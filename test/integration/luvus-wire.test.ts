// 验证真实原生校验器接入 Wire 后的授权、流状态、证据、回滚及预算边界。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLuvusWireAdapter } from '../../src/integration/luvus-wire.js'
import type { NativeWireBackend, TrustedAttempt } from '../../src/integration/luvus-wire.js'
import { boundedJson, contractRef, hash, LIMITS } from '../../src/wire/index.js'
import type {
  AttemptBinding,
  AuthenticatedEnvelope,
  ContractSource,
  Payloads,
  ProviderPolicies
} from '../../src/wire/types.js'
import type { NativeBinding, SafetyClassification } from '../../src/native-contract/index.js'
import { auth, clone, compiled, G, identity, json, request, T, view } from '../native-contract/helpers.js'

// 全部是隔离 P0 fixture 与明确的测试权限；生产模块不导入本工厂或测试 gate。
function fixture(
  method = 'task.add',
  raw = false,
  stream = false,
  limits?: Parameters<typeof createLuvusWireAdapter>[1]
) {
  const params =
    method === 'ping'
      ? {}
      : method === 'task.add'
        ? { title: 'synthetic' }
        : {
            server_generation: G,
            terminal_id: T,
            pane_id: '3',
            ...(method === 'terminal.backend.capture' ? { mode: 'visible', lines: 1, ansi: false } : {})
          }
  const candidate = request(view(), { id: 'native_1', method, params })
  const initial = auth(candidate)
  const origin: ContractSource = {
    provider_kind: 'luvus',
    protocol_family: 'uhp',
    binary_version: '0.14.3',
    binary_sha256: identity.binary_sha256,
    schema_sha256: identity.schema_sha256,
    schema_origin: 'installed_cli',
    schema_command: 'luvus uhp schema',
    server_version: '0.14.3',
    native_protocol_version: '1.0',
    runtime_generation: G,
    adapter_revision: 'integration_test',
    classification_revision: 'review1',
    support_basis: 'live_catalog'
  }
  const binding: AttemptBinding = {
    machine_id: 'm1',
    recovery_generation: 'recovery1',
    connection_epoch: 'e1',
    call_id: 'call1',
    attempt_id: 'attempt1',
    native_request_id: 'native_1',
    provider_kind: 'luvus',
    binding_revision: 1,
    contract_ref: contractRef(origin),
    target: { machine_id: 'm1', provider_id: 'p1', profile: 'session', session: 'synthetic' },
    registration: {
      deadline: 1000,
      history: null,
      caller_policy_revision: 'caller1',
      local_policy_revision: 'local1'
    }
  }
  const row: TrustedAttempt = {
    binding,
    principal_id: 'synthetic',
    method,
    mode: raw ? 'raw-contract' : 'strict',
    native_request: { method, params },
    transport: stream ? 'stream' : 'rpc',
    ...(stream ? { feature: 'terminal_control', stream_id: 'stream1' } : {})
  }
  const rows = new Map([[binding.call_id, row]])
  const policies: ProviderPolicies = {
    caller: {
      revision: 'caller1',
      grants: [
        {
          target: clone(binding.target),
          methods: [method],
          actions: ['dispatch', 'read', 'stream_input', 'cancel']
        }
      ]
    },
    local: { revision: 'local1', grants: [] }
  }
  policies.local.grants = clone(policies.caller.grants)
  const state = {
    active: true,
    enabled: true,
    sourceVerified: true,
    reader: 'synthetic',
    content: 'available' as 'available' | 'expired' | 'discarded' | 'unavailable',
    owner: raw,
    grant: raw,
    trustedClassification: true,
    classifications: clone(initial.classifications) as SafetyClassification[],
    revision: 1,
    localConfig: 'config1',
    now: 100,
    custody: false,
    channel: 'ordinary' as 'ordinary' | 'custody'
  }
  const capabilities = json('session-capabilities.json')
  capabilities.result.session = 'synthetic'
  capabilities.result.server_generation = G
  // 从指定测试记录构造独立原生绑定，保留 provider、revision 与连接身份差异。
  const nativeBinding = (record: TrustedAttempt): NativeBinding => ({
    ...candidate.binding,
    provider_id: record.binding.target.provider_id,
    binding_revision: record.binding.binding_revision,
    contract_source_ref: record.binding.contract_ref
  })
  const backend: NativeWireBackend = {
    // 返回测试连接及可变在线状态，用于验证 epoch 与认证失效。
    connection: () => ({
      machine_id: 'm1',
      recovery_generation: 'recovery1',
      connection_epoch: 'e1',
      authenticated: true,
      active: state.active as true,
      negotiated: {
        major: 2,
        minor: 0,
        capabilities: ['rpc', 'objects', 'late_evidence', 'terminal_observe', 'terminal_control']
      }
    }),
    // 只查找调用及尝试 ID 均匹配的测试账本记录，避免夹具掩盖跨绑定错误。
    attempt: (call, attempt) => {
      const found = rows.get(call)
      return found?.binding.attempt_id === attempt ? found : undefined
    },
    // 返回当前测试 revision 的网关 provider 配置，支持双端错配注入。
    provider: (target) => ({
      machine_id: 'm1',
      provider_id: target.provider_id,
      binding_revision: state.revision,
      kind: 'luvus',
      enabled: state.enabled,
      config_ref: 'config1'
    }),
    // 返回本地 provider 配置，用于真实适配器的双端配置交叉核对。
    localProvider: (target) => ({
      machine_id: 'm1',
      provider_id: target.provider_id,
      binding_revision: state.revision,
      kind: 'luvus',
      enabled: state.enabled,
      config_ref: state.localConfig
    }),
    // 返回固定来源的真实编译契约和可变能力广告，支持陈旧能力与预算检查。
    contract: (ref) =>
      ref === contractRef(origin)
        ? {
            wire: { source: origin, support_status: 'validated' },
            compiled,
            capabilities,
            capability_revision: 'caps1'
          }
        : undefined,
    // 按调用独立提供已认证的原生绑定，找不到记录时不补造来源。
    nativeSource: (call) => {
      const found = rows.get(call)
      return found
        ? {
            authenticated: true,
            source_verified: state.sourceVerified,
            binding: nativeBinding(found)
          }
        : undefined
    },
    // 返回测试的当前双端策略，使撤权能即时作用于真实校验器。
    policies: () => policies,
    // 从真实候选构造独立测试授权事实，并覆盖当前分类和秘密边界状态。
    authority: (record, native) => {
      const {
        source: _source,
        principal_id: _principal,
        caller_policy: _caller,
        local_policy: _local,
        mode: _mode,
        now: _now,
        ...authority
      } = initial
      return {
        ...authority,
        classifications: state.classifications,
        classification_source_verified: state.trustedClassification,
        owner: state.owner,
        raw_requested: raw,
        custody_available: state.custody,
        result_channel: state.channel,
        ...(state.grant
          ? {
              raw_grant: {
                id: 'grant1',
                source_verified: true,
                principal_id: record.principal_id,
                binding: native,
                methods: [method],
                expires_at: 200
              }
            }
          : {})
      }
    },
    // 返回测试读取者身份，验证结果读取不能借用原调用者身份。
    currentPrincipal: () => state.reader,
    // 返回当前测试内容状态，用于验证过期和 discard 后的不可复活边界。
    contentStatus: () => state.content,
    // 返回可控测试时钟，让 deadline 与 TTL 边界可精确重现。
    now: () => state.now,
    // 按精确调用和尝试返回固定响应锚点，方法、模式及期限来自对应记录。
    responseAnchor: (input) => {
      const found = rows.get(input.call_id)
      if (!found || found.binding.attempt_id !== input.attempt_id) {
        return undefined
      }
      return {
        binding: found.binding,
        method: found.method,
        mode: found.mode,
        state: 'outcome_unknown',
        content_status: state.content,
        content_expires_at: 500,
        dedup_expires_at: 2000
      }
    }
  }
  const adapter = createLuvusWireAdapter(backend, limits)
  // 从完整测试绑定提取消息所携带的尝试身份，连接外壳保持独立。
  const attempt = ({
    machine_id: _machine,
    recovery_generation: _recovery,
    connection_epoch: _epoch,
    ...rest
  }: AttemptBinding) => rest
  // 把测试 payload 包装为当前连接的认证 Wire 消息，保持固定消息 ID 供去重测试。
  function frame<K extends keyof Payloads>(type: K, payload: Payloads[K]): Extract<AuthenticatedEnvelope, { type: K }> {
    return {
      protocol_major: 2,
      protocol_minor: 0,
      type,
      message_id: 'msg1',
      machine_id: 'm1',
      recovery_generation: 'recovery1',
      connection_epoch: 'e1',
      payload
    } as Extract<AuthenticatedEnvelope, { type: K }>
  }
  const opening = stream
    ? frame('stream_open', {
        attempt: attempt(binding),
        expected_binding_revision: 1,
        native_request: row.native_request,
        validation: row.mode,
        stream_id: 'stream1',
        feature: 'terminal_control'
      })
    : frame('request', {
        attempt: attempt(binding),
        expected_binding_revision: 1,
        native_request: row.native_request,
        validation: row.mode
      })
  const response = frame('response', {
    attempt: attempt(binding),
    native_response: {
      id: 'native_1',
      error: {
        code: 'synthetic',
        message: 'preserve',
        data: { deep: ['汉字', { native: true }] }
      }
    }
  })
  // 将测试对象序列化后交给真实适配器解码，默认模拟网关到连接器方向。
  const decode = (
    value: unknown,
    direction: 'gateway_to_connector' | 'connector_to_gateway' = 'gateway_to_connector'
  ) => adapter.decode(JSON.stringify(value), direction)
  return {
    adapter,
    backend,
    binding,
    row,
    rows,
    origin,
    policies,
    state,
    opening,
    response,
    decode,
    frame,
    attempt,
    nativeBinding
  }
}
// 执行待拒绝操作并核对固定错误码，避免只检查抛错而掩盖错误分支。
const rejects = (run: () => unknown, code: string) =>
  assert.throws(run, /* 核对抛出的固定错误码与预期一致，避免无关异常被误判为通过。 */ (e: any) => e.code === code, code)

