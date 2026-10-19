/** 离线验证共享普通方法审核与真实原 gate 的授权组合；合成来源只供测试，不启动原生或导入 JSON 许可。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { checkDispatch, compileBundle, createNativeValidator } from '../../src/native-contract/index.js'
import type { DispatchAuthorization, NativeBinding, TrustedNativeContext } from '../../src/native-contract/index.js'
import type { NativeContractRecord, TrustedAttempt } from '../../src/integration/luvus-wire.js'
import { boundedJson, contractRef } from '../../src/wire/index.js'
import type { ContractSource } from '../../src/wire/types.js'
import { FIXED_LUVUS_SCHEMA_SHA256, FIXED_LUVUS_SHA256 } from '../../src/runtime/native-control.js'
import { MANAGED_LUVUS_CLASSIFICATION, MANAGED_LUVUS_REVISION } from '../../src/runtime/native-source.js'
import {
  assertLuvusOperationsContract,
  createLuvusOperationsAuthority
} from '../../src/runtime/luvus-operations-authority.js'
import { LUVUS_OPERATION_METHODS } from '../../src/runtime/luvus-operations.js'

const schema = readFileSync(new URL('../fixtures/luvus/0.14.3/linux/schema-bundle.json', import.meta.url))
const result = await compileBundle(schema, {
  identity: {
    binary_sha256: FIXED_LUVUS_SHA256,
    schema_sha256: FIXED_LUVUS_SCHEMA_SHA256,
    revision: MANAGED_LUVUS_REVISION
  }
})
assert(result.ok)
const compiled = result.value

/** 每个场景复制原官方能力 envelope，session 与 generation 仅换为明确的合成测试值。 */
function record(): NativeContractRecord {
  const capabilities = JSON.parse(
    readFileSync(new URL('../fixtures/luvus/0.14.3/linux/session-capabilities.json', import.meta.url), 'utf8')
  )
  capabilities.result.session = 'synthetic'
  capabilities.result.server_generation = 'generation1'
  const source: ContractSource = {
    provider_kind: 'luvus',
    protocol_family: 'uhp',
    binary_version: '0.14.3',
    binary_sha256: FIXED_LUVUS_SHA256,
    schema_sha256: FIXED_LUVUS_SCHEMA_SHA256,
    schema_origin: 'installed_cli',
    schema_command: 'luvus uhp schema',
    server_version: '0.14.3',
    native_protocol_version: '1.0',
    runtime_generation: 'generation1',
    adapter_revision: MANAGED_LUVUS_REVISION,
    classification_revision: MANAGED_LUVUS_CLASSIFICATION,
    support_basis: 'live_catalog'
  }
  return {
    wire: { source, support_status: 'validated' },
    compiled,
    capabilities,
    capability_revision: createHash('sha256').update(boundedJson(capabilities.result)).digest('hex')
  }
}

/** 构造完整合成 attempt 与来源，以当前实际编译句柄运行原生 gate，不模拟网络认证。 */
function fixture(method = 'workspace.rename', params: Record<string, unknown> = { workspace_id: 'a', name: 'chosen' }) {
  const contract = record()
  const target = { machine_id: 'machine1', provider_id: 'provider1', profile: 'session' as const, session: 'synthetic' }
  const attempt: TrustedAttempt = {
    binding: {
      machine_id: target.machine_id,
      connection_epoch: 'epoch1',
      recovery_generation: 'recovery1',
      call_id: 'call1',
      attempt_id: 'attempt1',
      native_request_id: 'request1',
      target,
      provider_kind: 'luvus',
      binding_revision: 1,
      contract_ref: contractRef(contract.wire.source),
      registration: {
        deadline: 200,
        history: null,
        caller_policy_revision: 'caller1',
        local_policy_revision: 'local1'
      }
    },
    principal_id: 'principal1',
    method,
    mode: method === 'pane.list' ? 'strict' : 'raw-contract',
    transport: 'rpc',
    native_request: { id: 'request1', method, params }
  }
  const native: NativeBinding = {
    kind: 'luvus',
    provider_id: target.provider_id,
    binding_revision: 1,
    contract_source_ref: attempt.binding.contract_ref,
    target: { machine_id: target.machine_id, profile: 'session', session: target.session },
    server_generation: 'generation1',
    connection_epoch: 'epoch1',
    recovery_generation: 'recovery1',
    capability_revision: contract.capability_revision,
    caller_policy_revision: 'caller1',
    local_policy_revision: 'local1',
    classification_revision: MANAGED_LUVUS_CLASSIFICATION,
    contract: compiled.identity
  }
  const source: TrustedNativeContext = { binding: native, authenticated: true, source_verified: true }
  return { contract, attempt, native, source }
}

