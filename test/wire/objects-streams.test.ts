// 验证对象分片重组的资源边界，以及原生流关联、序号和逐输入授权。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ObjectAssembler,
  fragmentObject,
  LIMITS,
  encodeWireFrame,
  decodeWireFrame,
  boundedJson,
  advanceStream,
  hash
} from '../../src/wire/index.js'
import {
  bundle,
  transcript,
  request,
  response,
  frame,
  attempt,
  binding,
  context,
  rejects,
  withoutId
} from './helpers.js'

test(
  '真实 P0 bundle 跨多个分片重组，bundle 限额独立于 message 与普通对象',
  /* 验证真实 P0 bundle 跨多个分片重组，bundle 限额独立于 message 与普通对象。 */ () => {
    const ctx = context('connector_to_gateway')
    const chunks = fragmentObject(bundle, 'schema_bundle', 'schema_1', ctx)
    assert(chunks.length >= 2)
    const assembler = new ObjectAssembler()
    assert.equal(assembler.push(chunks[0]!, ctx, 100), undefined)
    assert.equal(assembler.push(chunks[0]!, ctx, 101), undefined)
    let result: ReturnType<ObjectAssembler['push']>
    for (const chunk of chunks.slice(1)) {
      result = assembler.push(chunk, ctx, 102)
    }
    assert.deepEqual(result!, { kind: 'schema_bundle', bundle })
    assert.equal(assembler.activeTransfers, 0)
    assert.equal(assembler.bufferedBytes, 0)
    rejects(
      /* 提交该用例输入，确认对象已完成或超时并留下墓碑时被拒绝。 */ () => assembler.push(chunks[0]!, ctx, 103),
      'object_closed'
    )
    const bad = structuredClone(chunks[0]!)
    delete (bad.payload as any).sha256
    rejects(
      /* 提交该用例输入，确认消息字段缺失或包含额外字段时被拒绝。 */ () => decodeWireFrame(JSON.stringify(bad), ctx),
      'invalid_frame_fields'
    )
    rejects(
      /* 提交该用例输入，确认消息传输方向错误时被拒绝。 */ () =>
        fragmentObject(bundle, 'schema_bundle', 'wrong_direction', context()),
      'wrong_direction'
    )
    rejects(
      /* 提交该用例输入，确认JSON 超过当前序列化字节上限时被拒绝。 */ () =>
        fragmentObject({ data: 'x'.repeat(LIMITS.schema_bundle_bytes) }, 'schema_bundle', 'too_big', ctx),
      'json_size_limit'
    )
  }
)

test(
  '超过 frame 限额的完整 response 走有界对象，重组后再次执行原生/schema/身份门禁',
  /* 验证超过 frame 限额的完整 response 走有界对象，重组后再次执行原生/schema/身份门禁。 */ () => {
    const ctx = context('connector_to_gateway')
    const big = {
      ...response,
      payload: {
        ...response.payload,
        native_response: {
          id: attempt.native_request_id,
          result: { synthetic: 'x'.repeat(LIMITS.frame_bytes) }
        }
      }
    }
    rejects(
      /* 提交该用例输入，确认JSON 超过当前序列化字节上限时被拒绝。 */ () => encodeWireFrame(big, ctx),
      'json_size_limit'
    )
    const chunks = fragmentObject(big, 'envelope', 'large_1', ctx)
    const assembler = new ObjectAssembler()
    let result: ReturnType<ObjectAssembler['push']>
    for (const chunk of chunks) {
      result = assembler.push(chunk, ctx, 1)
    }
    assert.deepEqual(result!, { kind: 'envelope', envelope: big })
    const oversized = {
      ...big,
      payload: {
        ...big.payload,
        native_response: {
          id: attempt.native_request_id,
          result: { data: 'x'.repeat(LIMITS.object_bytes) }
        }
      }
    }
    rejects(
      /* 提交该用例输入，确认JSON 超过当前序列化字节上限时被拒绝。 */ () =>
        fragmentObject(oversized, 'envelope', 'too_big', ctx),
      'json_size_limit'
    )
    const invalid = {
      ...response,
      payload: {
        ...response.payload,
        native_response: { id: attempt.native_request_id, extra: true, result: {} }
      }
    }
    // 即便直接构造正确 checksum 的分片，重组后的原生根字段也不能绕过校验。
    const raw = boundedJson(invalid)
    const handcrafted = frame('object_chunk', {
      object_id: 'invalid_1',
      kind: 'envelope',
      total_bytes: Buffer.byteLength(raw),
      sha256: hash(raw),
      chunk_count: 1,
      index: 0,
      data: Buffer.from(raw).toString('base64')
    })
    rejects(
      /* 提交该用例输入，确认原生响应未通过校验时被拒绝。 */ () => new ObjectAssembler().push(handcrafted, ctx, 0),
      'native_response_invalid'
    )
  }
)