// 打开真实控制流并准备开流响应、输入及 acknowledgement，供逐输入许可测试复用。
function controlFixture(limits?: Parameters<typeof createLuvusWireAdapter>[1]) {
  const f = fixture('terminal.backend.control', false, true, limits)
  // 把原生响应或事件包装为绑定当前控制流的 stream_data 消息。
  const data = (frame: Record<string, unknown>, sequence = 0) =>
    f.frame('stream_data', {
      attempt: f.attempt(f.binding),
      stream_id: 'stream1',
      feature: 'terminal_control',
      sequence,
      frame
    })
  const ack = {
    id: 'native_1',
    result: {
      type: 'terminal_backend_stream',
      mode: 'control',
      server_generation: G,
      terminal_id: T,
      pane_id: '3',
      sequence: 0,
      content_revision: 0,
      ansi: false,
      capture_mode: 'visible',
      lines: 1,
      frame_bytes: 65536,
      queue_capacity: 2,
      loss_behavior: 'resync_required_then_close'
    }
  }
  f.adapter.advanceStream(f.opening, 'gateway_to_connector')
  f.adapter.advanceStream(data(ack), 'connector_to_gateway')
  // 为指定输入 ID 构造绑定当前终端控制流的动作帧。
  const input = (id: string) =>
    f.frame('stream_input', {
      attempt: f.attempt(f.binding),
      stream_id: 'stream1',
      feature: 'terminal_control',
      sequence: 0,
      frame: { id, action: 'type_literal', params: { text: 'synthetic' } }
    })
  const inputAck = {
    id: 'input1',
    result: { type: 'terminal_backend_action', state: 'succeeded', dispatch: 'queued' }
  }
  return { ...f, data, input, inputAck, ack }
}

test(
  '外层输入顺序失败不留下控制许可或 ID 冲突，纠正后仍可使用原 ID',
  /* 先让控制输入在外层序号检查失败，再用同一 ID 校验正确输入，确认新许可与冲突状态完整回滚。 */ () => {
    const f = controlFixture()
    f.state.classifications.push({ ...clone(f.state.classifications[0]!), action: 'type_literal' })
    const bad = f.input('input1')
    bad.payload.sequence = 7
    rejects(
      /* 推进指定输入或输出的流生命周期，要求以 stream_sequence_mismatch 拒绝。 */ () =>
        f.adapter.advanceStream(bad, 'gateway_to_connector'),
      'stream_sequence_mismatch'
    )
    rejects(
      /* 检查所选响应或事件的当前读取权限，要求以 control_ack_unbound 拒绝（控制响应没有对应许可）。 */ () =>
        f.adapter.checkResult(f.binding, f.inputAck),
      'control_ack_unbound'
    )
    rejects(
      /* 推进指定输入或输出的流生命周期，要求以 control_ack_unbound 拒绝（控制响应没有对应许可）。 */ () =>
        f.adapter.advanceStream(f.data(f.inputAck, 1), 'connector_to_gateway'),
      'control_ack_unbound'
    )
    const corrected = f.input('input1')
    corrected.payload.frame.params = { text: 'corrected' }
    assert.equal(f.adapter.advanceStream(corrected, 'gateway_to_connector').next_input_sequence, 1)
    assert.equal(f.adapter.advanceStream(f.data(f.inputAck, 1), 'connector_to_gateway').next_data_sequence, 2)
  }
)

test(
  '失败输入返还控制 ID 和精确快照预算，已成功输入的许可仍保留',
  /* 按成功输入的精确快照量设置预算，失败输入返还容量且保留此前成功输入的读取许可。 */ () => {
    const base = controlFixture()
    const frame = base.input('input1')
    const source = base.backend.nativeSource(base.binding.call_id, base.binding.attempt_id)
    const capabilities = base.backend.contract(base.binding.contract_ref)!.capabilities
    const bytes =
      2 * Buffer.byteLength(boundedJson({ attempt: base.row, source, capabilities })) +
      2 * Buffer.byteLength(boundedJson(frame.payload.frame))
    const f = controlFixture({ attempts: 1, control_ids: 1, snapshot_bytes: bytes })
    f.state.classifications.push({ ...clone(f.state.classifications[0]!), action: 'type_literal' })
    const bad = f.input('input2')
    bad.payload.sequence = 7
    rejects(
      /* 推进指定输入或输出的流生命周期，要求以 stream_sequence_mismatch 拒绝。 */ () =>
        f.adapter.advanceStream(bad, 'gateway_to_connector'),
      'stream_sequence_mismatch'
    )
    assert.equal(f.adapter.advanceStream(f.input('input1'), 'gateway_to_connector').next_input_sequence, 1)
    rejects(
      /* 推进指定输入或输出的流生命周期，要求以 stream_sequence_mismatch 拒绝。 */ () =>
        f.adapter.advanceStream(f.input('input1'), 'gateway_to_connector'),
      'stream_sequence_mismatch'
    )
    assert.doesNotThrow(
      /* 确认失败输入没有撤销此前成功输入的许可，其 acknowledgement 仍可读取。 */ () =>
        f.adapter.checkResult(f.binding, f.inputAck)
    )
  }
)

