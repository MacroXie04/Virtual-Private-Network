# shellcheck shell=bash
# Preserve migration credentials and publish deployment environment files.

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
    "BOOTSTRAP_MODULE=$INSTALL_ROOT/src/state/bootstrap-files.js" \
    "MIGRATION_MODULE=$INSTALL_ROOT/src/migrations/legacy-v1-source.js" \
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
    if [[ -n "${TS_API_KEY_FILE:-}" ]]; then
      create_secret_file "$API_KEY_PATH" TS_API_KEY_FILE "Tailscale API access token" yes
    fi
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
