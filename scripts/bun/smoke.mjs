/** 验证构建后核心、认证通道与管理页边界及 SQLite 重开；不建立真实设备或管理员身份。 */
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
const persistence = await import('../../dist/src/integration/persistence.js')
const transport = await import('../../dist/src/transport/index.js')
assert.equal(typeof transport.createGateway, 'function')
assert.equal(typeof transport.createConnector, 'function')
assert.equal(typeof transport.loadCredential, 'function')
assert.equal(typeof transport.IdentityStore, 'function')
assert.equal(typeof transport.PersistentIdentity, 'function')
assert.equal(typeof transport.createPairingDelivery, 'function')
assert.equal(typeof transport.createStoreDeviceLedger, 'function')
assert.equal(typeof transport.createStoreIdentityFacts, 'function')
assert.equal(typeof transport.PersistentProofIdentity, 'function')
assert.equal(typeof transport.ChannelRegistry, 'function')
assert.equal(typeof transport.createDeviceLifecycleWiring, 'function')
assert.equal(typeof transport.createDeviceLifecycleAdapter, 'function')
// Herdr 产物复用共享 Wire 错误身份；导入本身不启动或连接原生实例。
const herdr = await import('../../dist/src/herdr/readonly.js')
assert.equal(typeof herdr.createHerdrReadonlyAdapter, 'function')
assert.deepEqual(herdr.HERDR_READONLY_REVIEW.methods, ['ping'])
assert.throws(
  /** 用未受信来源触发产物错误，核对跨入口共享 GatewayError 身份。 */
  () => herdr.createHerdrCodec({}, {}),
  contracts.GatewayError
)
const webui = await import('../../dist/src/webui/index.js')
assert.equal(typeof webui.mountWebUi, 'function')
assert.deepEqual(webui.parseRoute('#machine=a%2Fb'), { machineId: 'a/b', cursor: null, providerCursor: null })
await assert.rejects(webui.unavailableRead(), { problem: 'unavailable' })
const browserEntry = readFileSync(new URL('../../dist/webui/browser.js', import.meta.url), 'utf8')
assert(!browserEntry.includes('node:'))
assert(!browserEntry.includes('webUiFixture'))
assert(readFileSync(new URL('../../dist/webui/index.html', import.meta.url), 'utf8').includes('Rovloom 管理'))
assert(readFileSync(new URL('../../dist/webui/manage.css', import.meta.url), 'utf8').includes(':focus-visible'))
for (const asset of ['rovloom-mark-orange.png', 'rovloom-logo.png']) {
  assert.deepEqual(
    readFileSync(new URL(`../../dist/webui/${asset}`, import.meta.url)),
    readFileSync(new URL(`../../docs/assets/brand/${asset}`, import.meta.url))
  )
}
assert(
  readFileSync(new URL('../../dist/webui/index.html', import.meta.url), 'utf8').includes(
    'href="./rovloom-mark-orange.png"'
  )
)
assert.equal(typeof persistence.persistentBackend, 'function')
assert.equal(typeof persistence.commitLuvusResponse, 'function')
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
// 构建产物的普通坏 bundle 不能污染编译服务，随后仍须完成完整有效编译。
const malformed = await native.compileBundle('{}', {
  identity: { binary_sha256: 'a'.repeat(64), schema_sha256: contracts.digest('{}'), revision: 'artifact-rejection' }
})
assert.deepEqual(malformed, {
  ok: false,
  error: { origin: 'contract', code: 'schema_unavailable', stage: 'compile', reason: 'invalid_schema' }
})
const compiled = await native.compileBundle(bytes, {
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
  /** 为构建产物的隔离 adapter 提供固定 mock 连接，不接入真实设备。 */
  connection: () => connection,
  /** 提供已固定的 mock attempt，验证跨构建入口的私有 handle 关联。 */
  attempt: () => row,
  /** 提供 Gateway 侧的 mock provider registry，限定产物 smoke 的目标实例。 */
  provider: () => provider,
  /** 提供独立本机侧的 mock provider 配置，验证双端 binding 核对。 */
  localProvider: () => provider,
  /** 把固定离线 bundle 与合成来源组成 smoke 契约记录，不授予生产许可。 */
  contract: () => ({
    wire: { source: origin, support_status: 'validated' },
    compiled: compiled.value,
    capabilities,
    capability_revision: 'caps'
  }),
  /** 提供仅限 smoke 的原生来源证明，供真实 validator 校验来源关联。 */
  nativeSource: () => proof,
  /** 提供同一 mock 目标的双端 grant，验证构建后的授权交集路径。 */
  policies: () => ({
    caller: { revision: 'caller', grants },
    local: { revision: 'local', grants }
  }),
  /** 为固定 task.add fixture 提供合成分类和权限边界，验证产物间许可身份一致。 */
  authority: () => ({
    classification_source_verified: true,
    classifications: [
      {
        method: 'task.add',
        revision: 'review',
        contract: compiled.value.identity,
        native: capabilities.result.method_contracts.find(
          /** 从固定能力表选择 task.add 的原生契约，避免使用其它方法的来源。 */
          (row) => row.method === 'task.add'
        ),
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
  /** 提供 smoke 专用 caller ID，不从业务输入构造 principal。 */
  currentPrincipal: () => 'principal',
  /** 固定 smoke 可信时间，使许可和期限判断可重复。 */
  now: () => 100,
  /** 将 smoke 内容状态固定为可读，仅用于结果门禁验证。 */
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
const heartbeat = { ...base, type: 'heartbeat', payload: { sequence: 0 } }
const heartbeatContext = { phase: 'authenticated', direction: 'gateway_to_connector', connection }
assert.deepEqual(protocol.decodeFrame(protocol.encodeFrame(heartbeat, heartbeatContext), heartbeatContext), heartbeat)
assert.throws(
  /** 用旧 major 帧触发拒绝，确认产物未回退旧 Wire 执行协议。 */
  () => protocol.decodeFrame(JSON.stringify({ ...heartbeat, protocol_major: 1 }), heartbeatContext),
  /protocol_major_unsupported/
)
const { provider_id: _providerId, ...missingProvider } = target
assert.throws(
  /** 删除 provider 字段后尝试解码，确认产物不能补造缺失目标。 */
  () =>
    adapter.decode(
      JSON.stringify({
        ...base,
        type: 'request',
        payload: {
          attempt: { ...attempt, target: missingProvider },
          expected_binding_revision: 1,
          native_request: row.native_request,
          validation: 'strict'
        }
      }),
      'gateway_to_connector'
    ),
  /invalid_frame_fields/
)
const dir = mkdtempSync(join(tmpdir(), 'luvus-bun-artifact-'))
try {
  const store = new Store(join(dir, 'db'))
  const machine = store.register('artifact')
  assert.equal(store.machine(machine.machine_id).name, 'artifact')
  // 共享 chunk 必须保留不同构建入口之间的类身份。
  assert.throws(
    /** 查询缺失机器，确认构建后的 Store 保持拒绝语义。 */
    () => store.machine('missing'),
    contracts.GatewayError
  )
  store.close()
  const reopened = new Store(join(dir, 'db'))
  assert.equal(reopened.machine(machine.machine_id).name, 'artifact')
  reopened.close()
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log(
  'Built ESM foundation/native/wire/integration, 29 schema documents, native error, v2 boundaries and SQLite reopen: pass'
)
