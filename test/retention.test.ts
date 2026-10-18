import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { Router } from '../src/router.js';
import { connected, management, options, policy, respond } from './storage/helpers.js';

test('deduplicated handles retain expiry; aggregate quota reclaims expired payloads; cursor boundaries', () => {
  let now = 100;
  const s = new Store(':memory:', () => now, { management });
  try {
    const d = connected(s);
    const first = s.createCall('alice', d.target, { method: 'pane.read' }, options()),
      second = s.createCall('alice', d.target, { method: 'pane.read' }, options());
    respond(s, s.dispatch('alice', first.call_id, d.epoch), { result: { text: 'abc' } }, now);
    respond(s, s.dispatch('alice', second.call_id, d.epoch), { result: { text: 'abc' } }, now);
    const a = s.saveResult('alice', first.call_id, 10);
    now = 101;
    assert.deepEqual(s.saveResult('alice', first.call_id, 100), a);
    assert.throws(() => s.saveResult('alice', second.call_id, 10, a.bytes), /result_quota/);
    assert.equal(s.readResult('alice', a.result_id, a.bytes, 1).data, '');
    for (const cursor of [a.bytes + 1, -1, 0.5, NaN, Infinity])
      assert.throws(() => s.readResult('alice', a.result_id, cursor), /invalid_result_cursor/);
    for (const limit of [0, -1, 65_537, 0.5, NaN])
      assert.throws(() => s.readResult('alice', a.result_id, 0, limit), /invalid_result_cursor/);
    now = 110;
    const b = s.saveResult('alice', second.call_id, 10);
    assert(b.bytes > 0);
    assert.throws(() => s.readResult('alice', a.result_id), /result_not_found/);
    assert(s.call('alice', first.call_id).response);
  } finally {
    s.close();
  }
});
test('discard is reauthorized, removes inline response and handles, preserves deduplication tombstone', () => {
  const s = new Store(':memory:', () => 100, { management });
  try {
    const d = connected(s),
      scope = s.openHistory('alice', d.target, 1),
      o = options({
        history: { history_epoch: scope.history_epoch, client_request_key: 'retained-key' },
      });
    const c = s.createCall('alice', d.target, { method: 'pane.read' }, o);
    respond(s, s.dispatch('alice', c.call_id, d.epoch), { result: { text: 'abc' } }, 100);
    const meta = s.saveResult('alice', c.call_id);
    let local = policy(d.target, true);
    const p = { id: 'alice', policy: policy(d.target) },
      router = new Router(s, () => local);
    assert.throws(() => router.discardResponse({ ...p, id: 'other' }, c.call_id), /call_not_found/);
    local = { ...local, grants: [] };
    assert.throws(() => router.discardResponse(p, c.call_id), /forbidden/);
    local = policy(d.target, true);
    assert.throws(() => router.discardResponse(p, c.call_id), /discard_forbidden/);
    assert(s.call('alice', c.call_id).response);
    const manager = { ...p, permissions: { discard_response: true } };
    router.discardResponse(manager, c.call_id);
    assert.equal(s.call('alice', c.call_id).response, null);
    assert.equal(s.call('alice', c.call_id).state, 'responded');
    assert.equal(s.createCall('alice', d.target, { method: 'pane.read' }, o).call_id, c.call_id);
    assert.throws(() => router.readResult(p, meta.result_id), /result_not_found/);
    assert.throws(() => router.saveResult(p, c.call_id), /result_not_ready/);
    assert.throws(() => s.dispatch('alice', c.call_id, 'old'), /dispatch_rejected/);
    router.discardResponse(manager, c.call_id);
  } finally {
    s.close();
  }
});
test('canonical schema results survive reopen only until their original content deadline', () => {
  let now = 100;
  const dir = mkdtempSync(join(tmpdir(), 'rovloom-ttl-')),
    path = join(dir, 'db');
  let s = new Store(path, () => now, { management, retention: { content_ttl: 20 } });
  try {
    const d = connected(s),
      c = s.createCall('alice', d.target, { method: 'ping' }, options());
    respond(s, s.dispatch('alice', c.call_id, d.epoch), { result: { text: 'abc' } }, now);
    const meta = s.saveResult('alice', c.call_id);
    assert.equal(meta.expires, 120);
    s.close();
    s = new Store(path, () => now, { management });
    assert.equal(s.readResult('alice', meta.result_id).hash, meta.hash);
    assert.equal(s.machine(d.machine_id).status, 'offline');
    now = 120;
    s.expire();
    assert.throws(() => s.readResult('alice', meta.result_id), /result_not_found/);
    assert.equal(s.call('alice', c.call_id).response, null);
    assert.throws(() => s.saveResult('alice', c.call_id), /result_not_ready/);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
