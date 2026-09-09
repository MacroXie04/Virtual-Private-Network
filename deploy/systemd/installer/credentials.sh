# shellcheck shell=bash
# Read private credentials safely and generate controller environment files.

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

create_existing_controller_environment() {
  local temporary_file
  temporary_file="$(mktemp "$ENV_ROOT/.controller.env.XXXXXX")"
  chmod 0600 "$temporary_file"
  {
    write_environment_value TS_AUTH_KEY_FILE "$AUTH_KEY_PATH"
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
