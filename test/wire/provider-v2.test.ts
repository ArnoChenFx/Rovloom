import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeWireFrame, decodeWireFrame, contractRef, validateContractSource, assertProviderAccess,
  planResponseEvidence, decodeHistoricalV1, registeredRequestDigest } from '../../src/wire/index.js';
import type { AttemptBinding, ContractSource, AuthenticatedContext } from '../../src/wire/types.js';
import { source, provider, binding, attempt, request, response, context, frame, fixtureValidator, nativeHandle, rejects } from './helpers.js';

const decode = (value: unknown, ctx = context()) => decodeWireFrame(JSON.stringify(value), ctx);
function replaceProvider(ctx: AuthenticatedContext, revision = 1, enabled = true) {
  ctx.resolveProvider = () => ({ ...provider, binding_revision: revision, enabled }); return ctx;
}
const responseAnchor = { binding, method: 'ping', mode: 'strict' as const, state: 'outcome_unknown' as const,
  content_status: 'available' as const, content_expires_at: 500, dedup_expires_at: 2000 };

test('V2Target 必须显式 provider，expected revision 只在调用外层；旧字段与未知枚举拒绝', () => {
  const target = { ...attempt.target } as any; delete target.provider_id;
  rejects(() => decode({ ...request, payload: { ...request.payload, attempt: { ...attempt, target } } }), 'invalid_frame_fields');
  rejects(() => decode({ ...request, payload: { ...request.payload, attempt: { ...attempt,
    target: { ...attempt.target, kind: 'luvus' } } } }), 'invalid_frame_fields');
  rejects(() => decode({ ...request, payload: { ...request.payload, attempt: { ...attempt,
    target: { ...attempt.target, expected_binding_revision: 1 } } } }), 'invalid_frame_fields');
  rejects(() => decode({ ...request, payload: { ...request.payload, expected_binding_revision: 0 } }), 'invalid_integer');
  rejects(() => decode({ ...request, payload: { ...request.payload, expected_binding_revision: 2 } }), 'provider_binding_mismatch');
  for (const field of ['uhp_request', 'deadline', 'history'])
    rejects(() => decode({ ...request, payload: { ...request.payload, [field]: {} } }), 'invalid_frame_fields');
  rejects(() => decode({ ...request, payload: { ...request.payload, attempt: { ...attempt, provider_kind: 'other' } } }), 'invalid_enum');
  const hostAttempt = { ...attempt, target: { machine_id: provider.machine_id, provider_id: provider.provider_id, profile: 'host' as const } };
  const host = frame('request', { ...request.payload, attempt: hostAttempt });
  const hostContext = context('gateway_to_connector', fixtureValidator(), { ...binding, ...hostAttempt });
  assert.deepEqual(decode(host, hostContext), host);
});

test('trusted provider kind/revision/config 枚举严格检查，消息不能选择另一 validator', () => {
  const missing = context(); delete missing.resolveProvider;
  rejects(() => decode(request, missing), 'provider_binding_unavailable');
  for (const delta of [{ provider_id: 'other' }, { machine_id: 'other' }, { binding_revision: 2 }, { kind: 'herdr' as const }]) {
    const ctx = context(); ctx.resolveProvider = () => ({ ...provider, ...delta });
    rejects(() => decode(request, ctx), 'provider_binding_mismatch');
  }
  for (const revision of [0, -1, Number.MAX_SAFE_INTEGER + 1])
    rejects(() => decode(request, replaceProvider(context(), revision)), 'invalid_integer');
  const extra = context(); extra.resolveProvider = () => ({ ...provider, endpoint: 'untrusted' } as any);
  rejects(() => decode(request, extra), 'invalid_frame_fields');
  let called = false; const selection = context(); selection.validators!.herdr = { ...fixtureValidator(), requestGate() { called = true; throw Error('不得调用'); } };
  assert.deepEqual(decode(request, selection), request); assert.equal(called, false);
});

