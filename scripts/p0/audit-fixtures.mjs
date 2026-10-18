import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';

export const fixtureRoot = fileURLToPath(new URL('../../fixtures/p0/linux-luvus-0.14.3/', import.meta.url));
export const readJson = (name, root = fixtureRoot) => JSON.parse(readFileSync(resolve(root, name), 'utf8'));
export const sha256 = value => createHash('sha256').update(value).digest('hex');

export function offlineSchemas(bundle) {
  // strict:false 仅关闭上游 schema 的风格警告；不改写 schema、不补默认值、不转换数据。
  // 不提供 loadSchema，编译只使用安装包的固定 documents 映射，缺失引用直接失败。
  const ajv = new Ajv2020({ strict: false, allErrors: true, coerceTypes: false,
    useDefaults: false, removeAdditional: false });
  for (const [url, schema] of Object.entries(bundle.documents)) ajv.addSchema(schema, url);
  for (const url of Object.keys(bundle.documents)) assert(ajv.getSchema(url));
  return ajv;
}

export function inspectFixtures(root = fixtureRoot) {
  const manifest = readJson('manifest.json', root);
  for (const [name, info] of Object.entries(manifest.files)) {
    assert.equal(name, name.split('/').at(-1));
    const bytes = readFileSync(resolve(root, name));
    assert.equal(sha256(bytes), info.sha256, name);
    assert.equal(bytes.length, info.bytes, name);
  }
  const bundle = readJson('schema-bundle.json', root);
  const transcript = readJson('transcript.json', root);
  const environment = readJson('environment.json', root);
  assert.equal(environment.native_collection_completed, true);
  assert(readJson('assertions.json', root).every(row => row.passed));
  const ajv = offlineSchemas(bundle);
  const requests = new Map();
  const totals = { requests: 0, responses: 0, events: 0, intentional_invalid: 0, documents: Object.keys(bundle.documents).length };
  const invalid = new Set(['proxy-unknown-method', 'input-invalid']);
  const validate = (schema, value, label) => {
    const check = ajv.getSchema(schema.$id);
    assert(check(value), `${label}: ${JSON.stringify(check.errors)}`);
  };
  function request(value) {
    if (invalid.has(value.id)) {
      const check = ajv.getSchema(value.action ? bundle.terminal.control_frame.$id : bundle.request.$id);
      assert.equal(check(value), false, value.id);
      totals.intentional_invalid++;
    } else {
      validate(value.action ? bundle.terminal.control_frame : bundle.request, value, value.id);
      totals.requests++;
    }
    requests.set(value.id, value);
  }
  function response(value) {
    if (value.event) {
      validate(bundle.event, value, value.event);
      if (value.event.startsWith('terminal.')) validate(bundle.terminal.event, value, value.event);
      if (Object.hasOwn(bundle.event_catalog.properties, value.event)) {
        const check = ajv.compile({ $ref: `${bundle.event_catalog.$id}#/properties/${value.event}` });
        assert(check(value.data), `${value.event}: ${JSON.stringify(check.errors)}`);
      } else assert.equal(value.event, 'terminal.frame', '未知事件不得冒充已验证');
      totals.events++;
    } else {
      validate(bundle.response, value, value.id);
      const sent = requests.get(value.id);
      assert(sent, 'response must correlate to a captured request');
      if (sent.method?.startsWith('terminal.backend.') || sent.action) validate(bundle.terminal.response, value, value.id);
      totals.responses++;
    }
  }
  for (const record of transcript) {
    if (record.kind === 'send') request(JSON.parse(record.wire));
    if (record.kind === 'receive') response(JSON.parse(record.wire));
    if (record.kind !== 'process' || record.argv.slice(-2).join(' ') !== 'uhp proxy') continue;
    if (record.label !== 'proxy-malformed-json') request(JSON.parse(record.stdin.split('\n')[0]));
    if (record.stdout) response(JSON.parse(record.stdout));
  }
  const schemaRun = transcript.find(row => row.label === 'installed-schema');
  assert.equal(sha256(readFileSync(resolve(root, 'schema-bundle.json'))), schemaRun.raw_stdout_sha256);
  // 只检查交付的合成记录，不扫描用户目录；禁止向采集器传入原生认证字段。
  for (const request of requests.values()) assert.equal(Object.hasOwn(request, 'auth'), false);
  assert.equal(transcript.filter(row => row.kind === 'server_exit').at(-1).exit_code, 0);
  return totals;
}

