// cloudflared-guard is the fixed PID 1 launcher for the Docker Tunnel sidecar.
// It is intentionally Linux-only and has no configuration surface beyond the
// two exact modes below.
package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"
)

const (
	cloudflaredPath = "/usr/local/bin/cloudflared"
	tokenPath       = "/run/secrets/cloudflare-tunnel-token"
	tokenFD         = 9
	serviceID       = 65532
	maxTokenBytes   = 4096
	prCapBsetDrop   = 24
	prSetNoNewPrivs = 38
)

var cloudflaredEnvironment = []string{
	"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	"SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
}

func launcherError(message string) error {
	return fmt.Errorf("cloudflared credential launcher: %s", message)
}

func sameFile(left, right *syscall.Stat_t) bool {
	return left.Dev == right.Dev && left.Ino == right.Ino
}

func safeTokenStat(stat *syscall.Stat_t) bool {
	permissions := stat.Mode & 0o777
	return stat.Mode&syscall.S_IFMT == syscall.S_IFREG &&
		stat.Uid == 0 &&
		stat.Nlink == 1 &&
		(permissions == 0o400 || permissions == 0o600) &&
		stat.Size > 0 && stat.Size <= maxTokenBytes
}

func readTokenForValidation(fd int, expectedSize int64) ([]byte, error) {
	buffer := make([]byte, maxTokenBytes+1)
	total := 0
	for {
		count, err := syscall.Read(fd, buffer[total:])
		if count > 0 {
			total += count
			if total > maxTokenBytes {
				return nil, launcherError("token file is empty or exceeds the size limit")
			}
		}
		if err == syscall.EINTR {
			continue
		}
		if err != nil {
			return nil, launcherError("token file could not be read safely")
		}
		if count == 0 {
			break
		}
	}
	if int64(total) != expectedSize || len(bytes.TrimSpace(buffer[:total])) == 0 {
		return nil, launcherError("token file is empty or changed while being read")
	}
	return buffer[:total], nil
}

func readValidatedToken() (result []byte, resultError error) {
	var before syscall.Stat_t
	if err := syscall.Lstat(tokenPath, &before); err != nil {
		return nil, launcherError("token file is missing")
	}
	if before.Mode&syscall.S_IFMT == syscall.S_IFLNK {
		return nil, launcherError("token file must not be a symbolic link")
	}

	fd, err := syscall.Open(tokenPath, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, launcherError("token file could not be opened safely")
	}
	defer syscall.Close(fd)

	var opened syscall.Stat_t
	if err := syscall.Fstat(fd, &opened); err != nil || !sameFile(&before, &opened) {
		return nil, launcherError("token file changed while being opened")
	}
	if !safeTokenStat(&opened) {
		return nil, launcherError("token file must be a non-empty root-owned regular file with one link and mode 0400 or 0600")
	}
	token, err := readTokenForValidation(fd, opened.Size)
	if err != nil {
		return nil, err
	}

	var after syscall.Stat_t
	if err := syscall.Fstat(fd, &after); err != nil || !sameFile(&opened, &after) || !safeTokenStat(&after) || after.Size != opened.Size {
		return nil, launcherError("token file changed while being validated")
	}
	return token, nil
}

func prepareTokenPipe(token []byte) (result int, resultError error) {
	pipe := []int{0, 0}
	if err := syscall.Pipe2(pipe, syscall.O_CLOEXEC); err != nil {
		return -1, launcherError("token pipe could not be created")
	}
	readFD, writeFD := pipe[0], pipe[1]
	keepReadOpen := false
	defer func() {
		if !keepReadOpen {
			_ = syscall.Close(readFD)
		}
		_ = syscall.Close(writeFD)
	}()

	written := 0
	for written < len(token) {
		count, err := syscall.Write(writeFD, token[written:])
		if err == syscall.EINTR {
			continue
		}
		if err != nil || count == 0 {
			return -1, launcherError("token could not be transferred safely")
		}
		written += count
	}
	if err := syscall.Close(writeFD); err != nil {
		return -1, launcherError("token pipe could not be sealed")
	}
	writeFD = -1

	if readFD != tokenFD {
		if err := syscall.Dup3(readFD, tokenFD, 0); err != nil {
			return -1, launcherError("token descriptor could not be isolated")
		}
		_ = syscall.Close(readFD)
		readFD = tokenFD
	}
	if _, _, errno := syscall.Syscall(syscall.SYS_FCNTL, uintptr(readFD), syscall.F_SETFD, 0); errno != 0 {
		return -1, launcherError("token descriptor could not be preserved")
	}
	keepReadOpen = true
	return readFD, nil
}

