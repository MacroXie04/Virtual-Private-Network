# shellcheck shell=bash
# Inspect existing paths, deferred recovery work, and installation mode.

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

# Reject unsupported deployments without opening their configuration or changing
# their services. This installer owns only the vpn-gateway service namespace.
reject_retired_deployment() {
  local retired_path retired_unit load_state
  for retired_path in /etc/vpn-sub.env /etc/sing-box/config.json \
    /var/lib/sing-box/tailscale /etc/sudoers.d/vpn-sub; do
    if path_is_present "$retired_path"; then
      die "Unsupported previous deployment at $retired_path. Preserve it and use a new data directory on a separate host or container for a fresh installation."
    fi
  done
  for retired_unit in vpn-sub.service sing-box.service; do
    load_state="$(LC_ALL=C systemctl show "$retired_unit" --property=LoadState --value)" \
      || die "Could not safely inspect $retired_unit; no deployment services were changed."
    [[ "$load_state" == not-found ]] \
      || die "Existing $retired_unit is outside this installer service namespace. Preserve it and use a separate host or container with a new data directory."
  done
}

reject_retired_deployment
if [[ "$UPGRADE_RESTART_RECOVERY_REQUIRED" == yes \
    || "$UPGRADE_ROLLBACK_RECOVERY_REQUIRED" == yes ]]; then
  # Pending journal replay can own dangling or temporarily absent pointers.
  # Validate its backup before any restoration; do not reinterpret these as a
  # fresh deployment or inspect the incomplete live pointer set here.
  assert_supported_data_directory "$STATE_ROOT" no \
    || die "Unsupported or unsafe data directory. Preserve it and use a new data directory for a fresh installation."
else
  assert_supported_data_directory "$STATE_ROOT" \
    || die "Unsupported or unsafe state. Preserve it and use a new data directory for a fresh installation."
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

# Current revision recovery owns pointer loss; never initialize over old data.
INSTALL_MODE=fresh
if [[ "$UPGRADE_RESTART_RECOVERY_REQUIRED" == yes \
    || "$UPGRADE_ROLLBACK_RECOVERY_REQUIRED" == yes ]]; then
  INSTALL_MODE=existing
elif path_is_present "$STATE_ROOT/current" || path_is_present "$STATE_ROOT/runtime"; then
  INSTALL_MODE=existing
elif [[ -d "$STATE_ROOT/revisions" ]] \
    && [[ -n "$(find "$STATE_ROOT/revisions" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  die "Revision files exist without a current or runtime pointer. Preserve $STATE_ROOT and restore a pointer from a verified backup before retrying."
fi
readonly INSTALL_MODE

# This fixed child is intentionally owned by the unprivileged runtime user, so
# it cannot use the root-only fixed-directory validator above. Validate it
# before user creation, service stops, or the later `install -d` call could
# follow a planted symlink and change an unrelated directory.
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
  if [[ "$tailscale_owner" != 11000 ]]; then
    die "$STATE_ROOT/tailscale must be owned by vpn-runtime uid 11000 before deployment."
  fi
fi
