import { randomUUID } from 'node:crypto';
import { contractRef, planResponseEvidence } from '../../src/wire/index.js';
import type {
  AttemptBinding,
  AuthenticatedContext,
  AuthenticatedEnvelope,
  ProviderPolicy,
  V2Target,
} from '../../src/wire/types.js';
import { Store } from '../../src/store.js';
import type { CallOptions, StoreOptions } from '../../src/store.js';
import { context, fixtureValidator, source } from '../wire/helpers.js';

// 仅自建 fixture 权限与来源；生产不得导入此管理授权/原生 validator 工厂。
export const management: StoreOptions['management'] = () => ({
  actor: 'synthetic_admin',
  confirmation_id: randomUUID(),
});
export const options = (extra: Partial<CallOptions> = {}): CallOptions => ({
  binding_revision: 1,
  contract_ref: contractRef(source),
  caller_policy_revision: 'caller_policy_1',
  local_policy_revision: 'local_policy_1',
  ...extra,
});
export function connected(store: Store, name = 'linux') {
  const machine = store.register(name);
  const enrollment = store.issueEnrollment(machine.machine_id);
  const device = store.redeem(enrollment);
  const epoch = store.connect(machine.machine_id, device.credential);
  store.defineProvider({
    machine_id: machine.machine_id,
    provider_id: 'provider',
    kind: 'luvus',
    config_ref: 'synthetic',
    binding_revision: 1,
    enabled: true,
  });
  const target: V2Target = {
    machine_id: machine.machine_id,
    provider_id: 'provider',
    profile: 'session',
    session: 'test',
  };
  return { ...device, epoch, target, enrollment };
}
export function policy(target: V2Target, local = false): ProviderPolicy {
  return {
    revision: local ? 'local_policy_1' : 'caller_policy_1',
    grants: [
      {
        target,
        methods: ['pane.read', 'ping', 'host.capabilities'],
        actions: ['dispatch', 'read', 'cancel'],
      },
    ],
  };
}
export function evidenceContext(store: Store, binding: AttemptBinding): AuthenticatedContext {
  const ctx = context(
    'connector_to_gateway',
    fixtureValidator(),
    binding,
    store.call('alice', binding.call_id).method,
  );
  ctx.connection = {
    machine_id: binding.machine_id,
    recovery_generation: binding.recovery_generation,
    connection_epoch: binding.connection_epoch,
    authenticated: true,
    active: true,
    negotiated: { major: 2, minor: 0, capabilities: ['rpc', 'history_scope', 'late_evidence'] },
  };
  ctx.resolveProvider = () => store.provider(binding.machine_id, binding.target.provider_id);
  return ctx;
}
export function responseFrame(
  binding: AttemptBinding,
  nativeResponse: Record<string, unknown>,
): Extract<AuthenticatedEnvelope, { type: 'response' }> {
  const { machine_id, recovery_generation, connection_epoch, ...attempt } = binding;
  return {
    protocol_major: 2,
    protocol_minor: 0,
    message_id: randomUUID(),
    machine_id,
    recovery_generation,
    connection_epoch,
    type: 'response',
    payload: { attempt, native_response: { id: binding.native_request_id, ...nativeResponse } },
  };
}
export function respond(
  store: Store,
  binding: AttemptBinding,
  nativeResponse: Record<string, unknown>,
  now: number,
  retain = true,
) {
  const frame = responseFrame(binding, nativeResponse);
  return store.commitEvidence(binding, () =>
    planResponseEvidence(
      frame,
      evidenceContext(store, binding),
      store.responseAnchor(binding),
      now,
      { classification_status: 'trusted_complete', retain_content_authorized: retain },
    ),
  );
}
