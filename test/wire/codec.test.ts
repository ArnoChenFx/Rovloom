import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeWireFrame, encodeWireFrame, negotiate, LIMITS, boundedJson, WireError } from '../../src/wire/index.js';
import type { PreAuthEnvelope, CodecContext } from '../../src/wire/types.js';
import { ajv, bundle, transcript, context, identity, attempt, binding, request, response, frame, offer,
  rejects, fixtureValidator, allowedGate, nativeRequest } from './helpers.js';

const decode = (value: unknown, ctx = context()) => decodeWireFrame(JSON.stringify(value), ctx);
test('major 拒绝、minor 取交集，未知可选能力忽略、未知必需能力拒绝', () => {
  const local = { ...offer, capabilities: ['rpc', 'objects'], minor: 0 };
  assert.deepEqual(negotiate(local, { ...local, minor: 12, capabilities: ['rpc', 'future'] }), { major: 1, minor: 0, capabilities: ['rpc'] });
  rejects(() => negotiate(local, { ...local, major: 2 }), 'protocol_major_unsupported');
  rejects(() => negotiate(local, { ...local, capabilities: ['rpc', 'future'], required: ['future'] }), 'required_capability_unsupported');
  rejects(() => negotiate(local, { ...local, minor: -1 }), 'invalid_integer');
  rejects(() => negotiate(local, { ...local, capabilities: ['rpc', 'rpc'] }), 'invalid_capabilities');
  rejects(() => negotiate(local, { ...local, required: ['missing'] }), 'invalid_capabilities');
  rejects(() => negotiate({ ...offer, capabilities: ['terminal_control'], required: [] },
    { ...offer, capabilities: ['terminal_control'], required: [] }), 'invalid_capabilities');
});

test('握手必填字段、方向与 welcome 关联完整，但不构造已认证连接', () => {
  const c2g: CodecContext = { phase: 'preauth', direction: 'connector_to_gateway' };
  const g2c: CodecContext = { phase: 'preauth', direction: 'gateway_to_connector', offer, handshake_message_id: 'handshake_1' };
  const authenticate: PreAuthEnvelope = { protocol_major: 1, protocol_minor: 0, type: 'authenticate', message_id: 'handshake_1',
    payload: { machine_id: identity.machine_id, recovery_generation: identity.recovery_generation,
      connector_instance_id: 'connector_1', device_credential: 'synthetic-test-value', offer } };
  const enroll: PreAuthEnvelope = { ...authenticate, type: 'enroll', payload: { registration_id: 'registration_1',
    connector_instance_id: 'connector_1', enrollment_credential: 'synthetic-test-value', offer } };
  const welcome: PreAuthEnvelope = { ...authenticate, type: 'welcome', payload: { ...identity, in_reply_to: 'handshake_1', selected: negotiate(offer, offer) } };
  for (const value of [authenticate, enroll]) {
    assert.deepEqual(decodeWireFrame(encodeWireFrame(value, c2g), c2g), value);
    rejects(() => decodeWireFrame(JSON.stringify(value), g2c), 'wrong_direction');
    const missing = structuredClone(value) as any; delete missing.payload.connector_instance_id;
    rejects(() => decodeWireFrame(JSON.stringify(missing), c2g), 'invalid_frame_fields');
    rejects(() => decodeWireFrame(JSON.stringify({ ...value, connection_epoch: 'fake' }), c2g), 'invalid_frame_fields');
  }
  assert.deepEqual(decodeWireFrame(encodeWireFrame(welcome, g2c), g2c), welcome);
  rejects(() => decodeWireFrame(JSON.stringify(welcome), { ...g2c, handshake_message_id: 'wrong' }), 'handshake_mismatch');
  rejects(() => decodeWireFrame(JSON.stringify(welcome), { phase: 'preauth', direction: 'gateway_to_connector' }), 'handshake_context_required');
  rejects(() => decodeWireFrame(JSON.stringify({ ...welcome, payload: { ...welcome.payload, selected: { major: 1, minor: 0, capabilities: ['future'] } } }), g2c), 'unsupported_capability');
  rejects(() => decodeWireFrame(JSON.stringify({ ...authenticate, protocol_minor: 1 }), c2g), 'invalid_negotiation');
  rejects(() => decodeWireFrame(JSON.stringify(request), c2g), 'wrong_direction');
  const { machine_id, recovery_generation, connection_epoch, ...forged } = request;
  rejects(() => decodeWireFrame(JSON.stringify(forged), { phase: 'preauth', direction: 'gateway_to_connector' }), 'authentication_required');
  rejects(() => decode(authenticate), 'wrong_direction');
});

