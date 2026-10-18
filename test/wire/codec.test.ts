import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeWireFrame, encodeWireFrame, negotiate, LIMITS, boundedJson, WireError } from '../../src/wire/index.js';
import type { PreAuthEnvelope, CodecContext } from '../../src/wire/types.js';
import { ajv, transcript, context, identity, attempt, binding, request, response, frame, offer,
  rejects, fixtureValidator, allowedGate, nativeRequest, withoutId } from './helpers.js';

const decode = (v: unknown, ctx = context()) => decodeWireFrame(JSON.stringify(v), ctx);
const rawContext = (validator = fixtureValidator()) => context('gateway_to_connector', validator, binding, 'ping', 'rpc', undefined, 'raw-contract');

test('v2 major 拒绝、minor 取交集，未知可选能力忽略、未知必需能力拒绝', () => {
  const local = { ...offer, capabilities: ['rpc', 'objects'] };
  assert.deepEqual(negotiate(local, { ...local, minor: 12, capabilities: ['rpc', 'future'] }), { major: 2, minor: 0, capabilities: ['rpc'] });
  rejects(() => negotiate(local, { ...local, major: 1 }), 'protocol_major_unsupported');
  rejects(() => negotiate(local, { ...local, capabilities: ['rpc', 'future'], required: ['future'] }), 'required_capability_unsupported');
  rejects(() => negotiate(local, { ...local, minor: -1 }), 'invalid_integer');
  rejects(() => negotiate(local, { ...local, capabilities: ['rpc', 'rpc'] }), 'invalid_capabilities');
  rejects(() => negotiate(local, { ...local, required: ['missing'] }), 'invalid_capabilities');
  rejects(() => negotiate({ ...offer, capabilities: ['terminal_control'], required: [] },
    { ...offer, capabilities: ['terminal_control'], required: [] }), 'invalid_capabilities');
});

