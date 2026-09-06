#!/usr/bin/env bash
# Idempotent bare-metal deployment for Debian and Ubuntu. Dependencies must be
# installed by the operator from trusted packages before this script is run.
set -euo pipefail
umask 077

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly REPO_DIR
readonly INSTALL_ROOT=/opt/vpn-gateway
readonly STATE_ROOT=/var/lib/vpn-gateway
readonly ENV_ROOT=/etc/vpn-gateway
readonly SYSTEMD_ROOT=/etc/systemd/system
readonly CONTROLLER_ENV="$ENV_ROOT/controller.env"
readonly RUNTIME_ENV="$ENV_ROOT/runtime.env"
readonly ADMIN_ENV="$ENV_ROOT/admin.env"
readonly API_ENV="$ENV_ROOT/tailscale-api.env"
readonly SECRET_ROOT="$ENV_ROOT/secrets"
readonly AUTH_KEY_PATH="$SECRET_ROOT/tailscale-auth-key"
readonly API_KEY_PATH="$SECRET_ROOT/tailscale-api-key"
readonly TUNNEL_TOKEN_PATH="$SECRET_ROOT/cloudflare-tunnel-token"
readonly LEGACY_ENV_FILE=/etc/vpn-sub.env
readonly LEGACY_CONFIG_FILE=/etc/sing-box/config.json
readonly LEGACY_STATE_DIRECTORY=/var/lib/sing-box/tailscale
readonly LEGACY_SUDOERS=/etc/sudoers.d/vpn-sub
readonly MIGRATION_MARKER="$STATE_ROOT/.legacy-migration-in-progress"
readonly MIGRATION_COMMITTED_MARKER="$STATE_ROOT/.legacy-migration-committed"
readonly UPGRADE_RESTART_JOURNAL="$STATE_ROOT/.upgrade-restart-in-progress"
readonly UPGRADE_ROLLBACK_JOURNAL="$STATE_ROOT/.upgrade-rollback-in-progress"
readonly INSTALLER_LOCK=/run/vpn-gateway-installer.lock
readonly MIN_NODE_VERSION=24.20.0
readonly REQUIRED_SINGBOX_VERSION=1.13.21
readonly REQUIRED_CLOUDFLARED_VERSION=2026.8.3
readonly MIN_SYSTEMD_VERSION=247
readonly MAX_UPGRADE_REVISIONS=32
readonly MAX_UPGRADE_REVISION_BYTES=$((64 * 1024 * 1024))

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
    [[ -t 0 ]] || die "$variable_name must be set for a non-interactive installation or migration."
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

path_is_present() {
  [[ -e "$1" || -L "$1" ]]
}