export function coverage(root = fixtureRoot) {
  const bundle = readJson('schema-bundle.json', root);
  const session = readJson('session-capabilities.json', root).result;
  const host = readJson('host-capabilities.json', root).result;
  const transcript = readJson('transcript.json', root);
  const nativeCalls = new Map();
  const nativeResponses = new Map();
  for (const row of transcript) {
    if (row.kind === 'receive') {
      const value = JSON.parse(row.wire);
      if (value.id) nativeResponses.set(value.id, value);
    }
    let request;
    if (row.kind === 'send') request = JSON.parse(row.wire);
    if (row.kind === 'process' && row.argv.slice(-2).join(' ') === 'uhp proxy' && row.label !== 'proxy-malformed-json') {
      request = JSON.parse(row.stdin.split('\n')[0]);
      if (row.stdout) nativeResponses.set(request.id, JSON.parse(row.stdout));
    }
    if (request?.method) nativeCalls.set(request.id, request.method);
  }
  const schemaMethods = bundle.request.properties.method.enum;
  const liveMethods = [...session.methods, ...host.methods];
  const methods = [...new Set([...schemaMethods, ...liveMethods])].sort();
  const streamMethods = new Set(['events.subscribe', 'terminal.backend.events.subscribe', 'terminal.backend.observe', 'terminal.backend.control']);
  const rows = methods.map(method => {
    const inSession = session.methods.includes(method), inHost = host.methods.includes(method);
    const profile = inSession ? 'session' : inHost ? 'host' : method.startsWith('machine.') ? 'access_machines' : 'unknown';
    const contract = (inSession ? session : host).method_contracts.find(row => row.method === method);
    const branches = (bundle.request.allOf ?? []).flatMap((branch, index) => {
      const condition = branch.if?.properties?.method;
      return condition?.const === method || condition?.enum?.includes(method) ? [`#/allOf/${index}`] : [];
    });
    const evidence = [...nativeCalls.entries()].filter(([, m]) => method === m).map(([id]) => ({
      id, outcome: nativeResponses.get(id)?.error ? 'native_error' : nativeResponses.has(id) ? 'native_result' : 'no_response',
    }));
    let reason = 'adapter_not_implemented';
    if (profile === 'access_machines') reason = 'profile_not_exposed';
    else if (profile === 'unknown') reason = 'unknown_profile_fail_closed';
    else if (!schemaMethods.includes(method)) reason = 'schema_unavailable';
    else if (!contract) reason = 'permission_unclassified_fail_closed';
    else if (method.startsWith('uhp.token.')) reason = 'credential_custody_not_implemented';
    else if (contract.scope === 'admin') reason = 'admin_disabled_pending_explicit_authorization';
    else if (!branches.length) reason = 'parameter_schema_incomplete';
    return {
      method, profile, transport: profile === 'host' ? 'host_stdio_proxy' : streamMethods.has(method) ? 'persistent_local_stream' : profile === 'session' ? 'single_request_rpc' : 'not_exposed',
      schema: schemaMethods.includes(method) ? { document: bundle.request.$id, branches, parameter_detail: branches.length ? 'conditional_branch' : 'generic_params_only' } : null,
      native_contract: contract ?? null, gateway_permission: 'not_enabled', gateway_status: 'not_implemented', reason, native_evidence: evidence,
    };
  });
  return { format: 1, binary: '0.14.3', protocol: bundle.protocol,
    counts: { union: methods.length, session: session.methods.length, host: host.methods.length,
      schema: schemaMethods.length, access_machines: rows.filter(r => r.profile === 'access_machines').length,
      stream: rows.filter(r => r.transport === 'persistent_local_stream').length }, methods: rows };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const totals = inspectFixtures();
  const ledger = coverage();
  if (process.argv.includes('--write')) writeFileSync(new URL('../../docs/p0/coverage.json', import.meta.url), JSON.stringify(ledger, null, 2) + '\n');
  else assert.deepEqual(JSON.parse(readFileSync(new URL('../../docs/p0/coverage.json', import.meta.url))), ledger);
  console.log(JSON.stringify({ native_fixture_validation: totals, coverage: ledger.counts }, null, 2));
}
