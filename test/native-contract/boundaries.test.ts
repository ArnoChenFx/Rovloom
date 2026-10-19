// 验证 raw、分类、秘密结果、控制帧和结果保留门禁，以及可信绑定与编译输入的拒绝边界。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  checkDispatch,
  checkResultBoundary,
  compileBundle,
  createNativeValidator,
  inspectRequestGate
} from '../../src/native-contract/index.js'
import { checkResultRetention } from '../../src/native-contract/safety.js'
import type { SafetyClassification } from '../../src/native-contract/index.js'
import {
  auth,
  bytes,
  clone,
  compiled,
  G,
  identity,
  json,
  raw,
  register,
  rejects,
  request,
  source,
  sourceFor,
  T,
  unwrap,
  validator,
  view
} from './helpers.js'

test(
  '选用 custody 通道时必须当前可用，普通分类不能把失效 custody 标为已授权',
  /* 验证 custody 的选择与当前可用性独立受检，普通分类也不能绕过通道要求。 */ () => {
    const candidate = request(view(), {
      id: 'custody',
      method: 'task.add',
      params: { title: 'synthetic' }
    })
    const context = { ...auth(candidate), result_channel: 'custody' as const }
    assert.equal(unwrap(inspectRequestGate(candidate, context)).secret_result_authorized, false)
    rejects(checkDispatch(candidate, context), 'secret_boundary_required')
    unwrap(checkDispatch(candidate, { ...context, custody_available: true }))
    unwrap(checkDispatch(candidate, { ...context, result_channel: 'ordinary' }))
  }
)

test(
  'raw 需要 Owner 显式选择及独立 grant，不能放宽身份/恢复代次/契约',
  /* 验证 raw 必须由 Owner 显式选择，并拒绝越界主体或过时绑定的独立 grant。 */ () => {
    const candidate = request(view(), { id: 'raw', method: 'ping', params: {} })
    rejects(checkDispatch(candidate, { ...raw(candidate), owner: false }), 'raw_contract_not_authorized')
    rejects(checkDispatch(candidate, { ...raw(candidate), raw_requested: false }), 'raw_contract_not_authorized')
    for (const field of [
      'recovery_generation',
      'connection_epoch',
      'classification_revision',
      'capability_revision'
    ] as const) {
      const context: any = clone(raw(candidate))
      context.raw_grant.binding[field] += '-stale'
      rejects(checkDispatch(candidate, context), 'raw_contract_grant_stale')
    }
    const wrongPrincipal = clone(raw(candidate))
    rejects(
      checkDispatch(candidate, {
        ...wrongPrincipal,
        raw_grant: { ...wrongPrincipal.raw_grant!, principal_id: 'other' }
      }),
      'raw_contract_scope_mismatch'
    )
  }
)

test(
  'Wire 多轴 Gate 独立表达安全分类与参数缺口，不把许可或认证当结构副产物',
  /* 核对 Gate 各状态轴独立呈现，诊断成功不能代替完整派发授权。 */ () => {
    const candidate = request(view(), { id: 'gate', method: 'ping', params: {} })
    const strict = unwrap(inspectRequestGate(candidate, auth(candidate)))
    assert.deepEqual(strict, {
      classification_status: 'trusted_complete',
      schema_status: 'incomplete',
      transport_status: 'supported',
      authorized: true,
      secret_result_authorized: true,
      raw_contract_authorized: false
    })
    const rawGate = unwrap(inspectRequestGate(candidate, raw(candidate)))
    assert.equal(rawGate.raw_contract_authorized, true)
    assert.equal(rawGate.schema_status, 'incomplete')
    const unknown = unwrap(inspectRequestGate(candidate, { ...raw(candidate), classifications: [] }))
    assert.equal(unknown.classification_status, 'missing')
    assert.equal(unknown.schema_status, 'incomplete')
    assert.equal(unknown.authorized, false)
    assert.equal(unknown.raw_contract_authorized, true)
    // raw grant 可有效而分类缺失，真实派发必须同时通过所有维度。
    rejects(checkDispatch(candidate, { ...raw(candidate), classifications: [] }), 'safety_classification_missing')
  }
)

