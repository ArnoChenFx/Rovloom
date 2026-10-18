import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toolchain } from './toolchain.mjs'

toolchain()
// 必须导入构建后的 JavaScript，不能回到源码 .ts。
const contracts = await import('../../dist/src/contracts.js')
const { Store } = await import('../../dist/src/store.js')
const { Router } = await import('../../dist/src/router.js')
const protocol = await import('../../dist/src/protocol.js')
const native = await import('../../dist/src/native-contract/index.js')
const wire = await import('../../dist/src/wire/index.js')
const integration = await import('../../dist/src/integration/luvus-wire.js')
assert.deepEqual(
  Object.keys(contracts).sort(),
  ['GatewayError', 'authorize', 'canonical', 'digest', 'validateRequest', 'validateTarget'].sort()
)
assert.deepEqual(
  Object.keys(protocol).sort(),
  ['MAX_FRAME_BYTES', 'PROTOCOL_MAJOR', 'PROTOCOL_MINOR', 'decodeFrame', 'encodeFrame'].sort()
)
assert.equal(typeof Router, 'function')
assert.equal(protocol.PROTOCOL_MAJOR, 2)
assert.equal(typeof integration.createLuvusWireAdapter, 'function')
assert.equal(typeof wire.decodeWireObject, 'function')
assert.deepEqual(
  Object.keys(native).sort(),
  [
    'DEFAULT_LIMITS',
    'checkDispatch',
    'checkResultBoundary',
    'checkSequence',
    'compileBundle',
    'createNativeValidator',
    'inspectRequestGate',
    'parseNativeJson'
  ].sort()
)
const bytes = readFileSync(new URL('../../fixtures/p0/linux-luvus-0.14.3/schema-bundle.json', import.meta.url))
const compiled = native.compileBundle(bytes, {
  identity: {
    binary_sha256: '895073022da8edd231c9d4c810d68627b954b61e4e9f9f2d5d19e2c2fcf282a9',
    schema_sha256: contracts.digest(bytes.toString('utf8')),
    revision: 'artifact-smoke'
  }
})
assert(compiled.ok)
assert.equal(compiled.value.documents.length, 29)
const response = {
  id: 'artifact',
  error: { code: 'synthetic', message: 'synthetic', data: { preserved: true } }
}
const checked = native.createNativeValidator(compiled.value).checkResponseShape(response)
assert(checked.ok)
assert.deepEqual(checked.value.response, response)
// 仅用 P0 fixture 测试跨构建入口的私有 handle 身份，不建立网络或真实权限。
const capabilities = JSON.parse(
  readFileSync(new URL('../../fixtures/p0/linux-luvus-0.14.3/session-capabilities.json', import.meta.url))
)
const origin = {
  provider_kind: 'luvus',
  protocol_family: 'uhp',
  binary_version: '0.14.3',
  binary_sha256: compiled.value.identity.binary_sha256,
  schema_sha256: compiled.value.identity.schema_sha256,
  schema_origin: 'installed_cli',
  schema_command: 'luvus uhp schema',
  server_version: '0.14.3',
  native_protocol_version: '1.0',
  runtime_generation: capabilities.result.server_generation,
  adapter_revision: 'artifact',
  classification_revision: 'review',
  support_basis: 'live_catalog'
}
const target = {
  machine_id: 'machine',
  provider_id: 'provider',
  profile: 'session',
  session: capabilities.result.session
}
const connection = {
  machine_id: 'machine',
  recovery_generation: 'recovery',
  connection_epoch: 'epoch',
  authenticated: true,
  active: true,
  negotiated: { major: 2, minor: 0, capabilities: ['rpc'] }
}
const attempt = {
  call_id: 'call',
  attempt_id: 'attempt',
  native_request_id: 'artifact',
  target,
  provider_kind: 'luvus',
  binding_revision: 1,
  contract_ref: wire.contractRef(origin),
  registration: {
    deadline: 1000,
    history: null,
    caller_policy_revision: 'caller',
    local_policy_revision: 'local'
  }
}
const binding = {
  machine_id: 'machine',
  recovery_generation: 'recovery',
  connection_epoch: 'epoch',
  ...attempt
}
const row = {
  binding,
  principal_id: 'principal',
  method: 'task.add',
  mode: 'strict',
  transport: 'rpc',
  native_request: { method: 'task.add', params: { title: 'artifact' } }
}
const provider = {
  machine_id: 'machine',
  provider_id: 'provider',
  kind: 'luvus',
  config_ref: 'artifact',
  binding_revision: 1,
  enabled: true
}
const proof = {
  authenticated: true,
  source_verified: true,
  binding: {
    kind: 'luvus',
    provider_id: 'provider',
    binding_revision: 1,
    contract_source_ref: attempt.contract_ref,
    target: { machine_id: 'machine', profile: 'session', session: target.session },
    server_generation: origin.runtime_generation,
    connection_epoch: 'epoch',
    recovery_generation: 'recovery',
    capability_revision: 'caps',
    caller_policy_revision: 'caller',
    local_policy_revision: 'local',
    classification_revision: 'review',
    contract: compiled.value.identity
  }
}
const grants = [{ target, methods: ['task.add'], actions: ['dispatch', 'read'] }]
const adapter = integration.createLuvusWireAdapter({
  connection: () => connection,
  attempt: () => row,
  provider: () => provider,
  localProvider: () => provider,
  contract: () => ({
    wire: { source: origin, support_status: 'validated' },
    compiled: compiled.value,
    capabilities,
    capability_revision: 'caps'
  }),
  nativeSource: () => proof,
  policies: () => ({
    caller: { revision: 'caller', grants },
    local: { revision: 'local', grants }
  }),
  authority: () => ({
    classification_source_verified: true,
    classifications: [
      {
        method: 'task.add',
        revision: 'review',
        contract: compiled.value.identity,
        native: capabilities.result.method_contracts.find((row) => row.method === 'task.add'),
        transport: 'single_request_rpc',
        effect: 'execute',
        requires_owner: false,
        management_permission: null,
        confirmation_required: false,
        result: {
          boundary: 'ordinary',
          sensitivity: 'potentially_sensitive',
          read_authorization: 'required',
          retention: 'caller_policy',
          delivery: 'ordinary'
        }
      }
    ],
    permissions: [],
    owner: false,
    confirmation_verified: false,
    custody_available: false,
    result_channel: 'ordinary',
    raw_requested: false,
    supported_transports: ['single_request_rpc']
  }),
  currentPrincipal: () => 'principal',
  now: () => 100,
  contentStatus: () => 'available'
})
const base = {
  protocol_major: 2,
  protocol_minor: 0,
  message_id: 'message',
  machine_id: 'machine',
  recovery_generation: 'recovery',
  connection_epoch: 'epoch'
}
adapter.encode(
  {
    ...base,
    type: 'request',
    payload: {
      attempt,
      expected_binding_revision: 1,
      native_request: row.native_request,
      validation: 'strict'
    }
  },
  'gateway_to_connector'
)
adapter.decode(
  JSON.stringify({ ...base, type: 'response', payload: { attempt, native_response: response } }),
  'connector_to_gateway'
)
adapter.checkResult(binding)
const legacy = wire.decodeFoundationV1History(
  JSON.stringify({
    protocol_major: 1,
    protocol_minor: 0,
    type: 'heartbeat',
    message_id: 'msg',
    connection_epoch: 'epoch',
    payload: { sequence: 0 }
  }),
  'epoch'
)
assert.equal(legacy.read_only, true)
assert.equal(legacy.provider_resolution, 'unresolved')
const dir = mkdtempSync(join(tmpdir(), 'luvus-bun-artifact-'))
try {
  const store = new Store(join(dir, 'db'))
  const machine = store.register('artifact')
  assert.equal(store.machine(machine.machine_id).name, 'artifact')
  // 共享 chunk 必须保留不同构建入口之间的类身份。
  assert.throws(() => store.machine('missing'), contracts.GatewayError)
  store.close()
  const reopened = new Store(join(dir, 'db'))
  assert.equal(reopened.machine(machine.machine_id).name, 'artifact')
  reopened.close()
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log(
  'Built ESM foundation/native/wire/integration, 29 schema documents, native error, read-only v1 and SQLite reopen: pass'
)
