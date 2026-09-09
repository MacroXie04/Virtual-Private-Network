# shellcheck shell=bash
# Validate protected deployment paths.

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