test('所有基础业务帧往返，Host/session 与完整原生错误 data 保留', () => {
  assert.deepEqual(decodeWireFrame(encodeWireFrame(request, context()), context()), request);
  const host = structuredClone(request); host.payload.attempt.target = { machine_id: identity.machine_id, profile: 'host' };
  assert.deepEqual(decodeWireFrame(encodeWireFrame(host, context()), context()), host);
  for (const f of [frame('accepted', { attempt }), response, frame('heartbeat', { sequence: 0 }),
    frame('error', { source: 'transport', code: 'socket_closed', retryable: false, cause_message_id: 'message_1' })]) {
    assert.deepEqual(decodeWireFrame(encodeWireFrame(f, context('connector_to_gateway')), context('connector_to_gateway')), f);
  }
  const cancel = frame('cancel', { attempt, reason: 'caller_cancelled' });
  assert.deepEqual(decodeWireFrame(encodeWireFrame(cancel, context()), context()), cancel);
  const err = { ...response, payload: { ...response.payload, uhp_response: {
    id: attempt.native_request_id, error: { code: 'revision_conflict', message: 'synthetic', data: { revision: 42, nested: { retain: true } } } } } };
  assert.deepEqual(decodeWireFrame(encodeWireFrame(err, context('connector_to_gateway')), context('connector_to_gateway')), err);
  const rawError: PreAuthEnvelope = { protocol_major: 1, protocol_minor: 0, message_id: 'error_1', type: 'error',
    payload: { source: 'gateway', code: 'authentication_failed', retryable: false } };
  assert.deepEqual(decodeWireFrame(encodeWireFrame(rawError, { phase: 'preauth', direction: 'gateway_to_connector' }),
    { phase: 'preauth', direction: 'gateway_to_connector' }), rawError);
  rejects(() => decode({ ...request, payload: { ...request.payload, owner: true } }), 'invalid_frame_fields');
});

test('每一种 envelope 都有缺字段或错向负例，原生错误不混入网关 error', () => {
  const fixtures = [request, frame('accepted', { attempt }), response, frame('cancel', { attempt, reason: 'deadline_exceeded' }),
    frame('heartbeat', { sequence: 0 }), frame('error', { source: 'gateway', code: 'forbidden', retryable: false })];
  for (const f of fixtures) {
    const c2g = ['accepted', 'response'].includes(f.type), ctx = context(c2g ? 'connector_to_gateway' : 'gateway_to_connector');
    const bad = structuredClone(f) as any; delete bad.payload[Object.keys(bad.payload)[0]!];
    rejects(() => decodeWireFrame(JSON.stringify(bad), ctx), 'invalid_frame_fields');
    if (!['heartbeat', 'error'].includes(f.type)) rejects(() => decodeWireFrame(JSON.stringify(f),
      context(c2g ? 'gateway_to_connector' : 'connector_to_gateway')), 'wrong_direction');
  }
  rejects(() => decode(frame('error', { source: 'native' as any, code: 'native_error', retryable: false })), 'invalid_enum');
  rejects(() => decode(frame('heartbeat', { sequence: -1 })), 'invalid_integer');
  rejects(() => decode(frame('heartbeat', { sequence: Number.MAX_SAFE_INTEGER + 1 })), 'invalid_integer');
});

test('machine/恢复代次/epoch、完整 attempt/target/契约与原生 ID 均核对持久锚点', () => {
  for (const key of ['machine_id', 'recovery_generation', 'connection_epoch'] as const) {
    rejects(() => decode({ ...response, [key]: 'wrong' }, context('connector_to_gateway')), 'connection_binding_mismatch');
  }
  for (const key of ['call_id', 'attempt_id', 'native_request_id', 'contract_revision', 'contract_digest'] as const) {
    rejects(() => decode({ ...response, payload: { ...response.payload, attempt: { ...attempt, [key]: key === 'contract_digest' ? 'b'.repeat(64) : 'wrong' } } },
      context('connector_to_gateway')), 'attempt_binding_mismatch');
  }
  rejects(() => decode({ ...response, payload: { ...response.payload, attempt: { ...attempt,
    target: { ...attempt.target, session: 'different' } } } }, context('connector_to_gateway')), 'attempt_binding_mismatch');
  rejects(() => decode({ ...request, payload: { ...request.payload, attempt: { ...attempt,
    target: { machine_id: 'other', profile: 'host' } } } }), 'target_machine_mismatch');
  rejects(() => decode(response, { ...context('connector_to_gateway'), resolveAttempt: undefined }), 'attempt_anchor_unavailable');
  rejects(() => decode({ ...response, payload: { ...response.payload, uhp_response: { id: 'wrong', result: {} } } }, context('connector_to_gateway')), 'native_id_mismatch');
  const inactive = context(); (inactive.connection as any).active = false;
  rejects(() => decode(request, inactive), 'authentication_required');
  rejects(() => decode({ ...request, protocol_major: 2 }), 'protocol_major_unsupported');
  rejects(() => decode({ ...request, protocol_minor: 1 }), 'protocol_version_unsupported');
  const unknown = context(); (unknown.connection.negotiated.capabilities as string[]).push('future');
  rejects(() => decode(request, unknown), 'unsupported_capability');
});

