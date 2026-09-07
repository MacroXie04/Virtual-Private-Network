# shellcheck shell=bash
# Start services, verify routed readiness and ingress, then durably commit.

if [[ "$INSTALL_MODE" == existing ]]; then
  echo "==> Starting the hardened service set with boot enablement held until readiness"
elif [[ "$INSTALL_MODE" == migrate ]]; then
  echo "==> Starting the migration candidate with boot enablement held until commit"
  hold_migration_target_disabled
else
  echo "==> Enabling and starting the hardened service set"
  systemctl enable vpn-gateway.target
fi
systemctl restart vpn-gateway.target

for service_name in \
  vpn-gateway-controller.service \
  vpn-gateway-sing-box.service \
  vpn-gateway-subscription.service \
  vpn-gateway-admin.service \
  vpn-gateway-tunnel.service; do
  systemctl is-active --quiet "$service_name" \
    || die "$service_name did not become active; inspect it with journalctl -u $service_name."
done

echo "==> Waiting for the routed data-path readiness check"
gateway_ready=no
for ((attempt = 1; attempt <= 45; attempt += 1)); do
  if "$NODE_BIN" "$INSTALL_ROOT/src/runtime/healthcheck.js" >/dev/null 2>&1; then
    gateway_ready=yes
    break
  fi
  systemctl is-active --quiet vpn-gateway-controller.service \
    || die "vpn-gateway-controller.service stopped during its readiness check."
  sleep 2
done
[[ "$gateway_ready" == yes ]] \
  || die "The gateway did not become ready; inspect vpn-gateway-controller.service and vpn-gateway-sing-box.service."

echo "==> Verifying the Cloudflare edge connection and loopback-only origins"
timeout 10s "$CLOUDFLARED_BIN" tunnel --metrics 127.0.0.1:20241 ready >/dev/null \
  || die "cloudflared is running but its local readiness endpoint has no active edge connection."
verify_bare_loopback_origins \
  || die "The bare-metal listeners or local WebSocket origin failed their isolation check."

if [[ "$INSTALL_MODE" == migrate ]]; then
  # The committed marker makes the migration authoritative across reboot. Make
  # the independently mounted code, environment, and unit trees durable before
  # publishing that marker so it can never outlive a partially persisted
  # deployment after power loss.
  sync -f /opt
  sync -f /etc
  sync -f "$SYSTEMD_ROOT"
  if [[ -d "$SYSTEMD_ROOT/multi-user.target.wants" \
      && ! -L "$SYSTEMD_ROOT/multi-user.target.wants" ]]; then
    sync -f "$SYSTEMD_ROOT/multi-user.target.wants"
  fi
  [[ ! -e "$MIGRATION_COMMITTED_MARKER" && ! -L "$MIGRATION_COMMITTED_MARKER" ]] \
    || die "$MIGRATION_COMMITTED_MARKER unexpectedly appeared during migration."
  if ! path_is_present "$MIGRATION_MARKER/committed"; then
    install -o root -g root -m 0600 /dev/null "$MIGRATION_MARKER/committed"
  else
    validate_migration_marker_file "$MIGRATION_MARKER/committed"
  fi
  sync -f "$MIGRATION_MARKER/committed"
  sync -f "$MIGRATION_MARKER"
  mv -- "$MIGRATION_MARKER/committed" "$MIGRATION_COMMITTED_MARKER"
  sync -f "$STATE_ROOT"
  DEPLOYMENT_HANDOFF_COMPLETE=yes
  COMMITTED_MIGRATION_CLEANUP=yes
  cleanup_committed_migration_work
  systemctl enable vpn-gateway.target
  sync -f "$SYSTEMD_ROOT"
  if [[ -d "$SYSTEMD_ROOT/multi-user.target.wants" \
      && ! -L "$SYSTEMD_ROOT/multi-user.target.wants" ]]; then
    sync -f "$SYSTEMD_ROOT/multi-user.target.wants"
  fi
  [[ "$(query_upgrade_enablement vpn-gateway.target no)" == enabled ]] \
    || die "The committed gateway target could not be enabled for boot."
elif [[ "$INSTALL_MODE" == existing ]]; then
  # The rollback journal lives under /var. Flush the independently mounted
  # code and configuration trees before allowing that journal to commit.
  sync -f /opt
  sync -f /etc
  systemctl enable vpn-gateway.target
  sync -f "$SYSTEMD_ROOT"
  if [[ -d "$SYSTEMD_ROOT/multi-user.target.wants" \
      && ! -L "$SYSTEMD_ROOT/multi-user.target.wants" ]]; then
    sync -f "$SYSTEMD_ROOT/multi-user.target.wants"
  fi
  commit_upgrade_rollback_transaction
  DEPLOYMENT_HANDOFF_COMPLETE=yes
else
  DEPLOYMENT_HANDOFF_COMPLETE=yes
fi

if [[ "$REMOVE_LEGACY_SUDOERS" == yes ]]; then
  rm -f -- "$LEGACY_SUDOERS"
  echo "==> Removed the legacy vpn-sub passwordless sudo rule"
fi
if [[ -n "$UPGRADE_BACKUP" ]]; then
  echo "==> Previous deployment retained for manual rollback at $UPGRADE_BACKUP"
fi

cat <<EOF

Deployment complete.

  Public VPN endpoint:   https://$VPN_PUBLIC_HOSTNAME:443 (Cloudflare edge)
  Local VLESS origin:    http://127.0.0.1:8443 (WebSocket only)
  Local subscriptions:   http://127.0.0.1:8080
  Local administration:  http://127.0.0.1:8081
  Administration URL:    https://$ADMIN_PUBLIC_HOSTNAME
  Tunnel metrics:        http://127.0.0.1:20241 (local only)

All origins intentionally listen only on loopback. Cloudflare must be the only
public ingress; do not expose or forward ports 8443, 8080, 8081, or 20241.

If /var/lib/vpn-gateway/admin-secret exists after first initialization, retrieve
the generated administrator secret once with:
  sudo cat /var/lib/vpn-gateway/admin-secret

Store it securely. After vaulting it, deleting that root-only handoff file is
supported; the external copy is then the only way to authenticate. Rerunning
this installer preserves the credential hash and all revision state.
EOF