test(
  '顺序失败的开流 ack 不建立原生流或固定其摘要，后续合法 ack 可以恢复',
  /* 让开流 acknowledgement 在序号检查失败后重新处理合法帧，验证未错误建立原生流或固定摘要。 */ () => {
    const f = controlFixture()
    f.adapter.release(f.binding)
    f.adapter.advanceStream(f.opening, 'gateway_to_connector')
    rejects(
      /* 推进指定输入或输出的流生命周期，要求以 stream_sequence_mismatch 拒绝。 */ () =>
        f.adapter.advanceStream(f.data(f.ack, 7), 'connector_to_gateway'),
      'stream_sequence_mismatch'
    )
    rejects(
      /* 按当前消息方向执行完整解码校验，要求以 stream_not_ready 拒绝。 */ () => f.decode(f.input('input1')),
      'stream_not_ready'
    )
    const corrected = { ...f.ack, result: { ...f.ack.result, lines: 2 } }
    assert.equal(f.adapter.advanceStream(f.data(corrected), 'connector_to_gateway').state, 'open')
  }
)

test(
  '消息 ID 冲突回滚 native 校验产生的输入许可和容量，不撤销既有去重项',
  /* 制造消息去重冲突，验证此次生成的控制许可和容量被回滚而既有去重项仍生效。 */ () => {
    const f = controlFixture({ attempts: 1, control_ids: 1 })
    f.state.classifications.push({ ...clone(f.state.classifications[0]!), action: 'type_literal' })
    const heartbeat = f.frame('heartbeat', { sequence: 0 })
    assert.equal(f.adapter.observeMessage(heartbeat, 'gateway_to_connector'), 'new')
    rejects(
      /* 登记消息 ID 与去重摘要，要求以 message_id_conflict 拒绝。 */ () =>
        f.adapter.observeMessage(f.input('input2'), 'gateway_to_connector'),
      'message_id_conflict'
    )
    rejects(
      /* 检查所选响应或事件的当前读取权限，要求以 control_ack_unbound 拒绝（控制响应没有对应许可）。 */ () =>
        f.adapter.checkResult(f.binding, { ...f.inputAck, id: 'input2' }),
      'control_ack_unbound'
    )
    assert.equal(f.adapter.observeMessage(heartbeat, 'gateway_to_connector'), 'duplicate')
    assert.equal(f.adapter.advanceStream(f.input('input1'), 'gateway_to_connector').next_input_sequence, 1)
  }
)

test(
  '首次请求授权失败不占 attempt 名额或保存请求候选',
  /* 拒绝首次调用授权后用第二个调用占用唯一名额，证明失败路径未缓存候选或泄露预算。 */ () => {
    const f = fixture('task.add', false, false, { attempts: 1, control_ids: 1 })
    const classifications = f.state.classifications
    f.state.classifications = []
    rejects(
      /* 按当前消息方向执行完整解码校验，要求以 classification_unavailable 拒绝（可信分类不可用）。 */ () =>
        f.decode(f.opening),
      'classification_unavailable'
    )
    const second = clone(f.row)
    second.binding.call_id = 'call2'
    f.rows.set('call2', second)
    f.state.classifications = classifications
    const opening = {
      ...f.opening,
      payload: { ...f.opening.payload, attempt: f.attempt(second.binding) }
    }
    assert.doesNotThrow(
      /* 用第二个调用占用唯一 attempt 名额，证明首次授权失败没有留下候选或预算。 */ () => f.decode(opening)
    )
    assert.doesNotThrow(
      /* 检查第二个调用的真实许可，确认它未借用首次失败调用的状态。 */ () => f.adapter.checkResult(second.binding)
    )
  }
)

test(
  '错误入口拒绝请求帧后不留下已生成的派发许可，正常入口仍可重新校验',
  /* 把 RPC 请求送入错误流入口，再从正常入口校验，确认失败生成的派发许可未残留。 */ () => {
    const f = fixture()
    rejects(
      /* 推进指定输入或输出的流生命周期，要求以 invalid_stream_transition 拒绝。 */ () =>
        f.adapter.advanceStream(f.opening, 'gateway_to_connector'),
      'invalid_stream_transition'
    )
    rejects(
      /* 检查所选响应或事件的当前读取权限，要求以 dispatch_permit_unavailable 拒绝（真实派发许可缺失）。 */ () =>
        f.adapter.checkResult(f.binding),
      'dispatch_permit_unavailable'
    )
    assert.doesNotThrow(
      /* 从正常 RPC 入口重新校验原请求，证明错误流入口没有留下不可恢复状态。 */ () => f.decode(f.opening)
    )
    assert.doesNotThrow(
      /* 核对正常入口刚生成的许可已生效，结果读取不再因旧失败而被拒绝。 */ () => f.adapter.checkResult(f.binding)
    )
  }
)

test(
  '控制分类拒绝不缓存输入内容，重新授权后可使用同一 ID 的纠正请求',
  /* 让控制输入因分类缺失被拒，恢复分类后修改同一 ID 的内容，确认旧候选没有被缓存。 */ () => {
    const f = controlFixture({ attempts: 1, control_ids: 1 })
    rejects(
      /* 按当前消息方向执行完整解码校验，要求以 safety_classification_missing 拒绝。 */ () =>
        f.decode(f.input('input1')),
      'safety_classification_missing'
    )
    f.state.classifications.push({ ...clone(f.state.classifications[0]!), action: 'type_literal' })
    const corrected = f.input('input1')
    corrected.payload.frame.params = { text: 'corrected' }
    assert.doesNotThrow(/* 在恢复输入分类后解码同一 ID 的纠正正文，证明失败候选已回滚。 */ () => f.decode(corrected))
    assert.doesNotThrow(
      /* 读取纠正输入的 acknowledgement，确认其绑定新校验的输入许可。 */ () =>
        f.adapter.checkResult(f.binding, f.inputAck)
    )
  }
)

test(
  'backend 回调不能重入修改正在验证的 adapter，外层校验仍能完成',
  /* 在宿主授权回调内尝试重入释放，确认内层被拒且外层校验仍保留正确许可。 */ () => {
    const f = fixture()
    const authority = f.backend.authority
    f.backend.authority = /* 在宿主授权回调内故意重入释放，再返回原授权，验证外层校验不被破坏。 */ (...args) => {
      rejects(
        /* 重入释放正在验证的尝试上下文，要求以 native_adapter_unavailable 拒绝（适配器拒绝重入或底层异常）。 */ () =>
          f.adapter.release(f.binding),
        'native_adapter_unavailable'
      )
      return authority(...args)
    }
    assert.doesNotThrow(
      /* 完成包含受拒重入回调的外层请求校验，确认原子状态没有被内层释放。 */ () => f.decode(f.opening)
    )
    assert.doesNotThrow(
      /* 读取外层成功校验后保留的许可，证明重入失败未撤销外层状态。 */ () => f.adapter.checkResult(f.binding)
    )
  }
)

