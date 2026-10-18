import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ObjectAssembler,
  fragmentObject,
  LIMITS,
  encodeWireFrame,
  decodeWireFrame,
  boundedJson,
  advanceStream,
  hash,
} from '../../src/wire/index.js';
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
  withoutId,
} from './helpers.js';

test('真实 P0 bundle 跨多个分片重组，bundle 限额独立于 message 与普通对象', () => {
  const ctx = context('connector_to_gateway'),
    chunks = fragmentObject(bundle, 'schema_bundle', 'schema_1', ctx);
  assert(chunks.length >= 2);
  const assembler = new ObjectAssembler();
  assert.equal(assembler.push(chunks[0]!, ctx, 100), undefined);
  assert.equal(assembler.push(chunks[0]!, ctx, 101), undefined);
  let result: ReturnType<ObjectAssembler['push']>;
  for (const chunk of chunks.slice(1)) result = assembler.push(chunk, ctx, 102);
  assert.deepEqual(result!, { kind: 'schema_bundle', bundle });
  assert.equal(assembler.activeTransfers, 0);
  assert.equal(assembler.bufferedBytes, 0);
  rejects(() => assembler.push(chunks[0]!, ctx, 103), 'object_closed');
  const bad = structuredClone(chunks[0]!);
  delete (bad.payload as any).sha256;
  rejects(() => decodeWireFrame(JSON.stringify(bad), ctx), 'invalid_frame_fields');
  rejects(
    () => fragmentObject(bundle, 'schema_bundle', 'wrong_direction', context()),
    'wrong_direction',
  );
  rejects(
    () =>
      fragmentObject(
        { data: 'x'.repeat(LIMITS.schema_bundle_bytes) },
        'schema_bundle',
        'too_big',
        ctx,
      ),
    'json_size_limit',
  );
});

test('超过 frame 限额的完整 response 走有界对象，重组后再次执行原生/schema/身份门禁', () => {
  const ctx = context('connector_to_gateway');
  const big = {
    ...response,
    payload: {
      ...response.payload,
      native_response: {
        id: attempt.native_request_id,
        result: { synthetic: 'x'.repeat(LIMITS.frame_bytes) },
      },
    },
  };
  rejects(() => encodeWireFrame(big, ctx), 'json_size_limit');
  const chunks = fragmentObject(big, 'envelope', 'large_1', ctx),
    assembler = new ObjectAssembler();
  let result: ReturnType<ObjectAssembler['push']>;
  for (const chunk of chunks) result = assembler.push(chunk, ctx, 1);
  assert.deepEqual(result!, { kind: 'envelope', envelope: big });
  const oversized = {
    ...big,
    payload: {
      ...big.payload,
      native_response: {
        id: attempt.native_request_id,
        result: { data: 'x'.repeat(LIMITS.object_bytes) },
      },
    },
  };
  rejects(() => fragmentObject(oversized, 'envelope', 'too_big', ctx), 'json_size_limit');
  const invalid = {
    ...response,
    payload: {
      ...response.payload,
      native_response: { id: attempt.native_request_id, extra: true, result: {} },
    },
  };
  // 即便直接构造正确 checksum 的分片，重组后的原生根字段也不能绕过校验。
  const raw = boundedJson(invalid),
    handcrafted = frame('object_chunk', {
      object_id: 'invalid_1',
      kind: 'envelope',
      total_bytes: Buffer.byteLength(raw),
      sha256: hash(raw),
      chunk_count: 1,
      index: 0,
      data: Buffer.from(raw).toString('base64'),
    });
  rejects(() => new ObjectAssembler().push(handcrafted, ctx, 0), 'native_response_invalid');
});