test('v2 握手必填字段、方向与 welcome 关联完整，不构造认证来源', () => {
  const c2g: CodecContext = { phase: 'preauth', direction: 'connector_to_gateway' };
  const g2c: CodecContext = { phase: 'preauth', direction: 'gateway_to_connector', offer, handshake_message_id: 'handshake_1' };
  const authenticate: PreAuthEnvelope = { protocol_major: 2, protocol_minor: 0, type: 'authenticate', message_id: 'handshake_1',
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
  rejects(() => decodeWireFrame(JSON.stringify({ ...welcome, payload: { ...welcome.payload, selected: { major: 2, minor: 0, capabilities: ['future'] } } }), g2c), 'unsupported_capability');
  rejects(() => decodeWireFrame(JSON.stringify({ ...authenticate, protocol_minor: 1 }), c2g), 'invalid_negotiation');
  const { machine_id, recovery_generation, connection_epoch, ...forged } = request;
  rejects(() => decodeWireFrame(JSON.stringify(forged), { phase: 'preauth', direction: 'gateway_to_connector' }), 'authentication_required');
});

test('v2 基础帧往返，完整原生错误 data 保留，所有帧有缺字段与方向负例', () => {
  const fixtures = [request, frame('accepted', { attempt }), response, frame('cancel', { attempt, reason: 'deadline_exceeded' }),
    frame('heartbeat', { sequence: 0 }), frame('error', { source: 'gateway', code: 'forbidden', retryable: false })];
  for (const f of fixtures) {
    const c2g = ['accepted', 'response'].includes(f.type), ctx = context(c2g ? 'connector_to_gateway' : 'gateway_to_connector');
    assert.deepEqual(decodeWireFrame(encodeWireFrame(f, ctx), ctx), f);
    const bad = structuredClone(f) as any; delete bad.payload[Object.keys(bad.payload)[0]!];
    rejects(() => decodeWireFrame(JSON.stringify(bad), ctx), 'invalid_frame_fields');
    if (!['heartbeat', 'error'].includes(f.type)) rejects(() => decodeWireFrame(JSON.stringify(f),
      context(c2g ? 'gateway_to_connector' : 'connector_to_gateway')), 'wrong_direction');
  }
  const err = { ...response, payload: { ...response.payload, native_response: { id: attempt.native_request_id,
    error: { code: 'revision_conflict', message: 'synthetic', data: { revision: 42, nested: { retain: true } } } } } };
  assert.deepEqual(decodeWireFrame(encodeWireFrame(err, context('connector_to_gateway')), context('connector_to_gateway')), err);
  rejects(() => decode(frame('error', { source: 'native' as any, code: 'native_error', retryable: false })), 'invalid_enum');
  rejects(() => decode(frame('heartbeat', { sequence: -1 })), 'invalid_integer');
  rejects(() => decode(frame('heartbeat', { sequence: Number.MAX_SAFE_INTEGER + 1 })), 'invalid_integer');
  rejects(() => decode({ ...request, payload: { ...request.payload, owner: true } }), 'invalid_frame_fields');
});

test('连接、provider、revision、契约、登记 deadline/history/policy 与原生 ID 核对独立锚点', () => {
  for (const key of ['machine_id', 'recovery_generation', 'connection_epoch'] as const)
    rejects(() => decode({ ...response, [key]: 'wrong' }, context('connector_to_gateway')), 'connection_binding_mismatch');
  for (const [key, value] of [['call_id', 'wrong'], ['attempt_id', 'wrong'], ['native_request_id', 'wrong'],
    ['binding_revision', 2], ['provider_kind', 'herdr'], ['contract_ref', 'b'.repeat(64)]] as const)
    rejects(() => decode({ ...response, payload: { ...response.payload, attempt: { ...attempt, [key]: value } } }, context('connector_to_gateway')), 'attempt_binding_mismatch');
  for (const [key, value] of [['provider_id', 'other'], ['session', 'other']] as const)
    rejects(() => decode({ ...response, payload: { ...response.payload, attempt: { ...attempt, target: { ...attempt.target, [key]: value } } } }, context('connector_to_gateway')), 'attempt_binding_mismatch');
  for (const [key, value] of [['deadline', 2000], ['history', { history_epoch: 'other', client_request_key: 'key_1' }],
    ['caller_policy_revision', 'other'], ['local_policy_revision', 'other']] as const)
    rejects(() => decode({ ...response, payload: { ...response.payload, attempt: { ...attempt, registration: { ...attempt.registration, [key]: value } } } }, context('connector_to_gateway')), 'attempt_binding_mismatch');
  rejects(() => decode(response, { ...context('connector_to_gateway'), resolveAttempt: undefined }), 'attempt_anchor_unavailable');
  rejects(() => decode({ ...response, payload: { ...response.payload, native_response: { id: 'wrong', result: {} } } }, context('connector_to_gateway')), 'native_id_mismatch');
  const inactive = context(); (inactive.connection as any).active = false;
  rejects(() => decode(request, inactive), 'authentication_required');
  rejects(() => decode({ ...request, protocol_major: 1 }), 'protocol_major_unsupported');
  rejects(() => decode({ ...request, protocol_minor: 1 }), 'protocol_version_unsupported');
});

test('真实 P0 完整 UHP request 注入可信 ID；response 依赖原 handle/source 与完整离线 schema', () => {
  let checked = 0;
  for (const row of transcript.filter(r => r.kind === 'process' && r.stdin && r.stdout)) {
    const req = JSON.parse(row.stdin.split('\n')[0]), res = JSON.parse(row.stdout.split('\n')[0]);
    const a = { ...attempt, native_request_id: req.id, target: row.label.startsWith('host-') ?
      { machine_id: identity.machine_id, provider_id: attempt.target.provider_id, profile: 'host' as const } : attempt.target };
    const b = { ...binding, ...a };
    const f = frame('response', { attempt: a, native_response: res });
    const ctx = context('connector_to_gateway', fixtureValidator(), b, req.method);
    assert.deepEqual(decodeWireFrame(encodeWireFrame(f, ctx), ctx), f);
    if (nativeRequest(req)) {
      const rf = frame('request', { attempt: a, expected_binding_revision: 1, native_request: withoutId(req), validation: 'strict' });
      const rc = context('gateway_to_connector', fixtureValidator(), b, req.method);
      assert.deepEqual(decodeWireFrame(encodeWireFrame(rf, rc), rc), rf);
    }
    checked++;
  }
  assert(checked >= 8);
  for (const req of [{ ...request.payload.native_request, extra: true },
    { method: 'uhp.capabilities', params: { unannounced: true } },
    { method: 'agent.prompt', params: { target: '1', text: 'synthetic', until: 'done' } }, { method: 'ping' }])
    rejects(() => decode({ ...request, payload: { ...request.payload, native_request: req } }, context('gateway_to_connector', fixtureValidator(), binding, req.method as string)), 'native_request_invalid');
  for (const bad of [{ id: attempt.native_request_id }, { id: attempt.native_request_id, result: {}, extra: true },
    { id: attempt.native_request_id, error: { code: 'internal' } }])
    rejects(() => decode({ ...response, payload: { ...response.payload, native_response: bad } }, context('connector_to_gateway')), 'native_response_invalid');
  for (const field of ['id', 'auth']) rejects(() => decode({ ...request, payload: { ...request.payload,
    native_request: { ...request.payload.native_request, [field]: 'caller' } } }), 'reserved_request_field');
  assert.throws(() => ajv.compile({ $ref: 'https://untrusted.invalid/no-network.json' }), /resolve reference/);
});

test('分类与 generic/schema 状态独立；raw 需原登记 mode 和独立授权，不能越过根 schema', () => {
  const raw = { ...request, payload: { ...request.payload, validation: 'raw-contract' as const } };
  for (const classification_status of ['missing', 'unknown', 'invalid', 'untrusted'] as const) {
    const validator = fixtureValidator({ ...allowedGate, classification_status, raw_contract_authorized: true });
    rejects(() => decode(request, context('gateway_to_connector', validator)), 'classification_unavailable');
    rejects(() => decode(raw, rawContext(validator)), 'classification_unavailable');
  }
  for (const schema_status of ['generic', 'unavailable'] as const)
    rejects(() => decode(request, context('gateway_to_connector', fixtureValidator({ ...allowedGate, schema_status }))),
      schema_status === 'generic' ? 'parameter_schema_incomplete' : 'parameter_schema_unavailable');
  rejects(() => decode(raw, rawContext()), 'raw_contract_forbidden');
  rejects(() => decode(raw), 'attempt_binding_mismatch');
  const rawGate = { ...allowedGate, schema_status: 'generic' as const, raw_contract_authorized: true };
  assert.deepEqual(decode(raw, rawContext(fixtureValidator(rawGate))), raw);
  for (const part of [{ authorized: false }, { secret_result_authorized: false }])
    rejects(() => decode(raw, rawContext(fixtureValidator({ ...rawGate, ...part }))), 'forbidden');
  rejects(() => decode(raw, rawContext(fixtureValidator({ ...rawGate, transport_status: 'unsupported' }))), 'unsupported_transport');
  rejects(() => decode({ ...raw, payload: { ...raw.payload, native_request: { ...raw.payload.native_request, extra: true } } }, rawContext(fixtureValidator(rawGate))), 'native_request_invalid');
  rejects(() => decode(request, { ...context(), validators: undefined }), 'native_validator_unavailable');
  const missing = fixtureValidator(); missing.requestGate = () => ({} as any);
  rejects(() => decode(request, context('gateway_to_connector', missing)), 'classification_unavailable');
  const coverage = JSON.parse(readFileSync(new URL('../../fixtures/native-contract/coverage.json', import.meta.url), 'utf8'));
  const generic = coverage.methods.filter((r: any) => r.schema.parameter_detail === 'generic_params_only');
  assert.equal(generic.length, 144);
  for (const row of generic) {
    const r = { method: row.method, params: { unrelated: true } };
    assert(nativeRequest({ ...r, id: attempt.native_request_id }));
    rejects(() => decode({ ...request, payload: { ...request.payload, native_request: r } },
      context('gateway_to_connector', fixtureValidator({ ...allowedGate, schema_status: 'generic' }), binding, row.method)), 'parameter_schema_incomplete');
  }
});

test('UTF-8/JSON/Unicode、精确大小/深度/节点与 ID 边界保持有界', () => {
  rejects(() => decodeWireFrame(new Uint8Array([0xc3, 0x28]), context()), 'invalid_utf8');
  for (const raw of ['{', '{}\n{}', '\uFEFF{}', 'null', '[]']) assert.throws(() => decodeWireFrame(raw, context()), WireError);
  rejects(() => decodeWireFrame('x'.repeat(LIMITS.frame_bytes + 1), context()), 'frame_limit');
  for (const message_id of ['', 'a'.repeat(129)]) rejects(() => decode({ ...request, message_id }), 'invalid_frame_id');
  assert.doesNotThrow(() => decode({ ...request, message_id: 'a'.repeat(128) }));
  let boundary: unknown = 0; for (let i = 0; i < LIMITS.depth; i++) boundary = [boundary];
  assert.doesNotThrow(() => boundedJson(boundary)); rejects(() => boundedJson([boundary]), 'json_depth_limit');
  assert.doesNotThrow(() => boundedJson(Array.from({ length: LIMITS.nodes - 1 }, () => null)));
  rejects(() => boundedJson(Array.from({ length: LIMITS.nodes }, () => null)), 'json_depth_limit');
  rejects(() => boundedJson({ text: '\ud800' }), 'invalid_unicode'); assert.equal(boundedJson('😀'), '"😀"');
  const cyclic: any = {}; cyclic.self = cyclic;
  rejects(() => boundedJson(cyclic), 'invalid_json');
  rejects(() => boundedJson({ get x() { throw Error('不得执行'); } }), 'invalid_json');
  rejects(() => boundedJson(new Date()), 'invalid_json'); rejects(() => boundedJson(new Array(3)), 'invalid_json');
  const heartbeat = frame('heartbeat', { sequence: 0 }), raw = JSON.stringify(heartbeat);
  assert.deepEqual(decodeWireFrame(raw + ' '.repeat(LIMITS.frame_bytes - Buffer.byteLength(raw)), context()), heartbeat);
});