validate_fixed_directory() {
  local directory_path="$1"
  local stat_record owner_id permission_mode
  path_is_present "$directory_path" || return 0
  [[ -d "$directory_path" && ! -L "$directory_path" ]] \
    || die "$directory_path must be a real directory, not a symlink."
  stat_record="$(stat -c '%u:%a' -- "$directory_path")"
  owner_id="${stat_record%%:*}"
  permission_mode="${stat_record#*:}"
  [[ "$owner_id" == 0 && "$permission_mode" =~ ^[0-7]{3,4}$ ]] \
    || die "$directory_path must be owned by root with ordinary directory permissions."
  (( (8#$permission_mode & 8#022) == 0 )) \
    || die "$directory_path must not be writable by group or other users."
}

validate_fixed_file() {
  local file_path="$1"
  local stat_record owner_id permission_mode link_count
  path_is_present "$file_path" || return 0
  [[ -f "$file_path" && ! -L "$file_path" ]] \
    || die "$file_path must be a real regular file, not a symlink."
  stat_record="$(stat -c '%u:%a:%h' -- "$file_path")"
  IFS=: read -r owner_id permission_mode link_count <<<"$stat_record"
  [[ "$owner_id" == 0 && "$permission_mode" =~ ^[0-7]{3,4}$ ]] \
    || die "$file_path must be owned by root with ordinary file permissions."
  (( (8#$permission_mode & 8#022) == 0 )) \
    || die "$file_path must not be writable by group or other users."
  [[ "$link_count" == 1 ]] \
    || die "$file_path must have exactly one hard link."
}

validate_migration_marker_file() {
  local marker_file="$1"
  [[ -f "$marker_file" && ! -L "$marker_file" ]] \
    || die "Migration marker file $marker_file is missing or unsafe."
  [[ "$(stat -c '%u:%g:%a:%h' -- "$marker_file")" == 0:0:600:1 ]] \
    || die "Migration marker file $marker_file must be root-owned mode 0600 with one hard link."
}

assert_distinct_migration_state_trees() {
  local source_tree="$1"
  local destination_tree="$2"
  local source_identity destination_identity
  path_is_present "$source_tree" && path_is_present "$destination_tree" || return 0
  source_identity="$(stat -Lc '%d:%i' -- "$source_tree")" \
    || die "Could not resolve the legacy Tailscale state identity: $source_tree"
  destination_identity="$(stat -Lc '%d:%i' -- "$destination_tree")" \
    || die "Could not resolve the migration Tailscale state identity: $destination_tree"
  [[ "$source_identity" != "$destination_identity" ]] \
    || die "The legacy and migration Tailscale state paths resolve to the same directory. Rollback and crash recovery require an independent legacy source."
}

promote_interrupted_migration_commit() {
  local marker_name marker_value marker_size unexpected_entry
  local inner_commit="$MIGRATION_MARKER/committed"
  path_is_present "$inner_commit" || return 0
  ! path_is_present "$MIGRATION_COMMITTED_MARKER" \
    || die "Both pending and published legacy migration commit markers exist; inspect them manually."
  [[ -d "$MIGRATION_MARKER" && ! -L "$MIGRATION_MARKER" ]] \
    && [[ "$(stat -c '%u:%g:%a' -- "$MIGRATION_MARKER")" == 0:0:700 ]] \
    || die "$MIGRATION_MARKER must be a root-owned mode-0700 directory."
  unexpected_entry="$(find "$MIGRATION_MARKER" -mindepth 1 -maxdepth 1 \
    ! -name env.sha256 \
    ! -name config.sha256 \
    ! -name source-state \
    ! -name sub-active \
    ! -name sub-enabled \
    ! -name sing-box-active \
    ! -name sing-box-enabled \
    ! -name state-copied \
    ! -name state-published \
    ! -name lineage.json \
    ! -name committed \
    -print -quit)"
  [[ -z "$unexpected_entry" ]] \
    || die "Pending migration commit contains an unexpected entry: $unexpected_entry"

  for marker_name in \
    env.sha256 config.sha256 source-state state-copied state-published lineage.json committed; do
    validate_migration_marker_file "$MIGRATION_MARKER/$marker_name"
  done
  for marker_name in sub-active sub-enabled sing-box-active sing-box-enabled; do
    if path_is_present "$MIGRATION_MARKER/$marker_name"; then
      validate_migration_marker_file "$MIGRATION_MARKER/$marker_name"
    fi
  done
  for marker_name in sub-active sub-enabled sing-box-active sing-box-enabled state-copied state-published committed; do
    if path_is_present "$MIGRATION_MARKER/$marker_name"; then
      [[ "$(stat -c '%s' -- "$MIGRATION_MARKER/$marker_name")" == 0 ]] \
        || die "Migration phase marker $marker_name must be empty."
    fi
  done
  for marker_name in env.sha256 config.sha256; do
    marker_value="$(<"$MIGRATION_MARKER/$marker_name")"
    marker_size="$(stat -c '%s' -- "$MIGRATION_MARKER/$marker_name")"
    [[ "$marker_value" =~ ^[0-9a-f]{64}$ \
        && "$marker_size" == 65 ]] \
      || die "Migration digest marker $marker_name is not canonical."
  done
  marker_value="$(<"$MIGRATION_MARKER/source-state")"
  marker_size="$(stat -c '%s' -- "$MIGRATION_MARKER/source-state")"
  [[ "$marker_value" == /* && "$marker_size" -ge 3 && "$marker_size" -le 4096 ]] \
    || die "Migration source-state marker is not canonical."
  marker_size="$(stat -c '%s' -- "$MIGRATION_MARKER/lineage.json")"
  (( marker_size >= 2 && marker_size <= 1024 )) \
    || die "Migration lineage marker has an invalid size."
  "$NODE_BIN" --input-type=module --eval '
    import { readFile } from "node:fs/promises";
    const lineageBytes = await readFile(process.argv[1]);
    const lineageText = lineageBytes.toString("utf8");
    if (!Buffer.from(lineageText, "utf8").equals(lineageBytes)) {
      throw new Error("migration lineage record is not UTF-8");
    }
    const value = JSON.parse(lineageText);
    const keys = [
      "schemaVersion", "source", "initialRevisionId", "initialRevision",
      "initialStateSha256", "invariantSha256",
    ];
    if (value === null || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).length !== keys.length
        || !keys.every((key) => Object.hasOwn(value, key))
        || value.schemaVersion !== 1 || value.source !== "legacy-v1"
        || value.initialRevision !== 1
        || !/^[0-9]{16}-[0-9a-f]{16}$/u.test(value.initialRevisionId)
        || !/^[0-9a-f]{64}$/u.test(value.initialStateSha256)
        || !/^[0-9a-f]{64}$/u.test(value.invariantSha256)) {
      throw new Error("migration lineage record is invalid");
    }
    const sourceBytes = await readFile(process.argv[2]);
    const sourceText = sourceBytes.toString("utf8");
    if (!Buffer.from(sourceText, "utf8").equals(sourceBytes)
        || !sourceText.endsWith("\n") || sourceText.slice(0, -1).includes("\n")
        || sourceText.includes("\r") || sourceText.includes("\0")) {
      throw new Error("migration source-state marker is not canonical text");
    }
    const source = sourceText.slice(0, -1);
    const segments = source.split("/");
    if (source.length < 2 || !source.startsWith("/") || source.endsWith("/")
        || source.includes("//") || source.includes("\\")
        || segments.includes(".") || segments.includes("..")) {
      throw new Error("migration source-state marker is not a normalized absolute path");
    }
  ' "$MIGRATION_MARKER/lineage.json" "$MIGRATION_MARKER/source-state" \
    || die "Migration lineage marker is invalid."

  echo "==> Completing the durable legacy migration commit interrupted before publication"
  mv -T -- "$inner_commit" "$MIGRATION_COMMITTED_MARKER"
  sync -f "$MIGRATION_MARKER"
  sync -f "$STATE_ROOT"
}

validate_cloudflare_tunnel_token_file() {
  local token_path="$1"
  local token_label="$2"
  [[ "$token_path" == /* ]] || die "$token_label must be an absolute path."
  env -i \
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    "$NODE_BIN" --input-type=module --eval '
      import { constants } from "node:fs";
      import { lstat, open } from "node:fs/promises";

      const source = process.argv[1];
      let handle;
      const reject = (detail) => {
        throw new Error("invalid Cloudflare Tunnel token file: " + detail);
      };
      try {
        handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
        const before = await handle.stat();
        const pathname = await lstat(source);
        const mode = before.mode & 0o777;
        if (!before.isFile() || before.nlink !== 1 || before.uid !== 0 || before.gid !== 0
            || ![0o400, 0o600].includes(mode) || before.size < 32 || before.size > 16 * 1024
            || pathname.isSymbolicLink() || pathname.dev !== before.dev || pathname.ino !== before.ino) {
          reject("source must be root-owned, singly linked, mode 0400/0600, and 32 bytes to 16 KiB");
        }
        const bytes = await handle.readFile();
        const after = await handle.stat();
        const finalPathname = await lstat(source);
        if (bytes.length !== before.size || after.dev !== before.dev || after.ino !== before.ino
            || after.uid !== before.uid || after.gid !== before.gid || after.nlink !== before.nlink
            || after.size !== before.size || (after.mode & 0o777) !== mode
            || finalPathname.isSymbolicLink() || finalPathname.dev !== before.dev
            || finalPathname.ino !== before.ino) {
          reject("source identity changed while it was read");
        }
        const fileText = bytes.toString("utf8");
        if (!Buffer.from(fileText, "utf8").equals(bytes) || fileText.includes("\0") || fileText.includes("\r")) {
          reject("content must be UTF-8 without NUL or carriage returns");
        }
        const token = fileText.endsWith("\n") ? fileText.slice(0, -1) : fileText;
        if (!token || token.includes("\n") || token !== token.trim()
            || !/^[A-Za-z0-9+/]+={0,2}$/u.test(token) || token.length % 4 !== 0) {
          reject("content must be exactly one canonical base64 token");
        }
        const decoded = Buffer.from(token, "base64");
        if (decoded.toString("base64") !== token) reject("outer token encoding is not canonical base64");
        const jsonText = decoded.toString("utf8");
        if (!Buffer.from(jsonText, "utf8").equals(decoded)) reject("decoded token is not UTF-8 JSON");
        let payload;
        try { payload = JSON.parse(jsonText); } catch { reject("decoded token is not JSON"); }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) reject("decoded token is not an object");
        const keys = Object.keys(payload).sort();
        if (!keys.every((key) => ["a", "e", "s", "t"].includes(key))
            || !keys.includes("a") || !keys.includes("s") || !keys.includes("t")) {
          reject("decoded token has an unsupported shape");
        }
        if (typeof payload.a !== "string" || payload.a.length < 1 || payload.a.length > 256
            || /[\u0000-\u001f\u007f]/u.test(payload.a)) reject("account tag is invalid");
        if (typeof payload.s !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/u.test(payload.s)
            || payload.s.length % 4 !== 0) reject("tunnel secret is invalid");
        const tunnelSecret = Buffer.from(payload.s, "base64");
        if (tunnelSecret.length < 16 || tunnelSecret.toString("base64") !== payload.s) {
          reject("tunnel secret encoding is invalid");
        }
        if (typeof payload.t !== "string"
            || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(payload.t)) {
          reject("tunnel identifier is invalid");
        }
        if (payload.e !== undefined && (typeof payload.e !== "string" || payload.e.length > 2048
            || /[\u0000-\u001f\u007f]/u.test(payload.e))) reject("endpoint is invalid");
      } finally {
        await handle?.close().catch(() => {});
      }
    ' "$token_path" >/dev/null \
    || die "$token_label is not a safe, valid Cloudflare Tunnel token file."
}

generate_websocket_path() {
  "$NODE_BIN" --input-type=module --eval \
    'import { randomBytes } from "node:crypto"; process.stdout.write("/" + randomBytes(32).toString("base64url"));'
}

validate_cloudflare_ingress_settings() {
  local normalized_output
  local -a normalized_values
  normalized_output="$(
    env -i \
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
      "VALIDATION_MODULE=$REPO_DIR/src/core/validation.js" \
      "VPN_PUBLIC_HOSTNAME=$VPN_PUBLIC_HOSTNAME" \
      "SUBSCRIPTION_PUBLIC_BASE_URL=$SUBSCRIPTION_PUBLIC_BASE_URL" \
      "ADMIN_PUBLIC_HOSTNAME=$ADMIN_PUBLIC_HOSTNAME" \
      "WS_PATH=$WS_PATH" \
      "EGRESS_HEALTH_HOST=$EGRESS_HEALTH_HOST" \
      "$NODE_BIN" --input-type=module --eval '
        import { pathToFileURL } from "node:url";
        const {
          validatePublicDnsHostname,
          validatePublicIngressSettings,
        } = await import(pathToFileURL(process.env.VALIDATION_MODULE).href);
        const gateway = validatePublicIngressSettings({
          vpnPublicHostname: process.env.VPN_PUBLIC_HOSTNAME,
          subscriptionPublicBaseUrl: process.env.SUBSCRIPTION_PUBLIC_BASE_URL,
          adminPublicHostname: process.env.ADMIN_PUBLIC_HOSTNAME,
          websocketPath: process.env.WS_PATH,
        }, "Cloudflare ingress settings");
        const healthHost = validatePublicDnsHostname(
          process.env.EGRESS_HEALTH_HOST,
          "EGRESS_HEALTH_HOST",
        );
        const subscriptionHost = new URL(gateway.subscriptionPublicBaseUrl).hostname;
        if ([gateway.vpnPublicHostname, subscriptionHost, gateway.adminPublicHostname].includes(healthHost)) {
          throw new Error("EGRESS_HEALTH_HOST must be independent of all three Tunnel hostnames");
        }
        process.stdout.write([
          gateway.vpnPublicHostname,
          gateway.subscriptionPublicBaseUrl,
          gateway.adminPublicHostname,
          gateway.websocketPath,
          healthHost,
        ].join("\n"));
      '
  )" || die "The Cloudflare ingress or routed-health settings are invalid."
  mapfile -t normalized_values <<<"$normalized_output"
  (( ${#normalized_values[@]} == 5 )) \
    || die "The Cloudflare ingress settings validator returned an invalid result."
  VPN_PUBLIC_HOSTNAME="${normalized_values[0]}"
  SUBSCRIPTION_PUBLIC_BASE_URL="${normalized_values[1]}"
  ADMIN_PUBLIC_HOSTNAME="${normalized_values[2]}"
  WS_PATH="${normalized_values[3]}"
  EGRESS_HEALTH_HOST="${normalized_values[4]}"
}

collect_cloudflare_ingress_settings() {
  local allow_path_generation="$1"
  VPN_PUBLIC_HOSTNAME="${VPN_PUBLIC_HOSTNAME:-}"
  SUBSCRIPTION_PUBLIC_BASE_URL="${SUBSCRIPTION_PUBLIC_BASE_URL:-}"
  ADMIN_PUBLIC_HOSTNAME="${ADMIN_PUBLIC_HOSTNAME:-}"
  WS_PATH="${WS_PATH:-}"
  EGRESS_HEALTH_HOST="${EGRESS_HEALTH_HOST:-}"

  prompt_required VPN_PUBLIC_HOSTNAME "Public VPN Tunnel hostname" no
  prompt_required SUBSCRIPTION_PUBLIC_BASE_URL "Public subscription HTTPS origin" no
  prompt_required ADMIN_PUBLIC_HOSTNAME "Public administration Tunnel hostname" no
  if [[ -z "$WS_PATH" ]]; then
    if [[ "$allow_path_generation" == yes ]]; then
      WS_PATH="$(generate_websocket_path)"
    else
      die "WS_PATH must be set for this deployment."
    fi
  fi
  prompt_required EGRESS_HEALTH_HOST "Independent operator-controlled egress health hostname" no
  validate_cloudflare_ingress_settings
}

inspect_current_state_for_installer() {
  env -i \
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    "DATA_DIR=$STATE_ROOT" \
    "STATE_SCHEMA_MODULE=$REPO_DIR/src/core/state-schema.js" \
    "$NODE_BIN" --input-type=module --eval '
      import { constants } from "node:fs";
      import { lstat, open, readlink } from "node:fs/promises";
      import path from "node:path";
      import { pathToFileURL } from "node:url";

      const root = process.env.DATA_DIR;
      let pointerPath;
      for (const name of ["current", "runtime"]) {
        const candidate = path.join(root, name);
        try {
          const pointer = await lstat(candidate);
          if (!pointer.isSymbolicLink() || pointer.uid !== 0) throw new Error(name + " pointer is unsafe");
          pointerPath = candidate;
          break;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      if (!pointerPath) throw new Error("no current or runtime revision pointer exists");
      const target = await readlink(pointerPath);
      if (!/^revisions\/[0-9]{16}-[0-9a-f]{16}$/u.test(target)) {
        throw new Error("revision pointer target is not canonical");
      }
      const revisionPath = path.join(root, target);
      const revision = await lstat(revisionPath);
      if (!revision.isDirectory() || revision.isSymbolicLink() || revision.uid !== 0 || (revision.mode & 0o777) !== 0o751) {
        throw new Error("revision directory is unsafe");
      }
      const statePath = path.join(revisionPath, "state.json");
      let handle;
      try {
        handle = await open(statePath, constants.O_RDONLY | constants.O_NOFOLLOW);
        const before = await handle.stat();
        const pathname = await lstat(statePath);
        if (!before.isFile() || before.uid !== 0 || before.gid !== 0 || before.nlink !== 1
            || (before.mode & 0o777) !== 0o600 || before.size < 2 || before.size > 1024 * 1024
            || pathname.isSymbolicLink() || pathname.dev !== before.dev || pathname.ino !== before.ino) {
          throw new Error("state file is unsafe");
        }
        const bytes = await handle.readFile();
        const after = await handle.stat();
        const finalPathname = await lstat(statePath);
        if (bytes.length !== before.size || after.dev !== before.dev || after.ino !== before.ino
            || after.uid !== before.uid || after.gid !== before.gid || after.nlink !== before.nlink
            || after.size !== before.size || (after.mode & 0o777) !== (before.mode & 0o777)
            || finalPathname.isSymbolicLink() || finalPathname.dev !== before.dev
            || finalPathname.ino !== before.ino) {
          throw new Error("state file changed while it was read");
        }
        const state = JSON.parse(bytes.toString("utf8"));
        if (state.schemaVersion === 2) {
          process.stdout.write(JSON.stringify({ schemaVersion: 2 }));
        } else {
          const { validateState } = await import(pathToFileURL(process.env.STATE_SCHEMA_MODULE).href);
          const validated = validateState(state);
          process.stdout.write(JSON.stringify({
            schemaVersion: validated.schemaVersion,
            vpnPublicHostname: validated.gateway.vpnPublicHostname,
            subscriptionPublicBaseUrl: validated.gateway.subscriptionPublicBaseUrl,
            adminPublicHostname: validated.gateway.adminPublicHostname,
            websocketPath: validated.gateway.websocketPath,
            egressHealthHost: validated.health.target.host,
          }));
        }
      } finally {
        await handle?.close().catch(() => {});
      }
    '
}

read_installer_json_field() {
  local json_document="$1"
  local field_name="$2"
  printf '%s' "$json_document" \
    | "$NODE_BIN" -e '
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", () => {
        const value = JSON.parse(input)[process.argv[1]];
        if (typeof value !== "string" && !Number.isInteger(value)) process.exit(2);
        process.stdout.write(String(value));
      });
    ' "$field_name"
}

require_matching_canonical_setting() {
  local setting_name="$1"
  local supplied_value="$2"
  local canonical_value="$3"
  if [[ -n "$supplied_value" && "$supplied_value" != "$canonical_value" ]]; then
    die "$setting_name conflicts with canonical state; change public settings through the controller rather than the installer."
  fi
}

read_generated_environment_value() {
  local environment_path="$1"
  local setting_name="$2"
  # The embedded JavaScript replacement string "$1" must remain literal.
  # shellcheck disable=SC2016
  env -i \
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    "$NODE_BIN" --input-type=module --eval '
      import { constants } from "node:fs";
      import { lstat, open } from "node:fs/promises";
      const source = process.argv[1];
      const requested = process.argv[2];
      let handle;
      try {
        handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
        const before = await handle.stat();
        const pathname = await lstat(source);
        if (!before.isFile() || before.uid !== 0 || before.gid !== 0 || before.nlink !== 1
            || (before.mode & 0o777) !== 0o600 || before.size < 1 || before.size > 64 * 1024
            || pathname.isSymbolicLink() || pathname.dev !== before.dev || pathname.ino !== before.ino) {
          throw new Error("environment file is unsafe");
        }
        const text = await handle.readFile({ encoding: "utf8" });
        const after = await handle.stat();
        const finalPathname = await lstat(source);
        if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
            || after.uid !== before.uid || after.gid !== before.gid || after.nlink !== before.nlink
            || (after.mode & 0o777) !== (before.mode & 0o777)
            || finalPathname.isSymbolicLink() || finalPathname.dev !== before.dev
            || finalPathname.ino !== before.ino) {
          throw new Error("environment file changed while it was read");
        }
        let result;
        for (const line of text.split("\n")) {
          if (!line) continue;
          const match = /^([A-Z][A-Z0-9_]*)="((?:[^"\\\r\n]|\\["\\])*)"$/u.exec(line);
          if (!match) throw new Error("environment file has unsupported syntax");
          if (match[1] !== requested) continue;
          if (result !== undefined) throw new Error("environment setting is duplicated");
          result = match[2].replace(/\\(["\\])/gu, "$1");
        }
        if (result === undefined || /[\r\n\0]/u.test(result)) throw new Error("environment setting is missing or unsafe");
        process.stdout.write(result);
      } finally {
        await handle?.close().catch(() => {});
      }
    ' "$environment_path" "$setting_name"
}

load_ingress_settings_from_controller_environment() {
  local stored_vpn stored_subscription stored_admin stored_path stored_health
  stored_vpn="$(read_generated_environment_value "$CONTROLLER_ENV" VPN_PUBLIC_HOSTNAME)" \
    || die "$CONTROLLER_ENV does not contain safe Cloudflare ingress settings."
  stored_subscription="$(read_generated_environment_value "$CONTROLLER_ENV" SUBSCRIPTION_PUBLIC_BASE_URL)" \
    || die "$CONTROLLER_ENV does not contain safe Cloudflare ingress settings."
  stored_admin="$(read_generated_environment_value "$CONTROLLER_ENV" ADMIN_PUBLIC_HOSTNAME)" \
    || die "$CONTROLLER_ENV does not contain safe Cloudflare ingress settings."
  stored_path="$(read_generated_environment_value "$CONTROLLER_ENV" WS_PATH)" \
    || die "$CONTROLLER_ENV does not contain safe Cloudflare ingress settings."
  stored_health="$(read_generated_environment_value "$CONTROLLER_ENV" EGRESS_HEALTH_HOST)" \
    || die "$CONTROLLER_ENV does not contain safe Cloudflare ingress settings."
  require_matching_canonical_setting VPN_PUBLIC_HOSTNAME "${VPN_PUBLIC_HOSTNAME:-}" "$stored_vpn"
  require_matching_canonical_setting SUBSCRIPTION_PUBLIC_BASE_URL "${SUBSCRIPTION_PUBLIC_BASE_URL:-}" "$stored_subscription"
  require_matching_canonical_setting ADMIN_PUBLIC_HOSTNAME "${ADMIN_PUBLIC_HOSTNAME:-}" "$stored_admin"
  require_matching_canonical_setting WS_PATH "${WS_PATH:-}" "$stored_path"
  require_matching_canonical_setting EGRESS_HEALTH_HOST "${EGRESS_HEALTH_HOST:-}" "$stored_health"
  VPN_PUBLIC_HOSTNAME="$stored_vpn"
  SUBSCRIPTION_PUBLIC_BASE_URL="$stored_subscription"
  ADMIN_PUBLIC_HOSTNAME="$stored_admin"
  WS_PATH="$stored_path"
  EGRESS_HEALTH_HOST="$stored_health"
  validate_cloudflare_ingress_settings
}

cleanup_orphaned_secret_staging() {
  local staging_path staging_name stat_record
  while IFS= read -r -d '' staging_path; do
    staging_name="${staging_path##*/}"
    [[ "$staging_name" =~ ^\.secret\.[A-Za-z0-9]{6}$ ]] \
      || die "Refusing unexpected secret staging lookalike: $staging_path"
    [[ -f "$staging_path" && ! -L "$staging_path" ]] \
      || die "Refusing unsafe secret staging entry: $staging_path"
    stat_record="$(stat -c '%u:%a:%h' -- "$staging_path")"
    [[ "$stat_record" == 0:600:1 ]] \
      || die "Refusing secret staging entry with unsafe ownership, mode, or link count: $staging_path"
    rm -f -- "$staging_path"
  done < <(find "$SECRET_ROOT" -mindepth 1 -maxdepth 1 -name '.secret.*' -print0)
}

# Validate every fixed destination before creating users, stopping services, or
# writing host state. This prevents GNU install/cp from following a planted
# deployment-root or child symlink into an unrelated filesystem location.
for fixed_directory in \
  "$INSTALL_ROOT" \
  "$INSTALL_ROOT/src" \
  "$INSTALL_ROOT/bin" \
  "$STATE_ROOT" \
  "$STATE_ROOT/revisions" \
  "$UPGRADE_RESTART_JOURNAL" \
  "$UPGRADE_ROLLBACK_JOURNAL" \
  "$ENV_ROOT" \
  "$SECRET_ROOT" \
  "$SYSTEMD_ROOT/multi-user.target.wants" \
  /var/backups/vpn-gateway; do
  validate_fixed_directory "$fixed_directory"
done
for unit_file in "${UNIT_FILES[@]}"; do
  validate_fixed_file "$SYSTEMD_ROOT/$unit_file"
done
for deployment_file in \
  "$CONTROLLER_ENV" \
  "$RUNTIME_ENV" \
  "$ADMIN_ENV" \
  "$API_ENV" \
  "$AUTH_KEY_PATH" \
  "$API_KEY_PATH" \
  "$TUNNEL_TOKEN_PATH"; do
  validate_fixed_file "$deployment_file"
done
for legacy_file in "$LEGACY_ENV_FILE" "$LEGACY_CONFIG_FILE" "$LEGACY_SUDOERS"; do
  validate_fixed_file "$legacy_file"
done
validate_fixed_file "$MIGRATION_COMMITTED_MARKER"

UPGRADE_RESTART_RECOVERY_REQUIRED=no
if path_is_present "$UPGRADE_RESTART_JOURNAL"; then
  [[ -d "$UPGRADE_RESTART_JOURNAL" && ! -L "$UPGRADE_RESTART_JOURNAL" ]] \
    || die "$UPGRADE_RESTART_JOURNAL must be a real directory, not a symlink."
  [[ "$(stat -c '%u:%g:%a' -- "$UPGRADE_RESTART_JOURNAL")" == 0:0:700 ]] \
    || die "$UPGRADE_RESTART_JOURNAL must be root-owned with mode 0700."
  UPGRADE_RESTART_RECOVERY_REQUIRED=yes
fi
readonly UPGRADE_RESTART_RECOVERY_REQUIRED

UPGRADE_ROLLBACK_RECOVERY_REQUIRED=no
if path_is_present "$UPGRADE_ROLLBACK_JOURNAL"; then
  [[ -d "$UPGRADE_ROLLBACK_JOURNAL" && ! -L "$UPGRADE_ROLLBACK_JOURNAL" ]] \
    || die "$UPGRADE_ROLLBACK_JOURNAL must be a real directory, not a symlink."
  [[ "$(stat -c '%u:%g:%a' -- "$UPGRADE_ROLLBACK_JOURNAL")" == 0:0:700 ]] \
    || die "$UPGRADE_ROLLBACK_JOURNAL must be root-owned with mode 0700."
  UPGRADE_ROLLBACK_RECOVERY_REQUIRED=yes
fi
readonly UPGRADE_ROLLBACK_RECOVERY_REQUIRED

if [[ "$UPGRADE_RESTART_RECOVERY_REQUIRED" != yes \
    && "$UPGRADE_ROLLBACK_RECOVERY_REQUIRED" != yes ]] \
    && path_is_present "$MIGRATION_MARKER/committed"; then
  promote_interrupted_migration_commit
fi

TUNNEL_TOKEN_RECOVERY_PENDING=no
if [[ "$UPGRADE_RESTART_RECOVERY_REQUIRED" == yes \
    || "$UPGRADE_ROLLBACK_RECOVERY_REQUIRED" == yes ]]; then
  # Destination files can be absent or only partly restored after a power
  # loss. Replay the authoritative journal before inspecting any stored token;
  # even an invalid newly supplied token must not hold predecessor recovery
  # hostage.
  TUNNEL_TOKEN_RECOVERY_PENDING=yes
elif [[ -n "${CLOUDFLARE_TUNNEL_TOKEN_FILE:-}" ]]; then
  validate_cloudflare_tunnel_token_file \
    "$CLOUDFLARE_TUNNEL_TOKEN_FILE" CLOUDFLARE_TUNNEL_TOKEN_FILE
elif path_is_present "$TUNNEL_TOKEN_PATH"; then
  validate_cloudflare_tunnel_token_file \
    "$TUNNEL_TOKEN_PATH" "Stored Cloudflare Tunnel token"
else
  die "CLOUDFLARE_TUNNEL_TOKEN_FILE must identify a root-owned mode 0400/0600 Cloudflare Tunnel token file."
fi
readonly TUNNEL_TOKEN_RECOVERY_PENDING

CLOUDFLARED_DEPENDENCIES_VALIDATED=no
if [[ "$UPGRADE_RESTART_RECOVERY_REQUIRED" != yes \
    && "$UPGRADE_ROLLBACK_RECOVERY_REQUIRED" != yes ]]; then
  validate_cloudflare_runtime_dependencies
  CLOUDFLARED_DEPENDENCIES_VALIDATED=yes
fi

# Classify the host before changing legacy files or services. A partially
# present v1 deployment is not safe to guess at, and v2 pointer recovery is
# left to RevisionRepository rather than reinitializing over it.
INSTALL_MODE=fresh
MIGRATION_RESUME=no
COMMITTED_MIGRATION_CLEANUP=no
if [[ "$UPGRADE_RESTART_RECOVERY_REQUIRED" == yes \
    || "$UPGRADE_ROLLBACK_RECOVERY_REQUIRED" == yes ]]; then
  # A prior rollback owns state reconciliation. Normal classification must not
  # inspect potentially dangling pointers until that durable journal is replayed.
  INSTALL_MODE=existing
elif path_is_present "$MIGRATION_COMMITTED_MARKER"; then
  [[ "$(stat -c '%u:%a:%h' -- "$MIGRATION_COMMITTED_MARKER")" == 0:600:1 ]] \
    || die "$MIGRATION_COMMITTED_MARKER must be root-owned mode 0600 with one link."
  if ! path_is_present "$STATE_ROOT/current" && ! path_is_present "$STATE_ROOT/runtime"; then
    die "$MIGRATION_COMMITTED_MARKER exists without a v2 revision pointer. Restore the state directory from backup before retrying."
  fi
  INSTALL_MODE=existing
  if path_is_present "$MIGRATION_MARKER"; then
    COMMITTED_MIGRATION_CLEANUP=yes
  fi
elif path_is_present "$MIGRATION_MARKER"; then
  [[ -d "$MIGRATION_MARKER" && ! -L "$MIGRATION_MARKER" ]] \
    || die "$MIGRATION_MARKER must be a directory, not a symlink."
  [[ "$(stat -c '%u:%a' "$MIGRATION_MARKER")" == 0:700 ]] \
    || die "$MIGRATION_MARKER must be owned by root with mode 0700."
  if ! path_is_present "$LEGACY_ENV_FILE" || ! path_is_present "$LEGACY_CONFIG_FILE"; then
    die "An interrupted migration requires both original legacy files. Restore $LEGACY_ENV_FILE and $LEGACY_CONFIG_FILE before retrying."
  fi
  [[ -f "$LEGACY_ENV_FILE" && ! -L "$LEGACY_ENV_FILE" ]] \
    || die "$LEGACY_ENV_FILE must be a regular file, not a symlink."
  [[ -f "$LEGACY_CONFIG_FILE" && ! -L "$LEGACY_CONFIG_FILE" ]] \
    || die "$LEGACY_CONFIG_FILE must be a regular file, not a symlink."
  INSTALL_MODE=migrate
  MIGRATION_RESUME=yes
elif path_is_present "$STATE_ROOT/current" || path_is_present "$STATE_ROOT/runtime"; then
  INSTALL_MODE=existing
elif path_is_present "$LEGACY_ENV_FILE" || path_is_present "$LEGACY_CONFIG_FILE"; then
  if ! path_is_present "$LEGACY_ENV_FILE" || ! path_is_present "$LEGACY_CONFIG_FILE"; then
    die "Incomplete legacy deployment: both $LEGACY_ENV_FILE and $LEGACY_CONFIG_FILE are required. Restore the missing file from backup before retrying."
  fi
  [[ -f "$LEGACY_ENV_FILE" && ! -L "$LEGACY_ENV_FILE" ]] \
    || die "$LEGACY_ENV_FILE must be a regular file, not a symlink."
  [[ -f "$LEGACY_CONFIG_FILE" && ! -L "$LEGACY_CONFIG_FILE" ]] \
    || die "$LEGACY_CONFIG_FILE must be a regular file, not a symlink."
  INSTALL_MODE=migrate
elif [[ -d "$STATE_ROOT/revisions" ]] \
    && [[ -n "$(find "$STATE_ROOT/revisions" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  die "Revision files exist without a current or runtime pointer. Preserve $STATE_ROOT and restore a pointer from a verified backup before retrying."
fi
readonly INSTALL_MODE MIGRATION_RESUME

# This fixed child is intentionally owned by the unprivileged runtime user, so
# it cannot use the root-only fixed-directory validator above. Validate it
# before user creation, service stops, or the later `install -d` call could
# follow a planted symlink and change an unrelated directory. A root-owned
# destination is accepted only while a legacy migration still owns the handoff.
if path_is_present "$STATE_ROOT/tailscale"; then
  [[ -d "$STATE_ROOT/tailscale" && ! -L "$STATE_ROOT/tailscale" ]] \
    || die "$STATE_ROOT/tailscale must be a real directory, not a symlink."
  tailscale_stat="$(stat -c '%u:%a' -- "$STATE_ROOT/tailscale")"
  tailscale_owner="${tailscale_stat%%:*}"
  tailscale_mode="${tailscale_stat#*:}"
  [[ "$tailscale_mode" =~ ^[0-7]{3,4}$ ]] \
    || die "$STATE_ROOT/tailscale has invalid directory permissions."
  (( (8#$tailscale_mode & 8#022) == 0 )) \
    || die "$STATE_ROOT/tailscale must not be writable by group or other users."
  if [[ "$tailscale_owner" != 11000 ]] \
      && [[ ! ( "$INSTALL_MODE" == migrate && "$tailscale_owner" == 0 ) ]]; then
    die "$STATE_ROOT/tailscale must be owned by vpn-runtime uid 11000 before deployment."
  fi
fi

readonly MIGRATION_RUNNER='import { pathToFileURL } from "node:url";
const { bootstrap } = await import(pathToFileURL(process.env.BOOTSTRAP_MODULE).href);
const result = await bootstrap();
const expected = process.env.EXPECTED_MIGRATION_STATUS.split(",");
if (!expected.includes(result.status)) {
  throw new Error("expected migration status " + expected.join(" or ") + ", received " + result.status);
}
process.stdout.write(JSON.stringify(result, null, 2) + "\n");'

readonly MIGRATION_INSPECTOR='import { pathToFileURL } from "node:url";
const { inspectLegacyV1 } = await import(pathToFileURL(process.env.MIGRATION_MODULE).href);
const inspection = await inspectLegacyV1({
  envPath: process.env.LEGACY_ENV_FILE,
  configPath: process.env.LEGACY_CONFIG_FILE,
  fallbackEnvironment: process.env,
});
process.stdout.write(JSON.stringify({
  status: "dry-run",
  sourcePaths: [inspection.envPath, inspection.configPath],
  summary: inspection.summary,
}, null, 2) + "\n");'

inspect_legacy_deployment() {
  local migration_state_directory="${1:-}"
  local migration_module="${2:-$REPO_DIR/src/migrations/migrate-v1.js}"
  local -a isolated_environment=(
    env -i
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    "NODE_ENV=production"
    "NODE_PORT=8443"
    "VPN_PUBLIC_HOSTNAME=$VPN_PUBLIC_HOSTNAME"
    "SUBSCRIPTION_PUBLIC_BASE_URL=$SUBSCRIPTION_PUBLIC_BASE_URL"
    "ADMIN_PUBLIC_HOSTNAME=$ADMIN_PUBLIC_HOSTNAME"
    "WS_PATH=$WS_PATH"
    "EGRESS_HEALTH_HOST=$EGRESS_HEALTH_HOST"
    "SINGBOX_STATE_DIR=$STATE_ROOT/tailscale"
    "LEGACY_ENV_FILE=$LEGACY_ENV_FILE"
    "LEGACY_CONFIG_FILE=$LEGACY_CONFIG_FILE"
    "MIGRATION_MODULE=$migration_module"
  )
  if [[ -n "$migration_state_directory" ]]; then
    isolated_environment+=("MIGRATION_STATE_DIR=$migration_state_directory")
  fi
  "${isolated_environment[@]}" "$NODE_BIN" --input-type=module --eval "$MIGRATION_INSPECTOR"
}

run_legacy_bootstrap() {
  local mode="$1"
  local expected_status="$2"
  local migration_state_directory="${3:-}"
  local bootstrap_module="${4:-$REPO_DIR/src/state/bootstrap.js}"
  local -a isolated_environment=(
    env -i
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    "NODE_ENV=production"
    "DATA_DIR=$STATE_ROOT"
    "SINGBOX_BIN=$SINGBOX_BIN"
    "SINGBOX_CONFIG=$STATE_ROOT/runtime/sing-box.json"
    "SINGBOX_STATE_DIR=$STATE_ROOT/tailscale"
    "NODE_PORT=8443"
    "VPN_PUBLIC_HOSTNAME=$VPN_PUBLIC_HOSTNAME"
    "SUBSCRIPTION_PUBLIC_BASE_URL=$SUBSCRIPTION_PUBLIC_BASE_URL"
    "ADMIN_PUBLIC_HOSTNAME=$ADMIN_PUBLIC_HOSTNAME"
    "WS_PATH=$WS_PATH"
    "EGRESS_HEALTH_HOST=$EGRESS_HEALTH_HOST"
    "LEGACY_ENV_FILE=$LEGACY_ENV_FILE"
    "LEGACY_CONFIG_FILE=$LEGACY_CONFIG_FILE"
    "MIGRATION_MARKER_DIR=$MIGRATION_MARKER"
    "MIGRATE_LEGACY=$mode"
    "SINGBOX_GID=${RUNTIME_GID:-11000}"
    "SUB_GID=${SUB_GID_VALUE:-11001}"
    "BOOTSTRAP_MODULE=$bootstrap_module"
    "EXPECTED_MIGRATION_STATUS=$expected_status"
  )
  if [[ -n "$migration_state_directory" ]]; then
    isolated_environment+=("MIGRATION_STATE_DIR=$migration_state_directory")
  fi
  if [[ -s "$API_KEY_PATH" ]]; then
    isolated_environment+=("TS_API_KEY_FILE=$API_KEY_PATH")
  fi
  if [[ -s "$AUTH_KEY_PATH" ]]; then
    isolated_environment+=("TS_AUTH_KEY_FILE=$AUTH_KEY_PATH")
  fi
  "${isolated_environment[@]}" "$NODE_BIN" --input-type=module --eval "$MIGRATION_RUNNER"
}

MIGRATION_APPROVED=no
COPY_LEGACY_STATE=no
LEGACY_SOURCE_STATE=""
LEGACY_ENV_DIGEST=""
LEGACY_CONFIG_DIGEST=""
if [[ "$INSTALL_MODE" == migrate ]]; then
  if path_is_present "$CONTROLLER_ENV" \
      && grep -q '^VPN_PUBLIC_HOSTNAME=' "$CONTROLLER_ENV"; then
    load_ingress_settings_from_controller_environment
  else
    collect_cloudflare_ingress_settings yes
  fi

  echo "==> Legacy v1 deployment detected; performing a read-only migration preview"
  migration_preview="$(inspect_legacy_deployment)"
  printf '%s\n' "$migration_preview"

  LEGACY_SOURCE_STATE="$(
    printf '%s\n' "$migration_preview" \
      | "$NODE_BIN" -e 'let value="";process.stdin.setEncoding("utf8");process.stdin.on("data",chunk=>{value+=chunk});process.stdin.on("end",()=>{const parsed=JSON.parse(value);process.stdout.write(parsed.summary.tailscaleStateDirectory)})'
  )"
  [[ -n "$LEGACY_SOURCE_STATE" && "$LEGACY_SOURCE_STATE" == /* ]] \
    || die "The legacy Tailscale state directory is invalid."

  if [[ "$LEGACY_SOURCE_STATE" == "$STATE_ROOT/tailscale" ]]; then
    die "The legacy Tailscale state directory already equals the migration destination $STATE_ROOT/tailscale. Refusing an in-place handoff because rollback and crash recovery require an independent source; restore the legacy identity to a distinct protected directory before retrying."
  fi
  # String inequality is insufficient when a legacy configuration traverses a
  # symlinked ancestor or bind mount. Reject the same underlying directory while
  # this phase is still read-only and before the operator approves any mutation.
  assert_distinct_migration_state_trees "$LEGACY_SOURCE_STATE" "$STATE_ROOT/tailscale"

  if [[ "$LEGACY_SOURCE_STATE" == "$LEGACY_STATE_DIRECTORY" ]]; then
    COPY_LEGACY_STATE=yes
  elif [[ "${LEGACY_STATE_PRECOPIED:-0}" != 1 ]]; then
    die "The legacy configuration uses unexpected Tailscale state directory $LEGACY_SOURCE_STATE. Stop the legacy services, securely copy that directory to $STATE_ROOT/tailscale, verify the copy, then rerun with LEGACY_STATE_PRECOPIED=1."
  fi

  case "${MIGRATE_LEGACY:-}" in
    1)
      MIGRATION_APPROVED=yes
      ;;
    dry-run)
      echo "==> Dry run complete; no legacy service or persistent state was changed."
      exit 0
      ;;
    "")
      [[ -t 0 ]] \
        || die "Review the migration preview, then rerun with MIGRATE_LEGACY=1 to apply it non-interactively."
      read -r -p "Type MIGRATE_LEGACY=1 to stop the legacy services and apply this migration: " migration_confirmation
      [[ "$migration_confirmation" == MIGRATE_LEGACY=1 ]] \
        || die "Migration was not approved; no legacy service or persistent state was changed."
      MIGRATION_APPROVED=yes
      ;;
    *)
      die "MIGRATE_LEGACY must be exactly 1 to apply, dry-run to preview and exit, or unset for an interactive confirmation."
      ;;
  esac
  LEGACY_ENV_DIGEST="$(sha256sum "$LEGACY_ENV_FILE" | cut -d' ' -f1)"
  LEGACY_CONFIG_DIGEST="$(sha256sum "$LEGACY_CONFIG_FILE" | cut -d' ' -f1)"
fi
readonly MIGRATION_APPROVED COPY_LEGACY_STATE LEGACY_SOURCE_STATE LEGACY_ENV_DIGEST LEGACY_CONFIG_DIGEST

ensure_group() {
  local name="$1"
  local gid="$2"
  local preserve_existing="${3:-no}"
  local record existing_gid
  record="$(getent group "$name" || true)"
  if [[ -n "$record" ]]; then
    IFS=: read -r _ _ existing_gid _ <<<"$record"
    if [[ "$preserve_existing" == yes && "$existing_gid" != 0 ]]; then
      return
    fi
    [[ "$existing_gid" == "$gid" ]] || die "Group $name exists with gid $existing_gid; expected $gid."
    return
  fi
  record="$(getent group "$gid" || true)"
  [[ -z "$record" ]] || die "Gid $gid is already assigned to ${record%%:*}."
  groupadd --system --gid "$gid" "$name"
}

ensure_user() {
  local name="$1"
  local uid="$2"
  local gid="$3"
  local preserve_existing="${4:-no}"
  local record existing_uid existing_gid
  record="$(getent passwd "$name" || true)"
  if [[ -n "$record" ]]; then
    IFS=: read -r _ _ existing_uid existing_gid _ <<<"$record"
    if [[ "$preserve_existing" == yes && "$existing_uid" != 0 ]]; then
      [[ "$existing_gid" == "$gid" ]] \
        || die "User $name has primary gid $existing_gid; expected its $name group gid $gid."
      return
    fi
    [[ "$existing_uid" == "$uid" && "$existing_gid" == "$gid" ]] \
      || die "User $name exists with uid/gid $existing_uid:$existing_gid; expected $uid:$gid."
    return
  fi
  record="$(getent passwd "$uid" || true)"
  [[ -z "$record" ]] || die "Uid $uid is already assigned to ${record%%:*}."
  useradd --system --uid "$uid" --gid "$gid" --no-create-home --home-dir /nonexistent \
    --shell "$NOLOGIN_SHELL" "$name"
}

resolve_service_id() {
  local database="$1"
  local name="$2"
  local default_id="$3"
  local preserve_existing="$4"
  local records record_count=0 record_id
  records="$(getent "$database" "$name" || true)"
  while IFS= read -r record; do
    [[ -n "$record" ]] || continue
    ((record_count += 1))
    IFS=: read -r _ _ record_id _ <<<"$record"
  done <<<"$records"
  (( record_count <= 1 )) \
    || die "NSS returned more than one $database record named $name."
  if (( record_count == 1 )) && [[ "$preserve_existing" == yes && "$record_id" != 0 ]]; then
    printf '%s\n' "$record_id"
  else
    printf '%s\n' "$default_id"
  fi
}

validate_service_namespace() {
  local service_name="$1"
  local expected_uid="$2"
  local expected_gid="$3"
  local require_complete="$4"
  local passwd_records group_records record
  local account_name account_uid account_gid account_shell extra_field
  local group_name group_gid group_members member
  local -a explicit_members=()
  local account_name_count=0 account_uid_count=0 primary_gid_count=0
  local group_name_count=0 group_gid_count=0 explicit_member_count=0
  local password_status status_name status_value service_group_ids

  passwd_records="$(getent passwd)" \
    || die "Could not enumerate the NSS passwd database."
  group_records="$(getent group)" \
    || die "Could not enumerate the NSS group database."

  while IFS= read -r record; do
    [[ -n "$record" ]] || continue
    extra_field=""
    IFS=: read -r account_name _ account_uid account_gid _ _ account_shell extra_field <<<"$record"
    [[ -z "$extra_field" && "$account_uid" =~ ^[0-9]+$ && "$account_gid" =~ ^[0-9]+$ ]] \
      || die "NSS returned a malformed passwd record while validating $service_name."
    if [[ "$account_name" == "$service_name" ]]; then
      ((account_name_count += 1))
      [[ "$account_uid" == "$expected_uid" && "$account_gid" == "$expected_gid" ]] \
        || die "User $service_name has uid/gid $account_uid:$account_gid; expected $expected_uid:$expected_gid."
      case "$account_shell" in
        /usr/sbin/nologin|/sbin/nologin|/usr/bin/false|/bin/false) ;;
        *) die "Service identity $service_name must use a recognized non-login shell (found $account_shell)." ;;
      esac
    fi
    if [[ "$account_uid" == "$expected_uid" ]]; then
      ((account_uid_count += 1))
      [[ "$account_name" == "$service_name" ]] \
        || die "Service uid $expected_uid is also assigned to passwd principal $account_name."
    fi
    if [[ "$account_gid" == "$expected_gid" ]]; then
      ((primary_gid_count += 1))
      [[ "$account_name" == "$service_name" ]] \
        || die "Service gid $expected_gid is the primary gid of passwd principal $account_name."
    fi
  done <<<"$passwd_records"

  while IFS= read -r record; do
    [[ -n "$record" ]] || continue
    extra_field=""
    IFS=: read -r group_name _ group_gid group_members extra_field <<<"$record"
    [[ -z "$extra_field" && "$group_gid" =~ ^[0-9]+$ ]] \
      || die "NSS returned a malformed group record while validating $service_name."
    if [[ "$group_name" == "$service_name" ]]; then
      ((group_name_count += 1))
      [[ "$group_gid" == "$expected_gid" ]] \
        || die "Group $service_name has gid $group_gid; expected $expected_gid."
    fi
    if [[ "$group_gid" == "$expected_gid" ]]; then
      ((group_gid_count += 1))
      [[ "$group_name" == "$service_name" ]] \
        || die "Service gid $expected_gid is also assigned to group alias $group_name."
      if [[ -n "$group_members" ]]; then
        IFS=, read -r -a explicit_members <<<"$group_members"
        for member in "${explicit_members[@]}"; do
          [[ "$member" == "$service_name" ]] \
            || die "Service group $service_name contains unauthorized member $member."
          ((explicit_member_count += 1))
        done
        (( explicit_member_count <= 1 )) \
          || die "Service group $service_name contains duplicate membership entries."
      fi
    fi
  done <<<"$group_records"

  (( account_name_count <= 1 && account_uid_count <= 1 && primary_gid_count <= 1 \
      && group_name_count <= 1 && group_gid_count <= 1 )) \
    || die "NSS contains duplicate identity records for $service_name ($expected_uid:$expected_gid)."

  if [[ "$require_complete" == yes ]]; then
    (( account_name_count == 1 && account_uid_count == 1 && primary_gid_count == 1 \
        && group_name_count == 1 && group_gid_count == 1 )) \
      || die "Service identity $service_name is incomplete in NSS."
  fi

  if (( account_name_count == 1 )); then
    password_status="$(LC_ALL=C passwd -S "$service_name" 2>/dev/null)" \
      || die "Could not verify that service identity $service_name is locked."
    read -r status_name status_value _ <<<"$password_status"
    [[ "$status_name" == "$service_name" && "$status_value" == L ]] \
      || die "Service identity $service_name must have a locked password."
    service_group_ids="$(id -G "$service_name")"
    [[ "$service_group_ids" == "$expected_gid" ]] \
      || die "Service identity $service_name must belong only to its primary gid $expected_gid (found gids: $service_group_ids)."
  fi
}

if command -v nologin >/dev/null 2>&1; then
  NOLOGIN_SHELL="$(command -v nologin)"
  readonly NOLOGIN_SHELL
elif [[ -x /bin/false ]]; then
  readonly NOLOGIN_SHELL=/bin/false
else
  die "Could not find a non-login shell for service users."
fi

# Resolve the one legacy-compatible uid/gid pair before account creation, then
# audit every NSS record that could grant access through a service identity.
# Running the same audit after creation proves that no alias, primary-group
# occupant, explicit group member, login shell, or unlocked account survived.
EXPECTED_RUNTIME_UID=11000
EXPECTED_RUNTIME_GID=11000
EXPECTED_SUB_UID="$(resolve_service_id passwd vpn-sub 11001 yes)"
EXPECTED_SUB_GID="$(resolve_service_id group vpn-sub 11001 yes)"
EXPECTED_ADMIN_UID=11002
EXPECTED_ADMIN_GID=11002
EXPECTED_TUNNEL_UID=11003
EXPECTED_TUNNEL_GID=11003
readonly EXPECTED_RUNTIME_UID EXPECTED_RUNTIME_GID EXPECTED_SUB_UID EXPECTED_SUB_GID EXPECTED_ADMIN_UID EXPECTED_ADMIN_GID EXPECTED_TUNNEL_UID EXPECTED_TUNNEL_GID

validate_service_namespace vpn-runtime "$EXPECTED_RUNTIME_UID" "$EXPECTED_RUNTIME_GID" no
validate_service_namespace vpn-sub "$EXPECTED_SUB_UID" "$EXPECTED_SUB_GID" no
validate_service_namespace vpn-admin "$EXPECTED_ADMIN_UID" "$EXPECTED_ADMIN_GID" no

if [[ "$UPGRADE_RESTART_RECOVERY_REQUIRED" == yes \
    || "$UPGRADE_ROLLBACK_RECOVERY_REQUIRED" == yes ]]; then
  # These identities necessarily existed before a journal could be published.
  # Their disappearance is tampering, not permission to mutate NSS mid-replay.
  validate_service_namespace vpn-runtime "$EXPECTED_RUNTIME_UID" "$EXPECTED_RUNTIME_GID" yes
  validate_service_namespace vpn-sub "$EXPECTED_SUB_UID" "$EXPECTED_SUB_GID" yes
  validate_service_namespace vpn-admin "$EXPECTED_ADMIN_UID" "$EXPECTED_ADMIN_GID" yes
else
  ensure_group vpn-runtime 11000
  ensure_group vpn-sub 11001 yes
  ensure_group vpn-admin 11002
  ensure_user vpn-runtime 11000 11000
fi
VPN_SUB_GID="$(getent group vpn-sub | cut -d: -f3)"
readonly VPN_SUB_GID
if [[ "$UPGRADE_RESTART_RECOVERY_REQUIRED" != yes \
    && "$UPGRADE_ROLLBACK_RECOVERY_REQUIRED" != yes ]]; then
  ensure_user vpn-sub 11001 "$VPN_SUB_GID" yes
  ensure_user vpn-admin 11002 11002
fi

validate_service_namespace vpn-runtime "$EXPECTED_RUNTIME_UID" "$EXPECTED_RUNTIME_GID" yes
validate_service_namespace vpn-sub "$EXPECTED_SUB_UID" "$EXPECTED_SUB_GID" yes
validate_service_namespace vpn-admin "$EXPECTED_ADMIN_UID" "$EXPECTED_ADMIN_GID" yes

RUNTIME_UID="$(id -u vpn-runtime)"
readonly RUNTIME_UID
RUNTIME_GID="$(getent group vpn-runtime | cut -d: -f3)"
readonly RUNTIME_GID
SUB_UID_VALUE="$(id -u vpn-sub)"
readonly SUB_UID_VALUE
SUB_GID_VALUE="$(getent group vpn-sub | cut -d: -f3)"
readonly SUB_GID_VALUE
ADMIN_UID_VALUE="$(id -u vpn-admin)"
readonly ADMIN_UID_VALUE
ADMIN_GID_VALUE="$(getent group vpn-admin | cut -d: -f3)"
readonly ADMIN_GID_VALUE

LEGACY_SUB_WAS_ACTIVE=no
LEGACY_SINGBOX_WAS_ACTIVE=no
LEGACY_SUB_WAS_ENABLED=no
LEGACY_SINGBOX_WAS_ENABLED=no
LEGACY_SERVICES_STOPPED=no
MIGRATION_STAGING=""
MIGRATION_MARKER_STAGING=""
SECRET_STAGING=""
UPGRADE_WAS_ACTIVE=no
UPGRADE_WAS_ENABLED=no
UPGRADE_SINGBOX_WAS_ENABLED=no
UPGRADE_STOPPED=no
UPGRADE_BACKUP=""
UPGRADE_HAD_INSTALL_ROOT=no
UPGRADE_HAD_ENV_ROOT=no
UPGRADE_HAD_UNIT_TARGET=no
UPGRADE_HAD_UNIT_CONTROLLER=no
UPGRADE_HAD_UNIT_SING_BOX=no
UPGRADE_HAD_UNIT_SUBSCRIPTION=no
UPGRADE_HAD_UNIT_ADMIN=no
UPGRADE_HAD_UNIT_TUNNEL=no
UPGRADE_STATE_BACKUP_READY=no
ROLLBACK_RESTORE_STAGING=""
ROLLBACK_QUARANTINE_PATH=""
DEPLOYMENT_HANDOFF_COMPLETE=no

validate_upgrade_revision() {
  local revision_path="$1"
  local revision_name="${2:-${revision_path##*/}}"
  local expected_name file_name expected_identity actual_identity expected_max_bytes file_size unexpected_entry
  expected_name="$revision_name"
  [[ "$expected_name" =~ ^[0-9]{16}-[0-9a-f]{16}$ ]] \
    || die "Protected revision name is invalid: $expected_name"
  [[ -d "$revision_path" && ! -L "$revision_path" ]] \
    || die "Protected revision is missing or unsafe: $revision_path"
  [[ "$(stat -c '%u:%a' -- "$revision_path")" == 0:751 ]] \
    || die "Protected revision directory must be root-owned with mode 0751: $revision_path"
  unexpected_entry="$(find "$revision_path" -mindepth 1 -maxdepth 1 \
    ! -name manifest.json \
    ! -name state.json \
    ! -name sing-box.json \
    ! -name subscription-view.json \
    -print -quit)"
  [[ -z "$unexpected_entry" ]] \
    || die "Protected revision contains an unexpected entry: $unexpected_entry"
  for file_name in manifest.json state.json sing-box.json subscription-view.json; do
    [[ -f "$revision_path/$file_name" && ! -L "$revision_path/$file_name" ]] \
      || die "Protected revision file is missing or unsafe: $revision_path/$file_name"
    case "$file_name" in
      manifest.json|state.json)
        expected_identity=0:0:600:1
        if [[ "$file_name" == manifest.json ]]; then
          expected_max_bytes=$((64 * 1024))
        else
          expected_max_bytes=$((1024 * 1024))
        fi
        ;;
      sing-box.json)
        expected_identity="0:$RUNTIME_GID:640:1"
        expected_max_bytes=$((4 * 1024 * 1024))
        ;;
      subscription-view.json)
        expected_identity="0:$SUB_GID_VALUE:640:1"
        expected_max_bytes=$((1024 * 1024))
        ;;
    esac
    actual_identity="$(stat -c '%u:%g:%a:%h' -- "$revision_path/$file_name")"
    [[ "$actual_identity" == "$expected_identity" ]] \
      || die "Protected revision file has unsafe ownership, mode, or link count: $revision_path/$file_name"
    file_size="$(stat -c '%s' -- "$revision_path/$file_name")"
    if [[ ! "$file_size" =~ ^[0-9]+$ ]] \
        || (( file_size == 0 || file_size > expected_max_bytes )); then
      die "Protected revision file is empty or exceeds its storage bound: $revision_path/$file_name"
    fi
  done
}

validate_upgrade_pointer_target() {
  local pointer_target="$1"
  [[ "$pointer_target" =~ ^revisions/[0-9]{16}-[0-9a-f]{16}$ ]] \
    || die "Protected revision pointer target is invalid: $pointer_target"
  validate_upgrade_revision "$STATE_ROOT/$pointer_target"
}

validate_upgrade_temporary_revision() {
  local temporary_path="$1"
  local temporary_name="${temporary_path##*/}"
  local directory_mode file_name unexpected_entry stat_record owner_id group_id permission_mode link_count file_size max_bytes
  [[ "$temporary_name" =~ ^\.stage-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ \
      || "$temporary_name" =~ ^\.remove-[0-9]{16}-[0-9a-f]{16}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] \
    || die "Temporary revision name is invalid: $temporary_name"
  [[ -d "$temporary_path" && ! -L "$temporary_path" ]] \
    && [[ "$(stat -c '%u' -- "$temporary_path")" == 0 ]] \
    || die "Temporary revision directory is unsafe: $temporary_path"
  group_id="$(stat -c '%g' -- "$temporary_path")"
  [[ "$group_id" == 0 || "$group_id" == "$ADMIN_GID_VALUE" ]] \
    || die "Temporary revision directory has an unsafe group: $temporary_path"
  directory_mode="$(stat -c '%a' -- "$temporary_path")"
  [[ "$directory_mode" == 700 || "$directory_mode" == 751 ]] \
    || die "Temporary revision directory has unsafe permissions: $temporary_path"
  unexpected_entry="$(find "$temporary_path" -mindepth 1 -maxdepth 1 \
    ! -name manifest.json \
    ! -name state.json \
    ! -name sing-box.json \
    ! -name subscription-view.json \
    -print -quit)"
  [[ -z "$unexpected_entry" ]] \
    || die "Temporary revision contains an unexpected entry: $unexpected_entry"
  for file_name in manifest.json state.json sing-box.json subscription-view.json; do
    path_is_present "$temporary_path/$file_name" || continue
    [[ -f "$temporary_path/$file_name" && ! -L "$temporary_path/$file_name" ]] \
      || die "Temporary revision contains an unsafe file: $temporary_path/$file_name"
    stat_record="$(stat -c '%u:%g:%a:%h' -- "$temporary_path/$file_name")"
    IFS=: read -r owner_id group_id permission_mode link_count <<<"$stat_record"
    [[ "$owner_id" == 0 && "$link_count" == 1 ]] \
      || die "Temporary revision file has unsafe ownership or links: $temporary_path/$file_name"
    case "$file_name" in
      manifest.json)
        [[ "$permission_mode" == 600 \
            && ( "$group_id" == 0 || "$group_id" == "$ADMIN_GID_VALUE" ) ]] \
          || die "Temporary manifest has unsafe permissions."
        max_bytes=$((64 * 1024))
        ;;
      state.json)
        [[ "$permission_mode" == 600 \
            && ( "$group_id" == 0 || "$group_id" == "$ADMIN_GID_VALUE" ) ]] \
          || die "Temporary state has unsafe permissions."
        max_bytes=$((1024 * 1024))
        ;;
      sing-box.json)
        if [[ "$group_id" != 0 && "$group_id" != "$ADMIN_GID_VALUE" \
            && "$group_id" != "$RUNTIME_GID" ]] \
            || [[ "$permission_mode" != 600 && "$permission_mode" != 640 ]]; then
          die "Temporary sing-box configuration has unsafe permissions."
        fi
        max_bytes=$((4 * 1024 * 1024))
        ;;
      subscription-view.json)
        if [[ "$group_id" != 0 && "$group_id" != "$ADMIN_GID_VALUE" \
            && "$group_id" != "$SUB_GID_VALUE" ]] \
            || [[ "$permission_mode" != 600 && "$permission_mode" != 640 ]]; then
          die "Temporary subscription view has unsafe permissions."
        fi
        max_bytes=$((1024 * 1024))
        ;;
    esac
    file_size="$(stat -c '%s' -- "$temporary_path/$file_name")"
    if [[ ! "$file_size" =~ ^[0-9]+$ ]] || (( file_size > max_bytes )); then
      die "Temporary revision file exceeds its storage bound: $temporary_path/$file_name"
    fi
  done
}

# Older v2 units ran the root controller with vpn-admin as its effective group.
# Their root-owned private files could therefore inherit that group even though
# group permission bits were closed. Normalize only that exact, known-safe
# historical shape after the service set is stopped and before snapshotting it.
normalize_upgrade_repository_ownership() {
  local namespace_path="$STATE_ROOT/revisions"
  local revision_path revision_name file_path file_name stat_record owner_id group_id permission_mode link_count
  [[ -d "$namespace_path" && ! -L "$namespace_path" ]] \
    && [[ "$(stat -c '%u:%g:%a' -- "$namespace_path")" == 0:0:751 ]] \
    || die "Revision namespace is unsafe before ownership normalization."
  while IFS= read -r -d '' revision_path; do
    revision_name="${revision_path##*/}"
    [[ "$revision_name" =~ ^[0-9]{16}-[0-9a-f]{16}$ \
        || "$revision_name" =~ ^\.stage-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ \
        || "$revision_name" =~ ^\.remove-[0-9]{16}-[0-9a-f]{16}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] \
      || die "Revision namespace contains an unexpected entry before ownership normalization: $revision_path"
    [[ -d "$revision_path" && ! -L "$revision_path" ]] \
      || die "Revision directory is unsafe before ownership normalization: $revision_path"
    stat_record="$(stat -c '%u:%g:%a' -- "$revision_path")"
    IFS=: read -r owner_id group_id permission_mode <<<"$stat_record"
    [[ "$owner_id" == 0 \
        && ( "$group_id" == 0 || "$group_id" == "$ADMIN_GID_VALUE" ) \
        && ( "$permission_mode" == 700 || "$permission_mode" == 751 ) ]] \
      || die "Revision directory has unsafe legacy ownership or mode: $revision_path"
    if [[ "$group_id" == "$ADMIN_GID_VALUE" ]]; then
      chown root:root "$revision_path"
    fi
    while IFS= read -r -d '' file_path; do
      file_name="${file_path##*/}"
      case "$file_name" in
        manifest.json|state.json)
          [[ -f "$file_path" && ! -L "$file_path" ]] \
            || die "Private revision entry is unsafe before ownership normalization: $file_path"
          stat_record="$(stat -c '%u:%g:%a:%h' -- "$file_path")"
          IFS=: read -r owner_id group_id permission_mode link_count <<<"$stat_record"
          [[ "$owner_id" == 0 && "$permission_mode" == 600 && "$link_count" == 1 \
              && ( "$group_id" == 0 || "$group_id" == "$ADMIN_GID_VALUE" ) ]] \
            || die "Private revision entry has unsafe legacy ownership or mode: $file_path"
          if [[ "$group_id" == "$ADMIN_GID_VALUE" ]]; then
            chown root:root "$file_path"
          fi
          ;;
        sing-box.json)
          [[ -f "$file_path" && ! -L "$file_path" ]] \
            || die "Runtime projection is unsafe before ownership normalization: $file_path"
          ;;
        subscription-view.json)
          [[ -f "$file_path" && ! -L "$file_path" ]] \
            || die "Subscription projection is unsafe before ownership normalization: $file_path"
          ;;
        *) die "Revision directory contains an unexpected entry: $file_path" ;;
      esac
    done < <(find "$revision_path" -mindepth 1 -maxdepth 1 -print0)
  done < <(find "$namespace_path" -mindepth 1 -maxdepth 1 -print0)
  if path_is_present "$STATE_ROOT/maintenance"; then
    [[ -f "$STATE_ROOT/maintenance" && ! -L "$STATE_ROOT/maintenance" ]] \
      || die "Maintenance marker is unsafe before ownership normalization."
    stat_record="$(stat -c '%u:%g:%a:%h' -- "$STATE_ROOT/maintenance")"
    IFS=: read -r owner_id group_id permission_mode link_count <<<"$stat_record"
    [[ "$owner_id" == 0 && "$permission_mode" == 600 && "$link_count" == 1 \
        && ( "$group_id" == 0 || "$group_id" == "$ADMIN_GID_VALUE" ) ]] \
      || die "Maintenance marker has unsafe legacy ownership or mode."
    if [[ "$group_id" == "$ADMIN_GID_VALUE" ]]; then
      chown root:root "$STATE_ROOT/maintenance"
    fi
  fi
  sync -f "$namespace_path"
  sync -f "$STATE_ROOT"
}

reconcile_repository_revision_crash_artifacts() {
  local namespace_path="$1"
  local temporary_path temporary_name retirement_path
  [[ -d "$namespace_path" && ! -L "$namespace_path" ]] \
    && [[ "$(stat -c '%u:%g' -- "$namespace_path")" == 0:0 ]] \
    || die "Revision namespace is unsafe while reconciling repository crash artifacts."
  while IFS= read -r -d '' temporary_path; do
    temporary_name="${temporary_path##*/}"
    if [[ "$temporary_name" =~ ^\.stage-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ \
        || "$temporary_name" =~ ^\.remove-[0-9]{16}-[0-9a-f]{16}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
      validate_upgrade_temporary_revision "$temporary_path"
      retirement_path="$(mktemp -d "$STATE_ROOT/.repository-crash-artifact.XXXXXXXXXX")"
      rmdir -- "$retirement_path"
      mv -T -- "$temporary_path" "$retirement_path"
      sync -f "$namespace_path"
      sync -f "$STATE_ROOT"
      chmod 0700 "$retirement_path"
      rm -rf -- "$retirement_path"
      sync -f "$STATE_ROOT"
    fi
  done < <(find "$namespace_path" -mindepth 1 -maxdepth 1 -print0)
}

validate_upgrade_revision_namespace() {
  local namespace_path="$1"
  local expected_set="${2:-}"
  local expected_mode="${3:-751}"
  local revision_path revision_id file_name file_size
  local revision_count=0
  local expected_count=0
  local total_bytes=0
  [[ -d "$namespace_path" && ! -L "$namespace_path" ]] \
    || die "Revision namespace is missing or unsafe: $namespace_path"
  [[ "$(stat -c '%u:%g:%a' -- "$namespace_path")" == "0:0:$expected_mode" ]] \
    || die "Revision namespace must be root-owned with mode 0$expected_mode: $namespace_path"
  if [[ -n "$expected_set" ]]; then
    [[ -f "$expected_set" && ! -L "$expected_set" ]] \
      && [[ "$(stat -c '%u:%g:%a:%h' -- "$expected_set")" == 0:0:600:1 ]] \
      || die "Upgrade revision-set journal is missing or unsafe: $expected_set"
  fi
  while IFS= read -r -d '' revision_path; do
    revision_id="${revision_path##*/}"
    if [[ "$revision_id" =~ ^[0-9]{16}-[0-9a-f]{16}$ ]]; then
      validate_upgrade_revision "$revision_path"
      if [[ -n "$expected_set" ]]; then
        grep -Fxq -- "$revision_id" "$expected_set" \
          || die "Revision namespace contains a revision absent from the upgrade journal: $revision_id"
      fi
      for file_name in manifest.json state.json sing-box.json subscription-view.json; do
        file_size="$(stat -c '%s' -- "$revision_path/$file_name")"
        (( total_bytes += file_size ))
      done
    else
      die "Revision namespace contains an unexpected entry: $revision_path"
    fi
    (( revision_count += 1 ))
    (( revision_count <= MAX_UPGRADE_REVISIONS \
        && total_bytes <= MAX_UPGRADE_REVISION_BYTES )) \
      || die "Revision namespace exceeds the supported rollback snapshot budget."
  done < <(find "$namespace_path" -mindepth 1 -maxdepth 1 -print0)
  if [[ -n "$expected_set" ]]; then
    while IFS= read -r revision_id; do
      [[ "$revision_id" =~ ^[0-9]{16}-[0-9a-f]{16}$ ]] \
        || die "Upgrade revision-set journal contains an invalid revision id."
      [[ -d "$namespace_path/$revision_id" && ! -L "$namespace_path/$revision_id" ]] \
        || die "Upgrade revision-set journal references a missing revision: $revision_id"
      (( expected_count += 1 ))
    done <"$expected_set"
    [[ "$expected_count" == "$revision_count" ]] \
      || die "Revision namespace does not exactly match the upgrade revision-set journal."
  fi
}

compare_upgrade_revision_namespaces() {
  local left_namespace="$1"
  local right_namespace="$2"
  local revision_set="$3"
  local revision_id file_name
  validate_upgrade_revision_namespace "$left_namespace" "$revision_set"
  validate_upgrade_revision_namespace "$right_namespace" "$revision_set"
  while IFS= read -r revision_id; do
    for file_name in manifest.json state.json sing-box.json subscription-view.json; do
      cmp -s -- \
        "$left_namespace/$revision_id/$file_name" \
        "$right_namespace/$revision_id/$file_name" \
        || die "Revision snapshot differs from the stopped deployment: $revision_id/$file_name"
    done
  done <"$revision_set"
}

upgrade_revision_namespaces_match() {
  local live_namespace="$1"
  local backup_namespace="$2"
  local revision_set="$3"
  local revision_path revision_id file_name live_count=0 expected_count=0
  validate_upgrade_revision_namespace "$live_namespace"
  validate_upgrade_revision_namespace "$backup_namespace" "$revision_set"
  while IFS= read -r -d '' revision_path; do
    revision_id="${revision_path##*/}"
    grep -Fxq -- "$revision_id" "$revision_set" || return 1
    ((live_count += 1))
  done < <(find "$live_namespace" -mindepth 1 -maxdepth 1 -print0)
  while IFS= read -r revision_id; do
    ((expected_count += 1))
    [[ -d "$live_namespace/$revision_id" && ! -L "$live_namespace/$revision_id" ]] \
      || return 1
    for file_name in manifest.json state.json sing-box.json subscription-view.json; do
      cmp -s -- \
        "$live_namespace/$revision_id/$file_name" \
        "$backup_namespace/$revision_id/$file_name" \
        || return 1
    done
  done <"$revision_set"
  [[ "$live_count" == "$expected_count" ]]
}

write_upgrade_metadata_value() {
  local name="$1"
  local value="$2"
  local target="$UPGRADE_BACKUP/rollback-metadata/$name"
  [[ "$name" =~ ^[a-z-]+$ && "$value" =~ ^(yes|no)$ ]] \
    || die "Internal upgrade rollback metadata is invalid."
  install -o root -g root -m 0600 /dev/null "$target"
  printf '%s\n' "$value" >"$target"
  sync -f "$target"
}

persist_upgrade_rollback_metadata() {
  write_upgrade_metadata_value install-root "$UPGRADE_HAD_INSTALL_ROOT"
  write_upgrade_metadata_value environment-root "$UPGRADE_HAD_ENV_ROOT"
  write_upgrade_metadata_value target-active "$UPGRADE_WAS_ACTIVE"
  write_upgrade_metadata_value target-enabled "$UPGRADE_WAS_ENABLED"
  write_upgrade_metadata_value sing-box-enabled "$UPGRADE_SINGBOX_WAS_ENABLED"
  write_upgrade_metadata_value unit-target "$UPGRADE_HAD_UNIT_TARGET"
  write_upgrade_metadata_value unit-controller "$UPGRADE_HAD_UNIT_CONTROLLER"
  write_upgrade_metadata_value unit-sing-box "$UPGRADE_HAD_UNIT_SING_BOX"
  write_upgrade_metadata_value unit-subscription "$UPGRADE_HAD_UNIT_SUBSCRIPTION"
  write_upgrade_metadata_value unit-admin "$UPGRADE_HAD_UNIT_ADMIN"
  write_upgrade_metadata_value unit-tunnel "$UPGRADE_HAD_UNIT_TUNNEL"
  sync -f "$UPGRADE_BACKUP/rollback-metadata"
  sync -f "$UPGRADE_BACKUP"
}

read_upgrade_journal_line() {
  local file_path="$1"
  local expected_pattern="$2"
  local label="$3"
  local value file_size
  [[ -f "$file_path" && ! -L "$file_path" ]] \
    && [[ "$(stat -c '%u:%g:%a:%h' -- "$file_path")" == 0:0:600:1 ]] \
    || die "$label is missing or unsafe: $file_path"
  file_size="$(stat -c '%s' -- "$file_path")"
  if [[ ! "$file_size" =~ ^[0-9]+$ ]] \
      || (( file_size <= 1 || file_size > 512 )); then
    die "$label has an invalid size: $file_path"
  fi
  value="$(<"$file_path")"
  [[ "$value" =~ $expected_pattern ]] \
    || die "$label has invalid content: $file_path"
  (( file_size == ${#value} + 1 )) \
    || die "$label must contain exactly one newline-terminated value: $file_path"
  printf '%s\n' "$value"
}

load_upgrade_rollback_metadata() {
  local metadata_root="$UPGRADE_BACKUP/rollback-metadata"
  local unexpected_entry
  [[ -d "$metadata_root" && ! -L "$metadata_root" ]] \
    && [[ "$(stat -c '%u:%g:%a' -- "$metadata_root")" == 0:0:700 ]] \
    || die "Upgrade rollback metadata is missing or unsafe: $metadata_root"
  unexpected_entry="$(find "$metadata_root" -mindepth 1 -maxdepth 1 \
    ! -name install-root \
    ! -name environment-root \
    ! -name target-active \
    ! -name target-enabled \
    ! -name sing-box-enabled \
    ! -name unit-target \
    ! -name unit-controller \
    ! -name unit-sing-box \
    ! -name unit-subscription \
    ! -name unit-admin \
    ! -name unit-tunnel \
    -print -quit)"
  [[ -z "$unexpected_entry" ]] \
    || die "Upgrade rollback metadata contains an unexpected entry: $unexpected_entry"
  UPGRADE_HAD_INSTALL_ROOT="$(read_upgrade_journal_line "$metadata_root/install-root" '^(yes|no)$' 'Upgrade install-root metadata')"
  UPGRADE_HAD_ENV_ROOT="$(read_upgrade_journal_line "$metadata_root/environment-root" '^(yes|no)$' 'Upgrade environment-root metadata')"
  UPGRADE_WAS_ACTIVE="$(read_upgrade_journal_line "$metadata_root/target-active" '^(yes|no)$' 'Upgrade target-active metadata')"
  UPGRADE_WAS_ENABLED="$(read_upgrade_journal_line "$metadata_root/target-enabled" '^(yes|no)$' 'Upgrade target-enabled metadata')"
  UPGRADE_SINGBOX_WAS_ENABLED="$(read_upgrade_journal_line "$metadata_root/sing-box-enabled" '^(yes|no)$' 'Upgrade sing-box-enabled metadata')"
  UPGRADE_HAD_UNIT_TARGET="$(read_upgrade_journal_line "$metadata_root/unit-target" '^(yes|no)$' 'Upgrade target-unit metadata')"
  UPGRADE_HAD_UNIT_CONTROLLER="$(read_upgrade_journal_line "$metadata_root/unit-controller" '^(yes|no)$' 'Upgrade controller-unit metadata')"
  UPGRADE_HAD_UNIT_SING_BOX="$(read_upgrade_journal_line "$metadata_root/unit-sing-box" '^(yes|no)$' 'Upgrade sing-box-unit metadata')"
  UPGRADE_HAD_UNIT_SUBSCRIPTION="$(read_upgrade_journal_line "$metadata_root/unit-subscription" '^(yes|no)$' 'Upgrade subscription-unit metadata')"
  UPGRADE_HAD_UNIT_ADMIN="$(read_upgrade_journal_line "$metadata_root/unit-admin" '^(yes|no)$' 'Upgrade admin-unit metadata')"
  if path_is_present "$metadata_root/unit-tunnel"; then
    UPGRADE_HAD_UNIT_TUNNEL="$(read_upgrade_journal_line "$metadata_root/unit-tunnel" '^(yes|no)$' 'Upgrade tunnel-unit metadata')"
  else
    # Rollback metadata published by the immediately preceding deployment did
    # not know about the Tunnel unit. Absence therefore means the old unit was
    # absent; a corresponding backup file is rejected below.
    UPGRADE_HAD_UNIT_TUNNEL=no
  fi
}

backup_upgrade_revision_namespace() {
  local live_namespace="$STATE_ROOT/revisions"
  local backup_namespace="$UPGRADE_BACKUP/protected-state/revisions-snapshot"
  local revision_set="$UPGRADE_BACKUP/protected-state/revision-set"
  local revision_path
  validate_upgrade_revision_namespace "$live_namespace"
  install -o root -g root -m 0600 /dev/null "$revision_set"
  while IFS= read -r -d '' revision_path; do
    printf '%s\n' "${revision_path##*/}" >>"$revision_set"
  done < <(find "$live_namespace" -mindepth 1 -maxdepth 1 -print0)
  cp -a -- "$live_namespace" "$backup_namespace"
  compare_upgrade_revision_namespaces "$live_namespace" "$backup_namespace" "$revision_set"
}

backup_upgrade_pointer() {
  local pointer_name="$1"
  local pointer_path="$STATE_ROOT/$pointer_name"
  local pointer_target
  if path_is_present "$pointer_path"; then
    [[ -L "$pointer_path" && "$(stat -c '%u' -- "$pointer_path")" == 0 ]] \
      || die "$pointer_path must be a root-owned symbolic link before upgrade."
    pointer_target="$(readlink -- "$pointer_path")"
    validate_upgrade_pointer_target "$pointer_target"
    printf '%s\n' "$pointer_target" >"$UPGRADE_BACKUP/protected-state/$pointer_name.target"
    chmod 0600 "$UPGRADE_BACKUP/protected-state/$pointer_name.target"
    chown root:root "$UPGRADE_BACKUP/protected-state/$pointer_name.target"
  else
    install -o root -g root -m 0600 /dev/null \
      "$UPGRADE_BACKUP/protected-state/$pointer_name.absent"
  fi
}

backup_upgrade_protected_state() {
  local maintenance_path="$STATE_ROOT/maintenance"
  install -d -o root -g root -m 0700 "$UPGRADE_BACKUP/protected-state"
  backup_upgrade_revision_namespace
  backup_upgrade_pointer current
  backup_upgrade_pointer runtime
  if path_is_present "$maintenance_path"; then
    [[ -f "$maintenance_path" && ! -L "$maintenance_path" ]] \
      && [[ "$(stat -c '%u:%g:%a:%h' -- "$maintenance_path")" == 0:0:600:1 ]] \
      || die "$maintenance_path must be a root-owned, singly linked mode-0600 regular file."
    cp -a -- "$maintenance_path" "$UPGRADE_BACKUP/protected-state/maintenance.present"
  else
    install -o root -g root -m 0600 /dev/null \
      "$UPGRADE_BACKUP/protected-state/maintenance.absent"
  fi
  UPGRADE_STATE_BACKUP_READY=yes
}

validate_upgrade_backup_variant() {
  local base_path="$1"
  local present_suffix="$2"
  local absent_suffix="$3"
  local label="$4"
  local present_path="$base_path.$present_suffix"
  local absent_path="$base_path.$absent_suffix"
  local variant_count=0
  if path_is_present "$present_path"; then
    ((variant_count += 1))
    [[ -f "$present_path" && ! -L "$present_path" ]] \
      && [[ "$(stat -c '%u:%g:%a:%h' -- "$present_path")" == 0:0:600:1 ]] \
      || die "$label present journal is unsafe: $present_path"
  fi
  if path_is_present "$absent_path"; then
    ((variant_count += 1))
    [[ -f "$absent_path" && ! -L "$absent_path" ]] \
      && [[ "$(stat -c '%u:%g:%a:%h:%s' -- "$absent_path")" == 0:0:600:1:0 ]] \
      || die "$label absence journal is unsafe: $absent_path"
  fi
  (( variant_count == 1 )) \
    || die "$label journal must contain exactly one present/absent variant."
}

validate_upgrade_rollback_backup() {
  local protected_root="$UPGRADE_BACKUP/protected-state"
  local units_root="$UPGRADE_BACKUP/units"
  local revision_set="$protected_root/revision-set"
  local unexpected_entry pointer_name pointer_target unit_file unit_flag record_staging
  local record_staging_count=0
  [[ "$UPGRADE_BACKUP" =~ ^/var/backups/vpn-gateway/upgrade-[A-Za-z0-9]{10}$ ]] \
    || die "Upgrade rollback backup path is not canonical: $UPGRADE_BACKUP"
  [[ -d "$UPGRADE_BACKUP" && ! -L "$UPGRADE_BACKUP" ]] \
    && [[ "$(stat -c '%u:%g:%a' -- "$UPGRADE_BACKUP")" == 0:0:700 ]] \
    || die "Upgrade rollback backup is missing or unsafe: $UPGRADE_BACKUP"
  unexpected_entry="$(find "$UPGRADE_BACKUP" -mindepth 1 -maxdepth 1 \
    ! -name install-root \
    ! -name environment-root \
    ! -name units \
    ! -name rollback-metadata \
    ! -name protected-state \
    -print -quit)"
  [[ -z "$unexpected_entry" ]] \
    || die "Upgrade rollback backup contains an unexpected entry: $unexpected_entry"
  [[ -d "$protected_root" && ! -L "$protected_root" ]] \
    && [[ "$(stat -c '%u:%g:%a' -- "$protected_root")" == 0:0:700 ]] \
    || die "Upgrade protected-state backup is missing or unsafe."
  unexpected_entry="$(find "$protected_root" -mindepth 1 -maxdepth 1 \
    ! -name revisions-snapshot \
    ! -name revision-set \
    ! -name current.target \
    ! -name current.absent \
    ! -name runtime.target \
    ! -name runtime.absent \
    ! -name maintenance.present \
    ! -name maintenance.absent \
    ! -name failed-revision-namespace \
    ! -name '.failed-revision-namespace.*' \
    -print -quit)"
  [[ -z "$unexpected_entry" ]] \
    || die "Upgrade protected-state backup contains an unexpected entry: $unexpected_entry"
  while IFS= read -r -d '' record_staging; do
    [[ "${record_staging##*/}" =~ ^\.failed-revision-namespace\.[A-Za-z0-9]{10}$ ]] \
      || die "Upgrade protected-state backup contains an invalid record staging name."
    [[ -f "$record_staging" && ! -L "$record_staging" ]] \
      && [[ "$(stat -c '%u:%g:%a:%h' -- "$record_staging")" == 0:0:600:1 ]] \
      && [[ "$(stat -c '%s' -- "$record_staging")" -le 512 ]] \
      || die "Failed revision namespace staging record is unsafe: $record_staging"
    ((record_staging_count += 1))
  done < <(find "$protected_root" -mindepth 1 -maxdepth 1 \
    -name '.failed-revision-namespace.*' -print0)
  (( record_staging_count <= 1 )) \
    || die "Upgrade protected-state backup contains multiple staged namespace records."
  validate_upgrade_revision_namespace "$protected_root/revisions-snapshot" "$revision_set"
  for pointer_name in current runtime; do
    validate_upgrade_backup_variant "$protected_root/$pointer_name" target absent "Upgrade $pointer_name pointer"
    if [[ -f "$protected_root/$pointer_name.target" ]]; then
      pointer_target="$(read_upgrade_journal_line \
        "$protected_root/$pointer_name.target" \
        '^revisions/[0-9]{16}-[0-9a-f]{16}$' \
        "Upgrade $pointer_name pointer")"
      grep -Fxq -- "${pointer_target#revisions/}" "$revision_set" \
        || die "Upgrade $pointer_name pointer is absent from the protected revision set."
    fi
  done
  validate_upgrade_backup_variant "$protected_root/maintenance" present absent "Upgrade maintenance"
  if [[ -f "$protected_root/maintenance.present" ]]; then
    [[ "$(stat -c '%s' -- "$protected_root/maintenance.present")" -le $((64 * 1024)) ]] \
      || die "Upgrade maintenance backup exceeds its storage bound."
  fi
  load_upgrade_rollback_metadata
  if [[ "$UPGRADE_HAD_INSTALL_ROOT" == yes ]]; then
    validate_fixed_directory "$UPGRADE_BACKUP/install-root"
    [[ -d "$UPGRADE_BACKUP/install-root" ]] \
      || die "Upgrade metadata references a missing install-root backup."
  else
    ! path_is_present "$UPGRADE_BACKUP/install-root" \
      || die "Upgrade metadata marks install-root absent but a backup is present."
  fi
  if [[ "$UPGRADE_HAD_ENV_ROOT" == yes ]]; then
    validate_fixed_directory "$UPGRADE_BACKUP/environment-root"
    [[ -d "$UPGRADE_BACKUP/environment-root" ]] \
      || die "Upgrade metadata references a missing environment-root backup."
  else
    ! path_is_present "$UPGRADE_BACKUP/environment-root" \
      || die "Upgrade metadata marks environment-root absent but a backup is present."
  fi
  [[ -d "$units_root" && ! -L "$units_root" ]] \
    && [[ "$(stat -c '%u:%g:%a' -- "$units_root")" == 0:0:700 ]] \
    || die "Upgrade unit backup is missing or unsafe."
  unexpected_entry="$(find "$units_root" -mindepth 1 -maxdepth 1 \
    ! -name vpn-gateway.target \
    ! -name vpn-gateway-controller.service \
    ! -name vpn-gateway-sing-box.service \
    ! -name vpn-gateway-subscription.service \
    ! -name vpn-gateway-admin.service \
    ! -name vpn-gateway-tunnel.service \
    -print -quit)"
  [[ -z "$unexpected_entry" ]] \
    || die "Upgrade unit backup contains an unexpected entry: $unexpected_entry"
  for unit_file in "${UNIT_FILES[@]}"; do
    case "$unit_file" in
      vpn-gateway.target) unit_flag="$UPGRADE_HAD_UNIT_TARGET" ;;
      vpn-gateway-controller.service) unit_flag="$UPGRADE_HAD_UNIT_CONTROLLER" ;;
      vpn-gateway-sing-box.service) unit_flag="$UPGRADE_HAD_UNIT_SING_BOX" ;;
      vpn-gateway-subscription.service) unit_flag="$UPGRADE_HAD_UNIT_SUBSCRIPTION" ;;
      vpn-gateway-admin.service) unit_flag="$UPGRADE_HAD_UNIT_ADMIN" ;;
      vpn-gateway-tunnel.service) unit_flag="$UPGRADE_HAD_UNIT_TUNNEL" ;;
    esac
    if [[ "$unit_flag" == yes ]]; then
      validate_fixed_file "$units_root/$unit_file"
      [[ -f "$units_root/$unit_file" ]] \
        || die "Upgrade metadata references a missing unit backup: $unit_file"
    else
      ! path_is_present "$units_root/$unit_file" \
        || die "Upgrade metadata marks a unit absent but its backup is present: $unit_file"
    fi
  done
}