test(
  '未知在线方法只发现为未分类传输，原始分派仍需显式 adapter 与精确分类',
  /* 为未来方法构造在线广告，验证 raw 仍要求正确传输适配器与精确安全分类。 */ () => {
    const caps = json('session-capabilities.json')
    caps.result.session = 'synthetic'
    caps.result.server_generation = G
    caps.result.methods.push('future.synthetic')
    caps.result.method_contracts.push({
      method: 'future.synthetic',
      scope: 'read',
      access: 'read',
      idempotent: true
    })
    const discovered = unwrap(validator.bindCapabilities(caps, source()))
    assert.equal(unwrap(validator.describe(discovered, 'future.synthetic')).transport, 'unclassified')
    const candidate = request(
      discovered,
      { id: 'future', method: 'future.synthetic', params: { synthetic: true } },
      true
    )
    assert.equal(candidate.validation, 'unavailable')
    rejects(checkDispatch(candidate, { ...raw(candidate), supported_transports: [] }), 'unsupported_transport')
    const context: any = raw(candidate)
    context.classifications[0].transport = 'persistent_local_stream'
    rejects(checkDispatch(candidate, context), 'unsupported_transport')
    const permit = unwrap(checkDispatch(candidate, raw(candidate)))
    assert.equal(permit.validation, 'unavailable')
    const error = {
      id: 'future',
      error: { code: 'synthetic_future', message: 'synthetic', data: { keep: true } }
    }
    assert.deepEqual(unwrap(validator.checkResponse(permit, error, sourceFor(candidate.binding))).response, error)
    rejects(validator.checkResponse(candidate as any, error, sourceFor(candidate.binding)), 'invalid_request_handle')
  }
)

test(
  '评审分类字段/原生提示/revision 冲突与字符串策略均不能授权',
  /* 逐项破坏分类字段或策略结构，确认冲突、重复及类型错误均不能授权。 */ () => {
    const candidate = request(view(), {
      id: 'prompt',
      method: 'agent.prompt',
      params: { target: '3', text: 'synthetic' }
    })
    for (const mutation of [
      // 删除结果读取授权要求，构造不完整分类。
      (row: any) => delete row.result.read_authorization,
      // 篡改原生幂等性提示，构造与广告冲突的分类。
      (row: any) => (row.native.idempotent = true),
      // 替换分类版本，构造过时分类。
      (row: any) => (row.revision = 'other'),
      // 将写操作声明为读取效果，构造效果冲突。
      (row: any) => (row.effect = 'read'),
      // 替换二进制摘要，构造契约身份冲突。
      (row: any) => (row.contract.binary_sha256 = '3'.repeat(64)),
      // 添加未知管理要求字段，验证分类不会忽略未支持的语义。
      (row: any) => (row.future_admin_requirement = true),
      // 添加未知结果交付字段，验证结果分类完整性检查。
      (row: any) => (row.result.future_delivery_requirement = true)
    ]) {
      const context: any = clone(auth(candidate))
      mutation(context.classifications[0])
      rejects(checkDispatch(candidate, context), 'safety_classification_invalid')
    }
    const duplicate = auth(candidate)
    rejects(
      checkDispatch(candidate, {
        ...duplicate,
        classifications: [...duplicate.classifications, ...duplicate.classifications]
      }),
      'safety_classification_invalid'
    )
    const malformed: any = clone(auth(candidate))
    malformed.caller_policy.methods = 'prefix-agent.prompt-suffix'
    rejects(checkDispatch(candidate, malformed), 'invalid_authorization_context')
  }
)

test(
  '通用 action.invoke 必须分类实际子动作，raw 不接受容器方法代替',
  /* 验证通用动作调用必须分类实际子动作，raw 不接受仅匹配容器方法。 */ () => {
    const candidate = request(view(), {
      id: 'invoke',
      method: 'module.action.invoke',
      params: { action: 'reviewed' }
    })
    rejects(checkDispatch(candidate, raw(candidate)), 'safety_classification_invalid')
    const context: any = raw(candidate)
    context.classifications[0].sub_action = { pointer: '/params/action', value: 'other' }
    rejects(checkDispatch(candidate, context), 'safety_classification_missing')
    context.classifications[0].sub_action.value = 'reviewed'
    assert.equal(unwrap(checkDispatch(candidate, context)).validation, 'generic')
  }
)

