# shellcheck shell=bash
# Review legacy configuration and require the explicit migration choice.

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
  local migration_module="${2:-$REPO_DIR/src/migrations/legacy-v1-source.js}"
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
  local bootstrap_module="${4:-$REPO_DIR/src/state/bootstrap-service.js}"
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