load_upgrade_rollback_journal() {
  local unexpected_entry completed_value quarantine_record rollback_backup
  [[ -d "$UPGRADE_ROLLBACK_JOURNAL" && ! -L "$UPGRADE_ROLLBACK_JOURNAL" ]] \
    && [[ "$(stat -c '%u:%g:%a' -- "$UPGRADE_ROLLBACK_JOURNAL")" == 0:0:700 ]] \
    || die "Upgrade rollback journal is missing or unsafe."
  unexpected_entry="$(find "$UPGRADE_ROLLBACK_JOURNAL" -mindepth 1 -maxdepth 1 \
    ! -name backup-path \
    ! -name restore-staging \
    ! -name quarantine-path \
    ! -name restored \
    ! -name completed \
    ! -name committed \
    -print -quit)"
  [[ -z "$unexpected_entry" ]] \
    || die "Upgrade rollback journal contains an unexpected entry: $unexpected_entry"
  UPGRADE_BACKUP="$(read_upgrade_journal_line \
    "$UPGRADE_ROLLBACK_JOURNAL/backup-path" \
    '^/var/backups/vpn-gateway/upgrade-[A-Za-z0-9]{10}$' \
    'Upgrade rollback backup path')"
  ROLLBACK_RESTORE_STAGING="$STATE_ROOT/$(read_upgrade_journal_line \
    "$UPGRADE_ROLLBACK_JOURNAL/restore-staging" \
    '^\.revisions-restore\.[A-Za-z0-9]{10}$' \
    'Upgrade rollback staging path')"
  ROLLBACK_QUARANTINE_PATH="$STATE_ROOT/$(read_upgrade_journal_line \
    "$UPGRADE_ROLLBACK_JOURNAL/quarantine-path" \
    '^\.failed-upgrade-revisions\.[A-Za-z0-9]{10}$' \
    'Upgrade rollback quarantine path')"
  [[ "$ROLLBACK_RESTORE_STAGING" != "$ROLLBACK_QUARANTINE_PATH" ]] \
    || die "Upgrade rollback journal aliases staging and quarantine paths."
  if path_is_present "$UPGRADE_ROLLBACK_JOURNAL/restored"; then
    completed_value="$(read_upgrade_journal_line \
      "$UPGRADE_ROLLBACK_JOURNAL/restored" '^restored$' \
      'Upgrade rollback restored-state marker')"
    [[ "$completed_value" == restored ]] \
      || die "Upgrade rollback restored-state marker is invalid."
  fi
  if path_is_present "$UPGRADE_ROLLBACK_JOURNAL/completed"; then
    completed_value="$(read_upgrade_journal_line \
      "$UPGRADE_ROLLBACK_JOURNAL/completed" '^complete$' \
      'Upgrade rollback completion marker')"
    [[ "$completed_value" == complete ]] \
      || die "Upgrade rollback completion marker is invalid."
  fi
  if path_is_present "$UPGRADE_ROLLBACK_JOURNAL/committed"; then
    completed_value="$(read_upgrade_journal_line \
      "$UPGRADE_ROLLBACK_JOURNAL/committed" '^commit$' \
      'Upgrade commit marker')"
    [[ "$completed_value" == commit ]] \
      || die "Upgrade commit marker is invalid."
  fi
  ! { path_is_present "$UPGRADE_ROLLBACK_JOURNAL/completed" \
      && path_is_present "$UPGRADE_ROLLBACK_JOURNAL/committed"; } \
    || die "Upgrade journal cannot be both committed and rolled back."
  ! { path_is_present "$UPGRADE_ROLLBACK_JOURNAL/restored" \
      && path_is_present "$UPGRADE_ROLLBACK_JOURNAL/committed"; } \
    || die "Committed upgrade journal cannot contain a restored-state marker."
  if path_is_present "$UPGRADE_ROLLBACK_JOURNAL/completed"; then
    path_is_present "$UPGRADE_ROLLBACK_JOURNAL/restored" \
      || die "Completed rollback journal is missing its restored-state marker."
  fi
  validate_upgrade_rollback_backup
  if path_is_present "$UPGRADE_RESTART_JOURNAL"; then
    rollback_backup="$UPGRADE_BACKUP"
    load_upgrade_restart_journal
    [[ "$UPGRADE_BACKUP" == "$rollback_backup" ]] \
      || die "Upgrade restart and rollback journals reference different backups."
  fi
  quarantine_record="$UPGRADE_BACKUP/protected-state/failed-revision-namespace"
  if path_is_present "$quarantine_record"; then
    [[ "$(read_upgrade_journal_line \
      "$quarantine_record" \
      '^/var/lib/vpn-gateway/\.failed-upgrade-revisions\.[A-Za-z0-9]{10}$' \
      'Failed revision namespace record')" == "$ROLLBACK_QUARANTINE_PATH" ]] \
      || die "Failed revision namespace record conflicts with the rollback journal."
  fi
  UPGRADE_STATE_BACKUP_READY=yes
}