test(
  'RPC 原秘密许可在当前分类降级后仍要求 custody 可用，证据原文不得旁路',
  /* 先取得秘密 RPC 许可再降低当前分类，验证读取及证据原文仍受当前 custody 状态约束。 */ () => {
    const f = fixture()
    const ordinary = clone(f.state.classifications[0]!)
    f.state.classifications = [
      {
        ...ordinary,
        result: {
          ...ordinary.result,
          boundary: 'protected_secret',
          sensitivity: 'credential',
          delivery: 'custody'
        }
      }
    ]
    f.state.custody = true
    f.state.channel = 'custody'
    f.decode(f.opening)
    f.state.classifications = [ordinary]
    f.state.custody = false
    rejects(
      /* 检查所选响应或事件的当前读取权限，要求以 secret_boundary_required 拒绝（秘密边界尚未满足）。 */ () =>
        f.adapter.checkResult(f.binding),
      'secret_boundary_required'
    )
    assert.equal(f.adapter.planEvidence(f.response).content.delivery, 'metadata_only')
    f.state.custody = true
    assert.doesNotThrow(
      /* 恢复当前秘密 custody 后读取 RPC，证明原秘密许可仍按当前边界重新授权。 */ () => f.adapter.checkResult(f.binding)
    )
    assert.equal(f.adapter.planEvidence(f.response).content.delivery, 'payload')
    f.state.channel = 'ordinary'
    rejects(
      /* 检查所选响应或事件的当前读取权限，要求以 secret_boundary_required 拒绝（秘密边界尚未满足）。 */ () =>
        f.adapter.checkResult(f.binding),
      'secret_boundary_required'
    )
  }
)

test(
  '控制输入原秘密许可在当前分类降级后仍要求 custody 可用',
  /* 先取得秘密控制输入许可再降低当前分类，验证其 acknowledgement 仍要求当前 custody 可用。 */ () => {
    const f = controlFixture()
    const ordinary = { ...clone(f.state.classifications[0]!), action: 'type_literal' }
    f.state.classifications.push({
      ...ordinary,
      result: {
        ...ordinary.result,
        boundary: 'protected_secret',
        sensitivity: 'credential',
        delivery: 'custody'
      }
    })
    f.state.custody = true
    f.state.channel = 'custody'
    f.adapter.advanceStream(f.input('input1'), 'gateway_to_connector')
    f.state.classifications[1] = ordinary
    f.state.custody = false
    rejects(
      /* 检查所选响应或事件的当前读取权限，要求以 secret_boundary_required 拒绝（秘密边界尚未满足）。 */ () =>
        f.adapter.checkResult(f.binding, f.inputAck),
      'secret_boundary_required'
    )
    f.state.custody = true
    assert.doesNotThrow(
      /* 恢复当前秘密 custody 后读取控制输入响应，证明不能借降低分类省略 custody。 */ () =>
        f.adapter.checkResult(f.binding, f.inputAck)
    )
  }
)

test(
  'retention:none 可读取但证据计划只保留元数据，普通/秘密 result 与 error 均不复活原文',
  /* 遍历普通和秘密结果及错误响应，验证禁存策略允许当前读取但证据计划始终不携带原文。 */ () => {
    for (const secret of [false, true]) {
      for (const error of [false, true]) {
        const f = fixture()
        const row = f.state.classifications[0]!
        f.state.classifications = [
          {
            ...row,
            result: {
              ...row.result,
              retention: 'none',
              ...(secret
                ? ({
                    boundary: 'protected_secret',
                    sensitivity: 'credential',
                    delivery: 'custody'
                  } as const)
                : {})
            }
          }
        ]
        f.state.custody = secret
        f.state.channel = secret ? 'custody' : 'ordinary'
        f.decode(f.opening)
        const response = error
          ? f.response
          : {
              ...f.response,
              payload: {
                ...f.response.payload,
                native_response: {
                  id: 'native_1',
                  result: { synthetic: 'SYNTHETIC_PRIVATE_CONTENT' }
                }
              }
            }
        f.decode(response, 'connector_to_gateway')
        assert.doesNotThrow(
          /* 在当前读取授权完备时允许结果访问，禁存策略另由证据计划阻止原文落盘。 */ () =>
            f.adapter.checkResult(f.binding)
        )
        const anchor = clone(f.backend.responseAnchor!(f.binding))
        const plan = f.adapter.planEvidence(response)
        assert.equal(plan.content.delivery, 'metadata_only')
        assert.equal(plan.content.native_response, undefined)
        assert.equal(Object.hasOwn(plan.content, 'native_response'), false)
        assert.equal(Object.hasOwn(plan.content, 'result_id'), false)
        assert.equal(plan.evidence.response_hash, hash(boundedJson(response.payload.native_response)))
        assert.equal(plan.evidence.response_bytes, Buffer.byteLength(boundedJson(response.payload.native_response)))
        assert.equal(plan.evidence.category, error ? 'error' : 'result')
        assert.equal(plan.content.expires_at, anchor!.content_expires_at)
        assert.equal(plan.dispatch, false)
        assert.deepEqual(f.backend.responseAnchor!(f.binding), anchor)
      }
    }
  }
)

test(
  '控制 ack 读取选自己的 permit/当前分类，不能借普通开流许可走普通通道',
  /* 分别切换控制 acknowledgement 的当前分类和读取通道，证明其使用自己的输入许可而非开流许可。 */ () => {
    const f = controlFixture()
    const row = f.state.classifications[0]!
    const control = {
      ...clone(row),
      action: 'type_literal',
      result: {
        ...row.result,
        boundary: 'protected_secret',
        sensitivity: 'credential',
        delivery: 'custody'
      }
    } as const
    f.state.classifications.push(control)
    f.state.custody = true
    f.state.channel = 'custody'
    f.adapter.advanceStream(f.input('input1'), 'gateway_to_connector')
    f.state.channel = 'ordinary'
    const error = {
      id: 'input1',
      error: { code: 'send_failed', message: 'synthetic', metadata: { marker: 'SYNTHETIC_SECRET' } }
    }
    f.adapter.advanceStream(f.data(error, 1), 'connector_to_gateway')
    rejects(
      /* 检查所选响应或事件的当前读取权限，要求以 secret_boundary_required 拒绝（秘密边界尚未满足）。 */ () =>
        f.adapter.checkResult(f.binding, error),
      'secret_boundary_required'
    )
    rejects(
      /* 检查所选响应或事件的当前读取权限，要求以 secret_boundary_required 拒绝（秘密边界尚未满足）。 */ () =>
        f.adapter.checkResult(f.binding, f.inputAck),
      'secret_boundary_required'
    )
    rejects(
      /* 检查所选响应或事件的当前读取权限，要求以 result_selector_required 拒绝。 */ () =>
        f.adapter.checkResult(f.binding),
      'result_selector_required'
    )
    assert.doesNotThrow(
      /* 读取普通开流 acknowledgement，确认秘密控制输入的限制不会误用于开流许可。 */ () =>
        f.adapter.checkResult(f.binding, f.ack)
    )
    f.state.channel = 'custody'
    assert.doesNotThrow(
      /* 切换到 custody 通道后允许读取控制错误，证明其仍使用原秘密输入许可。 */ () =>
        f.adapter.checkResult(f.binding, error)
    )
    assert.doesNotThrow(
      /* 在 custody 通道读取控制成功响应，验证与错误响应采用同一输入边界。 */ () =>
        f.adapter.checkResult(f.binding, f.inputAck)
    )
    f.state.custody = false
    rejects(
      /* 检查所选响应或事件的当前读取权限，要求以 secret_boundary_required 拒绝（秘密边界尚未满足）。 */ () =>
        f.adapter.checkResult(f.binding, error),
      'secret_boundary_required'
    )
    f.state.custody = true
    f.state.classifications = [row]
    rejects(
      /* 检查所选响应或事件的当前读取权限，要求以 classification_unavailable 拒绝（可信分类不可用）。 */ () =>
        f.adapter.checkResult(f.binding, error),
      'classification_unavailable'
    )
    // 当前分类降为 ordinary 也不能覆盖当初控制 permit 的秘密边界。
    f.state.classifications.push({ ...control, result: row.result })
    f.state.channel = 'ordinary'
    rejects(
      /* 检查所选响应或事件的当前读取权限，要求以 secret_boundary_required 拒绝（秘密边界尚未满足）。 */ () =>
        f.adapter.checkResult(f.binding, error),
      'secret_boundary_required'
    )
  }
)

