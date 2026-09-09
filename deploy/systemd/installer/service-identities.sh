# shellcheck shell=bash
# Establish isolated runtime, subscription, and administrator identities.

if command -v nologin >/dev/null 2>&1; then
  NOLOGIN_SHELL="$(command -v nologin)"
  readonly NOLOGIN_SHELL
elif [[ -x /bin/false ]]; then
  readonly NOLOGIN_SHELL=/bin/false
else
  die "Could not find a non-login shell for service users."
fi

# Resolve the existing subscription uid/gid pair before account creation, then
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
