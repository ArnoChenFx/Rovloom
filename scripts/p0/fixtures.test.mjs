import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspectFixtures, coverage, offlineSchemas, readJson } from './audit-fixtures.mjs';
import { probeSdk } from './sdk-compatibility.mjs';

test('原生 fixture hash、闭包 schema、请求响应关联及清理可重放验证', () => {
  const counts = inspectFixtures();
  assert.equal(counts.documents, 29);
  assert(counts.requests > 20 && counts.responses > 20 && counts.events > 10);
  assert.equal(counts.intentional_invalid, 2);
});

test('安装 schema 保留根约束和条件；缺失引用不能联网补齐', () => {
  const bundle = readJson('schema-bundle.json');
  const ajv = offlineSchemas(bundle);
  const request = ajv.getSchema(bundle.request.$id);
  assert.equal(request({ id: 'invalid', method: 'uhp.capabilities', params: { unannounced: true } }), false);
  assert.equal(request({ id: 'invalid', method: 'ping', params: {}, unannounced: true }), false);
  const response = ajv.getSchema(bundle.response.$id);
  assert.equal(response({ result: {} }), false);
  assert.equal(response({ id: 'invalid', result: {}, error: { code: 'internal', message: 'synthetic' } }), false);
  assert.throws(() => ajv.compile({ $ref: 'https://untrusted.invalid/must-not-fetch.json' }), /resolve reference/);
  const missing = structuredClone(bundle);
  delete missing.documents['https://luvus.dev/protocol/uhp/v1/schema/terminal/common.schema.json'];
  assert.throws(() => offlineSchemas(missing), /resolve reference/);
});

test('覆盖账本保持全部方法与 profile；未实现、权限、schema 缺口分开', () => {
  const generated = coverage();
  assert.deepEqual(generated, JSON.parse(readFileSync(new URL('../../docs/p0/coverage.json', import.meta.url))));
  assert.deepEqual(generated.counts, { union: 223, session: 197, host: 17, schema: 223, access_machines: 9, stream: 4 });
  assert(generated.methods.every(row => row.gateway_status === 'not_implemented' && row.gateway_permission === 'not_enabled'));
  assert(generated.methods.filter(row => row.method.startsWith('machine.')).every(row => row.reason === 'profile_not_exposed'));
  assert.equal(generated.methods.find(row => row.method === 'pane.run').reason, 'parameter_schema_incomplete');
  assert.equal(generated.methods.find(row => row.method === 'host.update.install').reason, 'admin_disabled_pending_explicit_authorization');
});

test('真实终端拒绝、队列 ack、消费证据、事件 replay 和取消边界不变', () => {
  const transcript = readJson('transcript.json');
  const received = channel => transcript.filter(r => r.kind === 'receive' && r.channel === channel).map(r => JSON.parse(r.wire));
  for (const [channel, code] of [['control-stale-generation', 'stale_server'], ['control-wrong-terminal', 'stale_terminal'], ['control-lease-conflict', 'control_conflict']]) {
    assert.equal(received(channel)[0].error.code, code);
  }
  assert.equal(received('terminal-control').find(r => r.id === 'input-1').result.dispatch, 'queued');
  assert(received('terminal-observe').some(r => r.data?.text?.includes('CONSUMED:321cba-tupni-0p')));
  const snapshot = received('snapshot-after-create')[0].result;
  const closed = received('events-primary').find(r => r.event === 'terminal.closed');
  assert(closed.sequence > snapshot.event_sequence);
  assert.deepEqual(received('events-replay').find(r => r.event === 'terminal.closed'), closed);
  const deadline = transcript.find(r => r.label === 'client-deadline');
  assert.equal(deadline.timed_out, true);
  assert.equal(deadline.stdout, '');
  assert.equal(received('validate-after-deadline')[0].result.state, 'alive');
  assert.equal(received('validate-after-terminal-close')[0].result.state, 'gone');
});

test('所锁 SDK 客户端与独立 stdio 子进程协商已核实的 2025-11-25', { timeout: 10000 }, async () => {
  const report = await probeSdk();
  assert.equal(report.negotiated, '2025-11-25');
  assert.equal(report.dependencies['@modelcontextprotocol/sdk'].version, '1.32.1');
  assert.equal(report.sdk_supported_constants.includes('2026-07-28'), false);
});