/** 组合宿主共享 authority 和原生 gate，双方策略只包含当前测试目标与方法。 */
function dispatch(input: ReturnType<typeof fixture>, allowed: boolean, now = 100) {
  const authority = createLuvusOperationsAuthority(
    input.contract,
    /** 测试来源始终返回本场景的完整合成绑定。 */ () => input.source,
    /** raw 决定由独立参数控制，不从契约或能力广告推导。 */ () => allowed
  )
  const validator = createNativeValidator(compiled)
  const view = validator.bindCapabilities(input.contract.capabilities, input.source)
  assert(view.ok)
  const candidate = validator.checkRawRequest(view.value, input.attempt.native_request)
  assert(candidate.ok)
  const policy = { machines: ['machine1'], sessions: ['synthetic'], methods: [input.attempt.method], host: false }
  const auth: DispatchAuthorization = {
    ...authority(input.attempt, input.native),
    source: input.source,
    principal_id: input.attempt.principal_id,
    caller_policy: policy,
    local_policy: policy,
    mode: input.attempt.mode === 'strict' ? 'strict' : 'raw_contract',
    now
  }
  return checkDispatch(candidate.value, auth)
}

test(
  'shared Luvus contract review pins native, schema, source revisions and actual compiled identity',
  /** 每个固定来源字段都独立破坏，不能靠形状正确或非空修订替代受审固定值。 */ () => {
    assert.doesNotThrow(/** 原官方固定输入保持可用。 */ () => assertLuvusOperationsContract(record()))
    for (const [field, value] of [
      ['binary_sha256', 'a'.repeat(64)],
      ['schema_sha256', 'b'.repeat(64)],
      ['binary_version', '0.14.4'],
      ['server_version', '0.14.4'],
      ['provider_kind', 'herdr'],
      ['protocol_family', 'herdr-json'],
      ['schema_origin', 'advertisement'],
      ['schema_command', 'other schema'],
      ['native_protocol_version', '2.0'],
      ['support_basis', 'schema_and_version'],
      ['adapter_revision', 'unreviewed'],
      ['classification_revision', 'unreviewed'],
      ['runtime_generation', 'generation2']
    ]) {
      const contract = record()
      Object.assign(contract.wire.source, { [field!]: value })
      assert.throws(
        /** 固定 pin 不由待审核输入覆盖。 */ () => assertLuvusOperationsContract(contract),
        /luvus_operations_source_mismatch/
      )
    }
    for (const field of ['binary_sha256', 'schema_sha256', 'revision'] as const) {
      const contract = record()
      contract.compiled = { ...compiled, identity: { ...compiled.identity, [field]: 'changed' } }
      assert.throws(
        /** compiled 摘要和修订也必须与来源完全一致。 */ () => assertLuvusOperationsContract(contract),
        /luvus_operations_source_mismatch/
      )
    }
  }
)

test(
  'shared Luvus contract review requires all 34 exact native method descriptors',
  /** 任一普通方法缺失、重复、访问范围变化或多字段均不能成为可执行分类。 */ () => {
    assert.equal(LUVUS_OPERATION_METHODS.length, 34)
    for (const method of LUVUS_OPERATION_METHODS) {
      for (const change of ['missing', 'duplicate', 'access', 'scope', 'idempotent', 'extra']) {
        const contract = record()
        const capabilities = contract.capabilities as { result: { method_contracts: Record<string, unknown>[] } }
        const rows = capabilities.result.method_contracts
        const index = rows.findIndex(/** 只选择当前精确方法，不扩大前缀。 */ (row) => row.method === method)
        const row = rows[index]!
        if (change === 'missing') {
          rows.splice(index, 1)
        } else if (change === 'duplicate') {
          rows.push({ ...row })
        } else if (change === 'access') {
          row.access = row.access === 'read' ? 'write' : 'read'
        } else if (change === 'scope') {
          row.scope = 'admin'
        } else if (change === 'idempotent') {
          row.idempotent = !row.idempotent
        } else {
          row.extra = true
        }
        assert.throws(
          /** 每个受审 descriptor 均要求官方精确字段和值。 */ () => assertLuvusOperationsContract(contract),
          /luvus_operations_contract_mismatch/
        )
      }
    }
  }
)

test(
  'shared Luvus raw authority requires exact true from the independent decision and retains the original grant fence',
  /** truthy 广告不是授权；获准 grant 只覆盖原主体、完整绑定、精确方法和原 deadline。 */ () => {
    const input = fixture()
    for (const value of [false, undefined, null, 1, 'true', {}]) {
      const authority = createLuvusOperationsAuthority(
        input.contract,
        /** 合成来源不能影响独立 raw 决定。 */ () => input.source,
        /** 特意返回错误运行时类型，要求严格等于布尔 true。 */ () => value as boolean
      )
      const auth = authority(input.attempt, input.native)
      assert.equal(auth.owner, false)
      assert.equal(auth.raw_requested, true)
      assert.equal(Object.hasOwn(auth, 'raw_grant'), false)
    }
    const authority = createLuvusOperationsAuthority(
      input.contract,
      /** 每个调用显式提供本场景来源。 */ () => input.source,
      /** 核对宿主收到同一原始 attempt，再明确放行当前 raw。 */ (attempt) => {
        assert.equal(attempt, input.attempt)
        return true
      }
    )
    const auth = authority(input.attempt, input.native)
    assert.equal(auth.owner, true)
    assert.deepEqual(auth.raw_grant, {
      id: 'call1',
      source_verified: true,
      principal_id: 'principal1',
      binding: input.native,
      methods: ['workspace.rename'],
      expires_at: 200
    })
    assert.equal(auth.confirmation_verified, false)
    assert.equal(auth.custody_available, false)
  }
)

