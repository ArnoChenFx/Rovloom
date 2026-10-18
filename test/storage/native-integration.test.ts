import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/store.js'
import { contractRef } from '../../src/wire/index.js'
import { createLuvusWireAdapter } from '../../src/integration/luvus-wire.js'
import { commitLuvusResponse, persistentBackend } from '../../src/integration/persistence.js'
import type { NativeBinding } from '../../src/native-contract/index.js'
import type { AuthenticatedContext, ProviderPolicies } from '../../src/wire/types.js'
import { auth, compiled, G, identity, json, request, view } from '../native-contract/helpers.js'
import { source } from '../wire/helpers.js'
import { connected, management, options, responseFrame } from './helpers.js'

test('real NativeValidator and Wire adapter commit a late response through the durable SQLite backend', () => {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-native-ledger-'))
  let now = 100
  const s = new Store(join(root, 'db'), () => now, { management })
  try {
    const d = connected(s)
    const target = { ...d.target, session: 'synthetic' }
    const nativeRequest = { method: 'task.add', params: { title: 'synthetic' } }
    const reviewed = auth(request(view(), { id: 'unused', ...nativeRequest }))
    const origin = { ...source, runtime_generation: G, classification_revision: 'review1' }
    const c = s.createCall(
      'synthetic',
      target,
      nativeRequest,
      options({
        contract_ref: contractRef(origin),
        timeoutMs: 10,
        caller_policy_revision: 'caller1',
        local_policy_revision: 'local1'
      })
    )
    const binding = s.dispatch('synthetic', c.call_id, d.epoch)
    const grants: ProviderPolicies['caller']['grants'] = [
      { target, methods: ['task.add'], actions: ['dispatch', 'read', 'cancel'] }
    ]
    const nativeBinding: NativeBinding = {
      kind: 'luvus',
      provider_id: target.provider_id,
      binding_revision: 1,
      contract_source_ref: binding.contract_ref,
      target: { machine_id: d.machine_id, profile: 'session', session: 'synthetic' },
      server_generation: G,
      connection_epoch: d.epoch,
      recovery_generation: s.generation(),
      capability_revision: 'caps1',
      caller_policy_revision: 'caller1',
      local_policy_revision: 'local1',
      classification_revision: 'review1',
      contract: identity
    }
    const capabilities = json('session-capabilities.json')
    capabilities.result.session = 'synthetic'
    capabilities.result.server_generation = G
    const connection: AuthenticatedContext['connection'] = {
      machine_id: d.machine_id,
      recovery_generation: s.generation(),
      connection_epoch: d.epoch,
      authenticated: true,
      active: true,
      negotiated: { major: 2, minor: 0, capabilities: ['rpc', 'late_evidence'] }
    }
    const backend = persistentBackend(s, {
      connection: () => connection,
      localProvider: () => s.provider(d.machine_id, target.provider_id),
      contract: () => ({
        wire: { source: origin, support_status: 'validated' },
        compiled,
        capabilities,
        capability_revision: 'caps1'
      }),
      nativeSource: () => ({ authenticated: true, source_verified: true, binding: nativeBinding }),
      policies: () => ({
        caller: { revision: 'caller1', grants },
        local: { revision: 'local1', grants }
      }),
      authority: () => reviewed,
      currentPrincipal: () => 'synthetic'
    })
    const adapter = createLuvusWireAdapter(backend)
    const { machine_id, recovery_generation, connection_epoch, ...attempt } = binding
    const encoded = adapter.encode(
      {
        protocol_major: 2,
        protocol_minor: 0,
        message_id: 'request',
        machine_id,
        recovery_generation,
        connection_epoch,
        type: 'request',
        payload: {
          attempt,
          expected_binding_revision: 1,
          native_request: nativeRequest,
          validation: 'strict'
        }
      },
      'gateway_to_connector'
    )
    assert(encoded.includes('task.add'))
    now = 110
    s.expire()
    const frame = responseFrame(binding, { result: { id: 'task-created' } })
    const result = commitLuvusResponse(s, adapter, frame)
    assert.equal(result.state, 'responded')
    assert.equal(JSON.parse(result.response!).result.id, 'task-created')
    const duplicate = commitLuvusResponse(s, adapter, frame)
    assert.equal(duplicate.call_id, c.call_id)
    assert.throws(() => s.dispatch('synthetic', c.call_id, d.epoch), /dispatch_rejected/)
    const events = s.auditRecords()
    assert.equal(events.filter((e) => e.action === 'dispatching').length, 1)
    assert.equal(events.filter((e) => e.action === 'late_evidence').length, 1)
  } finally {
    s.close()
    rmSync(root, { recursive: true, force: true })
  }
})
