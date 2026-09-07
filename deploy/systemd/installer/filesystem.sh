# shellcheck shell=bash
# Validate protected paths and promote a durable legacy migration commit.

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
