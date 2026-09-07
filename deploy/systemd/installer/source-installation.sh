# shellcheck shell=bash
# Install the source tree and remove only enumerated retired application modules.

remove_retired_source_files() {
  local filename parent_directory
  local -a retired_source_files=(
    admin-page.js
    admin-server.js
    bootstrap.js
    control-client.js
    controller-server.js
    controller-sessions.js
    controller.js
    credentials.js
    health-probe.js
    healthcheck.js
    http-common.js
    legacy-reality.js
    legacy-v2.js
    lifecycle.js
    migrate-v1.js
    render.js
    repository.js
    runtime.js
    state-schema.js
    subscription-server.js
    tailscale.js
    validation.js
    websocket-probe.js
  )
  local -a retired_nested_source_files=(
    core/render.js
    http/http-common.js
    migrations/legacy-v2.js
  )
  # Only these former application files are retired. Validate the whole set
  # before removing any entry, and preserve all other operator-owned content.
  # A regular leaf can still escape the source tree through a symlink parent.
  for filename in "${retired_nested_source_files[@]}"; do
    parent_directory="$INSTALL_ROOT/src/${filename%/*}"
    if [[ -e "$parent_directory" || -L "$parent_directory" ]]; then
      [[ -d "$parent_directory" && ! -L "$parent_directory" ]] \
        || die "Retired application source parent ${filename%/*} must be a real directory, not a symlink."
    fi
  done
  for filename in "${retired_source_files[@]}" "${retired_nested_source_files[@]}"; do
    if [[ -e "$INSTALL_ROOT/src/$filename" || -L "$INSTALL_ROOT/src/$filename" ]]; then
      [[ -f "$INSTALL_ROOT/src/$filename" && ! -L "$INSTALL_ROOT/src/$filename" ]] \
        || die "Retired application source $filename must be a regular file, not a symlink."
    fi
  done
  for filename in "${retired_source_files[@]}" "${retired_nested_source_files[@]}"; do
    rm -f -- "$INSTALL_ROOT/src/$filename"
  done
}

validate_fixed_directory "$INSTALL_ROOT/src"
install -o root -g root -m 0644 "$REPO_DIR/package.json" "$INSTALL_ROOT/package.json"
cp -a "$REPO_DIR/src/." "$INSTALL_ROOT/src/"
# Upgrade backups and the durable rollback journal are already in place, and
# the replacement source tree has copied successfully before old paths retire.
remove_retired_source_files
chown -R root:root "$INSTALL_ROOT/src"
find "$INSTALL_ROOT/src" -type d -exec chmod 0755 {} +
find "$INSTALL_ROOT/src" -type f -exec chmod 0644 {} +
install -o root -g root -m 0755 "$REPO_DIR/deploy/systemd/sing-box-wrapper.sh" "$INSTALL_ROOT/bin/sing-box-wrapper"