test('禁用只封锁指定 provider 的派发/输入/读取/迟到，新 revision 不接纳旧 attempt', () => {
  const disabled = replaceProvider(context(), 2, false);
  rejects(() => decode(request, disabled), 'provider_disabled');
  rejects(() => assertProviderAccess(binding, 'ping', 'read', disabled), 'provider_disabled');
  rejects(() => planResponseEvidence(response, replaceProvider(context('connector_to_gateway'), 2, false), responseAnchor, 400), 'provider_disabled');
  rejects(() => decode(response, replaceProvider(context('connector_to_gateway'), 3, true)), 'provider_binding_mismatch');
  // 设备连接/心跳仍有效；另一个 provider 具有独立 ID、revision 与授权。
  assert.doesNotThrow(() => encodeWireFrame(frame('heartbeat', { sequence: 0 }), disabled));
  const otherBinding: AttemptBinding = { ...binding, target: { ...binding.target, provider_id: 'provider_2' } };
  const otherAttempt = { ...attempt, target: otherBinding.target };
  const otherContext = context('gateway_to_connector', fixtureValidator(), otherBinding);
  otherContext.resolveProvider = target => ({ ...provider, provider_id: target.provider_id,
    enabled: target.provider_id === 'provider_2' });
  assert.doesNotThrow(() => decode(frame('request', { ...request.payload, attempt: otherAttempt }), otherContext));
  assert.doesNotThrow(() => assertProviderAccess(otherBinding, 'ping', 'read', otherContext));
});

test('权限按完整 Target 行在 caller/local 求交，禁止跨 provider/session/方法的笛卡尔授权', () => {
  const ctx = context();
  ctx.policies!.caller.grants = [
    { target: { ...attempt.target, provider_id: 'provider_2' }, methods: ['ping'], actions: ['dispatch'] },
    { target: { machine_id: provider.machine_id, provider_id: provider.provider_id, profile: 'session', session: 'other' }, methods: ['ping'], actions: ['dispatch'] },
    { target: attempt.target, methods: ['pane.read'], actions: ['dispatch'] },
  ];
  rejects(() => decode(request, ctx), 'provider_scope_forbidden');
  const disjoint = context(); disjoint.policies!.local.grants[0]!.target = { ...attempt.target, provider_id: 'provider_2' };
  rejects(() => decode(request, disjoint), 'provider_scope_forbidden');
  const missing = context(); delete missing.policies;
  rejects(() => decode(request, missing), 'provider_scope_forbidden');
  const flat = context(); (flat.policies!.caller as any).machines = ['machine_1'];
  rejects(() => decode(request, flat), 'invalid_frame_fields');
  const stale = context(); stale.policies!.caller.revision = 'new_policy';
  rejects(() => decode(request, stale), 'policy_revision_stale');
  const noRead = context('connector_to_gateway'); noRead.policies!.caller.grants[0]!.actions = ['dispatch'];
  const plan = planResponseEvidence(response, noRead, responseAnchor, 400,
    { classification_status: 'trusted_complete', retain_content_authorized: true });
  assert.equal(plan.content.delivery, 'metadata_only'); assert.equal(plan.content.native_response, undefined);
});