write_upgrade_rollback_journal_value() {
  local journal_root="$1"
  local name="$2"
  local value="$3"
  local value_staging
  [[ "$name" =~ ^[a-z-]+$ ]] \
    || die "Upgrade rollback journal value name is invalid."
  ! path_is_present "$journal_root/$name" \
    || die "Upgrade rollback journal value already exists: $journal_root/$name"
  value_staging="$(mktemp "$STATE_ROOT/.upgrade-journal-value.XXXXXXXXXX")"
  chown root:root "$value_staging"
  chmod 0600 "$value_staging"
  printf '%s\n' "$value" >"$value_staging"
  sync -f "$value_staging"
  mv -T -- "$value_staging" "$journal_root/$name"
  sync -f "$journal_root"
  sync -f "$STATE_ROOT"
}

validate_upgrade_restart_backup() {
  [[ "$UPGRADE_BACKUP" =~ ^/var/backups/vpn-gateway/upgrade-[A-Za-z0-9]{10}$ ]] \
    || die "Upgrade restart backup path is not canonical: $UPGRADE_BACKUP"
  [[ -d "$UPGRADE_BACKUP" && ! -L "$UPGRADE_BACKUP" ]] \
    && [[ "$(stat -c '%u:%g:%a' -- "$UPGRADE_BACKUP")" == 0:0:700 ]] \
    || die "Upgrade restart backup is missing or unsafe: $UPGRADE_BACKUP"
  load_upgrade_rollback_metadata
}

load_upgrade_restart_journal() {
  local unexpected_entry
  [[ -d "$UPGRADE_RESTART_JOURNAL" && ! -L "$UPGRADE_RESTART_JOURNAL" ]] \
    && [[ "$(stat -c '%u:%g:%a' -- "$UPGRADE_RESTART_JOURNAL")" == 0:0:700 ]] \
    || die "Upgrade restart journal is missing or unsafe."
  unexpected_entry="$(find "$UPGRADE_RESTART_JOURNAL" -mindepth 1 -maxdepth 1 \
    ! -name backup-path -print -quit)"
  [[ -z "$unexpected_entry" ]] \
    || die "Upgrade restart journal contains an unexpected entry: $unexpected_entry"
  UPGRADE_BACKUP="$(read_upgrade_journal_line \
    "$UPGRADE_RESTART_JOURNAL/backup-path" \
    '^/var/backups/vpn-gateway/upgrade-[A-Za-z0-9]{10}$' \
    'Upgrade restart backup path')"
  validate_upgrade_restart_backup
}

prepare_upgrade_restart_journal() {
  local journal_staging
  ! path_is_present "$UPGRADE_RESTART_JOURNAL" \
    || die "An upgrade restart journal already exists. Re-run the installer to reconcile it first."
  validate_upgrade_restart_backup
  journal_staging="$(mktemp -d "$STATE_ROOT/.upgrade-restart-journal.XXXXXXXXXX")"
  chown root:root "$journal_staging"
  chmod 0700 "$journal_staging"
  write_upgrade_rollback_journal_value "$journal_staging" backup-path "$UPGRADE_BACKUP"
  sync -f "$UPGRADE_BACKUP"
  sync -f "$journal_staging"
  mv -T -- "$journal_staging" "$UPGRADE_RESTART_JOURNAL"
  sync -f "$STATE_ROOT"
  load_upgrade_restart_journal
}

retire_upgrade_restart_journal() {
  local retirement_path
  if ! path_is_present "$UPGRADE_RESTART_JOURNAL"; then
    return
  fi
  load_upgrade_restart_journal
  retirement_path="$(mktemp -d "$STATE_ROOT/.upgrade-restart-completed.XXXXXXXXXX")"
  rmdir -- "$retirement_path"
  mv -T -- "$UPGRADE_RESTART_JOURNAL" "$retirement_path"
  sync -f "$STATE_ROOT"
  [[ -d "$retirement_path" && ! -L "$retirement_path" ]] \
    && [[ "$(stat -c '%u:%g:%a' -- "$retirement_path")" == 0:0:700 ]] \
    || die "Completed upgrade restart journal became unsafe."
  rm -rf -- "$retirement_path"
  sync -f "$STATE_ROOT"
}

prepare_upgrade_rollback_journal() {
  local restore_staging="$1"
  local quarantine_path="$2"
  local journal_staging expected_backup="$UPGRADE_BACKUP"
  ! path_is_present "$UPGRADE_ROLLBACK_JOURNAL" \
    || die "An upgrade rollback journal already exists. Re-run the installer to reconcile it first."
  path_is_present "$UPGRADE_RESTART_JOURNAL" \
    || die "Upgrade rollback cannot begin without its durable restart journal."
  load_upgrade_restart_journal
  [[ "$UPGRADE_BACKUP" == "$expected_backup" ]] \
    || die "Upgrade restart and rollback journals reference different backups."
  validate_upgrade_rollback_backup
  [[ "$restore_staging" =~ ^$STATE_ROOT/\.revisions-restore\.[A-Za-z0-9]{10}$ ]] \
    || die "Upgrade rollback staging path is not canonical."
  [[ "$quarantine_path" =~ ^$STATE_ROOT/\.failed-upgrade-revisions\.[A-Za-z0-9]{10}$ ]] \
    || die "Upgrade rollback quarantine path is not canonical."
  [[ -d "$restore_staging" && ! -L "$restore_staging" ]] \
    || die "Upgrade rollback staging directory is missing or unsafe."
  ! path_is_present "$quarantine_path" \
    || die "Upgrade rollback quarantine destination already exists."
  journal_staging="$(mktemp -d "$STATE_ROOT/.upgrade-rollback-journal.XXXXXXXXXX")"
  chown root:root "$journal_staging"
  chmod 0700 "$journal_staging"
  write_upgrade_rollback_journal_value "$journal_staging" backup-path "$UPGRADE_BACKUP"
  write_upgrade_rollback_journal_value "$journal_staging" restore-staging "${restore_staging##*/}"
  write_upgrade_rollback_journal_value "$journal_staging" quarantine-path "${quarantine_path##*/}"
  sync -f "$UPGRADE_BACKUP"
  sync -f "$restore_staging"
  sync -f "$journal_staging"
  mv -T -- "$journal_staging" "$UPGRADE_ROLLBACK_JOURNAL"
  sync -f "$STATE_ROOT"
  load_upgrade_rollback_journal
}

begin_upgrade_rollback_transaction() {
  local backup_namespace="$UPGRADE_BACKUP/protected-state/revisions-snapshot"
  local revision_set="$UPGRADE_BACKUP/protected-state/revision-set"
  validate_upgrade_revision_namespace "$backup_namespace" "$revision_set"
  ROLLBACK_RESTORE_STAGING="$(mktemp -d "$STATE_ROOT/.revisions-restore.XXXXXXXXXX")"
  rmdir -- "$ROLLBACK_RESTORE_STAGING"
  ROLLBACK_QUARANTINE_PATH="$(mktemp -d "$STATE_ROOT/.failed-upgrade-revisions.XXXXXXXXXX")"
  rmdir -- "$ROLLBACK_QUARANTINE_PATH"
  prepare_upgrade_restore_staging
  prepare_upgrade_rollback_journal \
    "$ROLLBACK_RESTORE_STAGING" "$ROLLBACK_QUARANTINE_PATH"
}

validate_and_seal_upgrade_quarantine() {
  local quarantine_path="$1"
  local quarantine_mode
  [[ -d "$quarantine_path" && ! -L "$quarantine_path" ]] \
    && [[ "$(stat -c '%u:%g' -- "$quarantine_path")" == 0:0 ]] \
    || die "Upgrade rollback quarantine is missing or unsafe: $quarantine_path"
  reconcile_repository_revision_crash_artifacts "$quarantine_path"
  quarantine_mode="$(stat -c '%a' -- "$quarantine_path")"
  case "$quarantine_mode" in
    700)
      validate_upgrade_revision_namespace "$quarantine_path" "" 700
      ;;
    751)
      validate_upgrade_revision_namespace "$quarantine_path" "" 751
      chmod 0700 "$quarantine_path"
      sync -f "$quarantine_path"
      ;;
    *)
      die "Upgrade rollback quarantine has unsafe permissions: $quarantine_path"
      ;;
  esac
}