test('分片拒绝错序、冲突、checksum、超时、错误关联与容量洪泛', () => {
  const ctx = context('connector_to_gateway'),
    chunks = fragmentObject(bundle, 'schema_bundle', 'schema_1', ctx);
  const assembler = new ObjectAssembler();
  rejects(() => assembler.push(chunks[1]!, ctx, 0), 'chunk_out_of_order');
  assembler.push(chunks[0]!, ctx, 0);
  const changed = structuredClone(chunks[0]!);
  changed.payload.data = Buffer.alloc(LIMITS.chunk_bytes, 120).toString('base64');
  rejects(() => assembler.push(changed, ctx, 1), 'chunk_conflict');
  assert.equal(assembler.bufferedBytes, 0);
  const altered = new ObjectAssembler();
  altered.push(chunks[0]!, ctx, 0);
  rejects(
    () =>
      altered.push(
        { ...chunks[1]!, payload: { ...chunks[1]!.payload, sha256: 'b'.repeat(64) } },
        ctx,
        1,
      ),
    'object_conflict',
  );
  const checksum = fragmentObject(bundle, 'schema_bundle', 'checksum_1', ctx).map((c) => ({
    ...c,
    payload: { ...c.payload, sha256: 'b'.repeat(64) },
  }));
  const check = new ObjectAssembler();
  for (const c of checksum.slice(0, -1)) check.push(c, ctx, 0);
  rejects(() => check.push(checksum.at(-1)!, ctx, 0), 'object_checksum');
  const timeout = new ObjectAssembler();
  timeout.push(chunks[0]!, ctx, 100);
  timeout.push(chunks[0]!, ctx, 100 + LIMITS.transfer_timeout_ms - 1);
  rejects(() => timeout.push(chunks[1]!, ctx, 100 + LIMITS.transfer_timeout_ms), 'object_closed');
  assert.equal(timeout.bufferedBytes, 0);
  rejects(
    () => new ObjectAssembler().push({ ...chunks[0]!, connection_epoch: 'old' }, ctx, 0),
    'connection_binding_mismatch',
  );
  rejects(
    () =>
      encodeWireFrame(
        { ...chunks[0]!, payload: { ...chunks[0]!.payload, data: 'not-base64' } },
        ctx,
      ),
    'invalid_chunk',
  );
  rejects(
    () =>
      encodeWireFrame({ ...chunks[0]!, payload: { ...chunks[0]!.payload, chunk_count: 999 } }, ctx),
    'object_limit',
  );
  const capacity = new ObjectAssembler();
  for (let i = 0; i < LIMITS.transfers; i++)
    capacity.push(fragmentObject(bundle, 'schema_bundle', `capacity_${i}`, ctx)[0]!, ctx, 0);
  rejects(
    () => capacity.push(fragmentObject(bundle, 'schema_bundle', 'capacity_full', ctx)[0]!, ctx, 0),
    'object_capacity',
  );
  assert.equal(capacity.activeTransfers, LIMITS.transfers);
  const byteCapacity = new ObjectAssembler();
  const big = { data: 'x'.repeat(11 * LIMITS.frame_bytes) };
  byteCapacity.push(fragmentObject(big, 'schema_bundle', 'large_schema_1', ctx)[0]!, ctx, 0);
  rejects(
    () =>
      byteCapacity.push(fragmentObject(big, 'schema_bundle', 'large_schema_2', ctx)[0]!, ctx, 0),
    'object_capacity',
  );
  assert.doesNotThrow(() => fragmentObject(response, 'envelope', 'a'.repeat(128), ctx));
});

