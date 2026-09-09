# shellcheck shell=bash
# Check host commands, pinned runtime dependencies, and the installer lock.

die() {
  echo "Error: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command is missing: $1"
}

prompt_required() {
  local variable_name="$1"
  local label="$2"
  local secret="$3"
  local value="${!variable_name-}"
  if [[ -z "$value" ]]; then
    [[ -t 0 ]] || die "$variable_name must be set for a non-interactive installation."
    if [[ "$secret" == yes ]]; then
      read -r -s -p "$label: " value
      echo
    else
      read -r -p "$label: " value
    fi
  fi
  [[ -n "$value" ]] || die "$variable_name must not be empty."
  printf -v "$variable_name" '%s' "$value"
}

prompt_optional() {
  local variable_name="$1"
  local label="$2"
  local default_value="$3"
  local secret="$4"
  local value="${!variable_name-}"
  if [[ -z "$value" && -t 0 ]]; then
    if [[ "$secret" == yes ]]; then
      read -r -s -p "$label: " value
      echo
    else
      read -r -p "$label [$default_value]: " value
    fi
  fi
  value="${value:-$default_value}"
  printf -v "$variable_name" '%s' "$value"
}

[[ $EUID -eq 0 ]] || die "Run this installer as root (for example: sudo bash deploy/systemd/install.sh)."

[[ -r /etc/os-release ]] || die "This installer supports Debian and Ubuntu systems."
# shellcheck disable=SC1091
. /etc/os-release
case " ${ID:-} ${ID_LIKE:-} " in
  *debian*|*ubuntu*) ;;
  *) die "This installer supports Debian and Ubuntu systems." ;;
esac
[[ -d /run/systemd/system ]] || die "The host is not booted with systemd."

for command_name in bash chmod chown cmp cp cut env find flock getent grep groupadd id install ln mktemp mv node passwd readlink rm rmdir sha256sum sleep stat sync systemctl systemd-notify timeout useradd; do
  require_command "$command_name"
done
[[ -x /usr/bin/systemd-notify ]] \
  || die "systemd-notify must be installed at /usr/bin/systemd-notify."
[[ -x /usr/bin/systemctl ]] \
  || die "systemctl must be installed at /usr/bin/systemctl."