test('ContractSource 摘要不可变，来源缺失/互相矛盾或分类 revision 缺失都不能执行', () => {
  assert.equal(contractRef(source), attempt.contract_ref);
  for (const delta of [{ schema_sha256: 'b'.repeat(64) }, { adapter_revision: 'other' }, { runtime_generation: 'actual_other_generation' }])
    assert.notEqual(contractRef({ ...source, ...delta }), attempt.contract_ref);
  for (const field of ['binary_sha256', 'schema_command', 'schema_origin', 'binary_version']) {
    const broken = { ...source } as any; delete broken[field];
    rejects(() => validateContractSource(broken), 'invalid_frame_fields');
  }
  rejects(() => validateContractSource({ ...source, protocol_family: 'herdr-json' }), 'contract_provider_mismatch');
  rejects(() => validateContractSource({ ...source, schema_origin: 'website' }), 'invalid_enum');
  const changed = context(); changed.resolveContract = () => ({ source: { ...source, adapter_revision: 'other' }, support_status: 'validated' });
  rejects(() => decode(request, changed), 'contract_binding_mismatch');
  for (const delta of [{ classification_revision: null }, { support_basis: 'schema_and_version' as const }]) {
    const recordSource = { ...source, ...delta }, ref = contractRef(recordSource), a = { ...attempt, contract_ref: ref };
    const ctx = context('gateway_to_connector', fixtureValidator(), { ...binding, ...a });
    ctx.resolveContract = () => ({ source: recordSource, support_status: 'validated' });
    rejects(() => decode(frame('request', { ...request.payload, attempt: a }), ctx), 'contract_unavailable');
  }
  // 缺 generation 用 null 表达，不能合成一个看似原生的值。
  assert.equal(source.runtime_generation, null); assert.doesNotThrow(() => validateContractSource(source));
});

test('Herdr 可用 v2 类型准确表示，但无 P0 始终 candidate；Host 先报 unsupported_profile', () => {
  const herdrSource: ContractSource = { ...source, provider_kind: 'herdr', protocol_family: 'herdr-json',
    binary_version: 'synthetic_unverified', binary_sha256: 'b'.repeat(64), schema_sha256: 'c'.repeat(64),
    adapter_revision: 'synthetic_herdr_candidate', classification_revision: null,
    schema_command: 'herdr api schema --json', support_basis: 'schema_and_version', runtime_generation: null,
    server_version: null, native_protocol_version: null };
  const ref = contractRef(herdrSource);
  for (const profile of ['session', 'host'] as const) {
    const target = profile === 'host' ? { machine_id: provider.machine_id, provider_id: provider.provider_id, profile } :
      { ...attempt.target, profile, session: 'synthetic' };
    const a = { ...attempt, target, provider_kind: 'herdr' as const, contract_ref: ref };
    const ctx = context('gateway_to_connector', fixtureValidator(), { ...binding, ...a });
    ctx.resolveProvider = () => ({ ...provider, kind: 'herdr' });
    ctx.resolveContract = () => ({ source: herdrSource, support_status: 'candidate' });
    const value = frame('request', { ...request.payload, attempt: a });
    rejects(() => decode(value, ctx), profile === 'host' ? 'unsupported_profile' : 'provider_support_candidate');
    ctx.resolveContract = () => ({ source: herdrSource, support_status: 'validated' });
    rejects(() => decode(value, ctx), profile === 'host' ? 'unsupported_profile' : 'provider_support_candidate');
  }
});

test('响应必须沿用原 opaque handle 和当前独立 source，native 异常只返回 code', () => {
  const absent = context('connector_to_gateway');
  absent.resolveAttempt = () => ({ binding, mode: 'strict', method: 'ping', transport: 'rpc' });
  rejects(() => decode(response, absent), 'native_handle_unavailable');
  const noSource = context('connector_to_gateway'); delete noSource.resolveNativeSource;
  rejects(() => decode(response, noSource), 'native_source_unavailable');
  const wrong = context('connector_to_gateway'); wrong.resolveAttempt = () => ({ binding, mode: 'strict', method: 'ping', transport: 'rpc', native_handle: {} });
  rejects(() => decode(response, wrong), 'native_handle_mismatch');
  const leaking = fixtureValidator(); leaking.validateResponse = () => { throw Error('synthetic-private-payload'); };
  assert.throws(() => decode(response, context('connector_to_gateway', leaking)), (e: any) =>
    e.code === 'native_response_invalid' && !e.message.includes('synthetic-private-payload'));
  const responseWithHandle = { ...response, payload: { ...response.payload, native_handle: nativeHandle } };
  rejects(() => decode(responseWithHandle, context('connector_to_gateway')), 'invalid_frame_fields');
});