test(
  '分片拒绝错序、冲突、checksum、超时、错误关联与容量洪泛',
  /* 验证分片拒绝错序、冲突、checksum、超时、错误关联与容量洪泛。 */ () => {
    const ctx = context('connector_to_gateway')
    const chunks = fragmentObject(bundle, 'schema_bundle', 'schema_1', ctx)
    const assembler = new ObjectAssembler()
    rejects(
      /* 提交该用例输入，确认分片未按连续索引到达时被拒绝。 */ () => assembler.push(chunks[1]!, ctx, 0),
      'chunk_out_of_order'
    )
    assembler.push(chunks[0]!, ctx, 0)
    const changed = structuredClone(chunks[0]!)
    changed.payload.data = Buffer.alloc(LIMITS.chunk_bytes, 120).toString('base64')
    rejects(
      /* 提交该用例输入，确认重复分片的实际字节冲突时被拒绝。 */ () => assembler.push(changed, ctx, 1),
      'chunk_conflict'
    )
    assert.equal(assembler.bufferedBytes, 0)
    const altered = new ObjectAssembler()
    altered.push(chunks[0]!, ctx, 0)
    rejects(
      /* 提交该用例输入，确认同一对象的分片描述符冲突时被拒绝。 */ () =>
        altered.push({ ...chunks[1]!, payload: { ...chunks[1]!.payload, sha256: 'b'.repeat(64) } }, ctx, 1),
      'object_conflict'
    )
    const checksum = fragmentObject(bundle, 'schema_bundle', 'checksum_1', ctx).map(
      /* 篡改每片的声明摘要，构造分片一致但最终校验失败的传输。 */ (c) => ({
        ...c,
        payload: { ...c.payload, sha256: 'b'.repeat(64) }
      })
    )
    const check = new ObjectAssembler()
    for (const c of checksum.slice(0, -1)) {
      check.push(c, ctx, 0)
    }
    rejects(
      /* 提交该用例输入，确认重组对象摘要与声明值不一致时被拒绝。 */ () => check.push(checksum.at(-1)!, ctx, 0),
      'object_checksum'
    )
    const timeout = new ObjectAssembler()
    timeout.push(chunks[0]!, ctx, 100)
    timeout.push(chunks[0]!, ctx, 100 + LIMITS.transfer_timeout_ms - 1)
    rejects(
      /* 提交该用例输入，确认对象已完成或超时并留下墓碑时被拒绝。 */ () =>
        timeout.push(chunks[1]!, ctx, 100 + LIMITS.transfer_timeout_ms),
      'object_closed'
    )
    assert.equal(timeout.bufferedBytes, 0)
    rejects(
      /* 提交该用例输入，确认消息与当前连接身份不匹配时被拒绝。 */ () =>
        new ObjectAssembler().push({ ...chunks[0]!, connection_epoch: 'old' }, ctx, 0),
      'connection_binding_mismatch'
    )
    rejects(
      /* 提交该用例输入，确认分片数据不是规范 base64 或长度非法时被拒绝。 */ () =>
        encodeWireFrame({ ...chunks[0]!, payload: { ...chunks[0]!.payload, data: 'not-base64' } }, ctx),
      'invalid_chunk'
    )
    rejects(
      /* 提交该用例输入，确认对象总长或分片数量不符合协议约束时被拒绝。 */ () =>
        encodeWireFrame({ ...chunks[0]!, payload: { ...chunks[0]!.payload, chunk_count: 999 } }, ctx),
      'object_limit'
    )
    const capacity = new ObjectAssembler()
    for (let i = 0; i < LIMITS.transfers; i++) {
      capacity.push(fragmentObject(bundle, 'schema_bundle', `capacity_${i}`, ctx)[0]!, ctx, 0)
    }
    rejects(
      /* 提交该用例输入，确认活动传输或预约字节容量已满时被拒绝。 */ () =>
        capacity.push(fragmentObject(bundle, 'schema_bundle', 'capacity_full', ctx)[0]!, ctx, 0),
      'object_capacity'
    )
    assert.equal(capacity.activeTransfers, LIMITS.transfers)
    const byteCapacity = new ObjectAssembler()
    const big = { data: 'x'.repeat(11 * LIMITS.frame_bytes) }
    byteCapacity.push(fragmentObject(big, 'schema_bundle', 'large_schema_1', ctx)[0]!, ctx, 0)
    rejects(
      /* 提交该用例输入，确认活动传输或预约字节容量已满时被拒绝。 */ () =>
        byteCapacity.push(fragmentObject(big, 'schema_bundle', 'large_schema_2', ctx)[0]!, ctx, 0),
      'object_capacity'
    )
    assert.doesNotThrow(
      /* 验证达到标识长度上限的对象仍能分片。 */ () => fragmentObject(response, 'envelope', 'a'.repeat(128), ctx)
    )
  }
)

