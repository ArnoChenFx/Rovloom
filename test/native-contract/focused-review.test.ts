import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { checkDispatch, checkResultBoundary, compileBundle, inspectRequestGate, parseNativeJson } from '../../src/native-contract/index.js';
import { DEFAULT_LIMITS, snapshot } from '../../src/native-contract/json.js';
import { auth, bytes, clone, G, identity, json, raw, register, rejects, request, sourceFor, T, unwrap, validator, view } from './helpers.js';

function opening() {
  const from = view();
  const candidate = request(from, { id: 'review-open', method: 'terminal.backend.control',
    params: { server_generation: G, terminal_id: T, pane_id: '3' } });
  const permit = unwrap(checkDispatch(candidate, auth(candidate)));
  const response = { id: 'review-open', result: { type: 'terminal_backend_stream', mode: 'control',
    server_generation: G, terminal_id: T, pane_id: '3', sequence: 0, content_revision: 0,
    ansi: false, capture_mode: 'visible', lines: 1, frame_bytes: 65536, queue_capacity: 2,
    loss_behavior: 'resync_required_then_close' } };
  const acknowledgement = unwrap(validator.checkResponse(permit, response, sourceFor(candidate.binding)));
  return { from, candidate, permit, response, acknowledgement };
}

test('聚焦复核：Check 成功但 Gate 拒绝不能转成候选/permit/stream', () => {
  const candidate = request(view(), { id: 'review-gate', method: 'ping', params: {} });
  const gate = unwrap(inspectRequestGate(candidate, auth(candidate)));
  assert.equal(gate.schema_status, 'incomplete');
  rejects(checkDispatch(candidate, auth(candidate)), 'parameter_schema_incomplete');
  rejects(checkDispatch(gate as any, auth(candidate)), 'invalid_request_handle');
  rejects(checkDispatch({ ...candidate } as any, auth(candidate)), 'invalid_request_handle');
  rejects(checkResultBoundary(gate as any, {} as any), 'invalid_permit_handle');
  const opened = opening();
  rejects(validator.openStream(gate as any, opened.acknowledgement), 'invalid_stream_context');
});

test('聚焦复核：ack 必须来自同一份 permit，不能跨 principal 或事后授权', () => {
  const opened = opening();
  const another = unwrap(checkDispatch(opened.candidate, { ...auth(opened.candidate), principal_id: 'other-principal' }));
  rejects(validator.openStream(another, opened.acknowledgement), 'invalid_stream_context');
  const samePrincipalNewPermit = unwrap(checkDispatch(opened.candidate, auth(opened.candidate)));
  rejects(validator.openStream(samePrincipalNewPermit, opened.acknowledgement), 'invalid_stream_context');
  const shapeBound = unwrap(validator.checkResponse(opened.candidate, opened.response, sourceFor(opened.candidate.binding)));
  assert.equal(shapeBound.bound, true);
  rejects(validator.openStream(opened.permit, shapeBound), 'invalid_stream_context');
  rejects(validator.openStream(opened.permit, clone(opened.acknowledgement)), 'invalid_stream_context');
  unwrap(validator.openStream(opened.permit, opened.acknowledgement));
});

test('聚焦复核：同名 native ID 的 provider/revision/source/旧 epoch 全链拒绝', () => {
  const opened = opening();
  const stream = unwrap(validator.openStream(opened.permit, opened.acknowledgement));
  const frame = register(unwrap(validator.checkControl(stream, { id: 'input', action: 'type_literal', params: { text: 'synthetic' } })), opened.from);
  const event = { event: 'terminal.resync_required', sequence: 1, data: { reason: 'subscriber_overflow' } };
  for (const [field, value] of [['provider_id', 'p2'], ['binding_revision', 2], ['contract_source_ref', 'other-source'],
    ['connection_epoch', 'old-epoch'], ['recovery_generation', 'old-recovery']] as const) {
    const source: any = clone(sourceFor(opened.candidate.binding)); source.binding[field] = value;
    rejects(validator.checkResponse(opened.permit, opened.response, source), 'native_identity_mismatch');
    rejects(validator.checkEvent(stream, event, source), 'native_identity_mismatch');
    rejects(checkDispatch(frame, { ...auth(frame), source }), 'capability_stale');
  }
  const untrusted = { ...sourceFor(opened.candidate.binding), source_verified: false };
  rejects(validator.checkResponse(opened.permit, opened.response, untrusted), 'native_source_untrusted');
});

