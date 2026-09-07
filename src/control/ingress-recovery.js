import path from 'node:path';
import { buildRuntimeHealth } from '../core/server-render.js';
import { ControllerError } from './request-contract.js';

export async function recoverIngressMigration(controller, previous) {
  const candidate = await controller.repository.readRuntime();
  if (
    !candidate
    || candidate.requiresIngressMigration
    || candidate.id === previous.id
    || candidate.state.schemaVersion !== 3
    || candidate.state.revision !== previous.state.revision + 1
    || candidate.manifest.operation !== 'ingress.migrate'
    || candidate.state.createdAt !== previous.state.createdAt
    || JSON.stringify(candidate.state.users) !== JSON.stringify(previous.state.users)
    || JSON.stringify(candidate.state.admin) !== JSON.stringify(previous.state.admin)
    || JSON.stringify(candidate.state.tailscale) !== JSON.stringify(previous.state.tailscale)
    || candidate.state.health.listenPort !== previous.state.health.listenPort
    || candidate.state.health.username !== previous.state.health.username
    || candidate.state.health.password !== previous.state.health.password
  ) {
    throw new ControllerError('MIGRATION_NOT_STAGED', 503);
  }
  controller.ready = false;
  await controller.setMaintenance(true);
  try {
    await controller.validateConfig(path.join(candidate.path, 'sing-box.json'));
    await controller.repository.activateRuntime(candidate.id);
    controller.runtime.health = buildRuntimeHealth(candidate.state);
    await controller.runtime.restart();
    await controller.runtime.probe();
    await controller.repository.activateCurrent(candidate.id);
    await controller.appendAudit({
      operation: 'ingress.migrate',
      revision: candidate.state.revision,
    }).catch(() => {});
  } catch {
    let restored = true;
    try {
      await controller.repository.activateCurrent(previous.id);
      await controller.repository.activateRuntime(previous.id);
    } catch {
      restored = false;
    }
    // Deliberately do not restart the retired public REALITY listener. The
    // restored pointers exist only as rollback authority for the next
    // explicit attempt; maintenance remains authoritative and startup fails.
    if (restored) await controller.repository.removeRevision?.(candidate.id).catch(() => {});
    await controller.appendAudit({
      operation: 'ingress.migrate',
      revision: previous.state.revision,
      outcome: restored ? 'rolled-back' : 'rollback-failed',
    }).catch(() => {});
    throw new ControllerError(restored ? 'MIGRATION_FAILED' : 'MIGRATION_ROLLBACK_FAILED', 503);
  }
  try {
    return await controller.retireBootstrapCredentials(candidate);
  } catch {
    controller.ready = false;
    await controller.setMaintenance(true).catch(() => {});
    throw new ControllerError('RUNTIME_UNAVAILABLE', 503);
  }
}
