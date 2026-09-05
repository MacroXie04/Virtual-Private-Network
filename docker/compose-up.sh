#!/bin/sh
set -eu

umask 077

PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

fail() {
  echo "Docker deployment preflight failed: $1" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] \
  || fail "run this deployment preflight as root (for example, with sudo)."

SCRIPT_ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)"
PROJECT_ROOT="$(dirname -- "$SCRIPT_ROOT")"
readonly SCRIPT_ROOT PROJECT_ROOT

token_file="${CLOUDFLARE_TUNNEL_TOKEN_FILE:-}"
if [ -z "$token_file" ]; then
  env_file="$PROJECT_ROOT/.env"
  [ -f "$env_file" ] && [ ! -L "$env_file" ] \
    || fail "CLOUDFLARE_TUNNEL_TOKEN_FILE is unset and a regular .env file is unavailable."
  token_count="$(grep -c '^CLOUDFLARE_TUNNEL_TOKEN_FILE=' "$env_file" || true)"
  [ "$token_count" = 1 ] \
    || fail ".env must contain exactly one unquoted CLOUDFLARE_TUNNEL_TOKEN_FILE assignment."
  token_file="$(sed -n 's/^CLOUDFLARE_TUNNEL_TOKEN_FILE=//p' "$env_file")"
fi

case "$token_file" in
  /*) ;;
  *) fail "CLOUDFLARE_TUNNEL_TOKEN_FILE must be an absolute path." ;;
esac
case "$token_file" in
  *[!A-Za-z0-9_./-]*)
    fail "CLOUDFLARE_TUNNEL_TOKEN_FILE must be an unquoted normalized path using safe characters."
    ;;
esac

command -v stat >/dev/null 2>&1 || fail "GNU stat is required."
command -v readlink >/dev/null 2>&1 || fail "GNU readlink is required."
canonical_token_file="$(readlink -f -- "$token_file" 2>/dev/null || true)"
[ -n "$canonical_token_file" ] && [ "$canonical_token_file" = "$token_file" ] \
  || fail "the Tunnel token path must exist, be normalized, and contain no symbolic-link component."
[ -f "$token_file" ] && [ ! -L "$token_file" ] && [ -s "$token_file" ] \
  || fail "the Tunnel token must be a non-empty regular file, not a symbolic link."

# Docker opens the bind source after this process validates it. Require a
# root-controlled ancestor chain so an unprivileged user cannot exchange the
# pathname between validation and the daemon's later open.
token_parent="$(dirname -- "$token_file")"
while :; do
  [ -d "$token_parent" ] && [ ! -L "$token_parent" ] \
    || fail "every Tunnel token parent must be a real directory."
  parent_stat="$(stat -c '%u:%a' -- "$token_parent" 2>/dev/null)" \
    || fail "Tunnel token parent metadata could not be inspected."
  parent_owner="${parent_stat%%:*}"
  parent_mode="${parent_stat##*:}"
  [ "$parent_owner" = 0 ] \
    || fail "every Tunnel token parent must be owned by root."
  case "$parent_mode" in
    [0-7][0-7][0-7]|[0-7][0-7][0-7][0-7]) ;;
    *) fail "Tunnel token parent permissions are invalid." ;;
  esac
  [ $((0$parent_mode & 022)) -eq 0 ] \
    || fail "Tunnel token parents must not be writable by group or other."
  [ "$token_parent" = / ] && break
  token_parent="$(dirname -- "$token_parent")"
done

token_stat="$(stat -c '%u:%a:%h:%s' -- "$token_file" 2>/dev/null)" \
  || fail "the Tunnel token metadata could not be inspected."
token_owner="${token_stat%%:*}"
token_remainder="${token_stat#*:}"
token_mode="${token_remainder%%:*}"
token_remainder="${token_remainder#*:}"
token_links="${token_remainder%%:*}"
token_size="${token_remainder##*:}"

[ "$token_owner" = 0 ] \
  || fail "the Tunnel token must be owned by root."
{ [ "$token_mode" = 400 ] || [ "$token_mode" = 600 ]; } \
  || fail "the Tunnel token mode must be 0400 or 0600."
[ "$token_links" = 1 ] \
  || fail "the Tunnel token must have exactly one hard link."
case "$token_size" in
  ''|*[!0-9]*) fail "the Tunnel token size is invalid." ;;
esac
[ "$token_size" -gt 0 ] && [ "$token_size" -le 4096 ] \
  || fail "the Tunnel token must be between 1 and 4096 bytes."

# Export only the validated path. The credential value is never placed in the
# environment or command line; cloudflared receives an inherited descriptor.
export CLOUDFLARE_TUNNEL_TOKEN_FILE="$token_file"
cd "$PROJECT_ROOT"
if [ "$#" -eq 0 ]; then
  set -- --detach --build --wait
fi
exec docker compose --project-directory "$PROJECT_ROOT" \
  -f "$PROJECT_ROOT/docker-compose.yml" up "$@"