test(
  '独立秘密结果边界覆盖真实 token 方法与未来方法，不向错误诊断写原文',
  /* 验证 token 的管理和秘密交付边界，并确保错误诊断不泄露非法结果原文。 */ () => {
    const candidate = request(view(), {
      id: 'token',
      method: 'uhp.token.create',
      params: { scopes: ['read'] }
    })
    let context = auth(candidate)
    rejects(checkDispatch(candidate, { ...context, owner: true }), 'management_forbidden')
    context = {
      ...context,
      permissions: ['admin-test'],
      custody_available: true,
      result_channel: 'custody'
    }
    const permit = unwrap(checkDispatch(candidate, context))
    for (const channel of ['ordinary', 'handle', 'late']) {
      rejects(
        checkResultBoundary(permit, {
          principal_id: 'synthetic',
          caller_policy_allowed: true,
          classification_source_verified: true,
          classification_revision: candidate.binding.classification_revision,
          local_policy_allowed: true,
          channel: channel as any,
          content_status: 'available'
        }),
        'secret_boundary_required'
      )
    }
    unwrap(
      checkResultBoundary(permit, {
        principal_id: 'synthetic',
        caller_policy_allowed: true,
        classification_source_verified: true,
        classification_revision: candidate.binding.classification_revision,
        local_policy_allowed: true,
        channel: 'custody',
        content_status: 'available'
      })
    )
    const forged: any = clone(context)
    forged.classifications[0].result = {
      boundary: 'ordinary',
      sensitivity: 'public',
      read_authorization: 'required',
      retention: 'caller_policy',
      delivery: 'ordinary'
    }
    rejects(checkDispatch(candidate, forged), 'safety_classification_invalid')
    const error = validator.checkResponse(
      permit,
      { id: 'token', result: 'SYNTHETIC_SECRET_DO_NOT_LOG' },
      sourceFor(candidate.binding)
    )
    rejects(error, 'native_response_invalid')
    assert(!JSON.stringify(error).includes('SYNTHETIC_SECRET_DO_NOT_LOG'))
  }
)

test(
  '控制流逐帧分类及授权，open 许可不能被另一个 handle 或 observe 借用',
  /* 验证控制帧逐次获得独立分类与许可，复制流句柄无法借用父流授权。 */ () => {
    const from = view()
    const candidate = request(from, {
      id: 'open',
      method: 'terminal.backend.control',
      params: { server_generation: G, terminal_id: T, pane_id: '3' }
    })
    const permit = unwrap(checkDispatch(candidate, auth(candidate)))
    const acknowledgement = {
      id: 'open',
      result: {
        type: 'terminal_backend_stream',
        mode: 'control',
        server_generation: G,
        terminal_id: T,
        pane_id: '3',
        sequence: 0,
        content_revision: 0,
        ansi: true,
        capture_mode: 'visible',
        lines: 1,
        frame_bytes: 65536,
        queue_capacity: 2,
        loss_behavior: 'resync_required_then_close'
      }
    }
    const stream = unwrap(
      validator.openStream(
        permit,
        unwrap(validator.checkResponse(permit, acknowledgement, sourceFor(candidate.binding)))
      )
    )
    const frame = register(
      unwrap(
        validator.checkControl(stream, {
          id: 'input',
          action: 'type_literal',
          params: { text: 'synthetic' }
        })
      ),
      from
    )
    const inputPermit = unwrap(checkDispatch(frame, auth(frame)))
    const ack = {
      id: 'input',
      result: { type: 'terminal_backend_action', state: 'succeeded', dispatch: 'queued' }
    }
    assert.equal(unwrap(validator.checkResponse(inputPermit, ack, sourceFor(frame.binding))).response.id, 'input')
    rejects(
      checkDispatch(frame, { ...auth(frame), classifications: auth(candidate).classifications }),
      'safety_classification_missing'
    )
    const another = createNativeValidator(compiled)
    // 同一 contract 的另一个实例共享可信编译状态；假 stream 对象仍被拒绝。
    rejects(another.checkControl(clone(stream), frame.frame), 'invalid_stream_context')
  }
)

test(
  '结果保留是独立门禁：派发与当前分类均可禁存，禁存不等于禁止当前读取',
  /* 验证结果读取与保留独立，派发时或当前分类禁存均会阻止保留。 */ () => {
    const candidate = request(view(), {
      id: 'retention',
      method: 'task.add',
      params: { title: 'synthetic' }
    })
    const context = auth(candidate)
    const row = context.classifications[0] as SafetyClassification
    const noRetention = {
      ...context,
      classifications: [{ ...row, result: { ...row.result, retention: 'none' as const } }]
    }
    const ordinary = unwrap(checkDispatch(candidate, context))
    const transient = unwrap(checkDispatch(candidate, noRetention))
    unwrap(checkResultRetention(ordinary, context))
    rejects(checkResultRetention(ordinary, noRetention), 'content_retention_forbidden')
    rejects(checkResultRetention(transient, context), 'content_retention_forbidden')
    rejects(checkResultRetention(transient, noRetention), 'content_retention_forbidden')
    unwrap(
      checkResultBoundary(transient, {
        principal_id: 'synthetic',
        caller_policy_allowed: true,
        local_policy_allowed: true,
        classification_source_verified: true,
        classification_revision: candidate.binding.classification_revision,
        channel: 'ordinary',
        content_status: 'available'
      })
    )
  }
)

