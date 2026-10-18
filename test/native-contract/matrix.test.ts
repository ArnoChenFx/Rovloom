import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { checkDispatch, compileBundle, parseNativeJson } from '../../src/native-contract/index.js';
import { auth, clone, G, identity, json, raw, register, request, source, sourceFor, T, unwrap, validator, view } from './helpers.js';

// 将接口无关场景转为真实内存工厂；不把 JSON 中的可信标志直接当作生产认证。
const matrix: any = JSON.parse(readFileSync(new URL('../../fixtures/issue4/native-validator/matrix.json', import.meta.url), 'utf8'));
const seeds = new Map<string, any>();
function pointer(value: any, path: string): any {
  for (const piece of path.split('/').slice(1)) value = value[piece.replace(/~1/g, '/').replace(/~0/g, '~')];
  return value;
}
for (const [name, spec] of Object.entries(matrix.seeds) as [string, any][]) {
  let value: any;
  if ('value' in spec) value = spec.value;
  else {
    assert(spec.artifact.startsWith('fixtures/p0/linux-luvus-0.14.3/'));
    value = json(spec.artifact.split('/').at(-1));
    if (spec.select) {
      const chosen = value.filter((row: any) => Object.entries(spec.select).every(([key, expected]) => row[key] === expected));
      assert.equal(chosen.length, 1); value = JSON.parse(chosen[0][spec.json_field]);
    }
    value = pointer(value, spec.pointer ?? '');
  }
  seeds.set(name, value);
}
function specimen(c: any): any {
  let value = clone(seeds.get(c.seed));
  for (const change of c.mutations ?? []) {
    if (change.path === '') { value = clone(change.value); continue; }
    const at = change.path.lastIndexOf('/');
    const parent = pointer(value, change.path.slice(0, at));
    const key = change.path.slice(at + 1).replace(/~1/g, '/').replace(/~0/g, '~');
    if (change.op === 'remove') { if (Array.isArray(parent)) parent.splice(Number(key), 1); else delete parent[key]; }
    else parent[key] = clone(change.value);
  }
  return value;
}
function assertCase(c: any, result: any): void {
  assert.equal(result.ok, c.expected.verdict === 'accept', `${c.id}: ${JSON.stringify(result)}`);
  if (!result.ok) assert.equal(result.error.code, c.expected.code, c.id);
  else if (c.expected.validation) assert.equal(result.value.validation, c.expected.validation, c.id);
  else if (c.expected.coverage) assert.equal(result.value.schema_status,
    c.expected.coverage === 'generic_params_only' ? 'generic_params_only' : 'conditional_branch', c.id);
}
const session = view(), host = view('host');
function stream(mode: 'control' | 'observe' | 'general_events' = 'control'): any {
  const method = mode === 'general_events' ? 'events.subscribe' : `terminal.backend.${mode}`;
  const checked = request(session, { id: 'u.control', method, params: mode === 'general_events' ? {} : { server_generation: G, terminal_id: T, pane_id: '3' } });
  const permit = unwrap(checkDispatch(checked, auth(checked)));
  const result = mode === 'general_events' ? { type: 'subscription_started', sequence: 0 } : {
    type: 'terminal_backend_stream', mode, server_generation: G, terminal_id: T, pane_id: '3', sequence: 0, content_revision: 0,
    ansi: false, capture_mode: 'visible', lines: 1, frame_bytes: 65536, queue_capacity: 2, loss_behavior: 'resync_required_then_close' };
  return unwrap(validator.openStream(permit, unwrap(validator.checkResponse(permit, { id: 'u.control', result }, sourceFor(checked.binding)))));
}
const control = stream(), observe = stream('observe'), general = stream('general_events');
function syncAliases(b: any): void {
  const docs = b.documents;
  for (const key of ['request', 'response', 'event', 'event_catalog']) b[key] = docs[b[key].$id];
  for (const key of Object.keys(b.terminal.documents)) {
    if (docs[key]) b.terminal.documents[key] = docs[key]; else delete b.terminal.documents[key];
  }
  for (const key of ['request', 'response', 'event', 'control_frame']) b.terminal[key] = docs[b.terminal[key].$id];
  for (const key of Object.keys(b.terminal.methods)) b.terminal.methods[key] = docs[`https://luvus.dev/protocol/uhp/v1/schema/terminal/methods/${key.replace(/_/g, '-')}.schema.json`];
  b.access.descriptor = docs[b.access.descriptor.$id];
}
function bundleCase(c: any): any {
  const b: any = c.generator ? clone(seeds.get('bundle')) : specimen(c);
  if (c.generator === 'ref_chain_33') {
    const defs = b.documents['https://luvus.dev/protocol/uhp/v1/request.schema.json'].$defs;
    for (let i = 0; i < 34; i++) defs[`chain${i}`] = i === 33 ? { type: 'object' } : { $ref: `#/$defs/chain${i + 1}` };
  }
  if (c.id !== 'B-alias-mismatch') syncAliases(b);
  let serialized = JSON.stringify(b);
  if (c.generator === 'bundle_bytes_over_2mib') serialized += ' '.repeat(2_097_153);
  const expected = { ...identity, schema_sha256: c.id === 'B-hash-mismatch' ? '3'.repeat(64) : createHash('sha256').update(serialized).digest('hex') };
  const previousFetch = globalThis.fetch; let requests = 0;
  globalThis.fetch = (() => { requests++; throw Error('禁止网络 resolver'); }) as typeof fetch;
  try { const checked = compileBundle(serialized, { identity: expected }); assert.equal(requests, 0); return checked; }
  finally { globalThis.fetch = previousFetch; }
}
function capabilityCase(c: any): any {
  const value = specimen(c);
  if (c.id === 'C-stale') {
    const candidate = request(session, { id: 'stale', method: 'agent.prompt', params: { target: '3', text: 'synthetic' } });
    let result: any;
    for (const field of ['provider_id', 'binding_revision', 'contract_source_ref', 'connection_epoch', 'recovery_generation', 'capability_revision', 'caller_policy_revision', 'local_policy_revision', 'classification_revision']) {
      const authorization: any = clone(auth(candidate)); authorization.source.binding[field] = 'changed';
      result = checkDispatch(candidate, authorization); assertCase(c, result);
    }
    return result;
  }
  const profile = c.context?.target_profile ?? (value.result.profile === 'host' ? 'host' : 'session');
  const trusted: any = source(profile === 'host' ? 'host' : 'session', value.result.server_generation ?? G);
  if (profile === 'access_machines') trusted.binding.target.profile = profile;
  else if (profile === 'session' && value.result.session) trusted.binding.target.session = value.result.session;
  return validator.bindCapabilities(value, trusted);
}
function responseCase(c: any): any {
  const value = specimen(c);
  if (c.id === 'R-id-mismatch') {
    const checked = request(session, { id: 'u.other', method: 'ping', params: {} });
    return validator.checkResponse(checked, value, sourceFor(checked.binding));
  }
  if (['R-terminal-method', 'R-terminal-mode', 'R-terminal-identity'].includes(c.id)) {
    const method = c.context?.method ?? 'terminal.backend.control';
    const params: any = { server_generation: G, terminal_id: T, pane_id: '3' };
    if (method.endsWith('capture')) Object.assign(params, { mode: 'visible', lines: 1, ansi: false });
    const checked = request(session, { id: value.id, method, params });
    return validator.checkResponse(checked, value, sourceFor(checked.binding));
  }
  return validator.checkResponseShape(value, c.seed.startsWith('terminal_') ? 'terminal' : 'general');
}
function dispatchCase(c: any): any {
  const facts = specimen(c); const nativeRequest = clone(facts.request);
  const profile = facts.profile === 'host' ? 'host' : 'session';
  let from: any = profile === 'host' ? host : session;
  if (facts.schema_state === 'unavailable' || !from.methods.some((entry: any) => entry.method === nativeRequest.method)) {
    if (!nativeRequest.method.startsWith('future.')) nativeRequest.method = 'future.synthetic';
    const caps = json(profile === 'host' ? 'host-capabilities.json' : 'session-capabilities.json');
    if (profile === 'session') { caps.result.session = 'synthetic'; caps.result.server_generation = G; }
    caps.result.methods.push(nativeRequest.method);
    caps.result.method_contracts.push({ method: nativeRequest.method, scope: 'agent', access: 'write', idempotent: false });
    from = unwrap(validator.bindCapabilities(caps, source(profile)));
  }
  if (facts.machine_id !== 'm1') {
    const caps = json(profile === 'host' ? 'host-capabilities.json' : 'session-capabilities.json');
    if (profile === 'session') { caps.result.session = 'synthetic'; caps.result.server_generation = G; }
    const trusted = clone(source(profile)); trusted.binding.target.machine_id = facts.machine_id;
    from = unwrap(validator.bindCapabilities(caps, trusted));
  }
  if (!facts.advertised) {
    const caps = json('session-capabilities.json'); caps.result.session = 'synthetic'; caps.result.server_generation = G;
    caps.result.methods = caps.result.methods.filter((name: string) => name !== nativeRequest.method);
    caps.result.method_contracts = caps.result.method_contracts.filter((row: any) => row.method !== nativeRequest.method);
    from = unwrap(validator.bindCapabilities(caps, source()));
  }
  const checked = validator.checkRawRequest(from, nativeRequest);
  if (!checked.ok) return checked;
  const candidate = register(checked.value, from);
  const authorization: any = auth(candidate);
  authorization.owner = facts.owner;
  authorization.mode = facts.execution_mode; authorization.raw_requested = facts.raw_requested;
  authorization.confirmation_verified = facts.confirmation_present; authorization.custody_available = facts.custody_available;
  if (!facts.adapter_supported) authorization.supported_transports = [];
  if (!facts.caller_allowed) authorization.caller_policy.methods = [];
  if (!facts.local_allowed) authorization.local_policy.methods = [];
  const hint = facts.trusted_safety;
  if (!hint) authorization.classifications = [];
  else {
    const record: any = authorization.classifications[0];
    if (hint.state === 'unknown') record.effect = hint.effect;
    if (hint.state === 'invalid') delete record.result;
    if (hint.source === 'caller_input') authorization.classification_source_verified = false;
    if (hint.management_permission) record.management_permission = hint.management_permission;
    if (hint.result_boundary === 'protected_secret') Object.assign(record.result, { boundary: 'protected_secret', delivery: 'custody' });
  }
  if (facts.management_allowed) authorization.permissions = [authorization.classifications[0]?.management_permission ?? 'admin-test'];
  if (facts.raw_grant) {
    const spec = facts.raw_grant;
    const grant: any = clone(raw(candidate).raw_grant!);
    grant.principal_id = spec.principal_id; grant.expires_at = spec.expires_at;
    grant.methods = spec.methods; grant.binding.target.machine_id = spec.machine_id;
    for (const key of ['capability_revision', 'caller_policy_revision', 'local_policy_revision'] as const) {
      if (spec[key] !== facts[key]) grant.binding[key] = 'stale';
    }
    if (spec.contract_revision !== facts.contract_revision) grant.binding.contract.revision = 'stale';
    if (spec.contract_digest !== facts.contract_digest) grant.binding.contract.schema_sha256 = '3'.repeat(64);
    authorization.raw_grant = grant;
  }
  return checkDispatch(candidate, authorization);
}
function genericCases(c: any): void {
  for (const descriptor of session.methods.filter(entry => entry.schema_status === 'generic_params_only')) {
    const invoke = descriptor.method === 'module.action.invoke';
    const candidate = request(session, { id: 'generic-all', method: descriptor.method,
      params: { unannounced: ['synthetic'], ...(invoke ? { action: 'synthetic' } : {}) } });
    if (c.stage === 'request') { assertCase(c, { ok: true, value: candidate }); continue; }
    const authorization: any = c.context?.execution_mode === 'raw_contract' ? raw(candidate) : auth(candidate);
    authorization.permissions = ['admin-test']; authorization.custody_available = true; authorization.result_channel = 'custody';
    if (invoke) authorization.classifications[0].sub_action = { pointer: '/params/action', value: 'synthetic' };
    assertCase(c, checkDispatch(candidate, authorization));
  }
}
const implementedStages = new Set(['bundle', 'capabilities', 'request', 'response', 'event', 'control', 'dispatch', 'parse']);
export const implementedMatrixIds: string[] = matrix.cases.filter((c: any) => implementedStages.has(c.stage)).map((c: any) => c.id);
for (const c of matrix.cases.filter((c: any) => implementedStages.has(c.stage))) {
  test(`矩阵 ${c.id} ${c.expected.verdict}`, () => {
    if (c.generator === 'all_generic_methods') { genericCases(c); return; }
    let result: any;
    if (c.stage === 'bundle') result = bundleCase(c);
    else if (c.stage === 'capabilities') result = capabilityCase(c);
    else if (c.stage === 'request') result = validator.checkRequest(session, specimen(c));
    else if (c.stage === 'response') result = responseCase(c);
    else if (c.stage === 'dispatch') result = dispatchCase(c);
    else if (c.stage === 'parse') result = parseNativeJson(c.generator === 'depth_65' ? '['.repeat(65) + '0' + ']'.repeat(65) : Buffer.from(specimen(c).bytes_hex, 'hex'));
    else if (c.stage === 'control') result = validator.checkControl(c.context?.stream_mode === 'observe' ? observe : control, specimen(c));
    else {
      const input = c.generator === 'utf8_text_over_65536' ? clone(seeds.get('terminal_frame')) : specimen(c);
      if (c.generator) { input.data.text = '测'.repeat(21846); input.data.bytes = 65535; }
      const target = c.seed === 'general_event' || c.context?.stream_family === 'general_events' ? general : control;
      result = validator.checkEvent(target, input, sourceFor(target.binding));
    }
    assertCase(c, result);
  });
}
test('143 矩阵的纯模块与后续持久化/流状态验收分列，无静默 skip', () => {
  assert.equal(matrix.cases.length, 143); assert.equal(implementedMatrixIds.length, 119);
  const deferred = matrix.cases.filter((c: any) => !implementedStages.has(c.stage));
  assert.equal(deferred.length, 24);
  assert(deferred.every((c: any) => ['late', 'result', 'stream'].includes(c.stage)));
});