record_failed_upgrade_namespace() {
  local quarantine_path="$1"
  local quarantine_record="$UPGRADE_BACKUP/protected-state/failed-revision-namespace"
  local record_staging existing_value staged_value staging_count=0
  if path_is_present "$quarantine_record"; then
    existing_value="$(read_upgrade_journal_line \
      "$quarantine_record" \
      '^/var/lib/vpn-gateway/\.failed-upgrade-revisions\.[A-Za-z0-9]{10}$' \
      'Failed revision namespace record')"
    [[ "$existing_value" == "$quarantine_path" ]] \
      || die "Failed revision namespace record conflicts with the rollback transaction."
    return
  fi
  while IFS= read -r -d '' record_staging; do
    ((staging_count += 1))
    staged_value="$(<"$record_staging")"
    if [[ "$staged_value" != "$quarantine_path" ]] \
        || (( $(stat -c '%s' -- "$record_staging") != ${#staged_value} + 1 )); then
      rm -f -- "$record_staging"
      record_staging=""
      staging_count=0
    fi
  done < <(find "$UPGRADE_BACKUP/protected-state" -mindepth 1 -maxdepth 1 \
    -name '.failed-revision-namespace.*' -print0)
  (( staging_count <= 1 )) \
    || die "Multiple failed revision namespace staging records exist."
  if (( staging_count == 0 )); then
    record_staging="$(mktemp "$UPGRADE_BACKUP/protected-state/.failed-revision-namespace.XXXXXXXXXX")"
    chown root:root "$record_staging"
    chmod 0600 "$record_staging"
    printf '%s\n' "$quarantine_path" >"$record_staging"
    sync -f "$record_staging"
  fi
  mv -T -- "$record_staging" "$quarantine_record"
  sync -f "$UPGRADE_BACKUP/protected-state"
}

validate_partial_upgrade_restore_tree() {
  local partial_path="$1"
  local partial_name="${partial_path##*/}"
  local revision_path revision_id file_path file_name stat_record owner_id group_id permission_mode link_count file_size max_bytes
  local revision_count=0
  local total_bytes=0
  [[ "$partial_name" =~ ^\.revisions-restore-build\.[A-Za-z0-9]{10}\.[A-Za-z0-9]{10}$ \
      || "$partial_name" =~ ^\.revisions-restore-discard\.[A-Za-z0-9]{10}$ \
      || "$partial_name" =~ ^\.revisions-restore\.[A-Za-z0-9]{10}$ ]] \
    || die "Partial rollback staging path is not canonical: $partial_path"
  [[ -d "$partial_path" && ! -L "$partial_path" ]] \
    && [[ "$(stat -c '%u:%g' -- "$partial_path")" == 0:0 ]] \
    || die "Partial rollback staging directory is unsafe: $partial_path"
  permission_mode="$(stat -c '%a' -- "$partial_path")"
  [[ "$permission_mode" == 700 || "$permission_mode" == 751 ]] \
    || die "Partial rollback staging directory has unsafe permissions: $partial_path"
  while IFS= read -r -d '' revision_path; do
    revision_id="${revision_path##*/}"
    [[ "$revision_id" =~ ^[0-9]{16}-[0-9a-f]{16}$ ]] \
      || die "Partial rollback staging contains an unexpected entry: $revision_path"
    [[ -d "$revision_path" && ! -L "$revision_path" ]] \
      && [[ "$(stat -c '%u:%g' -- "$revision_path")" == 0:0 ]] \
      || die "Partial rollback revision directory is unsafe: $revision_path"
    permission_mode="$(stat -c '%a' -- "$revision_path")"
    [[ "$permission_mode" == 700 || "$permission_mode" == 751 ]] \
      || die "Partial rollback revision directory has unsafe permissions: $revision_path"
    while IFS= read -r -d '' file_path; do
      file_name="${file_path##*/}"
      [[ -f "$file_path" && ! -L "$file_path" ]] \
        || die "Partial rollback revision contains an unsafe entry: $file_path"
      stat_record="$(stat -c '%u:%g:%a:%h' -- "$file_path")"
      IFS=: read -r owner_id group_id permission_mode link_count <<<"$stat_record"
      [[ "$owner_id" == 0 && "$link_count" == 1 ]] \
        || die "Partial rollback revision file has unsafe ownership or links: $file_path"
      case "$file_name" in
        manifest.json)
          [[ "$group_id:$permission_mode" == 0:600 ]] \
            || die "Partial rollback manifest has unsafe permissions."
          max_bytes=$((64 * 1024))
          ;;
        state.json)
          [[ "$group_id:$permission_mode" == 0:600 ]] \
            || die "Partial rollback state has unsafe permissions."
          max_bytes=$((1024 * 1024))
          ;;
        sing-box.json)
          [[ "$group_id:$permission_mode" == "$RUNTIME_GID:640" \
              || "$group_id:$permission_mode" == 0:600 ]] \
            || die "Partial rollback runtime projection has unsafe permissions."
          max_bytes=$((4 * 1024 * 1024))
          ;;
        subscription-view.json)
          [[ "$group_id:$permission_mode" == "$SUB_GID_VALUE:640" \
              || "$group_id:$permission_mode" == 0:600 ]] \
            || die "Partial rollback subscription projection has unsafe permissions."
          max_bytes=$((1024 * 1024))
          ;;
        *) die "Partial rollback revision contains an unexpected entry: $file_path" ;;
      esac
      file_size="$(stat -c '%s' -- "$file_path")"
      if [[ ! "$file_size" =~ ^[0-9]+$ ]] || (( file_size > max_bytes )); then
        die "Partial rollback revision file exceeds its storage bound: $file_path"
      fi
      total_bytes=$((total_bytes + file_size))
    done < <(find "$revision_path" -mindepth 1 -maxdepth 1 -print0)
    (( revision_count += 1 ))
    (( revision_count <= MAX_UPGRADE_REVISIONS \
        && total_bytes <= MAX_UPGRADE_REVISION_BYTES )) \
      || die "Partial rollback staging exceeds the supported snapshot budget."
  done < <(find "$partial_path" -mindepth 1 -maxdepth 1 -print0)
}

remove_partial_upgrade_restore_tree() {
  local partial_path="$1"
  validate_partial_upgrade_restore_tree "$partial_path"
  chmod 0700 "$partial_path"
  rm -rf -- "$partial_path"
  sync -f "$STATE_ROOT"
}

partial_upgrade_restore_matches_snapshot() {
  local partial_path="$1"
  local backup_namespace="$UPGRADE_BACKUP/protected-state/revisions-snapshot"
  local revision_set="$UPGRADE_BACKUP/protected-state/revision-set"
  local revision_id file_name actual_count=0 expected_count=0
  local -a partial_entries=()
  validate_partial_upgrade_restore_tree "$partial_path"
  mapfile -d '' -t partial_entries \
    < <(find "$partial_path" -mindepth 1 -maxdepth 1 -print0)
  actual_count="${#partial_entries[@]}"
  while IFS= read -r revision_id; do
    ((expected_count += 1))
    [[ -d "$partial_path/$revision_id" && ! -L "$partial_path/$revision_id" ]] \
      || return 1
    for file_name in manifest.json state.json sing-box.json subscription-view.json; do
      [[ -f "$partial_path/$revision_id/$file_name" \
          && ! -L "$partial_path/$revision_id/$file_name" ]] \
        || return 1
      cmp -s -- \
        "$backup_namespace/$revision_id/$file_name" \
        "$partial_path/$revision_id/$file_name" \
        || return 1
    done
  done <"$revision_set"
  [[ "$actual_count" == "$expected_count" ]]
}

retire_partial_upgrade_restore_tree() {
  local partial_path="$1"
  local discard_path
  validate_partial_upgrade_restore_tree "$partial_path"
  discard_path="$(mktemp -d "$STATE_ROOT/.revisions-restore-discard.XXXXXXXXXX")"
  rmdir -- "$discard_path"
  mv -T -- "$partial_path" "$discard_path"
  sync -f "$STATE_ROOT"
  remove_partial_upgrade_restore_tree "$discard_path"
}

reconcile_partial_upgrade_restore_builds() {
  local restore_token="${ROLLBACK_RESTORE_STAGING##*.}"
  local partial_path
  [[ "$restore_token" =~ ^[A-Za-z0-9]{10}$ ]] \
    || die "Upgrade rollback staging token is invalid."
  while IFS= read -r -d '' partial_path; do
    remove_partial_upgrade_restore_tree "$partial_path"
  done < <(find "$STATE_ROOT" -mindepth 1 -maxdepth 1 \
    -name ".revisions-restore-build.$restore_token.*" -print0)
  while IFS= read -r -d '' partial_path; do
    remove_partial_upgrade_restore_tree "$partial_path"
  done < <(find "$STATE_ROOT" -mindepth 1 -maxdepth 1 \
    -name '.revisions-restore-discard.*' -print0)
}

prepare_upgrade_restore_staging() {
  local backup_namespace="$UPGRADE_BACKUP/protected-state/revisions-snapshot"
  local revision_set="$UPGRADE_BACKUP/protected-state/revision-set"
  local restore_token="${ROLLBACK_RESTORE_STAGING##*.}"
  local build_path
  if path_is_present "$ROLLBACK_RESTORE_STAGING"; then
    if partial_upgrade_restore_matches_snapshot "$ROLLBACK_RESTORE_STAGING"; then
      chmod 0751 "$ROLLBACK_RESTORE_STAGING"
      compare_upgrade_revision_namespaces \
        "$backup_namespace" "$ROLLBACK_RESTORE_STAGING" "$revision_set"
      return
    fi
    retire_partial_upgrade_restore_tree "$ROLLBACK_RESTORE_STAGING"
  fi
  reconcile_partial_upgrade_restore_builds
  build_path="$(mktemp -d "$STATE_ROOT/.revisions-restore-build.$restore_token.XXXXXXXXXX")"
  chown root:root "$build_path"
  chmod 0700 "$build_path"
  cp -a -- "$backup_namespace/." "$build_path/"
  chmod 0751 "$build_path"
  compare_upgrade_revision_namespaces \
    "$backup_namespace" "$build_path" "$revision_set"
  sync -f "$build_path"
  ! path_is_present "$ROLLBACK_RESTORE_STAGING" \
    || die "Upgrade rollback staging appeared while its atomic replacement was built."
  mv -T -- "$build_path" "$ROLLBACK_RESTORE_STAGING"
  sync -f "$STATE_ROOT"
  compare_upgrade_revision_namespaces \
    "$backup_namespace" "$ROLLBACK_RESTORE_STAGING" "$revision_set"
}

retire_upgrade_restore_staging() {
  local backup_namespace="$UPGRADE_BACKUP/protected-state/revisions-snapshot"
  local revision_set="$UPGRADE_BACKUP/protected-state/revision-set"
  local discard_path
  [[ -d "$ROLLBACK_RESTORE_STAGING" && ! -L "$ROLLBACK_RESTORE_STAGING" ]] \
    || die "Rollback staging path is missing or unsafe before retirement."
  compare_upgrade_revision_namespaces \
    "$backup_namespace" "$ROLLBACK_RESTORE_STAGING" "$revision_set"
  discard_path="$(mktemp -d "$STATE_ROOT/.revisions-restore-discard.XXXXXXXXXX")"
  rmdir -- "$discard_path"
  mv -T -- "$ROLLBACK_RESTORE_STAGING" "$discard_path"
  sync -f "$STATE_ROOT"
  [[ -d "$discard_path" && ! -L "$discard_path" ]] \
    && [[ "$(stat -c '%u:%g:%a' -- "$discard_path")" == 0:0:751 ]] \
    || die "Rollback staging retirement became unsafe."
  chmod 0700 "$discard_path"
  rm -rf -- "$discard_path"
  sync -f "$STATE_ROOT"
}

reconcile_upgrade_revision_namespace() {
  local live_namespace="$STATE_ROOT/revisions"
  local backup_namespace="$UPGRADE_BACKUP/protected-state/revisions-snapshot"
  local revision_set="$UPGRADE_BACKUP/protected-state/revision-set"
  local live_mode
  validate_upgrade_revision_namespace "$backup_namespace" "$revision_set"

  if path_is_present "$live_namespace"; then
    [[ -d "$live_namespace" && ! -L "$live_namespace" ]] \
      && [[ "$(stat -c '%u:%g' -- "$live_namespace")" == 0:0 ]] \
      || die "Refusing an unsafe live revision namespace during rollback recovery."
    reconcile_repository_revision_crash_artifacts "$live_namespace"
    live_mode="$(stat -c '%a' -- "$live_namespace")"
    case "$live_mode" in
      700)
        validate_upgrade_revision_namespace "$live_namespace" "" 700
        chmod 0751 "$live_namespace"
        sync -f "$live_namespace"
        ;;
      751)
        validate_upgrade_revision_namespace "$live_namespace"
        ;;
      *)
        die "Refusing a live revision namespace with unsafe permissions during rollback recovery."
        ;;
    esac
    if ! upgrade_revision_namespaces_match "$live_namespace" "$backup_namespace" "$revision_set"; then
      ! path_is_present "$ROLLBACK_QUARANTINE_PATH" \
        || die "Rollback found both an unrestored live namespace and an occupied quarantine path."
      mv -T -- "$live_namespace" "$ROLLBACK_QUARANTINE_PATH"
      sync -f "$STATE_ROOT"
      validate_and_seal_upgrade_quarantine "$ROLLBACK_QUARANTINE_PATH"
    fi
  else
    path_is_present "$ROLLBACK_QUARANTINE_PATH" \
      || die "Rollback journal found neither the live nor quarantined revision namespace."
    validate_and_seal_upgrade_quarantine "$ROLLBACK_QUARANTINE_PATH"
  fi

  if ! path_is_present "$live_namespace"; then
    prepare_upgrade_restore_staging
    mv -T -- "$ROLLBACK_RESTORE_STAGING" "$live_namespace"
    sync -f "$STATE_ROOT"
  fi
  upgrade_revision_namespaces_match "$live_namespace" "$backup_namespace" "$revision_set" \
    || die "Rollback could not publish the exact pre-upgrade revision namespace."

  if path_is_present "$ROLLBACK_RESTORE_STAGING"; then
    retire_upgrade_restore_staging
  fi
  if ! path_is_present "$ROLLBACK_QUARANTINE_PATH"; then
    install -d -o root -g root -m 0700 "$ROLLBACK_QUARANTINE_PATH"
    sync -f "$STATE_ROOT"
  else
    validate_and_seal_upgrade_quarantine "$ROLLBACK_QUARANTINE_PATH"
  fi
  record_failed_upgrade_namespace "$ROLLBACK_QUARANTINE_PATH"
}

restore_upgrade_revision_namespace() {
  local backup_namespace="$UPGRADE_BACKUP/protected-state/revisions-snapshot"
  local revision_set="$UPGRADE_BACKUP/protected-state/revision-set"
  validate_upgrade_revision_namespace "$backup_namespace" "$revision_set"
  path_is_present "$UPGRADE_ROLLBACK_JOURNAL" \
    || die "Protected-state rollback requires its durable rollback journal."
  load_upgrade_rollback_journal
  reconcile_upgrade_revision_namespace
}

restore_upgrade_pointer() {
  local pointer_name="$1"
  local pointer_path="$STATE_ROOT/$pointer_name"
  local target_file="$UPGRADE_BACKUP/protected-state/$pointer_name.target"
  local absent_file="$UPGRADE_BACKUP/protected-state/$pointer_name.absent"
  local pointer_target restore_staging
  if [[ -f "$target_file" && ! -L "$target_file" ]] \
      && [[ "$(stat -c '%u:%a:%h' -- "$target_file")" == 0:600:1 ]]; then
    pointer_target="$(<"$target_file")"
    [[ "$pointer_target" =~ ^revisions/[0-9]{16}-[0-9a-f]{16}$ ]] \
      || die "Upgrade pointer journal is invalid: $target_file"
    validate_upgrade_revision "$STATE_ROOT/$pointer_target"
    grep -Fxq -- "${pointer_target#revisions/}" \
      "$UPGRADE_BACKUP/protected-state/revision-set" \
      || die "Upgrade pointer target is absent from the restored revision set: $pointer_target"
    if path_is_present "$pointer_path"; then
      [[ -L "$pointer_path" && "$(stat -c '%u' -- "$pointer_path")" == 0 ]] \
        || die "Refusing to replace unsafe pointer during rollback: $pointer_path"
    fi
    restore_staging="$(mktemp -d "$STATE_ROOT/.pointer-restore.XXXXXXXXXX")"
    chmod 0700 "$restore_staging"
    ln -s -- "$pointer_target" "$restore_staging/$pointer_name"
    mv -T -- "$restore_staging/$pointer_name" "$pointer_path"
    rmdir -- "$restore_staging"
    sync -f "$STATE_ROOT"
  elif [[ -f "$absent_file" && ! -L "$absent_file" ]] \
      && [[ "$(stat -c '%u:%a:%h' -- "$absent_file")" == 0:600:1 ]]; then
    if path_is_present "$pointer_path"; then
      [[ -L "$pointer_path" && "$(stat -c '%u' -- "$pointer_path")" == 0 ]] \
        || die "Refusing to remove unsafe pointer during rollback: $pointer_path"
      rm -f -- "$pointer_path"
      sync -f "$STATE_ROOT"
    fi
  else
    die "Upgrade pointer journal is missing or unsafe for $pointer_name."
  fi
}

restore_upgrade_protected_state() {
  local maintenance_path="$STATE_ROOT/maintenance"
  local maintenance_staging
  [[ "$UPGRADE_STATE_BACKUP_READY" == yes ]] || return 0
  restore_upgrade_revision_namespace
  restore_upgrade_pointer current
  restore_upgrade_pointer runtime
  if [[ -f "$UPGRADE_BACKUP/protected-state/maintenance.present" ]] \
      && [[ ! -L "$UPGRADE_BACKUP/protected-state/maintenance.present" ]] \
      && [[ "$(stat -c '%u:%g:%a:%h' -- "$UPGRADE_BACKUP/protected-state/maintenance.present")" == 0:0:600:1 ]]; then
    if path_is_present "$maintenance_path"; then
      [[ -f "$maintenance_path" && ! -L "$maintenance_path" ]] \
        && [[ "$(stat -c '%u:%g:%a:%h' -- "$maintenance_path")" == 0:0:600:1 ]] \
        || die "Refusing to replace an unsafe maintenance marker during rollback."
    fi
    maintenance_staging="$(mktemp "$STATE_ROOT/.maintenance-restore.XXXXXXXXXX")"
    install -o root -g root -m 0600 \
      "$UPGRADE_BACKUP/protected-state/maintenance.present" "$maintenance_staging"
    mv -T -- "$maintenance_staging" "$maintenance_path"
    sync -f "$STATE_ROOT"
  elif [[ -f "$UPGRADE_BACKUP/protected-state/maintenance.absent" ]] \
      && [[ ! -L "$UPGRADE_BACKUP/protected-state/maintenance.absent" ]] \
      && [[ "$(stat -c '%u:%a:%h' -- "$UPGRADE_BACKUP/protected-state/maintenance.absent")" == 0:600:1 ]]; then
    if path_is_present "$maintenance_path"; then
      [[ -f "$maintenance_path" && ! -L "$maintenance_path" ]] \
        && [[ "$(stat -c '%u:%g:%a:%h' -- "$maintenance_path")" == 0:0:600:1 ]] \
        || die "Refusing to remove an unsafe maintenance marker during rollback."
      rm -f -- "$maintenance_path"
      sync -f "$STATE_ROOT"
    fi
  else
    die "Upgrade maintenance journal is missing or unsafe."
  fi
}

restore_upgrade_deployment_files() {
  local unit_file
  validate_upgrade_rollback_backup
  validate_fixed_directory "$INSTALL_ROOT"
  validate_fixed_directory "$ENV_ROOT"
  for unit_file in "${UNIT_FILES[@]}"; do
    validate_fixed_file "$SYSTEMD_ROOT/$unit_file"
  done
  rm -rf -- "$INSTALL_ROOT"
  if [[ "$UPGRADE_HAD_INSTALL_ROOT" == yes ]]; then
    cp -a -- "$UPGRADE_BACKUP/install-root" "$INSTALL_ROOT"
  fi
  rm -rf -- "$ENV_ROOT"
  if [[ "$UPGRADE_HAD_ENV_ROOT" == yes ]]; then
    cp -a -- "$UPGRADE_BACKUP/environment-root" "$ENV_ROOT"
  fi
  for unit_file in "${UNIT_FILES[@]}"; do
    rm -f -- "$SYSTEMD_ROOT/$unit_file"
    if [[ -f "$UPGRADE_BACKUP/units/$unit_file" ]]; then
      cp -a -- "$UPGRADE_BACKUP/units/$unit_file" "$SYSTEMD_ROOT/$unit_file"
    fi
  done
  sync -f /opt
  sync -f /etc
  systemctl daemon-reload
}

restore_upgrade_enablement() {
  local restored_target_state restored_singbox_state
  if [[ "$UPGRADE_WAS_ENABLED" == yes ]]; then
    systemctl enable vpn-gateway.target
  else
    systemctl disable vpn-gateway.target
  fi
  if [[ "$UPGRADE_SINGBOX_WAS_ENABLED" == yes ]]; then
    systemctl enable vpn-gateway-sing-box.service
  else
    systemctl disable vpn-gateway-sing-box.service
  fi
  sync -f "$SYSTEMD_ROOT"
  if [[ -d "$SYSTEMD_ROOT/multi-user.target.wants" \
      && ! -L "$SYSTEMD_ROOT/multi-user.target.wants" ]]; then
    sync -f "$SYSTEMD_ROOT/multi-user.target.wants"
  fi
  restored_target_state="$(query_upgrade_enablement vpn-gateway.target no)"
  if [[ "$UPGRADE_WAS_ENABLED" == yes ]]; then
    [[ "$restored_target_state" == enabled ]] \
      || die "Could not restore the target's enabled state."
  else
    [[ "$restored_target_state" == disabled ]] \
      || die "Could not restore the target's disabled state."
  fi
  restored_singbox_state="$(query_upgrade_enablement vpn-gateway-sing-box.service yes)"
  if [[ "$UPGRADE_SINGBOX_WAS_ENABLED" == yes ]]; then
    [[ "$restored_singbox_state" == enabled ]] \
      || die "Could not restore sing-box service enablement."
  else
    [[ "$restored_singbox_state" == disabled || "$restored_singbox_state" == static ]] \
      || die "Could not restore sing-box service disablement."
  fi
}

query_upgrade_enablement() {
  local unit_name="$1"
  local allow_static="$2"
  local allow_not_found="${3:-no}"
  local query_output query_status
  set +e
  query_output="$(systemctl is-enabled "$unit_name" 2>/dev/null)"
  query_status=$?
  set -e
  case "$query_output" in
    enabled)
      (( query_status == 0 )) \
        || die "systemd returned an inconsistent enabled state for $unit_name."
      ;;
    disabled)
      (( query_status != 0 )) \
        || die "systemd returned an inconsistent disabled state for $unit_name."
      ;;
    static)
      [[ "$allow_static" == yes ]] \
        || die "$unit_name is unexpectedly static; repair its unit installation before retrying."
      ;;
    not-found)
      [[ "$allow_not_found" == yes && "$query_status" -ne 0 ]] \
        || die "$unit_name unexpectedly has no installed unit."
      ;;
    *)
      die "Could not determine a supported enablement state for $unit_name (status $query_status, state ${query_output:-empty})."
      ;;
  esac
  printf '%s\n' "$query_output"
}

query_unit_active_state() {
  local unit_name="$1"
  local allow_not_found="${2:-no}"
  local query_output query_status
  set +e
  query_output="$(systemctl is-active "$unit_name" 2>/dev/null)"
  query_status=$?
  set -e
  case "$query_output" in
    active)
      (( query_status == 0 )) \
        || die "systemd returned an inconsistent active state for $unit_name."
      ;;
    inactive|failed)
      (( query_status != 0 )) \
        || die "systemd returned an inconsistent inactive state for $unit_name."
      ;;
    unknown)
      [[ "$allow_not_found" == yes && "$query_status" -ne 0 ]] \
        || die "$unit_name unexpectedly has no loaded unit."
      ;;
    *)
      die "Could not determine a stable active state for $unit_name (status $query_status, state ${query_output:-empty})."
      ;;
  esac
  printf '%s\n' "$query_output"
}

hold_upgrade_services_disabled() {
  local allow_not_found="${1:-no}"
  local target_state singbox_state unit_name enablement_link
  # The journal is already durable before this point. Holding both possible
  # boot entry points disabled prevents a reboot from starting a half-written
  # deployment; manual start for acceptance remains possible while disabled.
  # Remove the two canonical links explicitly as well: a power loss between
  # removing a unit file and restoring it can make systemctl report not-found
  # while a dangling enablement link is still waiting to become live again.
  for unit_name in vpn-gateway.target vpn-gateway-sing-box.service; do
    enablement_link="$SYSTEMD_ROOT/multi-user.target.wants/$unit_name"
    if path_is_present "$enablement_link"; then
      [[ -L "$enablement_link" && "$(stat -c '%u' -- "$enablement_link")" == 0 ]] \
        || die "Refusing unsafe upgrade enablement entry: $enablement_link"
      rm -f -- "$enablement_link"
    fi
  done
  target_state="$(query_upgrade_enablement vpn-gateway.target no "$allow_not_found")"
  if [[ "$target_state" == enabled ]]; then
    systemctl disable vpn-gateway.target >/dev/null 2>&1 \
      || die "Could not disable vpn-gateway.target before upgrade mutation."
    target_state="$(query_upgrade_enablement vpn-gateway.target no "$allow_not_found")"
  fi
  singbox_state="$(query_upgrade_enablement vpn-gateway-sing-box.service yes "$allow_not_found")"
  if [[ "$singbox_state" == enabled ]]; then
    systemctl disable vpn-gateway-sing-box.service >/dev/null 2>&1 \
      || die "Could not disable vpn-gateway-sing-box.service before upgrade mutation."
    singbox_state="$(query_upgrade_enablement vpn-gateway-sing-box.service yes "$allow_not_found")"
  fi
  [[ "$target_state" == disabled \
      || ( "$allow_not_found" == yes && "$target_state" == not-found ) ]] \
    || die "vpn-gateway.target remained enabled while preparing the upgrade."
  [[ "$singbox_state" == disabled || "$singbox_state" == static \
      || ( "$allow_not_found" == yes && "$singbox_state" == not-found ) ]] \
    || die "vpn-gateway-sing-box.service remained enabled while preparing the upgrade."
  sync -f "$SYSTEMD_ROOT"
  if [[ -d "$SYSTEMD_ROOT/multi-user.target.wants" \
      && ! -L "$SYSTEMD_ROOT/multi-user.target.wants" ]]; then
    sync -f "$SYSTEMD_ROOT/multi-user.target.wants"
  fi
}