test('v1 只能显式只读历史解码，不分配 legacy provider、不协商降级、不进入 v2 执行', () => {
  const legacy = { ...response, protocol_major: 1, payload: { attempt: { call_id: 'old_call', attempt_id: 'old_attempt',
    native_request_id: 'old_native', target: { machine_id: provider.machine_id, profile: 'session', session: 'old_session' },
    contract_revision: 'old_revision', contract_digest: 'a'.repeat(64) }, uhp_response: { id: 'old_native', result: {} } } };
  const history = decodeHistoricalV1(JSON.stringify(legacy));
  assert.equal(history.read_only, true); assert.equal(history.provider_resolution, 'unresolved');
  assert.deepEqual(history.frame, legacy); assert.equal('provider_id' in (history.frame.payload as any).attempt.target, false);
  rejects(() => decode(legacy, context('connector_to_gateway')), 'protocol_major_unsupported');
  rejects(() => decodeHistoricalV1(JSON.stringify(response)), 'historical_version_unsupported');
  rejects(() => decodeHistoricalV1(JSON.stringify({ ...legacy, provider_id: 'default' })), 'invalid_frame_fields');
});

test('登记摘要绑定 caller/完整 provider target/revision/契约及登记条件，不混入新分配的执行 ID', () => {
  const initial = registeredRequestDigest(request.payload, 'caller_1');
  assert.equal(initial, registeredRequestDigest({ ...request.payload, attempt: { ...attempt,
    call_id: 'other_call', attempt_id: 'other_attempt', native_request_id: 'other_native' } }, 'caller_1'));
  assert.notEqual(initial, registeredRequestDigest(request.payload, 'caller_2'));
  for (const payload of [
    { ...request.payload, attempt: { ...attempt, target: { ...attempt.target, provider_id: 'provider_2' } } },
    { ...request.payload, attempt: { ...attempt, binding_revision: 2 }, expected_binding_revision: 2 },
    { ...request.payload, attempt: { ...attempt, contract_ref: 'b'.repeat(64) } },
    { ...request.payload, attempt: { ...attempt, registration: { ...attempt.registration, deadline: 2000 } } },
    { ...request.payload, native_request: { method: 'ping', params: { changed: true } } },
  ]) assert.notEqual(initial, registeredRequestDigest(payload, 'caller_1'));
  rejects(() => registeredRequestDigest({ ...request.payload, native_request: { ...request.payload.native_request,
    id: 'caller_supplied' } }, 'caller_1'), 'reserved_request_field');
});

test('完整 v2 JSON 示例逐帧验证，包含 request/accepted/response/cancel 及全部 stream 帧', () => {
  const examples = JSON.parse(readFileSync(new URL('./v2-examples.json', import.meta.url), 'utf8'));
  const streamBinding: AttemptBinding = { ...binding, call_id: 'stream_call_1', attempt_id: 'stream_attempt_1',
    native_request_id: 'terminal-control' };
  for (const type of ['request', 'accepted', 'response', 'cancel', 'stream_open', 'stream_data', 'stream_input', 'stream_close']) {
    const isStream = type.startsWith('stream_');
    const direction = ['accepted', 'response', 'stream_data'].includes(type) ? 'connector_to_gateway' : 'gateway_to_connector';
    const ctx = isStream ? context(direction, fixtureValidator(), streamBinding, 'terminal.backend.control', 'stream', 'terminal_control') : context(direction);
    assert.deepEqual(decodeWireFrame(JSON.stringify(examples[type]), ctx), examples[type]);
  }
  assert.equal(contractRef(examples.contract_source), attempt.contract_ref);
  assert.equal('id' in examples.request.payload.native_request, false);
  assert.equal('expected_binding_revision' in examples.request.payload.attempt.target, false);
});