test(
  '流结果 frame 精确选择控制 ID/事件，未派发或其它 attempt 的 ID 不回退到开流许可',
  /* 逐项注入未派发 ID、跨尝试 ID 与错终端事件，证明结果读取必须精确选择真实控制许可或事件。 */ () => {
    const f = controlFixture()
    const row = f.state.classifications[0]!
    f.state.classifications.push({ ...clone(row), action: 'type_literal' })
    f.decode(f.input('input1'))
    f.decode(f.data(f.inputAck), 'connector_to_gateway')
    assert.doesNotThrow(
      /* 读取已真实派发的 input1 响应，作为随后未派发及跨尝试 ID 拒绝的对照。 */ () =>
        f.adapter.checkResult(f.binding, f.inputAck)
    )
    for (const id of ['unknown', 'input2']) {
      rejects(
        /* 检查所选响应或事件的当前读取权限，要求以 control_ack_unbound 拒绝（控制响应没有对应许可）。 */ () =>
          f.adapter.checkResult(f.binding, { ...f.inputAck, id }),
        'control_ack_unbound'
      )
    }
    const second = clone(f.row)
    second.binding.call_id = 'call2'
    f.rows.set('call2', second)
    const otherOpening = {
      ...f.opening,
      payload: { ...f.opening.payload, attempt: f.attempt(second.binding) }
    }
    f.decode(otherOpening)
    rejects(
      /* 检查所选响应或事件的当前读取权限，要求以 control_ack_unbound 拒绝（控制响应没有对应许可）。 */ () =>
        f.adapter.checkResult(second.binding, f.inputAck),
      'control_ack_unbound'
    )
    rejects(
      // 检查所选响应或事件的当前读取权限，要求以 attempt_binding_mismatch 拒绝。
      () => f.adapter.checkResult({ ...f.binding, native_request_id: 'input1' }, f.inputAck),
      'attempt_binding_mismatch'
    )
    // 不能把开流 native ID 写在控制 ack 上借其普通分类。
    rejects(
      /* 检查所选响应或事件的当前读取权限，要求以 native_result_mismatch 拒绝。 */ () =>
        f.adapter.checkResult(f.binding, { ...f.inputAck, id: 'native_1' }),
      'native_result_mismatch'
    )
    const event = {
      event: 'terminal.frame',
      sequence: 0,
      data: {
        server_generation: G,
        terminal_id: T,
        pane_id: '3',
        content_revision: 0,
        mode: 'visible',
        ansi: false,
        text: 'synthetic',
        lines: 1,
        bytes: 9,
        truncated: false
      }
    }
    assert.doesNotThrow(
      /* 读取绑定当前终端的合法流事件，作为错 terminal_id 拒绝的对照。 */ () => f.adapter.checkResult(f.binding, event)
    )
    rejects(
      // 检查所选响应或事件的当前读取权限，要求以 native_identity_mismatch 拒绝。
      () =>
        f.adapter.checkResult(f.binding, {
          ...event,
          data: { ...event.data, terminal_id: '9'.repeat(32) }
        }),
      'native_identity_mismatch'
    )
    f.state.reader = 'other'
    rejects(
      /* 检查所选响应或事件的当前读取权限，要求以 forbidden 拒绝（当前读取未授权）。 */ () =>
        f.adapter.checkResult(f.binding, f.inputAck),
      'forbidden'
    )
    f.state.reader = 'synthetic'
    f.state.content = 'discarded'
    rejects(
      /* 检查所选响应或事件的当前读取权限，要求以 content_unavailable 拒绝（内容不可用）。 */ () =>
        f.adapter.checkResult(f.binding, f.inputAck),
      'content_unavailable'
    )
    f.state.content = 'available'
    f.policies.local.grants[0]!.actions = ['dispatch', 'stream_input']
    rejects(
      /* 检查所选响应或事件的当前读取权限，要求以 forbidden 拒绝（当前读取未授权）。 */ () =>
        f.adapter.checkResult(f.binding, f.inputAck),
      'forbidden'
    )
  }
)

test(
  '证据原文保留同时服从原 permit 和当前分类，当前 custody 与读取授权仍独立生效',
  /* 在原许可与当前分类之间切换保留策略，验证证据原文必须同时满足两者以及当前读取权限。 */ () => {
    for (const initialRetention of ['caller_policy', 'none'] as const) {
      const f = fixture()
      const row = f.state.classifications[0]!
      f.state.classifications = [{ ...row, result: { ...row.result, retention: initialRetention } }]
      f.decode(f.opening)
      const current = initialRetention === 'none' ? 'caller_policy' : 'none'
      f.state.classifications = [{ ...row, result: { ...row.result, retention: current } }]
      assert.equal(f.adapter.planEvidence(f.response).content.delivery, 'metadata_only')
    }
    const f = fixture()
    const row = f.state.classifications[0]!
    f.state.classifications = [
      {
        ...row,
        result: {
          ...row.result,
          boundary: 'protected_secret',
          sensitivity: 'credential',
          delivery: 'custody'
        }
      }
    ]
    f.state.channel = 'custody'
    f.state.custody = true
    f.decode(f.opening)
    assert.equal(f.adapter.planEvidence(f.response).content.delivery, 'payload')
    f.state.channel = 'ordinary'
    assert.equal(f.adapter.planEvidence(f.response).content.delivery, 'metadata_only')
    f.state.channel = 'custody'
    f.state.reader = 'other'
    assert.equal(f.adapter.planEvidence(f.response).content.delivery, 'metadata_only')
    f.state.reader = 'synthetic'
    f.state.trustedClassification = false
    assert.equal(f.adapter.planEvidence(f.response).content.delivery, 'metadata_only')
    f.state.trustedClassification = true
    f.state.classifications = []
    assert.equal(f.adapter.planEvidence(f.response).content.delivery, 'metadata_only')
  }
)