test(
  '保留门禁不接受复制 permit、其它 principal 或未知/不可信/过时分类来源',
  /* 验证保留门禁拒绝伪造许可、错误主体以及失效或缺失的分类来源。 */ () => {
    const candidate = request(view(), {
      id: 'retention',
      method: 'task.add',
      params: { title: 'synthetic' }
    })
    const context = auth(candidate)
    const permit = unwrap(checkDispatch(candidate, context))
    rejects(checkResultRetention(clone(permit), context), 'invalid_permit_handle')
    rejects(checkResultRetention(permit, { ...context, principal_id: 'other' }), 'forbidden')
    rejects(checkResultRetention(permit, { ...context, classifications: [] }), 'safety_classification_missing')
    rejects(
      checkResultRetention(permit, { ...context, classification_source_verified: false }),
      'safety_classification_untrusted'
    )
    const stale = clone(context)
    rejects(
      checkResultRetention(permit, {
        ...stale,
        source: {
          ...stale.source,
          binding: { ...stale.source.binding, classification_revision: 'stale' }
        }
      }),
      'capability_stale'
    )
  }
)

test(
  '输入不可变快照与所有响应来源锚点，不能用接收时自报字段串调用',
  /* 验证请求快照不受后续变更影响，并逐项拒绝响应来源锚点变化。 */ () => {
    const input: any = {
      id: 'snapshot',
      method: 'agent.prompt',
      params: { target: '3', text: 'synthetic' }
    }
    const checked = request(view(), input)
    input.params.text = 'changed'
    assert.equal((checked.request.params as any).text, 'synthetic')
    assert(Object.isFrozen(checked.request.params))
    const response = { id: 'snapshot', result: {} }
    for (const field of ['recovery_generation', 'connection_epoch', 'server_generation'] as const) {
      const trusted: any = clone(sourceFor(checked.binding))
      trusted.binding[field] += '-different'
      rejects(validator.checkResponse(checked, response, trusted), 'native_identity_mismatch')
    }
    const otherRuntime: any = clone(sourceFor(checked.binding))
    otherRuntime.binding.contract.schema_sha256 = '3'.repeat(64)
    rejects(validator.checkResponse(checked, response, otherRuntime), 'native_identity_mismatch')
    for (const [field, value] of [
      ['provider_id', 'p2'],
      ['binding_revision', 2],
      ['contract_source_ref', 'different-reviewed-source']
    ] as const) {
      const other: any = clone(sourceFor(checked.binding))
      other.binding[field] = value
      rejects(validator.checkResponse(checked, response, other), 'native_identity_mismatch')
    }
    const wrongKind: any = clone(sourceFor(checked.binding))
    wrongKind.binding.kind = 'herdr'
    rejects(validator.checkResponse(checked, response, wrongKind), 'native_source_untrusted')
  }
)

test(
  'schema 关键字/别名/字节预算 fail closed，不把未引用原生属性字典当约束',
  /* 构造未知关键字、非法属性字典引用及字节预算反例，确认编译保守拒绝。 */ async () => {
    const b = json('schema-bundle.json')
    const uri = 'https://luvus.dev/protocol/uhp/v1/request.schema.json'
    b.documents[uri].synthetic_future_keyword = true
    let encoded = JSON.stringify(b)
    // 按当前序列化内容重算 schema 摘要，避免摘要检查遮蔽待测编译失败。
    const changedIdentity = () => ({
      ...identity,
      schema_sha256: createHash('sha256').update(encoded).digest('hex')
    })
    rejects(await compileBundle(encoded, { identity: changedIdentity() }), 'schema_unavailable')
    const original = json('schema-bundle.json')
    original.documents[uri].allOf[0].then.properties.params.$ref =
      'https://luvus.dev/protocol/uhp/v1/schema/terminal/common.schema.json#/$defs/locatorProperties'
    encoded = JSON.stringify(original)
    const bad = await compileBundle(encoded, { identity: changedIdentity() })
    rejects(bad, 'schema_unavailable')
    if (!bad.ok) {
      assert.equal(bad.error.reason, 'unsupported_reference')
    }
    rejects(await compileBundle(bytes, { identity, limits: { bundle_bytes: 16 } }), 'schema_unavailable')
    rejects(await compileBundle(bytes, { identity, limits: { bundle_bytes: 2_097_153 } }), 'invalid_limits')
  }
)
