import path from 'node:path';
import { buildRuntimeHealth } from '../core/server-render.js';
import { ControllerError } from './request-contract.js';
import { hasEnrollmentCredentials, nextState } from './state-views.js';

export async function recover(controller) {
  const current = await controller.repository.readCurrent();
  if (!current) throw new ControllerError('NOT_INITIALIZED', 503);
  if (current.requiresIngressMigration) return controller.recoverIngressMigration(current);
  controller.ready = false;
  await controller.setMaintenance(true);
  await controller.repository.activateRuntime(current.id);
  try {
    await controller.validateConfig(path.join(current.path, 'sing-box.json'));
    controller.runtime.health = buildRuntimeHealth(current.state);
    await controller.runtime.restart();
    await controller.runtime.probe();
    return await controller.retireBootstrapCredentials(current);
  } catch {
    controller.ready = false;
    await controller.setMaintenance(true).catch(() => {});
    throw new ControllerError('RUNTIME_UNAVAILABLE', 503);
  }
}

export async function retireBootstrapCredentials(controller, current = null) {
  let authoritative = current ?? await controller.repository.readCurrent();
  if (!authoritative) throw new ControllerError('NOT_INITIALIZED', 503);
  const credentialsPresent = hasEnrollmentCredentials(authoritative.state);
  if (credentialsPresent) {
    const timestamp = controller.timestamp();
    const scrubbed = nextState(authoritative.state, {
      tailscale: {
        ...authoritative.state.tailscale,
        authKey: null,
        apiKey: null,
        ...(authoritative.state.tailscale.extraExits ? {
          extraExits: authoritative.state.tailscale.extraExits.map((exit) => ({ ...exit, authKey: null })),
        } : {}),
      },
    }, timestamp < authoritative.state.updatedAt ? authoritative.state.updatedAt : timestamp);
    await controller.transact(scrubbed, {
      operation: 'credentials.scrub',
      publishReady: false,
    });
    authoritative = await controller.repository.readCurrent();
  }

  // If the process stopped after committing the scrub but before deleting
  // its predecessor, the manifest makes cleanup safely retryable. Revision
  // deletion first atomically quarantines a whole directory, so an
  // interruption can never expose a partially deleted normal revision.
  // Scan independently of the current operation label. This both repairs
  // state produced by older releases and prevents a later degraded repair
  // from obscuring an interrupted cleanup behind a new current revision.
  const revisions = await controller.repository.listRevisions();
  for (const revision of revisions) {
    if (revision.id === authoritative.id) continue;
    const obsolete = typeof controller.repository.readRevisionForRetirement === 'function'
      ? await controller.repository.readRevisionForRetirement(revision.id)
      : await controller.repository.readRevision(revision.id);
    if (
      obsolete.requiresIngressMigration
      || hasEnrollmentCredentials(obsolete.state)
    ) {
      const removed = await controller.repository.removeRevision(revision.id);
      if (!removed) throw new Error('credential-bearing revision remained protected');
    }
  }
  await controller.setMaintenance(false);
  controller.ready = true;
  return authoritative;
}

export async function transact(controller, candidateState, {
  operation,
  userId = null,
  restart = true,
  publishReady = true,
  allowUnreadyRemoval = false,
}) {
  const previous = await controller.state();
  if (candidateState.revision !== previous.state.revision + 1) {
    throw new ControllerError('STALE_REVISION', 409);
  }
  // Adding an identity writes a temporary enrollment credential. Close
  // publication before that write, including configuration-check failures
  // whose candidate cleanup could itself fail and need recovery to retry.
  if (hasEnrollmentCredentials(candidateState)) {
    controller.ready = false;
    await controller.setMaintenance(true);
  }
  const candidate = await controller.repository.createRevision(candidateState, { operation });
  try {
    await controller.validateConfig(path.join(candidate.path, 'sing-box.json'));
    await controller.setMaintenance(true);
  } catch {
    await controller.repository.removeRevision?.(candidate.id).catch(() => {});
    await controller.appendAudit({
      operation,
      revision: previous.state.revision,
      userId,
      outcome: 'rejected',
    }).catch(() => {});
    throw new ControllerError('CANDIDATE_REJECTED', 503);
  }
  controller.ready = false;
  try {
    await controller.repository.activateRuntime(candidate.id);
    controller.runtime.health = buildRuntimeHealth(candidateState);
    if (restart) await controller.runtime.restart();
    let routedReady = true;
    try {
      await controller.runtime.probe();
    } catch (error) {
      if (!allowUnreadyRemoval || operation !== 'exit.remove') throw error;
      routedReady = false;
    }
    await controller.repository.activateCurrent(candidate.id);
    if (publishReady && routedReady) {
      await controller.setMaintenance(false);
      controller.ready = true;
    } else {
      controller.ready = false;
    }
    await controller.appendAudit({ operation, revision: candidateState.revision, userId }).catch(() => {});
    return { ...candidate, routedReady };
  } catch {
    let rollbackHealthy = false;
    try {
      await controller.repository.activateCurrent(previous.id);
      await controller.repository.activateRuntime(previous.id);
      controller.runtime.health = buildRuntimeHealth(previous.state);
      if (restart) await controller.runtime.restart();
      await controller.runtime.probe();
      rollbackHealthy = true;
    } catch {
      rollbackHealthy = false;
    }
    if (rollbackHealthy && publishReady) {
      try {
        await controller.setMaintenance(false);
      } catch {
        rollbackHealthy = false;
      }
    }
    controller.ready = rollbackHealthy && publishReady;
    await controller.repository.removeRevision?.(candidate.id).catch(() => {});
    await controller.appendAudit({
      operation,
      revision: previous.state.revision,
      userId,
      outcome: rollbackHealthy ? 'rolled-back' : 'rollback-failed',
    }).catch(() => {});
    throw new ControllerError(rollbackHealthy ? 'ROLLED_BACK' : 'ROLLBACK_FAILED', 503);
  }
}