test(
  '真实 validator 接入 Wire：完整参数、独立 source 和原生 error.data 保真，结果读取另过当前门禁',
  /* 往返真实 Wire 请求与响应并保留原生 error.data，再逐项撤销当前读取权限验证结果门禁。 */ () => {
    const f = fixture()
    assert.deepEqual(f.decode(f.opening), f.opening)
    assert.deepEqual(
      f.adapter.decode(f.adapter.encode(f.opening, 'gateway_to_connector'), 'gateway_to_connector'),
      f.opening
    )
    assert.deepEqual(f.decode(f.response, 'connector_to_gateway'), f.response)
    assert.doesNotThrow(
      /* 在原调用者和双端读取权限有效时读取 RPC，作为随后撤权检查的对照。 */ () => f.adapter.checkResult(f.binding)
    )
    rejects(
      // 按当前消息方向执行完整解码校验，要求以 native_id_mismatch 拒绝。
      () =>
        f.decode(
          {
            ...f.response,
            payload: { ...f.response.payload, native_response: { id: 'other', result: {} } }
          },
          'connector_to_gateway'
        ),
      'native_id_mismatch'
    )
    f.state.reader = 'other'
    rejects(
      /* 检查所选响应或事件的当前读取权限，要求以 forbidden 拒绝（当前读取未授权）。 */ () =>
        f.adapter.checkResult(f.binding),
      'forbidden'
    )
    f.state.reader = 'synthetic'
    const classifications = f.state.classifications
    f.state.classifications = []
    rejects(
      /* 检查所选响应或事件的当前读取权限，要求以 classification_unavailable 拒绝（可信分类不可用）。 */ () =>
        f.adapter.checkResult(f.binding),
      'classification_unavailable'
    )
    f.state.classifications = classifications
    f.policies.local.grants[0]!.actions = ['dispatch']
    rejects(
      /* 检查所选响应或事件的当前读取权限，要求以 forbidden 拒绝（当前读取未授权）。 */ () =>
        f.adapter.checkResult(f.binding),
      'forbidden'
    )
  }
)

test(
  '真实 generic 只能标 incomplete；raw 仍要求精确 grant、完整分类与当前双方权限',
  /* 对通用参数 schema 分别测试 strict 和 raw，证明 raw 仍需精确 grant、完整分类及当前双端权限。 */ () => {
    const strict = fixture('ping')
    rejects(
      /* 按当前消息方向执行完整解码校验，要求以 parameter_schema_incomplete 拒绝。 */ () =>
        strict.decode(strict.opening),
      'parameter_schema_incomplete'
    )
    const raw = fixture('ping', true)
    assert.deepEqual(raw.decode(raw.opening), raw.opening)
    raw.state.grant = false
    rejects(
      /* 按当前消息方向执行完整解码校验，要求以 raw_contract_forbidden 拒绝。 */ () => raw.decode(raw.opening),
      'raw_contract_forbidden'
    )
    raw.state.grant = true
    raw.state.classifications = []
    rejects(
      /* 按当前消息方向执行完整解码校验，要求以 classification_unavailable 拒绝（可信分类不可用）。 */ () =>
        raw.decode(raw.opening),
      'classification_unavailable'
    )
    raw.state.classifications = clone(
      auth(request(view(), { id: 'id', method: 'ping', params: {} })).classifications
    ) as SafetyClassification[]
    raw.state.trustedClassification = false
    rejects(
      /* 按当前消息方向执行完整解码校验，要求以 classification_unavailable 拒绝（可信分类不可用）。 */ () =>
        raw.decode(raw.opening),
      'classification_unavailable'
    )
  }
)

test(
  '消息不能覆盖已登记参数、principal、权限、provider 或原生来源；双端配置必须完全一致',
  /* 逐项篡改登记参数、外壳权限、双端配置和独立来源，确认消息不能覆盖宿主事实且异常不泄漏私密文本。 */ () => {
    const f = fixture()
    const altered = clone(f.opening)
    altered.payload.native_request.params = { server_generation: G, terminal_id: T, pane_id: '4' }
    rejects(
      /* 按当前消息方向执行完整解码校验，要求以 attempt_request_mismatch 拒绝。 */ () => f.decode(altered),
      'attempt_request_mismatch'
    )
    rejects(
      /* 按当前消息方向执行完整解码校验，要求以 invalid_frame_fields 拒绝。 */ () =>
        f.decode({ ...f.opening, payload: { ...f.opening.payload, owner: true } }),
      'invalid_frame_fields'
    )
    rejects(
      // 按当前消息方向执行完整解码校验，要求以 reserved_request_field 拒绝。
      () =>
        f.decode({
          ...f.opening,
          payload: {
            ...f.opening.payload,
            native_request: { ...f.row.native_request, id: 'caller' }
          }
        }),
      'reserved_request_field'
    )
    f.state.sourceVerified = false
    rejects(
      /* 按当前消息方向执行完整解码校验，要求以 native_source_untrusted 拒绝。 */ () => f.decode(f.opening),
      'native_source_untrusted'
    )
    f.state.sourceVerified = true
    f.state.localConfig = 'other_root'
    rejects(
      /* 按当前消息方向执行完整解码校验，要求以 provider_binding_mismatch 拒绝。 */ () => f.decode(f.opening),
      'provider_binding_mismatch'
    )
    f.state.localConfig = 'config1'
    f.state.enabled = false
    rejects(
      /* 按当前消息方向执行完整解码校验，要求以 provider_disabled 拒绝。 */ () => f.decode(f.opening),
      'provider_disabled'
    )
    f.state.enabled = true
    f.state.revision = 2
    rejects(
      /* 按当前消息方向执行完整解码校验，要求以 provider_binding_mismatch 拒绝。 */ () => f.decode(f.opening),
      'provider_binding_mismatch'
    )
    f.state.revision = 1
    f.state.active = false
    rejects(
      /* 按当前消息方向执行完整解码校验，要求以 authentication_required 拒绝。 */ () => f.decode(f.opening),
      'authentication_required'
    )
    f.state.active = true
    f.backend.nativeSource = /* 注入含合成私密文本的来源异常，验证公开错误不会带出底层异常内容。 */ () => {
      throw Error('synthetic-private-payload')
    }
    assert.throws(
      // 触发宿主来源异常，确认解码只报告固定适配器错误且不泄露底层私密文本。
      () => f.decode(f.opening),
      // 核对公开错误仅含固定码，并确认底层合成私密文本没有泄露。
      (e: any) => e.code === 'native_adapter_unavailable' && !e.message.includes('synthetic-private-payload')
    )
  }
)