hold_migration_target_disabled() {
  local target_state
  target_state="$(query_upgrade_enablement vpn-gateway.target no yes)"
  if [[ "$target_state" == enabled ]]; then
    systemctl disable vpn-gateway.target >/dev/null 2>&1 \
      || die "Could not keep vpn-gateway.target disabled during legacy migration."
    target_state="$(query_upgrade_enablement vpn-gateway.target no yes)"
  fi
  [[ "$target_state" == disabled || "$target_state" == not-found ]] \
    || die "vpn-gateway.target is not safely disabled during legacy migration."
  sync -f "$SYSTEMD_ROOT"
  if [[ -d "$SYSTEMD_ROOT/multi-user.target.wants" \
      && ! -L "$SYSTEMD_ROOT/multi-user.target.wants" ]]; then
    sync -f "$SYSTEMD_ROOT/multi-user.target.wants"
  fi
}

quiesce_upgrade_services_for_rollback() {
  local service_name
  local -a service_names=(
    vpn-gateway.target \
    vpn-gateway-controller.service \
    vpn-gateway-sing-box.service \
    vpn-gateway-subscription.service \
    vpn-gateway-admin.service
  )
  for service_name in "${service_names[@]}"; do
    # A power loss while deployment files are being restored can leave one of
    # these unit files absent. Missing is conclusively non-running and must not
    # prevent the durable journal from restoring the file on the next pass.
    stop_unit_if_active_strict "$service_name" yes
  done
  stop_unit_if_active_strict vpn-gateway-tunnel.service yes
}

restart_and_verify_restored_upgrade() {
  local service_name active_state
  local -a service_names=(
    vpn-gateway.target
    vpn-gateway-controller.service
    vpn-gateway-sing-box.service
    vpn-gateway-subscription.service
    vpn-gateway-admin.service
  )
  [[ "$UPGRADE_WAS_ACTIVE" == yes ]] || return 0
  systemctl start vpn-gateway.target \
    || die "The previous deployment was restored but could not be restarted."
  if [[ "$UPGRADE_HAD_UNIT_TUNNEL" == yes ]]; then
    service_names+=(vpn-gateway-tunnel.service)
  fi
  for service_name in "${service_names[@]}"; do
    active_state="$(query_unit_active_state "$service_name")"
    [[ "$active_state" == active ]] \
      || die "The previous deployment restart left $service_name inactive; rollback journal retained."
  done
}

stop_unit_if_active_strict() {
  local unit_name="$1"
  local allow_not_found="${2:-no}"
  local active_state
  active_state="$(query_unit_active_state "$unit_name" "$allow_not_found")"
  if [[ "$active_state" == active ]]; then
    systemctl stop "$unit_name"
  fi
  active_state="$(query_unit_active_state "$unit_name" "$allow_not_found")"
  [[ "$active_state" == inactive || "$active_state" == failed || "$active_state" == unknown ]] \
    || die "$unit_name did not reach a conclusively stopped state."
}

restore_legacy_service_state() {
  local unit_name="$1"
  local was_active="$2"
  local was_enabled="$3"
  local active_state enablement_state
  if [[ "$was_enabled" == yes ]]; then
    systemctl enable "$unit_name"
  fi
  if [[ "$was_active" == yes ]]; then
    systemctl start "$unit_name"
  else
    stop_unit_if_active_strict "$unit_name"
  fi
  active_state="$(query_unit_active_state "$unit_name")"
  enablement_state="$(query_upgrade_enablement "$unit_name" yes yes)"
  if [[ "$was_active" == yes ]]; then
    [[ "$active_state" == active ]] \
      || die "$unit_name was active before migration but could not be restored."
  else
    [[ "$active_state" == inactive || "$active_state" == failed ]] \
      || die "$unit_name was inactive before migration but became active."
  fi
  if [[ "$was_enabled" == yes ]]; then
    [[ "$enablement_state" == enabled ]] \
      || die "$unit_name was enabled before migration but could not be restored."
  else
    [[ "$enablement_state" != enabled ]] \
      || die "$unit_name was disabled before migration but became enabled."
  fi
}

cleanup_unjournaled_upgrade_restore_artifacts() {
  local partial_path
  while IFS= read -r -d '' partial_path; do
    remove_partial_upgrade_restore_tree "$partial_path"
  done < <(find "$STATE_ROOT" -mindepth 1 -maxdepth 1 \
    \( -name '.revisions-restore.*' \
       -o -name '.revisions-restore-build.*' \
       -o -name '.revisions-restore-discard.*' \) -print0)
}

recover_interrupted_upgrade_restart() {
  [[ "$UPGRADE_RESTART_RECOVERY_REQUIRED" == yes \
      && "$UPGRADE_ROLLBACK_RECOVERY_REQUIRED" != yes ]] || return 0
  echo "==> Recovering an upgrade interrupted before protected-state handoff"
  load_upgrade_restart_journal
  quiesce_upgrade_services_for_rollback
  cleanup_unjournaled_upgrade_restore_artifacts
  restore_upgrade_enablement
  restart_and_verify_restored_upgrade
  retire_upgrade_restart_journal
  echo "==> Pre-handoff upgrade interruption reconciled; beginning a fresh upgrade attempt"
  UPGRADE_WAS_ACTIVE=no
  UPGRADE_WAS_ENABLED=no
  UPGRADE_SINGBOX_WAS_ENABLED=no
  UPGRADE_STOPPED=no
  UPGRADE_BACKUP=""
}

archive_completed_upgrade_rollback_journal() {
  local completed_value
  load_upgrade_rollback_journal
  completed_value="$(read_upgrade_journal_line \
    "$UPGRADE_ROLLBACK_JOURNAL/completed" '^complete$' \
    'Upgrade rollback completion marker')"
  [[ "$completed_value" == complete ]] \
    || die "Upgrade rollback completion marker is invalid."
  validate_and_seal_upgrade_quarantine "$ROLLBACK_QUARANTINE_PATH"
  retire_upgrade_restart_journal
  ! path_is_present "$ROLLBACK_QUARANTINE_PATH/.rollback-journal" \
    || die "Upgrade rollback quarantine already contains a completed journal."
  mv -T -- "$UPGRADE_ROLLBACK_JOURNAL" \
    "$ROLLBACK_QUARANTINE_PATH/.rollback-journal"
  sync -f "$ROLLBACK_QUARANTINE_PATH"
  sync -f "$STATE_ROOT"
}

mark_upgrade_rollback_restored() {
  if path_is_present "$UPGRADE_ROLLBACK_JOURNAL/restored"; then
    [[ "$(read_upgrade_journal_line \
      "$UPGRADE_ROLLBACK_JOURNAL/restored" '^restored$' \
      'Upgrade rollback restored-state marker')" == restored ]] \
      || die "Upgrade rollback restored-state marker is invalid."
    return
  fi
  write_upgrade_rollback_journal_value \
    "$UPGRADE_ROLLBACK_JOURNAL" restored restored
  sync -f "$UPGRADE_ROLLBACK_JOURNAL"
}

complete_upgrade_rollback_journal() {
  path_is_present "$UPGRADE_ROLLBACK_JOURNAL/restored" \
    || die "Rollback cannot complete before restored state is durable."
  ! path_is_present "$UPGRADE_ROLLBACK_JOURNAL/completed" \
    || die "Upgrade rollback completion marker already exists unexpectedly."
  write_upgrade_rollback_journal_value \
    "$UPGRADE_ROLLBACK_JOURNAL" completed complete
  sync -f "$UPGRADE_ROLLBACK_JOURNAL"
  archive_completed_upgrade_rollback_journal
}

rollback_active_upgrade_transaction() {
  load_upgrade_rollback_journal
  # Do not let a reboot start the restored predecessor until both its exact
  # protected state and its code/configuration are durable and the journal says
  # so. The predecessor may predate this installer's controller-side mutation
  # gate, so boot disablement—not old application behavior—is the invariant.
  hold_upgrade_services_disabled yes
  quiesce_upgrade_services_for_rollback
  if path_is_present "$UPGRADE_ROLLBACK_JOURNAL/restored"; then
    # The exact old namespace and deployment files were durable before this
    # marker. Do not discard revisions legitimately appended by the restored
    # controller if the machine crashed after its restart.
    restore_upgrade_deployment_files
  else
    restore_upgrade_protected_state
    restore_upgrade_deployment_files
    mark_upgrade_rollback_restored
  fi
  restore_upgrade_enablement
  restart_and_verify_restored_upgrade
  complete_upgrade_rollback_journal
}

archive_committed_upgrade_journal() {
  local committed_value retirement_path backup_token
  load_upgrade_rollback_journal
  committed_value="$(read_upgrade_journal_line \
    "$UPGRADE_ROLLBACK_JOURNAL/committed" '^commit$' \
    'Upgrade commit marker')"
  [[ "$committed_value" == commit ]] \
    || die "Upgrade commit marker is invalid."
  ! path_is_present "$ROLLBACK_RESTORE_STAGING" \
    || die "Committed upgrade journal still references rollback staging."
  ! path_is_present "$ROLLBACK_QUARANTINE_PATH" \
    || die "Committed upgrade journal unexpectedly references a quarantine namespace."
  retire_upgrade_restart_journal
  backup_token="${UPGRADE_BACKUP##*/upgrade-}"
  [[ "$backup_token" =~ ^[A-Za-z0-9]{10}$ ]] \
    || die "Committed upgrade journal has an invalid backup token."
  retirement_path="$STATE_ROOT/.upgrade-rollback-retired.$backup_token"
  ! path_is_present "$retirement_path" \
    || die "Committed upgrade journal retirement path is already occupied."
  mv -T -- "$UPGRADE_ROLLBACK_JOURNAL" "$retirement_path"
  sync -f "$STATE_ROOT"
  [[ -d "$retirement_path" && ! -L "$retirement_path" ]] \
    && [[ "$(stat -c '%u:%g:%a' -- "$retirement_path")" == 0:0:700 ]] \
    || die "Committed upgrade journal retirement became unsafe."
  rm -rf -- "$retirement_path"
  sync -f "$STATE_ROOT"
}

commit_upgrade_rollback_transaction() {
  local backup_namespace="$UPGRADE_BACKUP/protected-state/revisions-snapshot"
  local revision_set="$UPGRADE_BACKUP/protected-state/revision-set"
  load_upgrade_rollback_journal
  [[ -d "$ROLLBACK_RESTORE_STAGING" && ! -L "$ROLLBACK_RESTORE_STAGING" ]] \
    || die "Upgrade commit found missing or unsafe rollback staging."
  compare_upgrade_revision_namespaces \
    "$backup_namespace" "$ROLLBACK_RESTORE_STAGING" "$revision_set"
  retire_upgrade_restore_staging
  ! path_is_present "$ROLLBACK_QUARANTINE_PATH" \
    || die "Upgrade commit found an unexpected rollback quarantine."
  write_upgrade_rollback_journal_value \
    "$UPGRADE_ROLLBACK_JOURNAL" committed commit
  sync -f "$UPGRADE_ROLLBACK_JOURNAL"
  archive_committed_upgrade_journal
}

recover_interrupted_upgrade_rollback() {
  [[ "$UPGRADE_ROLLBACK_RECOVERY_REQUIRED" == yes ]] || return 0
  echo "==> Reconciling an interrupted upgrade rollback before normal deployment"
  load_upgrade_rollback_journal
  if path_is_present "$UPGRADE_ROLLBACK_JOURNAL/committed"; then
    archive_committed_upgrade_journal
  elif path_is_present "$UPGRADE_ROLLBACK_JOURNAL/completed"; then
    archive_completed_upgrade_rollback_journal
  else
    rollback_active_upgrade_transaction
  fi
  echo "==> Interrupted upgrade rollback reconciled; beginning a fresh upgrade attempt"
  UPGRADE_WAS_ACTIVE=no
  UPGRADE_WAS_ENABLED=no
  UPGRADE_SINGBOX_WAS_ENABLED=no
  UPGRADE_STOPPED=no
  UPGRADE_BACKUP=""
  UPGRADE_HAD_INSTALL_ROOT=no
  UPGRADE_HAD_ENV_ROOT=no
  UPGRADE_HAD_UNIT_TARGET=no
  UPGRADE_HAD_UNIT_CONTROLLER=no
  UPGRADE_HAD_UNIT_SING_BOX=no
  UPGRADE_HAD_UNIT_SUBSCRIPTION=no
  UPGRADE_HAD_UNIT_ADMIN=no
  UPGRADE_HAD_UNIT_TUNNEL=no
  UPGRADE_STATE_BACKUP_READY=no
  ROLLBACK_RESTORE_STAGING=""
  ROLLBACK_QUARANTINE_PATH=""
}

recover_interrupted_upgrade_restart
recover_interrupted_upgrade_rollback

if [[ "$TUNNEL_TOKEN_RECOVERY_PENDING" == yes ]]; then
  if [[ -n "${CLOUDFLARE_TUNNEL_TOKEN_FILE:-}" ]]; then
    validate_cloudflare_tunnel_token_file \
      "$CLOUDFLARE_TUNNEL_TOKEN_FILE" CLOUDFLARE_TUNNEL_TOKEN_FILE
  elif path_is_present "$TUNNEL_TOKEN_PATH"; then
    validate_cloudflare_tunnel_token_file \
      "$TUNNEL_TOKEN_PATH" "Restored Cloudflare Tunnel token"
  else
    die "The predecessor deployment was recovered. Rerun with CLOUDFLARE_TUNNEL_TOKEN_FILE pointing to a protected Tunnel token file to begin the Cloudflare migration."
  fi
fi

# A predecessor rollback journal can legitimately predate both the tunnel unit
# and this fixed identity. Replay that journal before even auditing uid/gid
# 11003 so an unrelated occupant cannot prevent the stopped predecessor from
# being restored. A conflict still fails the subsequent fresh rollout closed,
# after the previous deployment is safely running again.
validate_service_namespace vpn-tunnel "$EXPECTED_TUNNEL_UID" "$EXPECTED_TUNNEL_GID" no
ensure_group vpn-tunnel 11003
ensure_user vpn-tunnel 11003 11003
validate_service_namespace vpn-tunnel "$EXPECTED_TUNNEL_UID" "$EXPECTED_TUNNEL_GID" yes

if [[ "$CLOUDFLARED_DEPENDENCIES_VALIDATED" != yes ]]; then
  validate_cloudflare_runtime_dependencies
  CLOUDFLARED_DEPENDENCIES_VALIDATED=yes
fi
readonly CLOUDFLARED_DEPENDENCIES_VALIDATED

systemd-analyze verify "${UNIT_FILES[@]/#/$REPO_DIR/deploy/systemd/}" \
  || die "The source systemd unit set failed validation; no deployment services were stopped."

REALITY_MIGRATION_REQUIRED=no
if [[ "$INSTALL_MODE" == existing ]]; then
  current_state_inspection="$(inspect_current_state_for_installer)" \
    || die "Could not safely inspect the active revision before upgrade."
  current_state_schema="$(read_installer_json_field "$current_state_inspection" schemaVersion)" \
    || die "Could not identify the active state schema."
  case "$current_state_schema" in
    2)
      case "${MIGRATE_REALITY:-}" in
        1) ;;
        "")
          [[ -t 0 ]] \
            || die "Existing REALITY state requires explicit one-way migration approval: rerun with MIGRATE_REALITY=1."
          read -r -p "Type MIGRATE_REALITY=1 to replace every REALITY client profile with Cloudflare WebSocket ingress: " reality_confirmation
          [[ "$reality_confirmation" == MIGRATE_REALITY=1 ]] \
            || die "REALITY migration was not approved; the running deployment was not changed."
          ;;
        *)
          die "MIGRATE_REALITY must be exactly 1 for the one-way Cloudflare WebSocket migration."
          ;;
      esac
      collect_cloudflare_ingress_settings yes
      REALITY_MIGRATION_REQUIRED=yes
      ;;
    3)
      supplied_vpn_hostname="${VPN_PUBLIC_HOSTNAME:-}"
      supplied_subscription_url="${SUBSCRIPTION_PUBLIC_BASE_URL:-}"
      supplied_admin_hostname="${ADMIN_PUBLIC_HOSTNAME:-}"
      supplied_websocket_path="${WS_PATH:-}"
      supplied_health_hostname="${EGRESS_HEALTH_HOST:-}"
      VPN_PUBLIC_HOSTNAME="$(read_installer_json_field "$current_state_inspection" vpnPublicHostname)"
      SUBSCRIPTION_PUBLIC_BASE_URL="$(read_installer_json_field "$current_state_inspection" subscriptionPublicBaseUrl)"
      ADMIN_PUBLIC_HOSTNAME="$(read_installer_json_field "$current_state_inspection" adminPublicHostname)"
      WS_PATH="$(read_installer_json_field "$current_state_inspection" websocketPath)"
      EGRESS_HEALTH_HOST="$(read_installer_json_field "$current_state_inspection" egressHealthHost)"
      require_matching_canonical_setting VPN_PUBLIC_HOSTNAME "$supplied_vpn_hostname" "$VPN_PUBLIC_HOSTNAME"
      require_matching_canonical_setting SUBSCRIPTION_PUBLIC_BASE_URL "$supplied_subscription_url" "$SUBSCRIPTION_PUBLIC_BASE_URL"
      require_matching_canonical_setting ADMIN_PUBLIC_HOSTNAME "$supplied_admin_hostname" "$ADMIN_PUBLIC_HOSTNAME"
      require_matching_canonical_setting WS_PATH "$supplied_websocket_path" "$WS_PATH"
      require_matching_canonical_setting EGRESS_HEALTH_HOST "$supplied_health_hostname" "$EGRESS_HEALTH_HOST"
      validate_cloudflare_ingress_settings
      ;;
    *)
      die "Unsupported active state schema $current_state_schema; no deployment changes were made."
      ;;
  esac
fi
readonly REALITY_MIGRATION_REQUIRED

restore_previous_deployment_on_failure() {
  local status=$?
  local -a new_unit_names
  trap - EXIT
  if [[ -n "$MIGRATION_MARKER_STAGING" ]]; then
    case "$MIGRATION_MARKER_STAGING" in
      "$STATE_ROOT"/.legacy-migration-marker.*)
        rm -rf -- "$MIGRATION_MARKER_STAGING"
        ;;
    esac
  fi
  if [[ -n "$SECRET_STAGING" ]]; then
    case "$SECRET_STAGING" in
      "$SECRET_ROOT"/.secret.??????)
        if [[ -f "$SECRET_STAGING" && ! -L "$SECRET_STAGING" ]] \
            && [[ "$(stat -c '%u:%a:%h' -- "$SECRET_STAGING")" == 0:600:1 ]]; then
          rm -f -- "$SECRET_STAGING"
        fi
        ;;
    esac
  fi
  if [[ -n "$MIGRATION_STAGING" ]]; then
    case "$MIGRATION_STAGING" in
      "$STATE_ROOT"/.tailscale-migrate.*)
        rm -rf -- "$MIGRATION_STAGING"
        ;;
    esac
  fi

  if [[ $status -ne 0 && "$UPGRADE_STOPPED" == yes && "$DEPLOYMENT_HANDOFF_COMPLETE" != yes ]]; then
    echo "==> Upgrade did not become ready; restoring the previous deployment from $UPGRADE_BACKUP" >&2
    if path_is_present "$UPGRADE_ROLLBACK_JOURNAL"; then
      rollback_active_upgrade_transaction
    elif path_is_present "$UPGRADE_RESTART_JOURNAL"; then
      load_upgrade_restart_journal
      quiesce_upgrade_services_for_rollback
      cleanup_unjournaled_upgrade_restore_artifacts
      restore_upgrade_enablement
      restart_and_verify_restored_upgrade
      retire_upgrade_restart_journal
    else
      die "Upgrade failed after shutdown without a durable recovery journal."
    fi
  elif [[ $status -ne 0 && "$LEGACY_SERVICES_STOPPED" == yes && "$DEPLOYMENT_HANDOFF_COMPLETE" != yes ]]; then
    echo "==> Migration did not complete; restoring the previously active legacy services" >&2
    new_unit_names=(
      vpn-gateway.target \
      vpn-gateway-controller.service \
      vpn-gateway-sing-box.service \
      vpn-gateway-subscription.service \
      vpn-gateway-admin.service
    )
    for service_name in "${new_unit_names[@]}"; do
      # A failure can occur after the legacy units stop but before every new
      # unit file is installed. Missing replacement units are therefore safe;
      # any loaded or running unit must still stop conclusively.
      stop_unit_if_active_strict "$service_name" yes
    done
    stop_unit_if_active_strict vpn-gateway-tunnel.service yes
    hold_migration_target_disabled
    restore_legacy_service_state \
      sing-box.service "$LEGACY_SINGBOX_WAS_ACTIVE" "$LEGACY_SINGBOX_WAS_ENABLED"
    restore_legacy_service_state \
      vpn-sub.service "$LEGACY_SUB_WAS_ACTIVE" "$LEGACY_SUB_WAS_ENABLED"
  fi
  exit "$status"
}
trap restore_previous_deployment_on_failure EXIT

if [[ "$INSTALL_MODE" == existing ]]; then
  target_enablement_state="$(query_upgrade_enablement vpn-gateway.target no)"
  singbox_enablement_state="$(query_upgrade_enablement vpn-gateway-sing-box.service yes)"
  existing_service_names=(
    vpn-gateway.target \
    vpn-gateway-controller.service \
    vpn-gateway-sing-box.service \
    vpn-gateway-subscription.service \
    vpn-gateway-admin.service
  )
  for service_name in "${existing_service_names[@]}"; do
    service_active_state="$(query_unit_active_state "$service_name")"
    if [[ "$service_active_state" == active ]]; then
      UPGRADE_WAS_ACTIVE=yes
    fi
  done
  tunnel_active_state="$(query_unit_active_state vpn-gateway-tunnel.service yes)"
  if [[ "$tunnel_active_state" == active ]]; then
    UPGRADE_WAS_ACTIVE=yes
  fi
  if [[ "$target_enablement_state" == enabled ]]; then
    UPGRADE_WAS_ENABLED=yes
  fi
  if [[ "$singbox_enablement_state" == enabled ]]; then
    UPGRADE_SINGBOX_WAS_ENABLED=yes
  fi

  install -d -o root -g root -m 0700 /var/backups/vpn-gateway
  UPGRADE_BACKUP="$(mktemp -d /var/backups/vpn-gateway/upgrade-XXXXXXXXXX)"
  chmod 0700 "$UPGRADE_BACKUP"
  install -d -o root -g root -m 0700 \
    "$UPGRADE_BACKUP/units" "$UPGRADE_BACKUP/rollback-metadata"
  if path_is_present "$INSTALL_ROOT"; then
    [[ -d "$INSTALL_ROOT" && ! -L "$INSTALL_ROOT" ]] \
      || die "$INSTALL_ROOT must be a directory, not a symlink."
    cp -a -- "$INSTALL_ROOT" "$UPGRADE_BACKUP/install-root"
    UPGRADE_HAD_INSTALL_ROOT=yes
  fi
  if path_is_present "$ENV_ROOT"; then
    [[ -d "$ENV_ROOT" && ! -L "$ENV_ROOT" ]] \
      || die "$ENV_ROOT must be a directory, not a symlink."
    cp -a -- "$ENV_ROOT" "$UPGRADE_BACKUP/environment-root"
    UPGRADE_HAD_ENV_ROOT=yes
  fi
  for unit_file in "${UNIT_FILES[@]}"; do
    if path_is_present "$SYSTEMD_ROOT/$unit_file"; then
      [[ -f "$SYSTEMD_ROOT/$unit_file" && ! -L "$SYSTEMD_ROOT/$unit_file" ]] \
        || die "$SYSTEMD_ROOT/$unit_file must be a regular file, not a symlink."
      cp -a -- "$SYSTEMD_ROOT/$unit_file" "$UPGRADE_BACKUP/units/$unit_file"
      case "$unit_file" in
        vpn-gateway.target) UPGRADE_HAD_UNIT_TARGET=yes ;;
        vpn-gateway-controller.service) UPGRADE_HAD_UNIT_CONTROLLER=yes ;;
        vpn-gateway-sing-box.service) UPGRADE_HAD_UNIT_SING_BOX=yes ;;
        vpn-gateway-subscription.service) UPGRADE_HAD_UNIT_SUBSCRIPTION=yes ;;
        vpn-gateway-admin.service) UPGRADE_HAD_UNIT_ADMIN=yes ;;
        vpn-gateway-tunnel.service) UPGRADE_HAD_UNIT_TUNNEL=yes ;;
      esac
    fi
  done
  persist_upgrade_rollback_metadata

  echo "==> Publishing restart intent before disabling or stopping the current deployment"
  prepare_upgrade_restart_journal
  UPGRADE_STOPPED=yes
  hold_upgrade_services_disabled
  echo "==> Stopping the current deployment after saving rollback files in $UPGRADE_BACKUP"
  quiesce_upgrade_services_for_rollback
  normalize_upgrade_repository_ownership
  reconcile_repository_revision_crash_artifacts "$STATE_ROOT/revisions"
  echo "==> Saving the stopped deployment's protected revisions and atomic pointers"
  backup_upgrade_protected_state
  echo "==> Persisting the crash-recovery journal before deployment mutation"
  begin_upgrade_rollback_transaction
fi

install -d -o root -g root -m 0755 "$INSTALL_ROOT" "$INSTALL_ROOT/src" "$INSTALL_ROOT/bin"
install -d -o root -g root -m 0751 "$STATE_ROOT" "$STATE_ROOT/revisions"
if [[ "$INSTALL_MODE" != migrate ]]; then
  install -d -o vpn-runtime -g vpn-runtime -m 0700 "$STATE_ROOT/tailscale"