test(
  'shared Luvus authority composes with the original native gate for denied, permitted and expired raw calls',
  /** 真正使用本机编译句柄与原 native gate，缺 grant 及到期均拒绝，而明确当前授权保持可派发。 */ () => {
    const input = fixture()
    const denied = dispatch(input, false)
    assert.equal(denied.ok, false)
    if (!denied.ok) {
      assert.equal(denied.error.code, 'raw_contract_not_authorized')
    }
    assert.equal(dispatch(input, true).ok, true)
    const expired = dispatch(input, true, input.attempt.binding.registration.deadline)
    assert.equal(expired.ok, false)
    if (!expired.ok) {
      assert.equal(expired.error.code, 'raw_contract_grant_expired')
    }
  }
)

test(
  'shared Luvus strict classification keeps schema mode without asking for Owner or raw permission',
  /** 有官方条件分支的方法不调用 raw 回调，也不生成 raw grant。 */ () => {
    const input = fixture('pane.list', { all_tabs: true })
    const authority = createLuvusOperationsAuthority(
      input.contract,
      /** strict 路径仍核对当前来源。 */ () => input.source,
      /** strict 不得旁路取得 Owner 权限。 */ () => {
        throw new Error('raw_decision_unexpected')
      }
    )
    const auth = authority(input.attempt, input.native)
    assert.equal(auth.owner, false)
    assert.equal(auth.raw_requested, false)
    assert.equal(Object.hasOwn(auth, 'raw_grant'), false)
    assert.equal(dispatch(input, false).ok, true)
    const classification = auth.classifications[0] as { revision: string; effect: string; native: unknown }
    assert.equal(classification.revision, MANAGED_LUVUS_CLASSIFICATION)
    assert.equal(classification.effect, 'read')
    assert.deepEqual(classification.native, {
      method: 'pane.list',
      access: 'read',
      scope: 'workspace',
      idempotent: true
    })
  }
)

test(
  'shared Luvus authority rechecks current source before methods, params and independent raw permission',
  /** 来源每次重查；旧 epoch 或不可信状态在 raw 回调之前失败。 */ () => {
    const input = fixture()
    let source = input.source
    let reads = 0
    let decisions = 0
    const authority = createLuvusOperationsAuthority(
      input.contract,
      /** 记录每次实际查询并核对完整原 attempt 引用。 */ (binding) => {
        assert.equal(binding, input.attempt.binding)
        reads++
        return source
      },
      /** 无效来源不得到达权限决定。 */ () => {
        decisions++
        return true
      }
    )
    authority(input.attempt, input.native)
    source = { ...source, binding: { ...source.binding, connection_epoch: 'epoch2' } }
    assert.throws(
      /** 原 native 绑定不能借新 epoch 来源。 */ () => authority(input.attempt, input.native),
      /luvus_operation_unreviewed/
    )
    source = { ...input.source, source_verified: false }
    assert.throws(
      /** 缺独立来源不能凭同形绑定放行。 */ () => authority(input.attempt, input.native),
      /luvus_operation_unreviewed/
    )
    source = { ...input.source, authenticated: false }
    assert.throws(/** 未认证来源也拒绝。 */ () => authority(input.attempt, input.native), /luvus_operation_unreviewed/)
    assert.equal(reads, 4)
    assert.equal(decisions, 1)
  }
)

test(
  'shared Luvus authority rejects unreviewed methods, wrong modes and invalid params before raw permission',
  /** 显式 raw 权限不扩大普通操作表，也不豁免精确参数 guard。 */ () => {
    const input = fixture()
    let decisions = 0
    const authority = createLuvusOperationsAuthority(
      input.contract,
      /** 所有变体仅改变方法内容，不伪造另一个来源。 */ () => input.source,
      /** 拒绝输入不得到达独立 raw 决定。 */ () => {
        decisions++
        return true
      }
    )
    for (const attempt of [
      { ...input.attempt, method: 'uhp.token.create' },
      { ...input.attempt, native_request: { ...input.attempt.native_request, method: 'workspace.close' } },
      { ...input.attempt, mode: 'strict' as const },
      { ...input.attempt, native_request: { ...input.attempt.native_request, params: { workspace_id: 'a' } } }
    ]) {
      assert.throws(
        /** 未审方法、模式和参数都应先拒绝。 */ () => authority(attempt, input.native),
        /luvus_operation_(unreviewed|params_invalid)/
      )
    }
    assert.equal(decisions, 0)
  }
)
