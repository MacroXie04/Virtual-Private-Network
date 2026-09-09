# shellcheck shell=bash
# Run pending recovery before auditing the tunnel identity or canonical settings.

recover_interrupted_upgrade_restart
recover_interrupted_upgrade_rollback

assert_supported_data_directory "$STATE_ROOT" \
  || die "Unsupported or unsafe restored state. Preserve it and use a new data directory for a fresh installation."

if [[ "$TUNNEL_TOKEN_RECOVERY_PENDING" == yes ]]; then
  if [[ -n "${CLOUDFLARE_TUNNEL_TOKEN_FILE:-}" ]]; then
    validate_cloudflare_tunnel_token_file \
      "$CLOUDFLARE_TUNNEL_TOKEN_FILE" CLOUDFLARE_TUNNEL_TOKEN_FILE
  elif path_is_present "$TUNNEL_TOKEN_PATH"; then
    validate_cloudflare_tunnel_token_file \
      "$TUNNEL_TOKEN_PATH" "Restored Cloudflare Tunnel token"
  else
    die "The predecessor deployment was recovered. Rerun with CLOUDFLARE_TUNNEL_TOKEN_FILE pointing to a protected Tunnel token file to begin the upgrade."
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

if [[ "$INSTALL_MODE" == existing ]]; then
  current_state_inspection="$(inspect_current_state_for_installer)" \
    || die "Could not safely inspect the active revision before upgrade."
  current_state_schema="$(read_installer_json_field "$current_state_inspection" schemaVersion)" \
    || die "Could not identify the active state schema."
  [[ "$current_state_schema" == 3 ]] \
    || die "Unsupported state schema; preserve the existing deployment and use a new data directory for a fresh installation."
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
fi