fi
install -d -o root -g root -m 0700 "$ENV_ROOT"
install -d -o root -g root -m 0700 "$SECRET_ROOT"
cleanup_orphaned_secret_staging

cleanup_committed_migration_work() {
  local unexpected_entry marker_name
  [[ "$COMMITTED_MIGRATION_CLEANUP" == yes ]] || return 0
  [[ -d "$MIGRATION_MARKER" && ! -L "$MIGRATION_MARKER" ]] \
    || die "$MIGRATION_MARKER must be a directory, not a symlink."
  [[ "$(stat -c '%u:%a' -- "$MIGRATION_MARKER")" == 0:700 ]] \
    || die "$MIGRATION_MARKER must be owned by root with mode 0700."
  unexpected_entry="$(find "$MIGRATION_MARKER" -mindepth 1 -maxdepth 1 \
    ! -name env.sha256 \
    ! -name config.sha256 \
    ! -name source-state \
    ! -name sub-active \
    ! -name sub-enabled \
    ! -name sing-box-active \
    ! -name sing-box-enabled \
    ! -name state-copied \
    ! -name state-published \
    ! -name lineage.json \
    ! -name committed \
    -print -quit)"
  [[ -z "$unexpected_entry" ]] \
    || die "Committed migration work contains an unexpected entry: $unexpected_entry"
  for marker_name in \
    env.sha256 config.sha256 source-state \
    sub-active sub-enabled sing-box-active sing-box-enabled \
    state-copied state-published lineage.json committed; do
    if path_is_present "$MIGRATION_MARKER/$marker_name"; then
      [[ -f "$MIGRATION_MARKER/$marker_name" && ! -L "$MIGRATION_MARKER/$marker_name" ]] \
        || die "Committed migration work contains an unsafe entry: $MIGRATION_MARKER/$marker_name"
      [[ "$(stat -c '%u:%a:%h' -- "$MIGRATION_MARKER/$marker_name")" == 0:600:1 ]] \
        || die "Committed migration work entry has unsafe ownership, mode, or link count: $MIGRATION_MARKER/$marker_name"
    fi
  done
  rm -f -- \
    "$MIGRATION_MARKER/env.sha256" \
    "$MIGRATION_MARKER/config.sha256" \
    "$MIGRATION_MARKER/source-state" \
    "$MIGRATION_MARKER/sub-active" \
    "$MIGRATION_MARKER/sub-enabled" \
    "$MIGRATION_MARKER/sing-box-active" \
    "$MIGRATION_MARKER/sing-box-enabled" \
    "$MIGRATION_MARKER/state-copied" \
    "$MIGRATION_MARKER/state-published" \
    "$MIGRATION_MARKER/lineage.json" \
    "$MIGRATION_MARKER/committed"
  rmdir -- "$MIGRATION_MARKER"
}

cleanup_committed_migration_work

if [[ "$INSTALL_MODE" == migrate ]]; then
  if [[ "$MIGRATION_RESUME" == yes ]]; then
    unexpected_marker_entry="$(find "$MIGRATION_MARKER" -mindepth 1 -maxdepth 1 \
      ! -name env.sha256 \
      ! -name config.sha256 \
      ! -name source-state \
      ! -name sub-active \
      ! -name sub-enabled \
      ! -name sing-box-active \
      ! -name sing-box-enabled \
      ! -name state-copied \
      ! -name state-published \
      ! -name lineage.json \
      ! -name committed \
      -print -quit)"
    [[ -z "$unexpected_marker_entry" ]] \
      || die "Migration marker contains an unexpected entry: $unexpected_marker_entry"
    for marker_name in env.sha256 config.sha256 source-state; do
      validate_migration_marker_file "$MIGRATION_MARKER/$marker_name"
    done
    read -r marker_env_digest <"$MIGRATION_MARKER/env.sha256"
    read -r marker_config_digest <"$MIGRATION_MARKER/config.sha256"
    read -r marker_source_state <"$MIGRATION_MARKER/source-state"
    [[ "$marker_env_digest" =~ ^[a-f0-9]{64}$ && "$marker_env_digest" == "$LEGACY_ENV_DIGEST" ]] \
      || die "$LEGACY_ENV_FILE no longer matches the interrupted migration. Restore the reviewed original before retrying."
    [[ "$marker_config_digest" =~ ^[a-f0-9]{64}$ && "$marker_config_digest" == "$LEGACY_CONFIG_DIGEST" ]] \
      || die "$LEGACY_CONFIG_FILE no longer matches the interrupted migration. Restore the reviewed original before retrying."
    [[ "$marker_source_state" == "$LEGACY_SOURCE_STATE" ]] \
      || die "The legacy Tailscale state path no longer matches the interrupted migration."
    for marker_name in sub-active sub-enabled sing-box-active sing-box-enabled state-copied state-published lineage.json; do
      if path_is_present "$MIGRATION_MARKER/$marker_name"; then
        validate_migration_marker_file "$MIGRATION_MARKER/$marker_name"
      fi
    done
    path_is_present "$MIGRATION_MARKER/sub-active" && LEGACY_SUB_WAS_ACTIVE=yes || true
    path_is_present "$MIGRATION_MARKER/sub-enabled" && LEGACY_SUB_WAS_ENABLED=yes || true
    path_is_present "$MIGRATION_MARKER/sing-box-active" && LEGACY_SINGBOX_WAS_ACTIVE=yes || true
    path_is_present "$MIGRATION_MARKER/sing-box-enabled" && LEGACY_SINGBOX_WAS_ENABLED=yes || true
    echo "==> Resuming the explicitly approved legacy migration recorded in $MIGRATION_MARKER"

    # A power loss does not run the EXIT trap. If it happened after candidate
    # readiness but before the outer commit marker, the replacement units can
    # still be live even though the legacy migration remains uncommitted. Stop
    # every possible new writer before replacing code or mutable tsnet state.
    # Mark the legacy handoff active first so any later failure restores the
    # exact legacy active/enablement state recorded in the durable marker.
    LEGACY_SERVICES_STOPPED=yes
    hold_migration_target_disabled
    for service_name in \
      vpn-gateway.target \
      vpn-gateway-controller.service \
      vpn-gateway-sing-box.service \
      vpn-gateway-subscription.service \
      vpn-gateway-admin.service; do
      stop_unit_if_active_strict "$service_name" yes
    done
    stop_unit_if_active_strict vpn-gateway-tunnel.service yes
  else
    legacy_sub_active_state="$(query_unit_active_state vpn-sub.service)"
    legacy_singbox_active_state="$(query_unit_active_state sing-box.service)"
    legacy_sub_enablement_state="$(query_upgrade_enablement vpn-sub.service yes yes)"
    legacy_singbox_enablement_state="$(query_upgrade_enablement sing-box.service yes yes)"
    if [[ "$legacy_sub_active_state" == active ]]; then
      LEGACY_SUB_WAS_ACTIVE=yes
    fi
    if [[ "$legacy_singbox_active_state" == active ]]; then
      LEGACY_SINGBOX_WAS_ACTIVE=yes
    fi
    if [[ "$legacy_sub_enablement_state" == enabled ]]; then
      LEGACY_SUB_WAS_ENABLED=yes
    fi
    if [[ "$legacy_singbox_enablement_state" == enabled ]]; then
      LEGACY_SINGBOX_WAS_ENABLED=yes
    fi

    MIGRATION_MARKER_STAGING="$(mktemp -d "$STATE_ROOT/.legacy-migration-marker.XXXXXXXXXX")"
    chmod 0700 "$MIGRATION_MARKER_STAGING"
    printf '%s\n' "$LEGACY_ENV_DIGEST" >"$MIGRATION_MARKER_STAGING/env.sha256"
    printf '%s\n' "$LEGACY_CONFIG_DIGEST" >"$MIGRATION_MARKER_STAGING/config.sha256"
    printf '%s\n' "$LEGACY_SOURCE_STATE" >"$MIGRATION_MARKER_STAGING/source-state"
    chmod 0600 \
      "$MIGRATION_MARKER_STAGING/env.sha256" \
      "$MIGRATION_MARKER_STAGING/config.sha256" \
      "$MIGRATION_MARKER_STAGING/source-state"
    [[ "$LEGACY_SUB_WAS_ACTIVE" == no ]] \
      || install -o root -g root -m 0600 /dev/null "$MIGRATION_MARKER_STAGING/sub-active"
    [[ "$LEGACY_SUB_WAS_ENABLED" == no ]] \
      || install -o root -g root -m 0600 /dev/null "$MIGRATION_MARKER_STAGING/sub-enabled"
    [[ "$LEGACY_SINGBOX_WAS_ACTIVE" == no ]] \
      || install -o root -g root -m 0600 /dev/null "$MIGRATION_MARKER_STAGING/sing-box-active"
    [[ "$LEGACY_SINGBOX_WAS_ENABLED" == no ]] \
      || install -o root -g root -m 0600 /dev/null "$MIGRATION_MARKER_STAGING/sing-box-enabled"
    chown -R root:root "$MIGRATION_MARKER_STAGING"
    while IFS= read -r -d '' marker_file; do
      sync -f "$marker_file"
    done < <(find "$MIGRATION_MARKER_STAGING" -mindepth 1 -maxdepth 1 -type f -print0)
    sync -f "$MIGRATION_MARKER_STAGING"
    mv -- "$MIGRATION_MARKER_STAGING" "$MIGRATION_MARKER"
    sync -f "$STATE_ROOT"
    MIGRATION_MARKER_STAGING=""
  fi
fi

remove_retired_source_files() {
  local filename
  local -a retired_source_files=(
    admin-page.js
    admin-server.js
    bootstrap.js
    control-client.js
    controller-server.js
    controller-sessions.js
    controller.js
    credentials.js
    health-probe.js
    healthcheck.js
    http-common.js
    legacy-reality.js
    legacy-v2.js
    lifecycle.js
    migrate-v1.js
    render.js
    repository.js
    runtime.js
    state-schema.js
    subscription-server.js
    tailscale.js
    validation.js
    websocket-probe.js
  )
  # Only these former application files are retired. Validate the whole set
  # before removing any entry, and preserve all other operator-owned content.
  for filename in "${retired_source_files[@]}"; do
    if [[ -e "$INSTALL_ROOT/src/$filename" || -L "$INSTALL_ROOT/src/$filename" ]]; then
      [[ -f "$INSTALL_ROOT/src/$filename" && ! -L "$INSTALL_ROOT/src/$filename" ]] \
        || die "Retired application source $filename must be a regular file, not a symlink."
    fi
  done
  for filename in "${retired_source_files[@]}"; do
    rm -f -- "$INSTALL_ROOT/src/$filename"
  done
}

validate_fixed_directory "$INSTALL_ROOT/src"
install -o root -g root -m 0644 "$REPO_DIR/package.json" "$INSTALL_ROOT/package.json"
cp -a "$REPO_DIR/src/." "$INSTALL_ROOT/src/"
# Upgrade backups and the durable rollback journal are already in place, and
# the replacement source tree has copied successfully before old paths retire.
remove_retired_source_files
chown -R root:root "$INSTALL_ROOT/src"
find "$INSTALL_ROOT/src" -type d -exec chmod 0755 {} +
find "$INSTALL_ROOT/src" -type f -exec chmod 0644 {} +
install -o root -g root -m 0755 "$REPO_DIR/deploy/systemd/sing-box-wrapper.sh" "$INSTALL_ROOT/bin/sing-box-wrapper"

write_environment_value() {
  local name="$1"
  local value="$2"
  local escaped
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "$name contains a newline."
  escaped="${value//\\/\\\\}"
  escaped="${escaped//\"/\\\"}"
  printf '%s="%s"\n' "$name" "$escaped"
}

