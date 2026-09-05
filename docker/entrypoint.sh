#!/bin/sh
set -eu

umask 077

readonly DATA_ROOT="${DATA_DIR:-/data}"
readonly SOCKET_PATH="${CONTROLLER_SOCKET:-/run/vpn-gateway/controller.sock}"
SOCKET_ROOT="$(dirname "$SOCKET_PATH")"
readonly SOCKET_ROOT

if [ "$(id -u)" -ne 0 ]; then
  echo "The container controller must start as root so it can initialize state and drop child identities." >&2
  exit 1
fi
if [ "$DATA_ROOT" != /data ] || [ "$SOCKET_ROOT" != /run/vpn-gateway ]; then
  echo "The container requires DATA_DIR=/data and CONTROLLER_SOCKET below /run/vpn-gateway." >&2
  exit 1
fi
if [ "${NODE_HOST:-127.0.0.1}" != 127.0.0.1 ] \
    || [ "${NODE_PORT:-8443}" != 8443 ] \
    || [ "${SUB_HOST:-127.0.0.1}" != 127.0.0.1 ] \
    || [ "${SUB_PORT:-8080}" != 8080 ] \
    || [ "${ADMIN_HOST:-127.0.0.1}" != 127.0.0.1 ] \
    || [ "${ADMIN_PORT:-8081}" != 8081 ]; then
  echo "Container listeners must use the fixed loopback-only Cloudflare Tunnel origins." >&2
  exit 1
fi

assert_identity() {
  name="$1"
  expected_uid="$2"
  expected_gid="$3"
  actual_uid="$(id -u "$name")"
  actual_gid="$(id -g "$name")"
  if [ "$actual_uid" != "$expected_uid" ] || [ "$actual_gid" != "$expected_gid" ]; then
    echo "Container identity $name does not match configured uid/gid $expected_uid:$expected_gid." >&2
    exit 1
  fi
}

assert_identity vpn-runtime "${SINGBOX_UID:-11000}" "${SINGBOX_GID:-11000}"
assert_identity vpn-sub "${SUB_UID:-11001}" "${SUB_GID:-11001}"
assert_identity vpn-admin "${ADMIN_UID:-11002}" "${ADMIN_GID:-11002}"

# The named volume can be attached to more than one container, while /run is
# private to each container. Secure the volume root, create a non-replaceable
# lock inode, and hold its advisory lock on fd 9 across the final exec. This is
# acquired before creating revision/state subdirectories or invoking bootstrap.
if [ ! -e "$DATA_ROOT" ] && [ ! -L "$DATA_ROOT" ]; then
  mkdir -p "$DATA_ROOT"
fi
if [ ! -d "$DATA_ROOT" ] || [ -L "$DATA_ROOT" ]; then
  echo "$DATA_ROOT must be a directory, not a symlink." >&2
  exit 1
fi
chown root:root "$DATA_ROOT"
chmod 0751 "$DATA_ROOT"

readonly CONTROLLER_LOCK="$DATA_ROOT/controller.lock"
if [ ! -e "$CONTROLLER_LOCK" ] && [ ! -L "$CONTROLLER_LOCK" ]; then
  if ! (set -C; umask 077; : >"$CONTROLLER_LOCK") 2>/dev/null \
      && [ ! -e "$CONTROLLER_LOCK" ] && [ ! -L "$CONTROLLER_LOCK" ]; then
    echo "Could not create the controller volume lock safely." >&2
    exit 1
  fi
fi
if [ ! -f "$CONTROLLER_LOCK" ] || [ -L "$CONTROLLER_LOCK" ] \
    || [ "$(stat -c '%u:%a:%h' "$CONTROLLER_LOCK")" != 0:600:1 ]; then
  echo "$CONTROLLER_LOCK must be a root-owned, singly linked regular file with mode 0600." >&2
  exit 1
fi
exec 9<"$CONTROLLER_LOCK"
if ! /usr/bin/flock -n 9; then
  echo "Another VPN gateway controller already owns this data volume." >&2
  exit 1