test(
  '同设备同名方法/native ID 的多个 provider 独立，错 endpoint 来源和 Herdr 冒充均拒绝',
  /* 在同设备构造多个同名方法及 ID 的 provider，分别验证跨 endpoint 来源及 Herdr 冒充均被拒绝。 */ () => {
    const f = fixture()
    f.decode(f.opening)
    const second = clone(f.row)
    second.binding = {
      ...second.binding,
      call_id: 'call2',
      target: { ...second.binding.target, provider_id: 'p2' }
    }
    f.rows.set('call2', second)
    for (const side of [f.policies.caller, f.policies.local]) {
      side.grants.push({ ...clone(side.grants[0]!), target: second.binding.target })
    }
    const request2 = {
      ...f.opening,
      payload: { ...f.opening.payload, attempt: f.attempt(second.binding) }
    }
    assert.deepEqual(f.decode(request2), request2)
    f.backend.nativeSource = /* 故意返回另一个 provider 的真实绑定，验证同名方法和 ID 不能掩盖来源错配。 */ () => ({
      authenticated: true,
      source_verified: true,
      binding: f.nativeBinding(second)
    })
    rejects(
      /* 按当前消息方向执行完整解码校验，要求以 native_identity_mismatch 拒绝。 */ () =>
        f.decode(f.response, 'connector_to_gateway'),
      'native_identity_mismatch'
    )
    const herdr = clone(f.row)
    herdr.binding = {
      ...herdr.binding,
      call_id: 'call3',
      provider_kind: 'herdr',
      target: { ...herdr.binding.target, provider_id: 'p3' }
    }
    f.rows.set('call3', herdr)
    f.backend.provider = /* 把网关 provider 冒报为 Herdr，验证 Luvus 适配器拒绝跨 provider 种类复用。 */ (target) => ({
      machine_id: 'm1',
      provider_id: target.provider_id,
      kind: 'herdr',
      binding_revision: 1,
      config_ref: 'config1',
      enabled: true
    })
    f.backend.localProvider = f.backend.provider
    rejects(
      // 按当前消息方向执行完整解码校验，要求以 contract_binding_mismatch 拒绝。
      () =>
        f.decode({
          ...f.opening,
          payload: { ...f.opening.payload, attempt: f.attempt(herdr.binding) }
        }),
      'contract_binding_mismatch'
    )
  }
)

test(
  '同一 permit 的原生流 ack 才能开流，逐输入重新分类/授权，控制 ack 绑定输入 ID',
  /* 从真实控制流 acknowledgement 建流后逐输入重新分类授权，再验证输入响应必须绑定原控制 ID。 */ () => {
    const f = fixture('terminal.backend.control', false, true)
    const ack = {
      id: 'native_1',
      result: {
        type: 'terminal_backend_stream',
        mode: 'control',
        server_generation: G,
        terminal_id: T,
        pane_id: '3',
        sequence: 0,
        content_revision: 0,
        ansi: false,
        capture_mode: 'visible',
        lines: 1,
        frame_bytes: 65536,
        queue_capacity: 2,
        loss_behavior: 'resync_required_then_close'
      }
    }
    // 把原生响应或事件包装为绑定当前控制流的 stream_data 消息。
    const data = (frame: Record<string, unknown>) =>
      f.frame('stream_data', {
        attempt: f.attempt(f.binding),
        stream_id: 'stream1',
        feature: 'terminal_control',
        sequence: 0,
        frame
      })
    rejects(
      /* 按当前消息方向执行完整解码校验，要求以 dispatch_permit_unavailable 拒绝（真实派发许可缺失）。 */ () =>
        f.decode(data(ack), 'connector_to_gateway'),
      'dispatch_permit_unavailable'
    )
    f.decode(f.opening)
    f.decode(f.opening)
    assert.deepEqual(f.decode(data(ack), 'connector_to_gateway'), data(ack))
    const event = {
      event: 'terminal.frame',
      sequence: 0,
      data: {
        server_generation: G,
        terminal_id: T,
        pane_id: '3',
        content_revision: 0,
        mode: 'visible',
        ansi: false,
        text: 'synthetic',
        lines: 1,
        bytes: 9,
        truncated: false
      }
    }
    assert.deepEqual(f.decode(data(event), 'connector_to_gateway'), data(event))
    rejects(
      // 按当前消息方向执行完整解码校验，要求以 native_identity_mismatch 拒绝。
      () => f.decode(data({ ...event, data: { ...event.data, terminal_id: '9'.repeat(32) } }), 'connector_to_gateway'),
      'native_identity_mismatch'
    )
    const input = f.frame('stream_input', {
      attempt: f.attempt(f.binding),
      stream_id: 'stream1',
      feature: 'terminal_control',
      sequence: 0,
      frame: { id: 'input1', action: 'type_literal', params: { text: 'synthetic' } }
    })
    rejects(
      /* 按当前消息方向执行完整解码校验，要求以 safety_classification_missing 拒绝。 */ () => f.decode(input),
      'safety_classification_missing'
    )
    const row = { ...clone(f.state.classifications[0]!), action: 'type_literal' }
    f.state.classifications.push(row)
    assert.deepEqual(f.decode(input), input)
    assert.equal(f.adapter.advanceStream(f.opening, 'gateway_to_connector').state, 'opening')
    assert.equal(f.adapter.advanceStream(data(ack), 'connector_to_gateway').state, 'open')
    assert.equal(f.adapter.observeMessage(input, 'gateway_to_connector'), 'new')
    assert.equal(f.adapter.observeMessage(input, 'gateway_to_connector'), 'duplicate')
    assert.equal(f.adapter.advanceStream(input, 'gateway_to_connector').next_input_sequence, 1)
    rejects(
      /* 推进指定输入或输出的流生命周期，要求以 stream_sequence_mismatch 拒绝。 */ () =>
        f.adapter.advanceStream(input, 'gateway_to_connector'),
      'stream_sequence_mismatch'
    )
    const inputAck = {
      id: 'input1',
      result: { type: 'terminal_backend_action', state: 'succeeded', dispatch: 'queued' }
    }
    assert.deepEqual(f.decode(data(inputAck), 'connector_to_gateway'), data(inputAck))
    rejects(
      /* 按当前消息方向执行完整解码校验，要求以 control_ack_unbound 拒绝（控制响应没有对应许可）。 */ () =>
        f.decode(data({ ...inputAck, id: 'unknown' }), 'connector_to_gateway'),
      'control_ack_unbound'
    )
    rejects(
      /* 按当前消息方向执行完整解码校验，要求以 stream_binding_mismatch 拒绝。 */ () =>
        f.decode({ ...input, payload: { ...input.payload, stream_id: 'other' } }),
      'stream_binding_mismatch'
    )
    f.policies.local.grants[0]!.actions = ['dispatch', 'read']
    rejects(
      /* 按当前消息方向执行完整解码校验，要求以 provider_scope_forbidden 拒绝。 */ () => f.decode(input),
      'provider_scope_forbidden'
    )
    f.policies.local.grants[0]!.actions.push('stream_input')
    f.decode(
      f.frame('stream_close', {
        attempt: f.attempt(f.binding),
        stream_id: 'stream1',
        reason: 'normal'
      })
    )
    rejects(/* 按当前消息方向执行完整解码校验，要求以 stream_closed 拒绝。 */ () => f.decode(input), 'stream_closed')
  }
)

test(
  '结果内容过期/discard 仅补最小可靠证据；原锚点不变、不派发、不续期限',
  /* 固定原响应锚点后切换过期和 discard，确认只生成最小可靠证据且不能恢复读取或改写期限。 */ () => {
    const f = fixture()
    f.decode(f.opening)
    const original = clone(f.backend.responseAnchor!(f.binding))
    const available = f.adapter.planEvidence(f.response)
    assert.equal(available.content.delivery, 'payload')
    assert.equal(available.dispatch, false)
    for (const status of ['expired', 'discarded', 'unavailable'] as const) {
      f.state.content = status
      rejects(
        /* 检查所选响应或事件的当前读取权限，要求以 content_unavailable 拒绝（内容不可用）。 */ () =>
          f.adapter.checkResult(f.binding),
        'content_unavailable'
      )
      const plan = f.adapter.planEvidence(f.response)
      assert.equal(plan.content.delivery, 'metadata_only')
      assert.equal(plan.content.native_response, undefined)
      assert.equal(plan.content.expires_at, original!.content_expires_at)
      assert.equal(plan.dispatch, false)
    }
    f.adapter.release(f.binding)
    rejects(
      /* 检查所选响应或事件的当前读取权限，要求以 dispatch_permit_unavailable 拒绝（真实派发许可缺失）。 */ () =>
        f.adapter.checkResult(f.binding),
      'dispatch_permit_unavailable'
    )
    rejects(
      /* 按当前消息方向执行完整解码校验，要求以 dispatch_permit_unavailable 拒绝（真实派发许可缺失）。 */ () =>
        f.decode(f.response, 'connector_to_gateway'),
      'dispatch_permit_unavailable'
    )
  }
)

