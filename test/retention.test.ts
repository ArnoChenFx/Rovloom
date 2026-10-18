import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { Router } from '../src/router.js';
import type { Target, Policy } from '../src/contracts.js';

function fixture(s: Store) {
  const m = s.register('retention');
  const d = s.redeem(s.issueEnrollment(m.machine_id));
  const epoch = s.connect(m.machine_id, d.credential);
  const target: Target = { machine_id: m.machine_id, profile: 'session', session: 'test' };
  const respond = (key?: string) => {
    const c = s.createCall('p', target, { method: 'pane.read' }, key);
    const attempt = s.dispatch('p', c.call_id, epoch);
    s.receive(m.machine_id, c.call_id, attempt, epoch, { result: 'abc' });
    return c.call_id;
  };
  return { respond, target };
}

test('deduplicated handles retain expiry; aggregate quota reclaims expired payloads; cursor boundaries', () => {
  let now = 0;
  const s = new Store(':memory:', () => now);
  try {
    const f = fixture(s);
    const first = f.respond(), second = f.respond();
    const a = s.saveResult('p', first, 10);
    now = 1;
    assert.deepEqual({ ...s.saveResult('p', first, 100) }, { ...a });
    assert.throws(() => s.saveResult('p', second, 10, a.bytes), /result_quota/);
    const eof = s.readResult('p', a.result_id, a.bytes, 1);
    assert.equal(eof.eof, true);
    assert.equal(eof.data, '');
    for (const cursor of [a.bytes + 1, -1, 0.5, NaN, Infinity]) {
      assert.throws(() => s.readResult('p', a.result_id, cursor), /invalid_result_cursor/);
    }
    for (const limit of [0, -1, 65_537, 0.5, NaN]) {
      assert.throws(() => s.readResult('p', a.result_id, 0, limit), /invalid_result_cursor/);
    }
    now = 10;
    const b = s.saveResult('p', second, 10, a.bytes);
    assert.equal(b.bytes, a.bytes);
    assert.throws(() => s.readResult('p', a.result_id), /result_not_found/);
    // 句柄过期不等于删除响应：底层调用仍保留原始响应。
    assert.equal(s.call('p', first).response, '{"result":"abc"}');
  } finally { s.close(); }
});

test('discard is reauthorized, removes inline response and handles, preserves deduplication tombstone', () => {
  const s = new Store(':memory:');
  try {
    const f = fixture(s);
    const call = f.respond('retained-key');
    const meta = s.saveResult('p', call);
    let policy: Policy = { machines: [f.target.machine_id], sessions: ['test'], methods: ['pane.read'], host: false };
    const principal = { id: 'p', policy };
    const r = new Router(s, () => policy);
    assert.throws(() => r.discardResponse({ ...principal, id: 'other' }, call), /call_not_found/);
    policy = { ...policy, methods: [] };
    assert.throws(() => r.discardResponse(principal, call), /forbidden/);
    policy = principal.policy;
    r.discardResponse(principal, call);
    assert.equal(s.call('p', call).response, null);
    assert.equal(s.call('p', call).state, 'responded');
    assert.equal(s.createCall('p', f.target, { method: 'pane.read' }, 'retained-key').call_id, call);
    assert.throws(() => r.readResult(principal, meta.result_id), /result_not_found/);
    assert.throws(() => r.saveResult(principal, call), /result_not_ready/);
    assert.throws(() => s.dispatch('p', call, 'old'), /dispatch_rejected/);
    r.discardResponse(principal, call);
  } finally { s.close(); }
});

test('populated v2 migration preserves context and results survive reopen until expiry', () => {
  let now = 0;
  const dir = mkdtempSync(join(tmpdir(), 'luvus-v2-'));
  const path = join(dir, 'db');
  try {
    const initial = new Store(path, () => now);
    const f = fixture(initial);
    const call = f.respond();
    const context = initial.call('p', call).target_json;
    initial.close();
    // v2 已有相同的调用表结构和数据，但尚无结果表及其索引。
    const v2 = new DatabaseSync(path);
    v2.exec('DROP TABLE results; UPDATE metadata SET version=2');
    v2.close();
    const upgraded = new Store(path, () => now);
    assert.equal(upgraded.call('p', call).target_json, context);
    assert.equal(upgraded.call('p', call).state, 'responded');
    const meta = upgraded.saveResult('p', call, 10);
    upgraded.close();
    const reopened = new Store(path, () => now);
    try {
      assert.equal(reopened.readResult('p', meta.result_id).hash, meta.hash);
      assert.equal(reopened.machine(f.target.machine_id).status, 'offline');
      now = 10;
      reopened.expire();
      assert.throws(() => reopened.readResult('p', meta.result_id), /result_not_found/);
      reopened.discardResponse('p', call);
    } finally { reopened.close(); }
    const inspect = new DatabaseSync(path);
    assert.equal(inspect.prepare('SELECT version FROM metadata').get()!.version, 3);
    assert.equal(inspect.prepare('SELECT COUNT(*) AS n FROM results').get()!.n, 0);
    assert.equal(inspect.prepare('SELECT response FROM calls WHERE call_id=?').get(call)!.response, null);
    inspect.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