fi
lock_path_identity="$(stat -c '%d:%i:%u:%a:%h' "$CONTROLLER_LOCK")"
lock_fd_identity="$(stat -Lc '%d:%i:%u:%a:%h' /proc/self/fd/9)"
if [ "$lock_path_identity" != "$lock_fd_identity" ] || [ "$lock_fd_identity" != "${lock_fd_identity%:*}:1" ]; then
  echo "The controller volume lock changed while it was acquired." >&2
  exit 1
fi

assert_private_secret() {
  secret_path="$1"
  label="$2"
  if [ ! -f "$secret_path" ] || [ -L "$secret_path" ] || [ ! -s "$secret_path" ]; then
    echo "$label must be a non-empty regular file, not a symlink." >&2
    exit 1
  fi
  secret_owner="$(stat -c '%u' "$secret_path")"
  secret_mode="$(stat -c '%a' "$secret_path")"
  secret_links="$(stat -c '%h' "$secret_path")"
  if [ "$secret_owner" != 0 ] || [ "$secret_links" != 1 ] \
      || { [ "$secret_mode" != 400 ] && [ "$secret_mode" != 600 ]; }; then
    echo "$label must be singly linked, owned by root, and have mode 0400 or 0600." >&2
    exit 1
  fi
}

# Bootstrap reads credentials only for a genuinely fresh volume. Existing v2
# pointers are self-contained, and a v1 volume carries its credential in the
# legacy configuration. This permits initialized containers to restart after
# the one-time host auth-key file has been removed.
bootstrap_credentials_required=yes
v2_state_present=no
legacy_state_present=no
for state_marker in "$DATA_ROOT/current" "$DATA_ROOT/runtime"; do
  if [ -e "$state_marker" ] || [ -L "$state_marker" ]; then
    v2_state_present=yes
  fi
done
for state_marker in "$DATA_ROOT/env" "$DATA_ROOT/config.json"; do
  if [ -e "$state_marker" ] || [ -L "$state_marker" ]; then
    legacy_state_present=yes
  fi
done
for state_marker in \
  "$DATA_ROOT/current" \
  "$DATA_ROOT/runtime" \
  "$DATA_ROOT/env" \
  "$DATA_ROOT/config.json"; do
  if [ -e "$state_marker" ] || [ -L "$state_marker" ]; then
    bootstrap_credentials_required=no
    break
  fi
done

# A pointer-loss crash is not a fresh volume. Let bootstrap inspect the
# immutable revision namespace and emit its fail-closed ORPHANED_REVISION
# diagnosis without demanding a retired enrollment key first. Any unsafe or
# otherwise invalid namespace still fails independently below/in bootstrap.
if [ -d "$DATA_ROOT/revisions" ] && [ ! -L "$DATA_ROOT/revisions" ]; then
  for revision_candidate in "$DATA_ROOT"/revisions/*; do
    [ -d "$revision_candidate" ] && [ ! -L "$revision_candidate" ] || continue
    canonical_revision_name="${revision_candidate##*/}"
    if [ "${#canonical_revision_name}" -eq 33 ] \
        && printf '%s\n' "$canonical_revision_name" \
        | grep -Eq '^[0-9]{16}-[0-9a-f]{16}$'; then
      v2_state_present=yes
      bootstrap_credentials_required=no
      break
    fi
  done
fi

if [ -n "${TS_AUTH_KEY_FILE:-}" ] && [ -s "$TS_AUTH_KEY_FILE" ]; then
  assert_private_secret "$TS_AUTH_KEY_FILE" TS_AUTH_KEY_FILE
elif [ "$bootstrap_credentials_required" = yes ]; then
  echo "A fresh data volume requires TS_AUTH_KEY_FILE to name a non-empty root-owned secret file." >&2
  exit 1
else
  unset TS_AUTH_KEY_FILE
fi
if [ -n "${TS_API_KEY_FILE:-}" ]; then
  if [ -s "$TS_API_KEY_FILE" ]; then
    assert_private_secret "$TS_API_KEY_FILE" TS_API_KEY_FILE
  else
    unset TS_API_KEY_FILE
  fi
fi

