import { exitProfileId } from '../../core/identity/exit-profiles.js';
import { MAX_EXTRA_EXITS } from '../../core/identity/exit-profiles.js';
import { validatePublicBaseUrl } from '../../core/validation/ingress.js';
import { selectExitNode } from '../../runtime/tailscale.js';
import { ControllerError, exactObject, stringField } from './contract.js';
import { nextState } from '../authority/state-views.js';

/** Mutate the published ingress/exit settings after session and revision checks. */
export async function mutateGateway(controller, request, { current, authorized }) {
  const op = request.op;
  if (op === 'publicBase.set') {
    exactObject(request, ['id', 'op', 'sessionId', 'csrf', 'expectedRevision', 'url']);
    const url = validatePublicBaseUrl(request.url, 'url');
    const timestamp = controller.timestamp();
    const changed = nextState(current.state, {
      gateway: { ...current.state.gateway, subscriptionPublicBaseUrl: url },
    }, timestamp);
    await controller.transact(changed, { operation: 'subscription-base.set', restart: false });
    return { revision: changed.revision, csrf: controller.commitMutationSession(authorized) };
  }
  if (op === 'exit.remove') {
    exactObject(request, ['id', 'op', 'sessionId', 'csrf', 'expectedRevision', 'exitId']);
    const exitId = stringField(request.exitId, { min: 16, max: 16, pattern: /^[0-9a-f]{16}$/u });
    const exits = current.state.tailscale.extraExits ?? [];
    if (!exits.some((exit) => exit.id === exitId)) {
      throw new ControllerError('EXIT_NODE_NOT_AVAILABLE', 409);
    }
    const changed = nextState(current.state, {
      tailscale: { ...current.state.tailscale, extraExits: exits.filter((exit) => exit.id !== exitId) },
    }, controller.timestamp());
    const result = await controller.transact(changed, {
      operation: 'exit.remove', publishReady: false, allowUnreadyRemoval: !controller.ready,
    });
    // Several exits may be down together. Persist each removal while
    // remaining in maintenance, so another failed route can be removed.
    const committed = result.routedReady
      ? await controller.retireBootstrapCredentials()
      : await controller.repository.readCurrent();
    return { revision: committed.state.revision, csrf: controller.commitMutationSession(authorized) };
  }
  if (op === 'exit.select' || op === 'exit.add') {
    exactObject(request, ['id', 'op', 'sessionId', 'csrf', 'expectedRevision', 'deviceId']);
    let directoryCredential;
    try {
      directoryCredential = await controller.exitDirectoryCredential(current.state);
    } catch {
      throw new ControllerError('EXIT_DIRECTORY_UNAVAILABLE', 503);
    }
    if (!directoryCredential) throw new ControllerError('EXIT_DIRECTORY_REQUIRED', 409);
    let candidates;
    try {
      candidates = await controller.exitDirectory(directoryCredential);
    } catch {
      throw new ControllerError('EXIT_DIRECTORY_UNAVAILABLE', 503);
    }
    let selected;
    try {
      selected = selectExitNode(candidates, stringField(request.deviceId, { min: 1, max: 128 }));
    } catch {
      throw new ControllerError('EXIT_NODE_NOT_AVAILABLE', 409);
    }
    if (op === 'exit.add') {
      const exits = current.state.tailscale.extraExits ?? [];
      const id = exitProfileId(selected.deviceId);
      if (exits.length >= MAX_EXTRA_EXITS) throw new ControllerError('EXIT_LIMIT_REACHED', 409);
      if (exits.some((exit) => exit.id === id || exit.address === selected.address)
        || [selected.address, selected.ipv4, selected.ipv6, selected.name].includes(current.state.tailscale.exitNode)) {
        throw new ControllerError('EXIT_ALREADY_PUBLISHED', 409);
      }
      if (!controller.readEnrollmentCredential) throw new ControllerError('ENROLLMENT_KEY_REQUIRED', 409);
      let authKey;
      try {
        authKey = stringField(await controller.readEnrollmentCredential(), { min: 8, max: 512 });
      } catch {
        throw new ControllerError('ENROLLMENT_KEY_UNAVAILABLE', 503);
      }
      const changed = nextState(current.state, {
        tailscale: {
          ...current.state.tailscale,
          extraExits: [...exits, { id, name: selected.name, address: selected.address, authKey }],
        },
      }, controller.timestamp());
      await controller.transact(changed, { operation: 'exit.add', publishReady: false });
      const committed = await controller.retireBootstrapCredentials();
      return { revision: committed.state.revision, csrf: controller.commitMutationSession(authorized) };
    }
    const timestamp = controller.timestamp();
    const changed = nextState(current.state, {
      tailscale: { ...current.state.tailscale, exitNode: selected.address },
    }, timestamp);
    await controller.transact(changed, {
      operation: 'exit.select',
      // Keep the marker in place through the unconditional history scan;
      // an earlier scrub may have committed before cleanup was
      // interrupted even though this candidate itself has no secrets.
      publishReady: false,
    });
    const committed = await controller.retireBootstrapCredentials();
    return {
      revision: committed.state.revision,
      exitNode: selected,
      csrf: controller.commitMutationSession(authorized),
    };
  }

  throw new ControllerError('UNKNOWN_OPERATION', 400);
}