test('原生 P0 request/response 逐记录通过真实离线 schema，额外根字段与非法条件拒绝', () => {
  let checked = 0;
  for (const row of transcript.filter(r => r.kind === 'process' && r.stdin && r.stdout)) {
    const req = JSON.parse(row.stdin.split('\n')[0]);
    const res = JSON.parse(row.stdout.split('\n')[0]);
    const a = { ...attempt, native_request_id: req.id }, b = { ...binding, ...a };
    const responseFrame = frame('response', { attempt: a, uhp_response: res });
    assert.deepEqual(decodeWireFrame(encodeWireFrame(responseFrame, context('connector_to_gateway', fixtureValidator(), b, req.method)),
      context('connector_to_gateway', fixtureValidator(), b, req.method)), responseFrame);
    if (nativeRequest(req)) {
      const rf = frame('request', { attempt: a, uhp_request: req, deadline: 1000, validation: 'strict' });
      assert.deepEqual(decodeWireFrame(encodeWireFrame(rf, context()), context()), rf);
    }
    checked++;
  }
  assert(checked >= 8);
  for (const req of [ { ...request.payload.uhp_request, unannounced: true },
    { id: attempt.native_request_id, method: 'uhp.capabilities', params: { unannounced: true } },
    { id: attempt.native_request_id, method: 'agent.prompt', params: { target: '1', text: 'synthetic', until: 'done' } },
    { id: attempt.native_request_id, method: 'ping' } ]) {
    rejects(() => decode({ ...request, payload: { ...request.payload, uhp_request: req } }), 'native_request_invalid');
  }
  for (const bad of [{ id: attempt.native_request_id }, { id: attempt.native_request_id, result: {}, extra: true },
    { id: attempt.native_request_id, error: { code: 'internal' } }]) {
    rejects(() => decode({ ...response, payload: { ...response.payload, uhp_response: bad } }, context('connector_to_gateway')),
      Object.hasOwn(bad, 'result') || Object.hasOwn(bad, 'error') ? 'native_response_invalid' : 'invalid_native_response');
  }
  assert.throws(() => ajv.compile({ $ref: 'https://untrusted.invalid/no-network.json' }), /resolve reference/);
});

