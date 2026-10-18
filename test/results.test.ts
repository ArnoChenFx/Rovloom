import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { Router } from '../src/router.js';
import { canonical, digest } from '../src/contracts.js';
import type { Policy, Target } from '../src/contracts.js';

test('results enforce ownership, policy, quota, TTL and byte-perfect pagination', () => {
  let now = 0;
  const s = new Store(':memory:', () => now);
  try {
    const m = s.register('results');
    const d = s.redeem(s.issueEnrollment(m.machine_id));
    const epoch = s.connect(m.machine_id, d.credential);
    const target: Target = { machine_id: m.machine_id, profile: 'session', session: 'test' };
    const policy: Policy = { machines: [m.machine_id], sessions: ['test'], methods: ['pane.read'], host: false };
    let local = policy;
    const r = new Router(s, () => local);
    const p = { id: 'alice', policy };
    const c = r.create(p, target, { method: 'pane.read' });
    assert.throws(() => r.saveResult(p, c.call_id), /result_not_ready/);
    const attempt = r.dispatch(p, c.call_id, epoch);
    const native = { result: { text: '\u4f60\u597d'.repeat(100) }, error: null };
    s.receive(m.machine_id, c.call_id, attempt, epoch, native);
    assert.throws(() => s.saveResult(p.id, c.call_id, 100, 1), /result_quota/);
    const meta = s.saveResult(p.id, c.call_id, 100);
    assert.equal(meta.hash, digest(canonical(native)));
    const chunks: Buffer[] = [];
    let cursor = 0;
    while (true) {
      const page = r.readResult(p, meta.result_id, cursor, 7);
      chunks.push(Buffer.from(page.data, 'base64'));
      cursor = page.next_cursor;
      if (page.eof) break;
    }
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString('utf8')), native);
    assert.throws(() => r.readResult({ ...p, id: 'bob' }, meta.result_id), /call_not_found/);
    assert.throws(() => r.readResult(p, meta.result_id, -1), /invalid_result_cursor/);
    local = { ...policy, methods: [] };
    assert.throws(() => r.readResult(p, meta.result_id), /forbidden/);
    local = policy;
    now = 100;
    assert.throws(() => r.readResult(p, meta.result_id), /result_not_found/);
    const next = r.saveResult(p, c.call_id);
    s.revoke(m.machine_id);
    assert.throws(() => r.readResult(p, next.result_id), /result_not_found/);
  } finally { s.close(); }
});

test('real v1 schema migrates to v3; legacy context fails closed and dispatched calls never replay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'luvus-v1-'));
  const path = join(dir, 'state');
  try {
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE metadata(version INTEGER NOT NULL);
      INSERT INTO metadata VALUES(1);
      CREATE TABLE machines(machine_id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,status TEXT NOT NULL,credential_hash TEXT,epoch TEXT);
      CREATE TABLE enrollments(token_hash TEXT PRIMARY KEY,machine_id TEXT NOT NULL REFERENCES machines,expires INTEGER NOT NULL,consumed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE calls(call_id TEXT PRIMARY KEY,principal TEXT NOT NULL,machine_id TEXT NOT NULL REFERENCES machines,request_hash TEXT NOT NULL,request_key TEXT,state TEXT NOT NULL,epoch TEXT,attempt_id TEXT,response TEXT,UNIQUE(principal,request_key));
      INSERT INTO machines VALUES('m','legacy','online',NULL,'e');
      INSERT INTO calls VALUES('c','p','m','hash',NULL,'dispatching','e','a',NULL);`);
    db.close();
    const store = new Store(path);
    try {
      assert.equal(store.machine('m').status, 'offline');
      assert.equal(store.call('p', 'c').state, 'outcome_unknown');
      assert.equal(store.call('p', 'c').target_json, null);
      const policy: Policy = { machines: ['m'], methods: ['pane.read'], sessions: ['test'], host: false };
      assert.throws(() => new Router(store, () => policy).get({ id: 'p', policy }, 'c'), /legacy_call_context_unavailable/);
    } finally { store.close(); }
    const inspect = new DatabaseSync(path);
    assert.equal(inspect.prepare('SELECT version FROM metadata').get()!.version, 3);
    assert.equal(inspect.prepare('SELECT COUNT(*) AS n FROM results').get()!.n, 0);
    inspect.close();
    const reopened = new Store(path);
    assert.equal(reopened.call('p', 'c').state, 'outcome_unknown');
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