const received = transcript.filter((r) => r.kind === 'receive').map((r) => JSON.parse(r.wire));
const terminalEvent = received.find((r) => r.event === 'terminal.frame')!;
const terminalInput = JSON.parse(
  transcript.find((r) => r.kind === 'send' && JSON.parse(r.wire).action === 'submit_text')!.wire,
);
const terminalRequest = JSON.parse(
  transcript.find(
    (r) => r.kind === 'send' && r.channel === 'terminal-control' && JSON.parse(r.wire).method,
  )!.wire,
);
const streamAttempt = { ...attempt, native_request_id: terminalRequest.id };
function streamContext(
  direction: 'gateway_to_connector' | 'connector_to_gateway' = 'gateway_to_connector',
) {
  return context(
    direction,
    undefined,
    { ...binding, ...streamAttempt },
    terminalRequest.method,
    'stream',
    'terminal_control',
  );
}
test('stream open/data/input/close 正向使用原生 P0 终端帧，外层序号与关闭边界清晰', () => {
  const open = frame('stream_open', {
    ...request.payload,
    attempt: streamAttempt,
    native_request: withoutId(terminalRequest),
    stream_id: 'stream_1',
    feature: 'terminal_control',
  });
  const data = frame('stream_data', {
    attempt: streamAttempt,
    stream_id: 'stream_1',
    feature: 'terminal_control',
    sequence: 0,
    frame: terminalEvent,
  });
  const input = frame('stream_input', {
    attempt: streamAttempt,
    stream_id: 'stream_1',
    feature: 'terminal_control',
    sequence: 0,
    frame: terminalInput,
  });
  const close = frame('stream_close', {
    attempt: streamAttempt,
    stream_id: 'stream_1',
    reason: 'normal',
  });
  let state = advanceStream(undefined, open, streamContext());
  assert.equal(state.state, 'opening');
  rejects(() => advanceStream(state, input, streamContext()), 'stream_not_ready');
  state = advanceStream(state, data, streamContext('connector_to_gateway'));
  state = advanceStream(state, input, streamContext());
  assert.equal(state.next_data_sequence, 1);
  assert.equal(state.next_input_sequence, 1);
  rejects(
    () => advanceStream(state, data, streamContext('connector_to_gateway')),
    'stream_sequence_mismatch',
  );
  state = advanceStream(state, close, streamContext());
  assert.equal(state.state, 'closed');
  rejects(() => advanceStream(state, input, streamContext()), 'invalid_stream_transition');
  // close 只是释放流的外层意图，不生成关闭 pane 的原生调用。
  assert.equal('native_request' in close.payload, false);
  for (const [f, ctx] of [
    [open, streamContext()],
    [data, streamContext('connector_to_gateway')],
    [input, streamContext()],
    [close, streamContext()],
  ] as const) {
    assert.deepEqual(decodeWireFrame(encodeWireFrame(f, ctx), ctx), f);
    const bad = structuredClone(f) as any;
    delete bad.payload.stream_id;
    rejects(() => decodeWireFrame(JSON.stringify(bad), ctx), 'invalid_frame_fields');
    if (f.type !== 'stream_close')
      rejects(
        () =>
          encodeWireFrame(
            f,
            context(
              ctx.direction === 'gateway_to_connector'
                ? 'connector_to_gateway'
                : 'gateway_to_connector',
            ),
          ),
        'wrong_direction',
      );
  }
  const checked = streamContext();
  const savedGate = checked.validators!.luvus!.requestGate;
  checked.validators!.luvus!.requestGate = (r, c) => {
    assert.equal(c.transport, 'stream');
    assert.equal(c.feature, 'terminal_control');
    assert.equal(c.method, terminalRequest.method);
    return savedGate(r, c);
  };
  encodeWireFrame(open, checked);
});