test('分类与 schema 状态独立，Owner/raw 不绕过分类、秘密交付、当前授权或根 schema', () => {
  for (const classification_status of ['missing', 'unknown', 'invalid', 'untrusted'] as const) {
    const native = fixtureValidator({ ...allowedGate, classification_status, raw_contract_authorized: true });
    for (const validation of ['strict', 'raw-contract'] as const) rejects(() => decode({ ...request,
      payload: { ...request.payload, validation } }, context('gateway_to_connector', native)), 'classification_unavailable');
  }
  for (const schema_status of ['incomplete', 'unavailable'] as const) {
    rejects(() => decode(request, context('gateway_to_connector', fixtureValidator({ ...allowedGate, schema_status }))),
      schema_status === 'incomplete' ? 'parameter_schema_incomplete' : 'parameter_schema_unavailable');
  }
  const raw = { ...request, payload: { ...request.payload, validation: 'raw-contract' as const } };
  rejects(() => decode(raw), 'raw_contract_forbidden');
  const rawGate = { ...allowedGate, schema_status: 'incomplete' as const, raw_contract_authorized: true };
  assert.deepEqual(decode(raw, context('gateway_to_connector', fixtureValidator(rawGate))), raw);
  for (const part of [{ authorized: false }, { secret_result_authorized: false }])
    rejects(() => decode(raw, context('gateway_to_connector', fixtureValidator({ ...rawGate, ...part }))), 'forbidden');
  rejects(() => decode(raw, context('gateway_to_connector', fixtureValidator({ ...rawGate, transport_status: 'unsupported' }))), 'unsupported_transport');
  rejects(() => decode({ ...raw, payload: { ...raw.payload, uhp_request: { ...raw.payload.uhp_request, auth: 'synthetic' } } }), 'reserved_request_field');
  rejects(() => decode({ ...raw, payload: { ...raw.payload, uhp_request: { ...raw.payload.uhp_request, extra: true } } },
    context('gateway_to_connector', fixtureValidator(rawGate))), 'native_request_invalid');
  rejects(() => decode(request, { ...context(), native: undefined }), 'native_validator_unavailable');
  const incomplete = fixtureValidator(); incomplete.requestGate = () => ({} as any);
  rejects(() => decode(request, context('gateway_to_connector', incomplete)), 'classification_unavailable');
  const missingSchema = fixtureValidator(); missingSchema.requestGate = () => ({ ...allowedGate, schema_status: undefined } as any);
  rejects(() => decode(request, context('gateway_to_connector', missingSchema)), 'parameter_schema_unavailable');
  const coverage = JSON.parse(readFileSync(new URL('../../docs/p0/coverage.json', import.meta.url), 'utf8'));
  const generic = coverage.methods.filter((r: any) => r.schema.parameter_detail === 'generic_params_only');
  assert.equal(generic.length, 144);
  for (const row of generic) {
    const rf = { ...request, payload: { ...request.payload, uhp_request: { id: attempt.native_request_id, method: row.method, params: { unrelated: true } } } };
    assert(nativeRequest(rf.payload.uhp_request));
    rejects(() => decode(rf, context('gateway_to_connector', fixtureValidator({ ...allowedGate, schema_status: 'incomplete' }))), 'parameter_schema_incomplete');
  }
});

test('UTF-8、JSON、Unicode、大小、深度与 ID 边界失败关闭', () => {
  rejects(() => decodeWireFrame(new Uint8Array([0xc3, 0x28]), context()), 'invalid_utf8');
  for (const raw of ['{', '{}\n{}', '\uFEFF{}', 'null', '[]']) assert.throws(() => decodeWireFrame(raw, context()), WireError);
  rejects(() => decodeWireFrame('x'.repeat(LIMITS.frame_bytes + 1), context()), 'frame_limit');
  rejects(() => decode({ ...request, message_id: '' }), 'invalid_frame_id');
  rejects(() => decode({ ...request, message_id: 'a'.repeat(129) }), 'invalid_frame_id');
  assert.deepEqual(decode({ ...request, message_id: 'a'.repeat(128) }), { ...request, message_id: 'a'.repeat(128) });
  rejects(() => decode({ ...request, payload: { ...request.payload, deadline: 0 } }), 'invalid_integer');
  let deep: unknown = 1; for (let i = 0; i < 66; i++) deep = [deep];
  rejects(() => boundedJson(deep), 'json_depth_limit');
  rejects(() => boundedJson({ text: '\ud800' }), 'invalid_unicode');
  rejects(() => decode({ ...request, payload: { ...request.payload, uhp_request: { ...request.payload.uhp_request, params: { bad: '\ud800' } } } }), 'invalid_unicode');
  assert.equal(boundedJson('😀'), '"😀"');
  const cyclic: any = {}; cyclic.self = cyclic;
  rejects(() => boundedJson(cyclic), 'invalid_json');
  rejects(() => boundedJson({ get x() { throw Error('不得执行'); } }), 'invalid_json');
  rejects(() => boundedJson(new Date()), 'invalid_json');
  rejects(() => boundedJson(new Array(3)), 'invalid_json');
  const heartbeat = frame('heartbeat', { sequence: 0 }), raw = JSON.stringify(heartbeat);
  assert.deepEqual(decodeWireFrame(raw + ' '.repeat(LIMITS.frame_bytes - Buffer.byteLength(raw)), context()), heartbeat);
  assert.doesNotThrow(() => boundedJson(Array.from({ length: LIMITS.nodes - 1 }, () => null)));
  rejects(() => boundedJson(Array.from({ length: LIMITS.nodes }, () => null)), 'json_depth_limit');
  let boundary: unknown = 0;
  for (let i = 0; i < LIMITS.depth; i++) boundary = [boundary];
  assert.doesNotThrow(() => boundedJson(boundary));
  rejects(() => boundedJson([boundary]), 'json_depth_limit');
  const nativeId = 'native.1:_-';
  assert.doesNotThrow(() => decode({ ...request, payload: { ...request.payload,
    attempt: { ...attempt, native_request_id: nativeId }, uhp_request: { ...request.payload.uhp_request, id: nativeId } } }));
});