create_secret_file() {
  local destination="$1"
  local source_variable="$2"
  local label="$3"
  local required="$4"
  local source_path="${!source_variable-}"
  local value=""
  local temporary_file

  if [[ -n "$source_path" ]]; then
    [[ "$source_path" == /* ]] || die "$source_variable must be an absolute path."
    value="$("$NODE_BIN" --input-type=module --eval '
      import { constants } from "node:fs";
      import { lstat, open } from "node:fs/promises";

      const source = process.argv[1];
      let handle;
      const reject = () => {
        throw new Error("secret source must be root-owned, singly linked, mode 0400/0600, and no larger than 16 KiB");
      };
      try {
        handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
        const before = await handle.stat();
        const pathname = await lstat(source);
        const mode = before.mode & 0o777;
        if (!before.isFile() || before.nlink !== 1 || before.uid !== 0 || before.gid !== 0
            || ![0o400, 0o600].includes(mode) || before.size < 1 || before.size > 16 * 1024
            || pathname.isSymbolicLink() || pathname.dev !== before.dev || pathname.ino !== before.ino) {
          reject();
        }
        const bytes = await handle.readFile();
        const after = await handle.stat();
        const finalPathname = await lstat(source);
        if (bytes.length !== before.size || after.dev !== before.dev || after.ino !== before.ino
            || after.uid !== before.uid || after.gid !== before.gid || after.nlink !== before.nlink
            || after.size !== before.size || (after.mode & 0o777) !== mode
            || finalPathname.isSymbolicLink() || finalPathname.dev !== before.dev
            || finalPathname.ino !== before.ino) {
          reject();
        }
        const text = bytes.toString("utf8");
        if (!Buffer.from(text, "utf8").equals(bytes) || text.includes("\0")) reject();
        process.stdout.write(bytes);
      } finally {
        await handle?.close().catch(() => {});
      }
    ' "$source_path")" \
      || die "$source_variable could not be read through a stable no-follow file descriptor."
  elif [[ -t 0 ]]; then
    read -r -s -p "$label: " value
    echo
  elif [[ "$required" == yes ]]; then
    die "$source_variable must identify a secret file for a non-interactive first installation."
  else
    return 1
  fi

  if [[ -z "$value" ]]; then
    [[ "$required" == no ]] && return 1
    die "$label must not be empty."
  fi
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "$label must contain exactly one line."

  temporary_file="$(mktemp "$SECRET_ROOT/.secret.XXXXXX")"
  SECRET_STAGING="$temporary_file"
  chmod 0600 "$temporary_file"
  printf '%s' "$value" >"$temporary_file"
  chown root:root "$temporary_file"
  sync -f "$temporary_file"
  mv -f -- "$temporary_file" "$destination"
  sync -f "$SECRET_ROOT"
  SECRET_STAGING=""
}

preserve_or_create_secret() {
  local destination="$1"
  local source_variable="$2"
  local label="$3"
  local required="$4"
  if [[ -e "$destination" || -L "$destination" ]]; then
    [[ -f "$destination" && ! -L "$destination" && -s "$destination" ]] \
      || die "$destination must be a non-empty regular file, not a symlink."
    chown root:root "$destination"
    chmod 0600 "$destination"
    return 0
  fi
  create_secret_file "$destination" "$source_variable" "$label" "$required"
}

create_fresh_controller_environment() {
  local temporary_file
  EXIT_NODE="${EXIT_NODE:-}"
  NODE_NAME="${NODE_NAME:-}"

  prompt_required EXIT_NODE "Tailscale exit node address or machine name" no
  prompt_optional NODE_NAME "Gateway node name" "vps-cloudflare" no
  collect_cloudflare_ingress_settings yes

  temporary_file="$(mktemp "$ENV_ROOT/.controller.env.XXXXXX")"
  chmod 0600 "$temporary_file"
  {
    write_environment_value TS_AUTH_KEY_FILE "$AUTH_KEY_PATH"
    write_environment_value EXIT_NODE "$EXIT_NODE"
    write_environment_value NODE_NAME "$NODE_NAME"
    write_environment_value VPN_PUBLIC_HOSTNAME "$VPN_PUBLIC_HOSTNAME"
    write_environment_value SUBSCRIPTION_PUBLIC_BASE_URL "$SUBSCRIPTION_PUBLIC_BASE_URL"
    write_environment_value ADMIN_PUBLIC_HOSTNAME "$ADMIN_PUBLIC_HOSTNAME"
    write_environment_value WS_PATH "$WS_PATH"
    write_environment_value EGRESS_HEALTH_HOST "$EGRESS_HEALTH_HOST"
  } >"$temporary_file"
  chown root:root "$temporary_file"
  sync -f "$temporary_file"
  mv -f -- "$temporary_file" "$CONTROLLER_ENV"
  sync -f "$ENV_ROOT"
}

create_migration_controller_environment() {
  local migration_state_directory="${1:-}"
  local temporary_file

  temporary_file="$(mktemp "$ENV_ROOT/.controller.env.XXXXXX")"
  chmod 0600 "$temporary_file"
  {
    if [[ -s "$AUTH_KEY_PATH" ]]; then
      write_environment_value TS_AUTH_KEY_FILE "$AUTH_KEY_PATH"
    fi
    write_environment_value LEGACY_ENV_FILE "$LEGACY_ENV_FILE"
    write_environment_value LEGACY_CONFIG_FILE "$LEGACY_CONFIG_FILE"
    if [[ -n "$migration_state_directory" ]]; then
      write_environment_value MIGRATION_STATE_DIR "$migration_state_directory"
    fi
    write_environment_value VPN_PUBLIC_HOSTNAME "$VPN_PUBLIC_HOSTNAME"
    write_environment_value SUBSCRIPTION_PUBLIC_BASE_URL "$SUBSCRIPTION_PUBLIC_BASE_URL"
    write_environment_value ADMIN_PUBLIC_HOSTNAME "$ADMIN_PUBLIC_HOSTNAME"
    write_environment_value WS_PATH "$WS_PATH"
    write_environment_value EGRESS_HEALTH_HOST "$EGRESS_HEALTH_HOST"
  } >"$temporary_file"
  chown root:root "$temporary_file"
  sync -f "$temporary_file"
  mv -f -- "$temporary_file" "$CONTROLLER_ENV"
  sync -f "$ENV_ROOT"
}

create_existing_controller_environment() {
  local temporary_file
  temporary_file="$(mktemp "$ENV_ROOT/.controller.env.XXXXXX")"
  chmod 0600 "$temporary_file"
  {
    write_environment_value VPN_PUBLIC_HOSTNAME "$VPN_PUBLIC_HOSTNAME"
    write_environment_value SUBSCRIPTION_PUBLIC_BASE_URL "$SUBSCRIPTION_PUBLIC_BASE_URL"
    write_environment_value ADMIN_PUBLIC_HOSTNAME "$ADMIN_PUBLIC_HOSTNAME"
    write_environment_value WS_PATH "$WS_PATH"
    write_environment_value EGRESS_HEALTH_HOST "$EGRESS_HEALTH_HOST"
    if [[ "$REALITY_MIGRATION_REQUIRED" == yes ]]; then
      write_environment_value MIGRATE_REALITY 1
    fi
  } >"$temporary_file"
  chown root:root "$temporary_file"
  sync -f "$temporary_file"
  mv -f -- "$temporary_file" "$CONTROLLER_ENV"
  sync -f "$ENV_ROOT"
}

install_cloudflare_tunnel_token() {
  if [[ -n "${CLOUDFLARE_TUNNEL_TOKEN_FILE:-}" ]]; then
    create_secret_file \
      "$TUNNEL_TOKEN_PATH" CLOUDFLARE_TUNNEL_TOKEN_FILE \
      "Cloudflare Tunnel token" yes
  fi
  validate_cloudflare_tunnel_token_file \
    "$TUNNEL_TOKEN_PATH" "Stored Cloudflare Tunnel token"
}

write_api_environment() {
  local api_environment_temporary_file
  api_environment_temporary_file="$(mktemp "$ENV_ROOT/.tailscale-api.env.XXXXXX")"
  chmod 0600 "$api_environment_temporary_file"
  write_environment_value TS_API_KEY_FILE "$API_KEY_PATH" >"$api_environment_temporary_file"
  chown root:root "$api_environment_temporary_file"
  mv -f -- "$api_environment_temporary_file" "$API_ENV"
}

readonly LEGACY_SECRET_MIGRATOR='import { lstat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const bootstrapModule = await import(pathToFileURL(process.env.BOOTSTRAP_MODULE).href);
const migrationModule = await import(pathToFileURL(process.env.MIGRATION_MODULE).href);
const inspection = await migrationModule.inspectLegacyV1({
  envPath: process.env.LEGACY_ENV_FILE,
  configPath: process.env.LEGACY_CONFIG_FILE,
});
const values = [
  [process.env.AUTH_KEY_PATH, inspection.legacyConfig.authKey || inspection.legacyEnvironment.TS_AUTH_KEY || null, "auth key"],
  [process.env.API_KEY_PATH, inspection.legacyEnvironment.TS_API_KEY || null, "API key"],
];
const present = {};
for (const [destination, value, label] of values) {
  present[label] = value !== null;
  if (value === null) continue;
  if (value.length < 8 || value.length > 512 || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("legacy " + label + " is invalid");
  }
  let exists = true;
  try {
    await lstat(destination);
  } catch (error) {
    if (error.code === "ENOENT") exists = false;
    else throw error;
  }
  if (exists) {
    const stored = await bootstrapModule.readSecretFile(destination, { description: "preserved " + label });
    if (stored !== value) throw new Error("existing preserved " + label + " conflicts with legacy state");
  } else {
    await bootstrapModule.writePrivateFileExclusive(destination, Buffer.from(value, "utf8"));
  }
}
process.stdout.write(JSON.stringify(present) + "\n");'

preserve_legacy_credentials() {
  env -i \
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    "BOOTSTRAP_MODULE=$INSTALL_ROOT/src/state/bootstrap.js" \
    "MIGRATION_MODULE=$INSTALL_ROOT/src/migrations/migrate-v1.js" \
    "LEGACY_ENV_FILE=$LEGACY_ENV_FILE" \
    "LEGACY_CONFIG_FILE=$LEGACY_CONFIG_FILE" \
    "AUTH_KEY_PATH=$AUTH_KEY_PATH" \
    "API_KEY_PATH=$API_KEY_PATH" \
    "$NODE_BIN" --input-type=module --eval "$LEGACY_SECRET_MIGRATOR"
  for secret_file in "$AUTH_KEY_PATH" "$API_KEY_PATH"; do
    if path_is_present "$secret_file"; then
      [[ -f "$secret_file" && ! -L "$secret_file" && -s "$secret_file" ]] \
        || die "$secret_file must be a non-empty regular file, not a symlink."
      chown root:root "$secret_file"
      chmod 0600 "$secret_file"
    fi
  done
}

install_cloudflare_tunnel_token

case "$INSTALL_MODE" in
  fresh)
    preserve_or_create_secret "$AUTH_KEY_PATH" TS_AUTH_KEY_FILE "Tailscale auth key" yes
    preserve_or_create_secret "$API_KEY_PATH" TS_API_KEY_FILE "Tailscale API access token (optional)" no || true
    if path_is_present "$CONTROLLER_ENV"; then
      [[ -f "$CONTROLLER_ENV" && ! -L "$CONTROLLER_ENV" ]] \
        || die "$CONTROLLER_ENV must be a regular file, not a symlink."
      for required_key in \
        TS_AUTH_KEY_FILE EXIT_NODE NODE_NAME VPN_PUBLIC_HOSTNAME \
        SUBSCRIPTION_PUBLIC_BASE_URL ADMIN_PUBLIC_HOSTNAME WS_PATH EGRESS_HEALTH_HOST; do
        grep -q "^${required_key}=" "$CONTROLLER_ENV" \
          || die "$CONTROLLER_ENV is missing $required_key; repair it before rerunning."
      done
      stored_auth_key_path="$(read_generated_environment_value "$CONTROLLER_ENV" TS_AUTH_KEY_FILE)"
      [[ "$stored_auth_key_path" == "$AUTH_KEY_PATH" ]] \
        || die "$CONTROLLER_ENV contains an unexpected TS_AUTH_KEY_FILE path."
      stored_exit_node="$(read_generated_environment_value "$CONTROLLER_ENV" EXIT_NODE)"
      stored_node_name="$(read_generated_environment_value "$CONTROLLER_ENV" NODE_NAME)"
      require_matching_canonical_setting EXIT_NODE "${EXIT_NODE:-}" "$stored_exit_node"
      require_matching_canonical_setting NODE_NAME "${NODE_NAME:-}" "$stored_node_name"
      EXIT_NODE="$stored_exit_node"
      NODE_NAME="$stored_node_name"
      load_ingress_settings_from_controller_environment
      chown root:root "$CONTROLLER_ENV"
      chmod 0600 "$CONTROLLER_ENV"
      echo "==> Resuming the existing first-install settings"
    else
      echo "==> Collecting first-install settings"
      create_fresh_controller_environment
    fi
    ;;
  migrate)
    echo "==> Preserving legacy Tailscale credentials in root-only secret files"
    preserve_legacy_credentials
    create_migration_controller_environment
    if [[ -n "${TS_API_KEY_FILE:-}" ]]; then
      preserve_or_create_secret "$API_KEY_PATH" TS_API_KEY_FILE "Tailscale API access token (optional)" no || true
    fi
    ;;
  existing)
    create_existing_controller_environment
    echo "==> Preserving canonical public settings and persistent state"
    ;;
esac

if [[ -s "$API_KEY_PATH" ]]; then
  write_api_environment
elif path_is_present "$API_ENV"; then
  [[ -f "$API_ENV" && ! -L "$API_ENV" ]] \
    || die "$API_ENV must be a regular file, not a symlink."
  chown root:root "$API_ENV"
  chmod 0600 "$API_ENV"
fi

create_admin_environment() {
  local temporary_file

  temporary_file="$(mktemp "$ENV_ROOT/.admin.env.XXXXXX")"
  chmod 0600 "$temporary_file"
  write_environment_value ADMIN_PUBLIC_HOSTNAME "$ADMIN_PUBLIC_HOSTNAME" >"$temporary_file"
  chown root:root "$temporary_file"
  sync -f "$temporary_file"
  mv -f -- "$temporary_file" "$ADMIN_ENV"
  sync -f "$ENV_ROOT"
}

create_admin_environment

runtime_temporary_file="$(mktemp "$ENV_ROOT/.runtime.env.XXXXXX")"
chmod 0600 "$runtime_temporary_file"
{
  write_environment_value SINGBOX_BIN "$SINGBOX_BIN"
  write_environment_value SINGBOX_CONFIG "$STATE_ROOT/runtime/sing-box.json"
  write_environment_value SINGBOX_STATE_DIR "$STATE_ROOT/tailscale"
  write_environment_value SINGBOX_UID "$RUNTIME_UID"
  write_environment_value SINGBOX_GID "$RUNTIME_GID"
  write_environment_value SUB_UID "$SUB_UID_VALUE"
  write_environment_value SUB_GID "$SUB_GID_VALUE"
  write_environment_value ADMIN_UID "$ADMIN_UID_VALUE"
  write_environment_value ADMIN_GID "$ADMIN_GID_VALUE"
} >"$runtime_temporary_file"
chown root:root "$runtime_temporary_file"
mv -f -- "$runtime_temporary_file" "$RUNTIME_ENV"

# Validate a legacy sudoers rule before stopping anything, but remove it only
# after the hardened replacement has passed its routed readiness check.
REMOVE_LEGACY_SUDOERS=no
if path_is_present "$LEGACY_SUDOERS"; then
  if [[ -f "$LEGACY_SUDOERS" && ! -L "$LEGACY_SUDOERS" ]] \
      && grep -Fq '/opt/vpn-sub/ts-ctl.sh' "$LEGACY_SUDOERS"; then
    REMOVE_LEGACY_SUDOERS=yes
  else
    die "$LEGACY_SUDOERS exists but is not the legacy rule expected by this installer; inspect it manually."
  fi
fi

validate_regular_tree() {
  local tree_root="$1"
  local description="$2"
  local unsafe_entry
  [[ -d "$tree_root" && ! -L "$tree_root" ]] \
    || die "$description must be a directory, not a symlink."
  unsafe_entry="$(find "$tree_root" -xdev \
    \( ! -type d ! -type f -o -type f -links +1 \) -print -quit)"
  [[ -z "$unsafe_entry" ]] \
    || die "$description contains an unsupported symlink, special file, or hard link: $unsafe_entry"
}

compare_regular_trees() {
  local source_root="$1"
  local destination_root="$2"
  local source_entry relative_path destination_entry
  while IFS= read -r -d '' source_entry; do
    relative_path="${source_entry#"$source_root"/}"
    destination_entry="$destination_root/$relative_path"
    if [[ -d "$source_entry" ]]; then
      [[ -d "$destination_entry" && ! -L "$destination_entry" ]] \
        || die "The copied Tailscale state is missing directory $relative_path."
    else
      [[ -f "$destination_entry" && ! -L "$destination_entry" ]] \
        || die "The copied Tailscale state is missing file $relative_path."
      cmp -s -- "$source_entry" "$destination_entry" \
        || die "The copied Tailscale state does not match file $relative_path."
    fi
  done < <(find "$source_root" -xdev -mindepth 1 -print0)
  while IFS= read -r -d '' destination_entry; do
    relative_path="${destination_entry#"$destination_root"/}"
    [[ -e "$source_root/$relative_path" && ! -L "$source_root/$relative_path" ]] \
      || die "The copied Tailscale state contains unexpected entry $relative_path."
  done < <(find "$destination_root" -xdev -mindepth 1 -print0)
}

if [[ "$INSTALL_MODE" == migrate ]]; then
  [[ "$MIGRATION_APPROVED" == yes ]] || die "Internal error: legacy migration was not approved."
  STATE_COPY_ALREADY_COMPLETE=no

  if [[ "$COPY_LEGACY_STATE" == yes ]]; then
    [[ -d "$LEGACY_SOURCE_STATE" && ! -L "$LEGACY_SOURCE_STATE" ]] \
      || die "Legacy Tailscale state is missing at $LEGACY_SOURCE_STATE. Restore it from backup before retrying."
    [[ -n "$(find "$LEGACY_SOURCE_STATE" -xdev -mindepth 1 -print -quit)" ]] \
      || die "Legacy Tailscale state at $LEGACY_SOURCE_STATE is empty. Restore it before retrying so the Tailnet identity is not silently replaced."
    if path_is_present "$STATE_ROOT/tailscale"; then
      [[ -d "$STATE_ROOT/tailscale" && ! -L "$STATE_ROOT/tailscale" ]] \
        || die "$STATE_ROOT/tailscale is unsafe; preserve it and inspect it manually."
      if [[ -n "$(find "$STATE_ROOT/tailscale" -mindepth 1 -print -quit)" ]]; then
        if [[ "$MIGRATION_RESUME" == yes ]]; then
          validate_regular_tree "$STATE_ROOT/tailscale" "Previously copied Tailscale state"
          # The legacy service was restored after the failed attempt and may
          # have updated its authoritative state. Re-copy it after stopping the
          # service below instead of trusting this earlier snapshot.
          STATE_COPY_ALREADY_COMPLETE=no
        else
          die "$STATE_ROOT/tailscale already contains data without a migration marker. Preserve it and inspect it manually before retrying."
        fi
      fi
    fi
  else
    validate_regular_tree "$LEGACY_SOURCE_STATE" "Legacy Tailscale state"
    validate_regular_tree "$STATE_ROOT/tailscale" "Pre-copied Tailscale state"
    [[ -n "$(find "$STATE_ROOT/tailscale" -xdev -mindepth 1 -print -quit)" ]] \
      || die "Pre-copied Tailscale state is empty."
    if [[ "$MIGRATION_RESUME" == yes ]]; then
      # The failed candidate and then the restored legacy service can each
      # mutate their own copy. Refresh from the now-authoritative legacy tree
      # after it is stopped below instead of trusting the pre-attempt snapshot.
      STATE_COPY_ALREADY_COMPLETE=no
    else
      compare_regular_trees "$LEGACY_SOURCE_STATE" "$STATE_ROOT/tailscale"
      STATE_COPY_ALREADY_COMPLETE=yes
    fi
  fi

  echo "==> Stopping legacy services before copying their mutable Tailscale state"
  LEGACY_SERVICES_STOPPED=yes
  legacy_sub_active_state="$(query_unit_active_state vpn-sub.service)"
  legacy_singbox_active_state="$(query_unit_active_state sing-box.service)"
  legacy_sub_enablement_state="$(query_upgrade_enablement vpn-sub.service yes yes)"
  legacy_singbox_enablement_state="$(query_upgrade_enablement sing-box.service yes yes)"
  [[ "$legacy_sub_active_state" != active ]] || systemctl stop vpn-sub.service
  [[ "$legacy_singbox_active_state" != active ]] || systemctl stop sing-box.service
  [[ "$legacy_sub_enablement_state" != enabled ]] || systemctl disable vpn-sub.service
  [[ "$legacy_singbox_enablement_state" != enabled ]] || systemctl disable sing-box.service
  legacy_sub_active_state="$(query_unit_active_state vpn-sub.service)"
  legacy_singbox_active_state="$(query_unit_active_state sing-box.service)"
  legacy_sub_enablement_state="$(query_upgrade_enablement vpn-sub.service yes yes)"
  legacy_singbox_enablement_state="$(query_upgrade_enablement sing-box.service yes yes)"
  [[ "$legacy_sub_active_state" == inactive || "$legacy_sub_active_state" == failed ]] \
    || die "vpn-sub.service did not reach a conclusively stopped state."
  [[ "$legacy_singbox_active_state" == inactive || "$legacy_singbox_active_state" == failed ]] \
    || die "sing-box.service did not reach a conclusively stopped state."
  [[ "$legacy_sub_enablement_state" != enabled ]] \
    || die "vpn-sub.service remained enabled during its state handoff."
  [[ "$legacy_singbox_enablement_state" != enabled ]] \
    || die "sing-box.service remained enabled during its state handoff."
  [[ "$(sha256sum "$LEGACY_ENV_FILE" | cut -d' ' -f1)" == "$LEGACY_ENV_DIGEST" ]] \
    || die "$LEGACY_ENV_FILE changed after its reviewed dry run; retry the installer."
  [[ "$(sha256sum "$LEGACY_CONFIG_FILE" | cut -d' ' -f1)" == "$LEGACY_CONFIG_DIGEST" ]] \
    || die "$LEGACY_CONFIG_FILE changed after its reviewed dry run; retry the installer."

  if [[ "$STATE_COPY_ALREADY_COMPLETE" != yes ]]; then
    validate_regular_tree "$LEGACY_SOURCE_STATE" "Legacy Tailscale state"
    MIGRATION_STAGING="$(mktemp -d "$STATE_ROOT/.tailscale-migrate.XXXXXX")"
    chmod 0700 "$MIGRATION_STAGING"
    cp -a -- "$LEGACY_SOURCE_STATE/." "$MIGRATION_STAGING/"
    validate_regular_tree "$MIGRATION_STAGING" "Copied Tailscale state"
    compare_regular_trees "$LEGACY_SOURCE_STATE" "$MIGRATION_STAGING"
    find "$MIGRATION_STAGING" -xdev -exec chown -h vpn-runtime:vpn-runtime {} +
    chmod 0700 "$MIGRATION_STAGING"
    # Recheck at the last destructive boundary in case the source topology was
    # changed after review. Never remove a destination that aliases the only
    # authoritative legacy identity.
    if path_is_present "$STATE_ROOT/tailscale"; then
      validate_regular_tree "$STATE_ROOT/tailscale" "Previously copied Tailscale state"
      assert_distinct_migration_state_trees "$LEGACY_SOURCE_STATE" "$STATE_ROOT/tailscale"
      rm -rf -- "$STATE_ROOT/tailscale"
    fi
    mv -- "$MIGRATION_STAGING" "$STATE_ROOT/tailscale"
    MIGRATION_STAGING=""
  fi
  find "$STATE_ROOT/tailscale" -xdev -exec chown -h vpn-runtime:vpn-runtime {} +
  chmod 0700 "$STATE_ROOT/tailscale"
  if ! path_is_present "$MIGRATION_MARKER/state-copied"; then
    install -o root -g root -m 0600 /dev/null "$MIGRATION_MARKER/state-copied"
    sync -f "$MIGRATION_MARKER/state-copied"
    sync -f "$MIGRATION_MARKER"
    sync -f "$STATE_ROOT"
  fi

  # This override is persisted only after the source tree has been copied and
  # byte-compared. The migration retains the original files plus a private
  # application-level backup under STATE_ROOT/legacy-backups.
  grep -Fq MIGRATION_STATE_DIR "$INSTALL_ROOT/src/migrations/migrate-v1.js" \
    || die "The installed migration module does not support the safe Tailscale state-directory override."
  create_migration_controller_environment "$STATE_ROOT/tailscale"

  echo "==> Final migration preview after the Tailscale state copy"
  inspect_legacy_deployment "$STATE_ROOT/tailscale" "$INSTALL_ROOT/src/migrations/migrate-v1.js"
  if path_is_present "$STATE_ROOT/current" || path_is_present "$STATE_ROOT/runtime"; then
    echo "==> Recovering the already published legacy migration"
    run_legacy_bootstrap 1 existing,recovered "$STATE_ROOT/tailscale" "$INSTALL_ROOT/src/state/bootstrap.js"
  else
    echo "==> Applying the explicitly approved legacy migration"
    # A fully authenticated immutable migration revision may have survived a
    # hard crash before either pointer. Its narrow recovery reports recovered.
    run_legacy_bootstrap 1 migrated,recovered "$STATE_ROOT/tailscale" "$INSTALL_ROOT/src/state/bootstrap.js"
  fi

  [[ -L "$STATE_ROOT/current" && -L "$STATE_ROOT/runtime" ]] \
    || die "Migration did not publish both atomic revision pointers."
  [[ -d "$STATE_ROOT/legacy-backups" ]] \
    && [[ -n "$(find "$STATE_ROOT/legacy-backups" -mindepth 1 -maxdepth 1 -type d -print -quit)" ]] \
    || die "Migration did not preserve a private backup of the legacy configuration."
  [[ "$(sha256sum "$LEGACY_ENV_FILE" | cut -d' ' -f1)" == "$LEGACY_ENV_DIGEST" ]] \
    || die "$LEGACY_ENV_FILE changed during migration."
  [[ "$(sha256sum "$LEGACY_CONFIG_FILE" | cut -d' ' -f1)" == "$LEGACY_CONFIG_DIGEST" ]] \
    || die "$LEGACY_CONFIG_FILE changed during migration."
  MIGRATION_STATE_WAS_PUBLISHED=no
  if path_is_present "$MIGRATION_MARKER/state-published"; then
    MIGRATION_STATE_WAS_PUBLISHED=yes
  fi
  MIGRATION_API_KEY_FILE=""
  if [[ -s "$API_KEY_PATH" ]]; then
    MIGRATION_API_KEY_FILE="$API_KEY_PATH"
  fi
  env -i \
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    "DATA_DIR=$STATE_ROOT" \
    "EXPECTED_STATE_DIRECTORY=$STATE_ROOT/tailscale" \
    "MIGRATION_LINEAGE_FILE=$MIGRATION_MARKER/lineage.json" \
    "MIGRATION_STATE_PUBLISHED=$MIGRATION_STATE_WAS_PUBLISHED" \
    "LEGACY_ENV_FILE=$LEGACY_ENV_FILE" \
    "LEGACY_CONFIG_FILE=$LEGACY_CONFIG_FILE" \
    "VPN_PUBLIC_HOSTNAME=$VPN_PUBLIC_HOSTNAME" \
    "SUBSCRIPTION_PUBLIC_BASE_URL=$SUBSCRIPTION_PUBLIC_BASE_URL" \
    "ADMIN_PUBLIC_HOSTNAME=$ADMIN_PUBLIC_HOSTNAME" \
    "WS_PATH=$WS_PATH" \
    "EGRESS_HEALTH_HOST=$EGRESS_HEALTH_HOST" \
    "TS_API_KEY_FILE=$MIGRATION_API_KEY_FILE" \
    "RUNTIME_GID=$RUNTIME_GID" \
    "SUB_GID=$SUB_GID_VALUE" \
    "$NODE_BIN" --input-type=module --eval '
      import { RevisionRepository } from "/opt/vpn-gateway/src/state/repository.js";
      import { assertLegacyV1MigrationLineage } from "/opt/vpn-gateway/src/migrations/migrate-v1.js";
      const repository = new RevisionRepository(process.env.DATA_DIR, {
        runtimeGid: Number(process.env.RUNTIME_GID),
        subscriptionGid: Number(process.env.SUB_GID),
      });
      await assertLegacyV1MigrationLineage({
        dataDir: process.env.DATA_DIR,
        envPath: process.env.LEGACY_ENV_FILE,
        configPath: process.env.LEGACY_CONFIG_FILE,
        fallbackEnvironment: process.env,
        expectedStateDirectory: process.env.EXPECTED_STATE_DIRECTORY,
        lineagePath: process.env.MIGRATION_LINEAGE_FILE,
        statePublished: process.env.MIGRATION_STATE_PUBLISHED === "yes",
        repository,
      });
    '
  validate_migration_marker_file "$MIGRATION_MARKER/lineage.json"
  sync -f "$MIGRATION_MARKER/lineage.json"
  sync -f "$MIGRATION_MARKER"
  if ! path_is_present "$MIGRATION_MARKER/state-published"; then
    install -o root -g root -m 0600 /dev/null "$MIGRATION_MARKER/state-published"
    sync -f "$MIGRATION_MARKER/state-published"
    sync -f "$MIGRATION_MARKER"
    sync -f "$STATE_ROOT"
  fi
fi

for unit_file in "${UNIT_FILES[@]}"; do
  install -o root -g root -m 0644 "$REPO_DIR/deploy/systemd/$unit_file" "$SYSTEMD_ROOT/$unit_file"
done

systemd-analyze verify "${UNIT_FILES[@]/#/$SYSTEMD_ROOT/}"

systemctl daemon-reload
# The controller owns sing-box startup because its recovery transaction must
# select/validate the runtime revision before starting the data plane. Remove
# any stale enablement link from an earlier deployment so target startup cannot
# race the controller's fixed `systemctl restart` operation.
systemctl disable vpn-gateway-sing-box.service >/dev/null 2>&1 \
  || die "Could not keep vpn-gateway-sing-box.service disabled."
gateway_singbox_enablement="$(query_upgrade_enablement vpn-gateway-sing-box.service yes)"
[[ "$gateway_singbox_enablement" != enabled ]] \
  || die "vpn-gateway-sing-box.service remained enabled."

disable_legacy_unit_if_present() {
  local unit_name="$1"
  local label="$2"
  local active_state enablement_state
  active_state="$(query_unit_active_state "$unit_name")"
  enablement_state="$(query_upgrade_enablement "$unit_name" yes yes)"
  if [[ "$active_state" == active || "$enablement_state" == enabled ]]; then
    echo "==> Disabling $label"
    systemctl disable --now "$unit_name"
  fi
  active_state="$(query_unit_active_state "$unit_name")"
  enablement_state="$(query_upgrade_enablement "$unit_name" yes yes)"
  [[ "$active_state" == inactive || "$active_state" == failed ]] \
    || die "$unit_name remained active after disable."
  [[ "$enablement_state" != enabled ]] \
    || die "$unit_name remained enabled after disable."
}

disable_legacy_unit_if_present vpn-sub.service "the legacy subscription unit"
disable_legacy_unit_if_present sing-box.service "the legacy sing-box unit to avoid a port conflict"

verify_bare_loopback_origins() {
  env -i \
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    "VPN_PUBLIC_HOSTNAME=$VPN_PUBLIC_HOSTNAME" \
    "WS_PATH=$WS_PATH" \
    "$NODE_BIN" --input-type=module --eval '
      import { randomBytes } from "node:crypto";
      import { readFile } from "node:fs/promises";
      import http from "node:http";

      const listenAddresses = new Map();
      for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
        const family = table.endsWith("6") ? 6 : 4;
        let text;
        try {
          text = await readFile(table, "utf8");
        } catch (error) {
          if (family === 6 && error?.code === "ENOENT") continue;
          throw error;
        }
        for (const line of text.trim().split("\n").slice(1)) {
          const columns = line.trim().split(/\s+/u);
          if (columns[3] !== "0A") continue;
          const [address, portHex] = columns[1].split(":");
          const port = Number.parseInt(portHex, 16);
          const records = listenAddresses.get(port) ?? [];
          records.push({ family, address });
          listenAddresses.set(port, records);
        }
      }
      if ((listenAddresses.get(443) ?? []).length !== 0) {
        throw new Error("TCP 443 is listening on the origin host");
      }
      for (const port of [8443, 8080, 8081, 20241]) {
        const records = listenAddresses.get(port) ?? [];
        if (records.length < 1 || records.some(({ family, address }) => family !== 4 || address !== "0100007F")) {
          throw new Error("TCP " + port + " is not exclusively bound to IPv4 loopback");
        }
      }

      const request = (options, expectUpgrade = false) => new Promise((resolve, reject) => {
        const req = http.request({
          host: "127.0.0.1",
          port: 8443,
          timeout: 5000,
          ...options,
        });
        req.once("timeout", () => req.destroy(new Error("origin request timed out")));
        req.once("error", (error) => {
          if (expectUpgrade) reject(error);
          else resolve("closed");
        });
        req.once("response", (response) => {
          response.resume();
          if (expectUpgrade) reject(new Error("canonical WebSocket path did not upgrade"));
          else resolve(response.statusCode);
        });
        req.once("upgrade", (_response, socket) => {
          socket.destroy();
          if (expectUpgrade) resolve(101);
          else reject(new Error("ordinary request unexpectedly upgraded"));
        });
        req.end();
      });

      const rejectedStatus = await request({
        method: "GET",
        path: "/__vpn_gateway_invalid_websocket_path__",
        headers: { Host: process.env.VPN_PUBLIC_HOSTNAME },
      });
      if (rejectedStatus !== "closed" && (!Number.isInteger(rejectedStatus) || rejectedStatus < 400)) {
        throw new Error("incorrect WebSocket path was not rejected");
      }
      const ordinaryStatus = await request({
        method: "GET",
        path: process.env.WS_PATH,
        headers: { Host: process.env.VPN_PUBLIC_HOSTNAME },
      });
      if (ordinaryStatus !== "closed" && (!Number.isInteger(ordinaryStatus) || ordinaryStatus < 400)) {
        throw new Error("ordinary HTTP request on the canonical WebSocket path was not rejected");
      }
      await request({
        method: "GET",
        path: process.env.WS_PATH,
        headers: {
          Host: process.env.VPN_PUBLIC_HOSTNAME,
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
          "Sec-WebSocket-Version": "13",
        },
      }, true);
    '
}

if [[ "$INSTALL_MODE" == existing ]]; then
  echo "==> Starting the hardened service set with boot enablement held until readiness"
elif [[ "$INSTALL_MODE" == migrate ]]; then
  echo "==> Starting the migration candidate with boot enablement held until commit"
  hold_migration_target_disabled
else
  echo "==> Enabling and starting the hardened service set"
  systemctl enable vpn-gateway.target
fi
systemctl restart vpn-gateway.target

for service_name in \
  vpn-gateway-controller.service \
  vpn-gateway-sing-box.service \
  vpn-gateway-subscription.service \
  vpn-gateway-admin.service \
  vpn-gateway-tunnel.service; do
  systemctl is-active --quiet "$service_name" \
    || die "$service_name did not become active; inspect it with journalctl -u $service_name."
done

echo "==> Waiting for the routed data-path readiness check"
gateway_ready=no
for ((attempt = 1; attempt <= 45; attempt += 1)); do
  if "$NODE_BIN" "$INSTALL_ROOT/src/runtime/healthcheck.js" >/dev/null 2>&1; then
    gateway_ready=yes
    break
  fi
  systemctl is-active --quiet vpn-gateway-controller.service \
    || die "vpn-gateway-controller.service stopped during its readiness check."
  sleep 2
done
[[ "$gateway_ready" == yes ]] \
  || die "The gateway did not become ready; inspect vpn-gateway-controller.service and vpn-gateway-sing-box.service."

echo "==> Verifying the Cloudflare edge connection and loopback-only origins"
timeout 10s "$CLOUDFLARED_BIN" tunnel --metrics 127.0.0.1:20241 ready >/dev/null \
  || die "cloudflared is running but its local readiness endpoint has no active edge connection."
verify_bare_loopback_origins \
  || die "The bare-metal listeners or local WebSocket origin failed their isolation check."

if [[ "$INSTALL_MODE" == migrate ]]; then
  # The committed marker makes the migration authoritative across reboot. Make
  # the independently mounted code, environment, and unit trees durable before
  # publishing that marker so it can never outlive a partially persisted
  # deployment after power loss.
  sync -f /opt
  sync -f /etc
  sync -f "$SYSTEMD_ROOT"
  if [[ -d "$SYSTEMD_ROOT/multi-user.target.wants" \
      && ! -L "$SYSTEMD_ROOT/multi-user.target.wants" ]]; then
    sync -f "$SYSTEMD_ROOT/multi-user.target.wants"
  fi
  [[ ! -e "$MIGRATION_COMMITTED_MARKER" && ! -L "$MIGRATION_COMMITTED_MARKER" ]] \
    || die "$MIGRATION_COMMITTED_MARKER unexpectedly appeared during migration."
  if ! path_is_present "$MIGRATION_MARKER/committed"; then
    install -o root -g root -m 0600 /dev/null "$MIGRATION_MARKER/committed"
  else
    validate_migration_marker_file "$MIGRATION_MARKER/committed"
  fi
  sync -f "$MIGRATION_MARKER/committed"
  sync -f "$MIGRATION_MARKER"
  mv -- "$MIGRATION_MARKER/committed" "$MIGRATION_COMMITTED_MARKER"
  sync -f "$STATE_ROOT"
  DEPLOYMENT_HANDOFF_COMPLETE=yes
  COMMITTED_MIGRATION_CLEANUP=yes
  cleanup_committed_migration_work
  systemctl enable vpn-gateway.target
  sync -f "$SYSTEMD_ROOT"
  if [[ -d "$SYSTEMD_ROOT/multi-user.target.wants" \
      && ! -L "$SYSTEMD_ROOT/multi-user.target.wants" ]]; then
    sync -f "$SYSTEMD_ROOT/multi-user.target.wants"
  fi
  [[ "$(query_upgrade_enablement vpn-gateway.target no)" == enabled ]] \
    || die "The committed gateway target could not be enabled for boot."
elif [[ "$INSTALL_MODE" == existing ]]; then
  # The rollback journal lives under /var. Flush the independently mounted
  # code and configuration trees before allowing that journal to commit.
  sync -f /opt
  sync -f /etc
  systemctl enable vpn-gateway.target
  sync -f "$SYSTEMD_ROOT"
  if [[ -d "$SYSTEMD_ROOT/multi-user.target.wants" \
      && ! -L "$SYSTEMD_ROOT/multi-user.target.wants" ]]; then
    sync -f "$SYSTEMD_ROOT/multi-user.target.wants"
  fi
  commit_upgrade_rollback_transaction
  DEPLOYMENT_HANDOFF_COMPLETE=yes
else
  DEPLOYMENT_HANDOFF_COMPLETE=yes
fi

if [[ "$REMOVE_LEGACY_SUDOERS" == yes ]]; then
  rm -f -- "$LEGACY_SUDOERS"
  echo "==> Removed the legacy vpn-sub passwordless sudo rule"
fi
if [[ -n "$UPGRADE_BACKUP" ]]; then
  echo "==> Previous deployment retained for manual rollback at $UPGRADE_BACKUP"
fi

cat <<EOF

Deployment complete.

  Public VPN endpoint:   https://$VPN_PUBLIC_HOSTNAME:443 (Cloudflare edge)
  Local VLESS origin:    http://127.0.0.1:8443 (WebSocket only)
  Local subscriptions:   http://127.0.0.1:8080
  Local administration:  http://127.0.0.1:8081
  Administration URL:    https://$ADMIN_PUBLIC_HOSTNAME
  Tunnel metrics:        http://127.0.0.1:20241 (local only)

All origins intentionally listen only on loopback. Cloudflare must be the only
public ingress; do not expose or forward ports 8443, 8080, 8081, or 20241.

If /var/lib/vpn-gateway/admin-secret exists after first initialization, retrieve
the generated administrator secret once with:
  sudo cat /var/lib/vpn-gateway/admin-secret

Store it securely. After vaulting it, deleting that root-only handoff file is
supported; the external copy is then the only way to authenticate. Rerunning
this installer preserves the credential hash and all revision state.
EOF