# Only bootstrap/controller write revisions. The subscription process can
# traverse a published revision but can read only its group-owned projection.
for state_directory in "$DATA_ROOT/revisions" "$DATA_ROOT/tailscale"; do
  if [ -e "$state_directory" ] || [ -L "$state_directory" ]; then
    if [ ! -d "$state_directory" ] || [ -L "$state_directory" ]; then
      echo "$state_directory must be a directory, not a symlink." >&2
      exit 1
    fi
  else
    mkdir "$state_directory"
  fi
done
if [ -e "$SOCKET_ROOT" ] || [ -L "$SOCKET_ROOT" ]; then
  if [ ! -d "$SOCKET_ROOT" ] || [ -L "$SOCKET_ROOT" ]; then
    echo "$SOCKET_ROOT must be a directory, not a symlink." >&2
    exit 1
  fi
else
  mkdir -p "$SOCKET_ROOT"
fi
chown root:root "$DATA_ROOT/revisions"
chmod 0751 "$DATA_ROOT/revisions"

# Version 1 ran as root, including its persistent tsnet identity. Before the
# first migration bootstrap, reject unsafe entries and hand that whole tree to
# the dedicated runtime identity. Once v2 pointers exist, this recursive step
# is never repeated.
chown -h root:root "$DATA_ROOT/tailscale"
chmod 0700 "$DATA_ROOT/tailscale"
unsafe_state_entry="$(find "$DATA_ROOT/tailscale" -xdev \
  \( ! -type d ! -type f -o -type f -links +1 \) -print -quit)"
if [ -n "$unsafe_state_entry" ]; then
  echo "The Tailscale state contains an unsafe symlink, special file, or hard link: $unsafe_state_entry" >&2
  exit 1
fi
if [ "$legacy_state_present" = yes ] && [ "$v2_state_present" = no ]; then
  legacy_state_directory="$(
    env -i \
      PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
      LEGACY_ENV_FILE="$DATA_ROOT/env" \
      LEGACY_CONFIG_FILE="$DATA_ROOT/config.json" \
      node --input-type=module --eval '
        import { inspectLegacyV1 } from "/app/src/migrate-v1.js";
        const inspection = await inspectLegacyV1({
          envPath: process.env.LEGACY_ENV_FILE,
          configPath: process.env.LEGACY_CONFIG_FILE,
        });
        process.stdout.write(inspection.legacyConfig.stateDirectory);
      '
  )"
  if [ "$legacy_state_directory" != "$DATA_ROOT/tailscale" ]; then
    echo "Docker legacy migration requires state_directory=$DATA_ROOT/tailscale; found $legacy_state_directory." >&2
    exit 1
  fi
  if [ -z "$(find "$DATA_ROOT/tailscale" -xdev -mindepth 1 -print -quit)" ]; then
    echo "Docker legacy migration requires a non-empty $DATA_ROOT/tailscale tree so it cannot silently enroll a replacement Tailnet identity." >&2
    exit 1
  fi
  echo "Handing the validated legacy Tailscale state to vpn-runtime."
  find "$DATA_ROOT/tailscale" -xdev -exec chown -h vpn-runtime:vpn-runtime {} +
else
  chown -h vpn-runtime:vpn-runtime "$DATA_ROOT/tailscale"
fi
chmod 0700 "$DATA_ROOT/tailscale"
chown root:vpn-admin "$SOCKET_ROOT"
chmod 0750 "$SOCKET_ROOT"

# This entrypoint is the single lifecycle owner for the container. A prior
# unclean stop may leave its socket inode behind, but no other file is safe to
# replace and the controller itself intentionally refuses split-brain cleanup.
if [ -e "$SOCKET_PATH" ] || [ -L "$SOCKET_PATH" ]; then
  if [ -L "$SOCKET_PATH" ] || [ ! -S "$SOCKET_PATH" ]; then
    echo "The controller socket path is occupied by an unsafe file." >&2
    exit 1
  fi
  rm -f -- "$SOCKET_PATH"
fi

for file in /app/src/bootstrap.js /app/src/controller-server.js /app/src/subscription-server.js /app/src/admin-server.js /app/src/healthcheck.js; do
  if [ ! -r "$file" ]; then
    echo "Missing application entrypoint: $file" >&2
    exit 1
  fi
done

node /app/src/bootstrap.js
exec node /app/src/controller-server.js