test('未知能力/原生流帧、只读流输入、缺 validator 与流关联错配均拒绝', () => {
  const data = frame('stream_data', {
    attempt: streamAttempt,
    stream_id: 'stream_1',
    feature: 'terminal_control',
    sequence: 0,
    frame: terminalEvent,
  });
  rejects(
    () =>
      encodeWireFrame(
        { ...data, payload: { ...data.payload, feature: 'future' as any } },
        streamContext('connector_to_gateway'),
      ),
    'invalid_enum',
  );
  const noFeature = streamContext('connector_to_gateway');
  noFeature.connection.negotiated.capabilities = ['rpc'];
  rejects(() => encodeWireFrame(data, noFeature), 'unsupported_capability');
  rejects(
    () =>
      encodeWireFrame(
        { ...data, payload: { ...data.payload, frame: { event: 'future', data: {} } } },
        streamContext('connector_to_gateway'),
      ),
    'native_stream_frame_invalid',
  );
  const readOnlyInput = frame('stream_input', {
    attempt,
    stream_id: 'stream_1',
    feature: 'events',
    sequence: 0,
    frame: terminalInput,
  });
  rejects(() => encodeWireFrame(readOnlyInput, context()), 'unsupported_stream_input');
  const noStreamValidator = streamContext('connector_to_gateway');
  delete noStreamValidator.validators!.luvus!.validateStreamFrame;
  rejects(() => encodeWireFrame(data, noStreamValidator), 'stream_validator_unavailable');
  const open = frame('stream_open', {
    ...request.payload,
    attempt: streamAttempt,
    native_request: withoutId(terminalRequest),
    stream_id: 'stream_1',
    feature: 'terminal_control',
  });
  const state = advanceStream(undefined, open, streamContext());
  rejects(
    () =>
      advanceStream(
        state,
        { ...data, payload: { ...data.payload, stream_id: 'other' } },
        streamContext('connector_to_gateway'),
      ),
    'stream_binding_mismatch',
  );
  rejects(
    () => advanceStream(undefined, data, streamContext('connector_to_gateway')),
    'stream_not_open',
  );
  const input = frame('stream_input', {
    attempt: streamAttempt,
    stream_id: 'stream_1',
    feature: 'terminal_control',
    sequence: 0,
    frame: { id: 'input_1', action: 'not_a_native_action', params: {} },
  });
  rejects(() => encodeWireFrame(input, streamContext()), 'native_stream_frame_invalid');
  rejects(
    () =>
      encodeWireFrame(
        { ...data, payload: { ...data.payload, feature: 'events' } },
        streamContext('connector_to_gateway'),
      ),
    'attempt_transport_mismatch',
  );
  const validInput = { ...input, payload: { ...input.payload, frame: terminalInput } };
  const perFrame = streamContext();
  let controls = 0,
    gates = 0;
  const actions: unknown[] = [];
  const validator = perFrame.validators!.luvus!,
    control = validator.validateStreamFrame!;
  validator.validateStreamFrame = (r, c) => {
    controls++;
    control(r, c);
  };
  validator.checkDispatch = (r, c) => {
    gates++;
    actions.push(r.action);
    assert.equal(c.method, terminalRequest.method);
  };
  encodeWireFrame(validInput, perFrame);
  encodeWireFrame(
    {
      ...validInput,
      message_id: 'input_2',
      payload: {
        ...validInput.payload,
        sequence: 1,
        frame: { id: 'input_2', action: 'type_literal', params: { text: 'synthetic' } },
      },
    },
    perFrame,
  );
  assert.equal(controls, 2);
  assert.equal(gates, 2);
  assert.deepEqual(actions, ['submit_text', 'type_literal']);
  validator.checkDispatch = () => {
    throw new Error('synthetic-private-policy');
  };
  rejects(() => encodeWireFrame(validInput, perFrame), 'native_dispatch_forbidden');
  delete validator.checkDispatch;
  rejects(() => encodeWireFrame(validInput, perFrame), 'dispatch_validator_unavailable');
  const disabled = streamContext();
  disabled.resolveProvider = () => ({
    machine_id: binding.machine_id,
    provider_id: binding.target.provider_id,
    kind: 'luvus',
    config_ref: 'config_1',
    binding_revision: 2,
    enabled: false,
  });
  rejects(() => encodeWireFrame(validInput, disabled), 'provider_disabled');
  const noScope = streamContext();
  noScope.policies!.local.grants[0]!.actions = ['dispatch', 'read'];
  rejects(() => encodeWireFrame(validInput, noScope), 'provider_scope_forbidden');
});