const received = transcript
  .filter(/* 筛选采集记录中的已接收原生帧。 */ (r) => r.kind === 'receive')
  .map(/* 解析采集记录中的原生 JSON 帧正文。 */ (r) => JSON.parse(r.wire))
const terminalEvent = received.find(/* 定位真实终端帧事件用于流输出测试。 */ (r) => r.event === 'terminal.frame')!
const terminalInput = JSON.parse(
  transcript.find(
    /* 定位真实提交文本的控制输入用于流输入测试。 */ (r) =>
      r.kind === 'send' && JSON.parse(r.wire).action === 'submit_text'
  )!.wire
)
const terminalRequest = JSON.parse(
  transcript.find(
    /* 定位终端控制通道的开流请求。 */ (r) =>
      r.kind === 'send' && r.channel === 'terminal-control' && JSON.parse(r.wire).method
  )!.wire
)
const streamAttempt = { ...attempt, native_request_id: terminalRequest.id }
// 构造绑定真实终端控制调用及流标识的认证上下文。
function streamContext(direction: 'gateway_to_connector' | 'connector_to_gateway' = 'gateway_to_connector') {
  return context(
    direction,
    undefined,
    { ...binding, ...streamAttempt },
    terminalRequest.method,
    'stream',
    'terminal_control'
  )
}
test(
  'stream open/data/input/close 正向使用原生 P0 终端帧，外层序号与关闭边界清晰',
  /* 验证stream open/data/input/close 正向使用原生 P0 终端帧，外层序号与关闭边界清晰。 */ () => {
    const open = frame('stream_open', {
      ...request.payload,
      attempt: streamAttempt,
      native_request: withoutId(terminalRequest),
      stream_id: 'stream_1',
      feature: 'terminal_control'
    })
    const data = frame('stream_data', {
      attempt: streamAttempt,
      stream_id: 'stream_1',
      feature: 'terminal_control',
      sequence: 0,
      frame: terminalEvent
    })
    const input = frame('stream_input', {
      attempt: streamAttempt,
      stream_id: 'stream_1',
      feature: 'terminal_control',
      sequence: 0,
      frame: terminalInput
    })
    const close = frame('stream_close', {
      attempt: streamAttempt,
      stream_id: 'stream_1',
      reason: 'normal'
    })
    let state = advanceStream(undefined, open, streamContext())
    assert.equal(state.state, 'opening')
    rejects(
      /* 提交该用例输入，确认原生流尚未完成开流确认时被拒绝。 */ () => advanceStream(state, input, streamContext()),
      'stream_not_ready'
    )
    state = advanceStream(state, data, streamContext('connector_to_gateway'))
    state = advanceStream(state, input, streamContext())
    assert.equal(state.next_data_sequence, 1)
    assert.equal(state.next_input_sequence, 1)
    rejects(
      /* 提交该用例输入，确认流帧外层序号不连续时被拒绝。 */ () =>
        advanceStream(state, data, streamContext('connector_to_gateway')),
      'stream_sequence_mismatch'
    )
    state = advanceStream(state, close, streamContext())
    assert.equal(state.state, 'closed')
    rejects(
      /* 提交该用例输入，确认帧不适用于当前流状态时被拒绝。 */ () => advanceStream(state, input, streamContext()),
      'invalid_stream_transition'
    )
    // close 只是释放流的外层意图，不生成关闭 pane 的原生调用。
    assert.equal('native_request' in close.payload, false)
    for (const [f, ctx] of [
      [open, streamContext()],
      [data, streamContext('connector_to_gateway')],
      [input, streamContext()],
      [close, streamContext()]
    ] as const) {
      assert.deepEqual(decodeWireFrame(encodeWireFrame(f, ctx), ctx), f)
      const bad = structuredClone(f) as any
      delete bad.payload.stream_id
      rejects(
        /* 提交该用例输入，确认消息字段缺失或包含额外字段时被拒绝。 */ () => decodeWireFrame(JSON.stringify(bad), ctx),
        'invalid_frame_fields'
      )
      if (f.type !== 'stream_close') {
        rejects(
          /* 提交该用例输入，确认消息传输方向错误时被拒绝。 */ () =>
            encodeWireFrame(
              f,
              context(ctx.direction === 'gateway_to_connector' ? 'connector_to_gateway' : 'gateway_to_connector')
            ),
          'wrong_direction'
        )
      }
    }
    const checked = streamContext()
    const savedGate = checked.validators!.luvus!.requestGate
    checked.validators!.luvus!.requestGate = /* 断言原生门禁收到正确流特性和方法，再调用原门禁。 */ (r, c) => {
      assert.equal(c.transport, 'stream')
      assert.equal(c.feature, 'terminal_control')
      assert.equal(c.method, terminalRequest.method)
      return savedGate(r, c)
    }
    encodeWireFrame(open, checked)
  }
)