acquire_installer_lock() {
  local before_identity after_identity run_mode
  [[ -d /run && ! -L /run && "$(stat -c '%u:%g' -- /run)" == 0:0 ]] \
    || die "/run must be a real root-owned directory."
  run_mode="$(stat -c '%a' -- /run)"
  if [[ ! "$run_mode" =~ ^[0-7]{3,4}$ ]] \
      || (( (8#$run_mode & 8#022) != 0 )); then
    die "/run must not be writable by group or other users."
  fi
  if [[ ! -e "$INSTALLER_LOCK" && ! -L "$INSTALLER_LOCK" ]]; then
    # noclobber makes creation fail rather than following a concurrently placed
    # path. The subsequent identity checks cover both the winner and reruns.
    ( set -o noclobber; umask 077; : >"$INSTALLER_LOCK" ) 2>/dev/null || true
  fi
  [[ -f "$INSTALLER_LOCK" && ! -L "$INSTALLER_LOCK" ]] \
    || die "$INSTALLER_LOCK must be a real regular file, not a symlink."
  before_identity="$(stat -c '%d:%i:%u:%g:%a:%h' -- "$INSTALLER_LOCK")"
  [[ "$before_identity" =~ ^[0-9]+:[0-9]+:0:0:600:1$ ]] \
    || die "$INSTALLER_LOCK must be root-owned mode 0600 with one hard link."
  exec {INSTALLER_LOCK_FD}<>"$INSTALLER_LOCK"
  after_identity="$(stat -Lc '%d:%i:%u:%g:%a:%h' -- "/proc/self/fd/$INSTALLER_LOCK_FD")"
  [[ "$after_identity" == "$before_identity" ]] \
    || die "$INSTALLER_LOCK changed while it was opened."
  flock -n "$INSTALLER_LOCK_FD" \
    || die "Another vpn-gateway installer is already running."
  [[ "$(stat -c '%d:%i:%u:%g:%a:%h' -- "$INSTALLER_LOCK")" == "$before_identity" ]] \
    || die "$INSTALLER_LOCK was replaced after locking."
  readonly INSTALLER_LOCK_FD
}

acquire_installer_lock

NODE_BIN="$(command -v node)"
readonly NODE_BIN
case "$NODE_BIN" in
  /usr/bin/node|/usr/local/bin/node) ;;
  *) die "Node must be installed system-wide at /usr/bin/node or /usr/local/bin/node (found $NODE_BIN)." ;;
esac
NODE_VERSION="$($NODE_BIN --version)"
readonly NODE_VERSION
if [[ ! "$NODE_VERSION" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  die "Could not parse the Node version: $NODE_VERSION"
fi
NODE_MAJOR="${BASH_REMATCH[1]}"
NODE_MINOR="${BASH_REMATCH[2]}"
readonly NODE_MAJOR NODE_MINOR
if (( NODE_MAJOR != 24 || NODE_MINOR < 20 )); then
  die "Node >=$MIN_NODE_VERSION and <25 is required (found $NODE_VERSION)."
fi

require_command sing-box
SINGBOX_BIN="$(command -v sing-box)"
readonly SINGBOX_BIN
case "$SINGBOX_BIN" in
  /usr/bin/sing-box|/usr/local/bin/sing-box) ;;
  *) die "sing-box must be installed system-wide at /usr/bin/sing-box or /usr/local/bin/sing-box (found $SINGBOX_BIN)." ;;
esac
SINGBOX_VERSION_OUTPUT="$($SINGBOX_BIN version)"
readonly SINGBOX_VERSION_OUTPUT
if [[ ! "$SINGBOX_VERSION_OUTPUT" =~ sing-box[[:space:]]+version[[:space:]]+v?([0-9]+)\.([0-9]+)\.([0-9]+)($|[[:space:]]) ]]; then
  die "Could not parse the installed sing-box version."
fi
readonly SINGBOX_MAJOR="${BASH_REMATCH[1]}"
readonly SINGBOX_MINOR="${BASH_REMATCH[2]}"
readonly SINGBOX_PATCH="${BASH_REMATCH[3]}"
if (( SINGBOX_MAJOR != 1 || SINGBOX_MINOR != 13 || SINGBOX_PATCH != 21 )); then
  die "sing-box exactly $REQUIRED_SINGBOX_VERSION is required (found $SINGBOX_MAJOR.$SINGBOX_MINOR.$SINGBOX_PATCH)."
fi
for required_singbox_tag in with_tailscale with_utls; do
  grep -Eq "(^|[ ,])${required_singbox_tag}([ ,]|$)" <<<"$SINGBOX_VERSION_OUTPUT" \
    || die "The installed sing-box binary is missing required build tag $required_singbox_tag."
done

validate_cloudflare_runtime_dependencies() {
  local systemd_version_output systemd_version cloudflared_identity
  local cloudflared_uid cloudflared_gid cloudflared_mode cloudflared_links
  local cloudflared_version_output cloudflared_version
  require_command systemd-analyze
  [[ -x /usr/bin/test ]] \
    || die "test must be installed at /usr/bin/test."
  systemd_version_output="$(LC_ALL=C systemctl --version)"
  if [[ ! "$systemd_version_output" =~ ^systemd[[:space:]]+([0-9]+)($|[[:space:]]) ]]; then
    die "Could not parse the installed systemd version."
  fi
  systemd_version="${BASH_REMATCH[1]}"
  if (( systemd_version < MIN_SYSTEMD_VERSION )); then
    die "systemd >=$MIN_SYSTEMD_VERSION is required for protected service credentials (found $systemd_version)."
  fi

  require_command cloudflared
  CLOUDFLARED_BIN="$(command -v cloudflared)"
  [[ "$CLOUDFLARED_BIN" == /usr/bin/cloudflared ]] \
    || die "cloudflared must be installed at /usr/bin/cloudflared (found $CLOUDFLARED_BIN)."
  [[ -f "$CLOUDFLARED_BIN" && ! -L "$CLOUDFLARED_BIN" ]] \
    || die "$CLOUDFLARED_BIN must be a real regular file, not a symlink."
  cloudflared_identity="$(stat -c '%u:%g:%a:%h' -- "$CLOUDFLARED_BIN")"
  IFS=: read -r cloudflared_uid cloudflared_gid cloudflared_mode cloudflared_links <<<"$cloudflared_identity"
  [[ "$cloudflared_uid" == 0 && "$cloudflared_gid" == 0 && "$cloudflared_links" == 1 \
      && "$cloudflared_mode" =~ ^[0-7]{3,4}$ ]] \
    || die "$CLOUDFLARED_BIN must be root-owned with one hard link and ordinary executable permissions."
  (( (8#$cloudflared_mode & 8#022) == 0 )) \
    || die "$CLOUDFLARED_BIN must not be writable by group or other users."
  [[ -x "$CLOUDFLARED_BIN" ]] || die "$CLOUDFLARED_BIN must be executable."
  cloudflared_version_output="$(LC_ALL=C "$CLOUDFLARED_BIN" --version)"
  if [[ ! "$cloudflared_version_output" =~ ^cloudflared[[:space:]]+version[[:space:]]+v?([0-9]+\.[0-9]+\.[0-9]+)($|[[:space:]]) ]]; then
    die "Could not parse the installed cloudflared version."
  fi
  cloudflared_version="${BASH_REMATCH[1]}"
  [[ "$cloudflared_version" == "$REQUIRED_CLOUDFLARED_VERSION" ]] \
    || die "cloudflared exactly $REQUIRED_CLOUDFLARED_VERSION is required (found $cloudflared_version)."
  readonly CLOUDFLARED_BIN
}

readonly -a REQUIRED_SOURCE_FILES=(
  package.json
  src/state/bootstrap.js
  src/control/controller-server.js
  src/http/subscription-server.js
  src/http/admin-server.js
  src/runtime/healthcheck.js
  deploy/systemd/sing-box-wrapper.sh
  deploy/systemd/vpn-gateway.target
  deploy/systemd/vpn-gateway-controller.service
  deploy/systemd/vpn-gateway-sing-box.service
  deploy/systemd/vpn-gateway-subscription.service
  deploy/systemd/vpn-gateway-admin.service
  deploy/systemd/vpn-gateway-tunnel.service
)
readonly -a UNIT_FILES=(
  vpn-gateway.target
  vpn-gateway-controller.service
  vpn-gateway-sing-box.service
  vpn-gateway-subscription.service
  vpn-gateway-admin.service
  vpn-gateway-tunnel.service
)
for relative_path in "${REQUIRED_SOURCE_FILES[@]}"; do
  [[ -f "$REPO_DIR/$relative_path" ]] || die "Missing deployment file: $relative_path"
done

bash -n "$REPO_DIR/deploy/systemd/install.sh"
while IFS= read -r -d '' source_file; do
  "$NODE_BIN" --check "$source_file" >/dev/null
done < <(find "$REPO_DIR/src" -type f -name '*.js' -print0)
