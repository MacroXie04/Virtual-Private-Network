# shellcheck shell=bash
# Validate and establish isolated runtime, subscription, and administrator identities.

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