test(
  '未知能力/原生流帧、只读流输入、缺 validator 与流关联错配均拒绝',
  /* 验证未知能力/原生流帧、只读流输入、缺 validator 与流关联错配均拒绝。 */ () => {
    const data = frame('stream_data', {
      attempt: streamAttempt,
      stream_id: 'stream_1',
      feature: 'terminal_control',
      sequence: 0,
      frame: terminalEvent
    })
    rejects(
      /* 提交该用例输入，确认字段使用未知枚举值时被拒绝。 */ () =>
        encodeWireFrame(
          { ...data, payload: { ...data.payload, feature: 'future' as any } },
          streamContext('connector_to_gateway')
        ),
      'invalid_enum'
    )
    const noFeature = streamContext('connector_to_gateway')
    noFeature.connection.negotiated.capabilities = ['rpc']
    rejects(
      /* 提交该用例输入，确认使用尚未协商的能力时被拒绝。 */ () => encodeWireFrame(data, noFeature),
      'unsupported_capability'
    )
    rejects(
      /* 提交该用例输入，确认原生流帧未通过 schema 校验时被拒绝。 */ () =>
        encodeWireFrame(
          { ...data, payload: { ...data.payload, frame: { event: 'future', data: {} } } },
          streamContext('connector_to_gateway')
        ),
      'native_stream_frame_invalid'
    )
    const readOnlyInput = frame('stream_input', {
      attempt,
      stream_id: 'stream_1',
      feature: 'events',
      sequence: 0,
      frame: terminalInput
    })
    rejects(
      /* 提交该用例输入，确认只读流不能接收控制输入时被拒绝。 */ () => encodeWireFrame(readOnlyInput, context()),
      'unsupported_stream_input'
    )
    const noStreamValidator = streamContext('connector_to_gateway')
    delete noStreamValidator.validators!.luvus!.validateStreamFrame
    rejects(
      /* 提交该用例输入，确认缺少原生流帧校验器时被拒绝。 */ () => encodeWireFrame(data, noStreamValidator),
      'stream_validator_unavailable'
    )
    const open = frame('stream_open', {
      ...request.payload,
      attempt: streamAttempt,
      native_request: withoutId(terminalRequest),
      stream_id: 'stream_1',
      feature: 'terminal_control'
    })
    const state = advanceStream(undefined, open, streamContext())
    rejects(
      /* 提交该用例输入，确认流标识与调用绑定不一致时被拒绝。 */ () =>
        advanceStream(
          state,
          { ...data, payload: { ...data.payload, stream_id: 'other' } },
          streamContext('connector_to_gateway')
        ),
      'stream_binding_mismatch'
    )
    rejects(
      /* 提交该用例输入，确认首帧未建立外层流时被拒绝。 */ () =>
        advanceStream(undefined, data, streamContext('connector_to_gateway')),
      'stream_not_open'
    )
    const input = frame('stream_input', {
      attempt: streamAttempt,
      stream_id: 'stream_1',
      feature: 'terminal_control',
      sequence: 0,
      frame: { id: 'input_1', action: 'not_a_native_action', params: {} }
    })
    rejects(
      /* 提交该用例输入，确认原生流帧未通过 schema 校验时被拒绝。 */ () => encodeWireFrame(input, streamContext()),
      'native_stream_frame_invalid'
    )
    rejects(
      /* 提交该用例输入，确认调用登记的传输或特性与帧不一致时被拒绝。 */ () =>
        encodeWireFrame(
          { ...data, payload: { ...data.payload, feature: 'events' } },
          streamContext('connector_to_gateway')
        ),
      'attempt_transport_mismatch'
    )
    const validInput = { ...input, payload: { ...input.payload, frame: terminalInput } }
    const perFrame = streamContext()
    let controls = 0
    let gates = 0
    const actions: unknown[] = []
    const validator = perFrame.validators!.luvus!
    const control = validator.validateStreamFrame!
    validator.validateStreamFrame = /* 累计原生输入校验次数，并继续执行原有帧检查。 */ (r, c) => {
      controls++
      control(r, c)
    }
    validator.checkDispatch = /* 累计逐输入授权次数并记录动作，同时核对关联方法。 */ (r, c) => {
      gates++
      actions.push(r.action)
      assert.equal(c.method, terminalRequest.method)
    }
    encodeWireFrame(validInput, perFrame)
    encodeWireFrame(
      {
        ...validInput,
        message_id: 'input_2',
        payload: {
          ...validInput.payload,
          sequence: 1,
          frame: { id: 'input_2', action: 'type_literal', params: { text: 'synthetic' } }
        }
      },
      perFrame
    )
    assert.equal(controls, 2)
    assert.equal(gates, 2)
    assert.deepEqual(actions, ['submit_text', 'type_literal'])
    validator.checkDispatch = /* 模拟原生派发策略抛出内部异常，验证边界只公开固定错误码。 */ () => {
      throw new Error('synthetic-private-policy')
    }
    rejects(
      /* 提交该用例输入，确认当前原生输入派发门禁拒绝时被拒绝。 */ () => encodeWireFrame(validInput, perFrame),
      'native_dispatch_forbidden'
    )
    delete validator.checkDispatch
    rejects(
      /* 提交该用例输入，确认缺少逐输入派发校验器时被拒绝。 */ () => encodeWireFrame(validInput, perFrame),
      'dispatch_validator_unavailable'
    )
    const disabled = streamContext()
    disabled.resolveProvider = /* 返回被禁用的 provider 绑定，模拟当前撤销状态。 */ () => ({
      machine_id: binding.machine_id,
      provider_id: binding.target.provider_id,
      kind: 'luvus',
      config_ref: 'config_1',
      binding_revision: 2,
      enabled: false
    })
    rejects(
      /* 提交该用例输入，确认当前 provider 已被禁用时被拒绝。 */ () => encodeWireFrame(validInput, disabled),
      'provider_disabled'
    )
    const noScope = streamContext()
    noScope.policies!.local.grants[0]!.actions = ['dispatch', 'read']
    rejects(
      /* 提交该用例输入，确认双端策略未共同允许完整目标操作时被拒绝。 */ () => encodeWireFrame(validInput, noScope),
      'provider_scope_forbidden'
    )
  }
)