test(
  '迟到证据先执行完整原生较低帧预算，过期内容也不能绕过边界',
  /* 降低原生响应帧预算后提交迟到证据，证明内容已过期也必须先通过完整原生字节边界检查。 */ () => {
    const f = fixture()
    const registry = f.backend.contract(f.binding.contract_ref)!
    const caps = registry.capabilities as ReturnType<typeof json>
    caps.result.limits.frame_bytes = Buffer.byteLength(JSON.stringify(f.response.payload.native_response))
    f.decode(f.opening)
    const anchor = clone(f.backend.responseAnchor!(f.binding))
    for (const status of ['available', 'expired', 'discarded', 'unavailable'] as const) {
      f.state.content = status
      rejects(
        /* 为该响应生成持久化证据计划，要求以 native_response_invalid 拒绝。 */ () =>
          f.adapter.planEvidence(f.response),
        'native_response_invalid'
      )
    }
    f.state.content = 'available'
    assert.deepEqual(f.backend.responseAnchor!(f.binding), anchor)
    rejects(
      /* 检查所选响应或事件的当前读取权限，要求以 content_unavailable 拒绝（内容不可用）。 */ () =>
        f.adapter.checkResult(f.binding),
      'content_unavailable'
    )
  }
)

test(
  '分片重组真实响应仍经过原生许可/完整 schema，传输限额及私有句柄不暴露',
  /* 将真实响应分片并重组，验证完整 schema、派发许可及传输限额依旧生效且私有句柄不能上网。 */ () => {
    const f = fixture()
    f.decode(f.opening)
    const raw = Buffer.from(boundedJson(f.response))
    const chunk = f.frame('object_chunk', {
      object_id: 'object1',
      kind: 'envelope',
      total_bytes: raw.length,
      sha256: hash(raw),
      chunk_count: 1,
      index: 0,
      data: raw.toString('base64')
    })
    assert.deepEqual(f.adapter.acceptChunk(JSON.stringify(chunk), 'connector_to_gateway'), {
      kind: 'envelope',
      envelope: f.response
    })
    rejects(
      /* 按当前消息方向执行完整解码校验，要求以 frame_limit 拒绝。 */ () =>
        f.adapter.decode('x'.repeat(LIMITS.frame_bytes + 1), 'connector_to_gateway'),
      'frame_limit'
    )
    assert.equal('context' in f.adapter, false)
    assert.equal('validators' in f.adapter, false)
    rejects(
      // 按当前消息方向执行完整解码校验，要求以 invalid_frame_fields 拒绝。
      () => f.decode({ ...f.response, payload: { ...f.response.payload, native_handle: {} } }, 'connector_to_gateway'),
      'invalid_frame_fields'
    )
  }
)

test(
  'Wire 外壳使用原生有界 JSON parser：重复键/精度损失在解码前拒绝',
  /* 在原始 Wire JSON 中注入重复键及不安全整数，确认有界 parser 在后续校验前拒绝精度或覆盖歧义。 */ () => {
    const f = fixture()
    const raw = JSON.stringify(f.opening).replace('"message_id":"msg1"', '"message_id":"old","message_id":"msg1"')
    rejects(
      /* 按当前消息方向执行完整解码校验，要求以 duplicate_json_key 拒绝（原始 JSON 存在重复键）。 */ () =>
        f.adapter.decode(raw, 'gateway_to_connector'),
      'duplicate_json_key'
    )
    const heartbeat = f.frame('heartbeat', { sequence: 0 })
    rejects(
      // 按当前消息方向执行完整解码校验，要求以 invalid_integer 拒绝。
      () =>
        f.adapter.decode(
          JSON.stringify(heartbeat).replace('"sequence":0', '"sequence":9007199254740993'),
          'gateway_to_connector'
        ),
      'invalid_integer'
    )
  }
)

test(
  '原生流打开失败保留完整错误并维持未就绪，不制造成功流',
  /* 提交原生开流错误后保留完整错误响应，确认流尚未就绪并拒绝后续控制输入。 */ () => {
    const f = fixture('terminal.backend.control', false, true)
    f.decode(f.opening)
    const error = f.frame('stream_data', {
      attempt: f.attempt(f.binding),
      stream_id: 'stream1',
      feature: 'terminal_control',
      sequence: 0,
      frame: {
        id: 'native_1',
        error: {
          code: 'control_conflict',
          message: 'synthetic conflict',
          metadata: { retained: true }
        }
      }
    })
    assert.deepEqual(f.decode(error, 'connector_to_gateway'), error)
    rejects(
      // 按当前消息方向执行完整解码校验，要求以 stream_not_ready 拒绝。
      () =>
        f.decode(
          f.frame('stream_input', {
            attempt: f.attempt(f.binding),
            stream_id: 'stream1',
            feature: 'terminal_control',
            sequence: 0,
            frame: { id: 'input', action: 'type_literal', params: { text: 'synthetic' } }
          })
        ),
      'stream_not_ready'
    )
  }
)

test(
  '私有 attempt/快照预算满额拒绝，显式释放后不继承旧 permit',
  /* 分别耗尽快照与 attempt 配额，显式释放后确认容量返还且旧调用不能继承已释放许可。 */ () => {
    const f = fixture()
    const tiny = createLuvusWireAdapter(f.backend, {
      attempts: 1,
      control_ids: 1,
      snapshot_bytes: 1
    })
    rejects(
      /* 按当前消息方向执行完整解码校验，要求以 adapter_limit 拒绝（保留上下文超出预算）。 */ () =>
        tiny.decode(JSON.stringify(f.opening), 'gateway_to_connector'),
      'adapter_limit'
    )
    const limited = createLuvusWireAdapter(f.backend, { attempts: 1, control_ids: 1 })
    limited.decode(JSON.stringify(f.opening), 'gateway_to_connector')
    const second = clone(f.row)
    second.binding.call_id = 'call2'
    f.rows.set('call2', second)
    const next = {
      ...f.opening,
      payload: { ...f.opening.payload, attempt: f.attempt(second.binding) }
    }
    rejects(
      /* 按当前消息方向执行完整解码校验，要求以 adapter_limit 拒绝（保留上下文超出预算）。 */ () =>
        limited.decode(JSON.stringify(next), 'gateway_to_connector'),
      'adapter_limit'
    )
    limited.release(f.binding)
    assert.deepEqual(limited.decode(JSON.stringify(next), 'gateway_to_connector'), next)
    rejects(
      /* 检查所选响应或事件的当前读取权限，要求以 dispatch_permit_unavailable 拒绝（真实派发许可缺失）。 */ () =>
        limited.checkResult(f.binding),
      'dispatch_permit_unavailable'
    )
  }
)