test('聚焦复核：raw grant 不能替代分类、管理或 custody', () => {
  const candidate = request(view(), { id: 'review-token', method: 'uhp.token.create', params: { scopes: ['read'] } });
  const context = { ...raw(candidate), permissions: ['admin-test'] };
  const gate = unwrap(inspectRequestGate(candidate, context));
  assert.equal(gate.raw_contract_authorized, true); assert.equal(gate.secret_result_authorized, false);
  rejects(checkDispatch(candidate, context), 'secret_boundary_required');
  rejects(checkDispatch(candidate, { ...context, classifications: [] }), 'safety_classification_missing');
  rejects(checkDispatch(candidate, { ...context, classification_source_verified: false }), 'safety_classification_untrusted');
  rejects(checkDispatch(candidate, { ...context, custody_available: true, result_channel: 'custody', permissions: [] }), 'management_forbidden');
});

test('聚焦复核：累计字节预算在遍历中拒绝，Unicode/转义/标点计量准确', () => {
  const oversized = { id: 'review-bytes', method: 'ping', params: {
    batch: Array(100).fill('x'.repeat(16384)), tail: undefined,
  } };
  rejects(validator.checkRequest(view(), oversized), 'object_limit');
  for (const value of [null, false, true, 123.5, '测😀\n"\\\u0000\b\t\f\r\u2028',
    { '测\n': [null, true, 1.5, '😀'], nested: { empty: {} } }]) {
    const exact = Buffer.byteLength(JSON.stringify(value));
    assert.deepEqual(snapshot(value, { ...DEFAULT_LIMITS, object_bytes: exact }), value);
    assert.throws(() => snapshot(value, { ...DEFAULT_LIMITS, object_bytes: exact - 1 }),
      (error: any) => error.failure?.code === 'object_limit');
  }
});

test('聚焦复核：schema 引用和结构资源预算实际拒绝，无 CPU 隔离虚假声明', () => {
  for (const limits of [{ bundle_nodes: 32 }, { documents: 28 }, { document_bytes: 32 },
    { references: 1 }, { reference_depth: 1 }]) rejects(compileBundle(bytes, { identity, limits }), 'schema_unavailable');
  const b = json('schema-bundle.json'); b.extra_nodes = Array(150001).fill(null);
  const encoded = JSON.stringify(b);
  const checked = compileBundle(encoded, { identity: { ...identity, schema_sha256: createHash('sha256').update(encoded).digest('hex') } });
  rejects(checked, 'schema_unavailable'); if (!checked.ok) assert.equal(checked.error.reason, 'bundle_limit');
  rejects(parseNativeJson(JSON.stringify({ nodes: Array(32).fill(null) }), { object_nodes: 16 }), 'object_limit');
  rejects(parseNativeJson('['.repeat(65) + '0' + ']'.repeat(65)), 'object_limit');
  // 恶意引用/循环/超深链由原矩阵实际编译反例覆盖；不执行可能卡死的正则来冒充 worker 隔离验收。
});

test('聚焦复核：native 字段按完整结构保真，非法字段拒绝而不剥除', () => {
  const payload = JSON.parse('{"__proto__":{"preserve":true},"nested":[null,false,1.25,"测😀"],"unknown_extension":{"keep":true}}');
  const input = { id: 'review-native:1', method: 'ping', params: payload, auth: 'synthetic-only' };
  const candidate = request(view(), input);
  assert.deepEqual(candidate.request, input);
  const response = { id: input.id, error: { code: 'synthetic_extension', message: 'synthetic', data: payload, extra: { keep: true } } };
  assert.deepEqual(unwrap(validator.checkResponse(candidate, response, sourceFor(candidate.binding))).response, response);
  const invalid = { ...response, forbidden_root_extension: true };
  rejects(validator.checkResponseShape(invalid), 'native_response_invalid');
  assert.equal(invalid.forbidden_root_extension, true);
  const typed = { id: 'typed', method: 'agent.prompt', params: { target: '3', text: 'synthetic', unknown_field: true } };
  rejects(validator.checkRequest(view(), typed), 'native_request_invalid');
  assert.equal(typed.params.unknown_field, true);
  const noDefaults = request(view(), { id: 'defaults', method: 'terminal.backend.control', params: { server_generation: G, terminal_id: T, pane_id: '3' } });
  const params = noDefaults.request.params;
  assert(params !== null && typeof params === 'object');
  assert.equal(Object.hasOwn(params, 'ansi'), false);
});