func setNoNewPrivileges() error {
	_, _, errno := syscall.RawSyscall6(syscall.SYS_PRCTL, prSetNoNewPrivs, 1, 0, 0, 0, 0)
	if errno != 0 {
		return launcherError("no-new-privileges could not be enforced")
	}
	return nil
}

func clearCapabilityBoundingSet() error {
	contents, err := os.ReadFile("/proc/sys/kernel/cap_last_cap")
	if err != nil {
		return launcherError("capability bounding set could not be inspected")
	}
	lastCapability, err := strconv.ParseUint(strings.TrimSpace(string(contents)), 10, 8)
	if err != nil || lastCapability > 63 {
		return launcherError("capability bounding set could not be inspected")
	}
	for capability := uint64(0); capability <= lastCapability; capability++ {
		_, _, errno := syscall.RawSyscall6(
			syscall.SYS_PRCTL,
			prCapBsetDrop,
			uintptr(capability),
			0,
			0,
			0,
			0,
		)
		if errno != 0 {
			return launcherError("capability bounding set could not be cleared")
		}
	}
	return nil
}

func assertDroppedPrivileges() error {
	if syscall.Geteuid() != serviceID || syscall.Getegid() != serviceID {
		return launcherError("service identity could not be enforced")
	}
	status, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return launcherError("process privileges could not be verified")
	}
	requiredZero := map[string]bool{
		"CapInh": false,
		"CapPrm": false,
		"CapEff": false,
		"CapBnd": false,
		"CapAmb": false,
	}
	noNewPrivileges := false
	for _, line := range strings.Split(string(status), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 {
			continue
		}
		name := strings.TrimSuffix(fields[0], ":")
		if _, required := requiredZero[name]; required {
			value, parseError := strconv.ParseUint(fields[1], 16, 64)
			if parseError != nil || value != 0 {
				return launcherError("service capabilities were not fully dropped")
			}
			requiredZero[name] = true
		}
		if name == "NoNewPrivs" && fields[1] == "1" {
			noNewPrivileges = true
		}
	}
	for _, present := range requiredZero {
		if !present {
			return launcherError("service capabilities could not be verified")
		}
	}
	if !noNewPrivileges {
		return launcherError("no-new-privileges is not active")
	}
	return nil
}

func dropPrivileges() error {
	if syscall.Geteuid() != 0 || syscall.Getegid() != 0 {
		return launcherError("launcher must start as root")
	}
	if err := setNoNewPrivileges(); err != nil {
		return err
	}
	if err := clearCapabilityBoundingSet(); err != nil {
		return err
	}
	if err := syscall.Setgroups([]int{}); err != nil {
		return launcherError("supplementary groups could not be cleared")
	}
	if err := syscall.Setresgid(serviceID, serviceID, serviceID); err != nil {
		return launcherError("service group could not be selected")
	}
	if err := syscall.Setresuid(serviceID, serviceID, serviceID); err != nil {
		return launcherError("service user could not be selected")
	}
	return assertDroppedPrivileges()
}

func execCloudflared(arguments ...string) error {
	argv := append([]string{"cloudflared"}, arguments...)
	if err := syscall.Exec(cloudflaredPath, argv, cloudflaredEnvironment); err != nil {
		return launcherError("cloudflared could not be executed")
	}
	return errors.New("unreachable")
}

func run() error {
	token, err := readValidatedToken()
	if err != nil {
		return err
	}
	defer func() {
		for index := range token {
			token[index] = 0
		}
	}()
	if err := dropPrivileges(); err != nil {
		return err
	}
	fd, err := prepareTokenPipe(token)
	for index := range token {
		token[index] = 0
	}
	if err != nil {
		return err
	}
	defer syscall.Close(fd)
	return execCloudflared(
		"--no-autoupdate",
		"tunnel",
		"--metrics", "127.0.0.1:2000",
		// Request-level error logs can contain the complete origin URL, including
		// subscription tokens or the private WebSocket path. Keep only fatal
		// process failures; readiness is monitored separately.
		"--loglevel", "fatal",
		"--grace-period", "30s",
		"run",
		"--token-file", "/proc/self/fd/9",
	)
}

func ready() error {
	if err := dropPrivileges(); err != nil {
		return err
	}
	return execCloudflared("tunnel", "--metrics", "127.0.0.1:2000", "ready")
}

func main() {
	var err error
	if len(os.Args) != 2 {
		err = launcherError("expected exactly one fixed mode")
	} else {
		switch os.Args[1] {
		case "run":
			err = run()
		case "ready":
			err = ready()
		default:
			err = launcherError("unsupported mode")
		}
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
}
