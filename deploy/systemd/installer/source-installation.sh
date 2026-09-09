# shellcheck shell=bash
# Install the source tree and remove only enumerated retired application modules.

remove_retired_source_files() {
  local filename parent_directory component
  local -a parent_components
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
    control/ingress-recovery.js
    state/bootstrap-ingress-migration.js
    migrations/legacy-reality.js
    migrations/legacy-v1-parse.js
    migrations/legacy-v1-source.js
    migrations/legacy-v1-state.js
    migrations/legacy-v2-policy.js
    migrations/legacy-v2-state.js
    migrations/migrate-v1.js
    migrations/migration-backup.js
    migrations/migration-errors.js
    migrations/migration-lineage-record.js
    migrations/migration-lineage.js
    migrations/migration-marker.js
    migrations/migration-recovery.js
    control/application.js
    control/control-client.js
    control/control-socket.js
    control/controller-sessions.js
    control/controller.js
    control/operational-files.js
    control/operations/gateway.js
    control/operations/mutations.js
    control/operations/users.js
    control/process-settings.js
    control/request-contract.js
    control/request-dispatch.js
    control/runtime-transactions.js
    control/socket-files.js
    control/socket-protocol.js
    control/state-views.js
    control/web-processes.js
    core/client-subscriptions.js
    core/credentials.js
    core/exit-profiles.js
    core/lifecycle.js
    core/server-config-assert.js
    core/server-config-model.js
    core/server-render.js
    core/single-exit-config-assert.js
    core/state-schema.js
    core/subscription-view.js
    core/user-records.js
    core/validation.js
    http/admin-application.js
    http/admin-auth.js
    http/admin-page.js
    http/admin-request.js
    http/admin-routes.js
    http/http-service.js
    http/rate-limit.js
    http/request-input.js
    http/subscription-application.js
    http/subscription-data.js
    runtime/health-probe.js
    runtime/runtime.js
    runtime/websocket-probe.js
    state/bootstrap-candidate.js
    state/bootstrap-credentials.js
    state/bootstrap-environment.js
    state/bootstrap-errors.js
    state/bootstrap-existing.js
    state/bootstrap-files.js
    state/bootstrap-initialize.js
    state/bootstrap-recovery.js
    state/bootstrap-service.js
    state/repository-files.js
    state/repository-pointers.js
    state/repository-policy.js
    state/revision-content.js
    state/revision-directory.js
    state/revision-manifest.js
    state/revision-retention.js
  )
  # Only these former application files are retired. Validate the whole set
  # before removing any entry, and preserve all other operator-owned content.
  # A regular leaf can still escape the source tree through a symlink parent.
  for filename in "${retired_nested_source_files[@]}"; do
    parent_directory="$INSTALL_ROOT/src"
    IFS=/ read -r -a parent_components <<<"${filename%/*}"
    for component in "${parent_components[@]}"; do
      parent_directory="$parent_directory/$component"
      if [[ -e "$parent_directory" || -L "$parent_directory" ]]; then
        [[ -d "$parent_directory" && ! -L "$parent_directory" ]] \
          || die "Retired application source parent ${parent_directory#"$INSTALL_ROOT/src/"} must be a real directory, not a symlink."
      fi
    done
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
