import type { Store } from '../../src/store.js'
import type { CallOptions } from '../../src/store.js'
import { contractRef } from '../../src/wire/index.js'
import { createLuvusWireAdapter } from '../../src/integration/luvus-wire.js'
import { commitLuvusResponse, persistentBackend } from '../../src/integration/persistence.js'
import type { NativeBinding } from '../../src/native-contract/index.js'
import type { AttemptBinding, AuthenticatedContext, ProviderPolicies } from '../../src/wire/types.js'
import { auth, compiled, G, identity, json, request, view } from '../native-contract/helpers.js'
import { source } from '../wire/helpers.js'
import { connected, options, responseFrame } from './helpers.js'

// 只用固定 P0 fixture 和隔离身份；编码/响应检查使用真实 NativeValidator 与 Wire adapter。
export function nativeBackend(store: Store) {
  const device = connected(store)
  const target = { ...device.target, session: 'synthetic' }
  const nativeRequest = { method: 'task.add', params: { title: 'synthetic' } }
  const reviewed = auth(request(view(), { id: 'unused', ...nativeRequest }))
  const origin = { ...source, runtime_generation: G, classification_revision: 'review1' }
  const bindings = new Map<string, AttemptBinding>()
  const state = { sourceVerified: true, sends: 0 }
  const grants: ProviderPolicies['caller']['grants'] = [
    { target, methods: ['task.add'], actions: ['dispatch', 'read', 'cancel'] }
  ]
  const capabilities = json('session-capabilities.json')
  capabilities.result.session = 'synthetic'
  capabilities.result.server_generation = G
  const connection: AuthenticatedContext['connection'] = {
    machine_id: device.machine_id,
    recovery_generation: store.generation(),
    connection_epoch: device.epoch,
    authenticated: true,
    active: true,
    negotiated: { major: 2, minor: 0, capabilities: ['rpc', 'late_evidence'] }
  }
  const adapter = createLuvusWireAdapter(
    persistentBackend(store, {
      connection: () => connection,
      localProvider: () => store.provider(device.machine_id, target.provider_id),
      contract: () => ({
        wire: { source: origin, support_status: 'validated' },
        compiled,
        capabilities,
        capability_revision: 'caps1'
      }),
      nativeSource: (call, attempt) => {
        const binding = bindings.get(call)
        if (!binding || binding.attempt_id !== attempt) {
          return undefined
        }
        const nativeBinding: NativeBinding = {
          kind: 'luvus',
          provider_id: target.provider_id,
          binding_revision: 1,
          contract_source_ref: binding.contract_ref,
          target: { machine_id: device.machine_id, profile: 'session', session: 'synthetic' },
          server_generation: G,
          connection_epoch: device.epoch,
          recovery_generation: store.generation(),
          capability_revision: 'caps1',
          caller_policy_revision: 'caller1',
          local_policy_revision: 'local1',
          classification_revision: 'review1',
          contract: identity
        }
        return { authenticated: true, source_verified: state.sourceVerified, binding: nativeBinding }
      },
      policies: () => ({ caller: { revision: 'caller1', grants }, local: { revision: 'local1', grants } }),
      authority: () => reviewed,
      currentPrincipal: () => 'synthetic'
    })
  )
  return {
    device,
    target,
    adapter,
    state,
    create(extra: Partial<CallOptions> = {}) {
      return store.createCall(
        'synthetic',
        target,
        nativeRequest,
        options({
          contract_ref: contractRef(origin),
          caller_policy_revision: 'caller1',
          local_policy_revision: 'local1',
          ...extra
        })
      )
    },
    dispatch(callId: string) {
      const binding = store.dispatch('synthetic', callId, device.epoch)
      bindings.set(callId, binding)
      const { machine_id, recovery_generation, connection_epoch, ...attempt } = binding
      adapter.encode(
        {
          protocol_major: 2,
          protocol_minor: 0,
          message_id: binding.attempt_id,
          machine_id,
          recovery_generation,
          connection_epoch,
          type: 'request',
          payload: { attempt, expected_binding_revision: 1, native_request: nativeRequest, validation: 'strict' }
        },
        'gateway_to_connector'
      )
      state.sends++
      return binding
    },
    respond(binding: AttemptBinding, result: Record<string, unknown> = { id: 'task-created' }) {
      return commitLuvusResponse(store, adapter, responseFrame(binding, { result }))
    }
  }
}
