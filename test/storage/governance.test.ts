import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/store.js';
import { Router } from '../../src/router.js';
import { management, connected, options, policy, respond } from './helpers.js';
import type { AttemptBinding } from '../../src/wire/types.js';

function disk(run: (root: string, path: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-governance-'));
  const state = join(root, 'state');
  mkdirSync(state, { mode: 0o700 });
  try {
    run(root, join(state, 'db'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
test('SQLite scope rotation, rollback clock, restart and deleted tombstones never admit an old key', () =>
  disk((_root, path) => {
    let now = 100;
    let s = new Store(path, () => now, {
      management,
      retention: { dedup_ttl: 100, call_metadata_ttl: 100, history_epoch_max_age: 20 },
    });
    try {
      const d = connected(s),
        h = s.openHistory('alice', d.target, 1),
        o = options({ history: { history_epoch: h.history_epoch, client_request_key: 'same' } });
      const c = s.createCall('alice', d.target, { method: 'ping' }, o);
      const b = s.dispatch('alice', c.call_id, d.epoch);
      s.stop('alice', c.call_id);
      const h2 = s.openHistory('alice', d.target, 1, h.history_epoch);
      assert.notEqual(h2.history_epoch, h.history_epoch);
      assert.equal(s.createCall('alice', d.target, { method: 'ping' }, o).call_id, c.call_id);
      assert.throws(
        () =>
          s.createCall(
            'alice',
            d.target,
            { method: 'ping' },
            options({ history: { history_epoch: h.history_epoch, client_request_key: 'new' } }),
          ),
        /dedup_history_unavailable/,
      );
      now = 121;
      s.expire();
      assert.throws(
        () =>
          s.createCall(
            'alice',
            d.target,
            { method: 'ping' },
            options({ history: { history_epoch: h2.history_epoch, client_request_key: 'new' } }),
          ),
        /dedup_history_unavailable/,
      );
      s.close();
      s = new Store(path, () => now, { management });
      assert.equal(s.call('alice', c.call_id).state, 'outcome_unknown');
      assert.throws(() => respond(s, b, { result: {} }, now), /stale_response/);
      now = 221;
      s.expire();
      assert.throws(
        () => s.createCall('alice', d.target, { method: 'ping' }, o),
        /dedup_history_unavailable/,
      );
      now = 110;
      assert.throws(() => s.openHistory('alice', d.target, 1), /clock_untrusted/);
      assert.equal(s.health().mode, 'storage_degraded');
    } finally {
      s.close();
    }
  }));
test('SQLite content and request TTL is anchored at registration; late evidence and discard never revive payload', () =>
  disk((_root, path) => {
    let now = 100;
    const s = new Store(path, () => now, { management, retention: { content_ttl: 10 } });
    try {
      const d = connected(s),
        c = s.createCall(
          'alice',
          d.target,
          { method: 'ping', params: { fake_secret: 'synthetic-secret-ttl' } },
          options({ timeoutMs: 5 }),
        );
      const b = s.dispatch('alice', c.call_id, d.epoch);
      now = 105;
      s.expire();
      assert.equal(s.call('alice', c.call_id).state, 'outcome_unknown');
      now = 110;
      s.expire();
      const result = respond(s, b, { result: { text: 'synthetic-secret-response' } }, now);
      assert.equal(result.state, 'responded');
      assert.equal(result.response, null);
      assert.equal(result.content_status, 'expired');
      assert.throws(() => s.saveResult('alice', c.call_id), /result_not_ready/);
      respond(s, b, { result: { text: 'synthetic-secret-response' } }, now);
      const other = s.createCall('alice', d.target, { method: 'ping' }, options());
      const b2 = s.dispatch('alice', other.call_id, d.epoch);
      s.discardResponse('alice', other.call_id);
      respond(s, b2, { result: { text: 'not-stored' } }, now);
      assert.equal(s.call('alice', other.call_id).response, null);
      const audit = JSON.stringify(s.auditRecords());
      for (const secret of ['synthetic-secret-ttl', 'synthetic-secret-response', 'not-stored'])
        assert(!audit.includes(secret));
    } finally {
      s.close();
    }
    const db = new DatabaseSync(path);
    assert.equal(
      db.prepare("SELECT request_json FROM calls WHERE content_status='expired'").get()!
        .request_json,
      null,
    );
    db.close();
  }));
test('SQLite late evidence is exactly bound, preserves timeout history, rejects conflict and never adds attempts', () =>
  disk((_root, path) => {
    let now = 100;
    const s = new Store(path, () => now, { management });
    try {
      const d = connected(s),
        c = s.createCall('alice', d.target, { method: 'ping' }, options({ timeoutMs: 5 }));
      const b = s.dispatch('alice', c.call_id, d.epoch);
      now = 105;
      const result = respond(s, b, { result: { pong: true } }, now);
      assert.equal(result.state, 'responded');
      for (const field of [
        'machine_id',
        'recovery_generation',
        'connection_epoch',
        'call_id',
        'attempt_id',
        'native_request_id',
        'contract_ref',
      ] as const) {
        const wrong = { ...b, [field]: 'mismatch' };
        assert.throws(() => s.responseAnchor(wrong));
      }
      assert.throws(() => s.responseAnchor({ ...b, binding_revision: 2 }));
      assert.throws(() =>
        s.responseAnchor({ ...b, target: { ...b.target, provider_id: 'another' } }),
      );
      respond(s, b, { result: { pong: true } }, now);
      assert.throws(
        () => respond(s, b, { result: { pong: false } }, now),
        /response_evidence_conflict/,
      );
      assert.throws(() => s.dispatch('alice', c.call_id, d.epoch), /dispatch_rejected/);
      const audit = s.auditRecords();
      assert.equal(audit.filter((e) => e.action === 'dispatching').length, 1);
      assert.equal(audit.filter((e) => e.action === 'deadline_exceeded').length, 1);
      assert.equal(audit.filter((e) => e.action === 'late_evidence').length, 1);
    } finally {
      s.close();
    }
  }));
test('SQLite provider revision and tuple policies isolate same-name IDs, keys and handles', () =>
  disk((_root, path) => {
    const s = new Store(path, () => 100, { management });
    try {
      const d = connected(s);
      s.defineProvider({
        machine_id: d.machine_id,
        provider_id: 'second',
        kind: 'luvus',
        config_ref: 'other',
        binding_revision: 1,
        enabled: true,
      });
      const second = { ...d.target, provider_id: 'second' };
      const p = { id: 'alice', policy: policy(d.target) },
        router = new Router(s, () => policy(d.target, true));
      assert.throws(() => router.create(p, second, { method: 'ping' }, options()), /forbidden/);
      const a = s.createCall('alice', d.target, { method: 'ping' }, options()),
        b = s.createCall('alice', second, { method: 'ping' }, options());
      respond(s, s.dispatch('alice', a.call_id, d.epoch), { result: { name: 'a' } }, 100);
      respond(s, s.dispatch('alice', b.call_id, d.epoch), { result: { name: 'b' } }, 100);
      const handle = s.saveResult('alice', a.call_id);
      s.setProviderEnabled(d.machine_id, 'provider', 1, false);
      assert.throws(() => s.call('alice', a.call_id), /provider_disabled/);
      assert.throws(() => s.readResult('alice', handle.result_id), /provider_disabled/);
      assert(s.call('alice', b.call_id).response);
      const next = s.setProviderEnabled(d.machine_id, 'provider', 2, true);
      assert.equal(next.binding_revision, 3);
      assert.throws(() => s.call('alice', a.call_id), /provider_binding_mismatch/);
      s.revoke(d.machine_id);
      assert.throws(() => s.call('alice', b.call_id), /call_not_found/);
    } finally {
      s.close();
    }
  }));
test('SQLite anchor and late-evidence commit failures publish no false durable result and no resend', () =>
  disk((_root, path) => {
    let point = '';
    const s = new Store(path, () => 100, {
      management,
      fault: (p) => {
        if (p === point) throw Error('synthetic I/O failure');
      },
    });
    try {
      const d = connected(s),
        c = s.createCall('alice', d.target, { method: 'ping' }, options());
      let sends = 0;
      point = 'before_commit';
      assert.throws(() => {
        s.dispatch('alice', c.call_id, d.epoch);
        sends++;
      }, /storage_degraded/);
      assert.equal(sends, 0);
      assert.equal(s.call('alice', c.call_id).state, 'created');
      assert.throws(() => s.connect(d.machine_id, d.credential), /storage_degraded/);
      point = '';
      s.resumeStorage();
      const b = s.dispatch('alice', c.call_id, d.epoch);
      sends++;
      point = 'evidence_commit';
      assert.throws(() => respond(s, b, { result: {} }, 100), /storage_degraded/);
      assert.equal(s.call('alice', c.call_id).state, 'outcome_unknown');
      assert.equal(s.call('alice', c.call_id).response, null);
      assert.throws(() => s.saveResult('alice', c.call_id), /storage_degraded/);
      point = '';
      s.resumeStorage();
      respond(s, b, { result: {} }, 100);
      assert.equal(sends, 1);
      assert.equal(s.call('alice', c.call_id).state, 'responded');
    } finally {
      s.close();
    }
  }));
test('SQLite SQLITE_FULL while committing an anchor prevents any send and remains degraded after restart', () =>
  disk((_root, path) => {
    let full = false;
    const s = new Store(path, () => 100, {
      management,
      fault: (p) => {
        if (full && p === 'before_commit') {
          const db = (s as unknown as { db: DatabaseSync }).db;
          const pages = Number(db.prepare('PRAGMA page_count').get()!.page_count);
          db.exec(`PRAGMA max_page_count=${pages}`);
          db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?)').run(
            'force-full',
            'test',
            'test',
            null,
            100,
            1000,
            'x'.repeat(2_000_000),
          );
        }
      },
    });
    try {
      const d = connected(s),
        c = s.createCall('alice', d.target, { method: 'ping' }, options());
      full = true;
      let sends = 0;
      assert.throws(() => {
        s.dispatch('alice', c.call_id, d.epoch);
        sends++;
      }, /storage_degraded/);
      assert.equal(sends, 0);
    } finally {
      s.close();
    }
    const reopened = new Store(path, () => 100, { management });
    try {
      assert.equal(reopened.health().mode, 'storage_degraded');
      assert.throws(() => reopened.register('blocked'), /storage_degraded/);
    } finally {
      reopened.close();
    }
  }));
test('SQLite total disk budget includes unrelated managed files, leaves tombstones intact, and requires explicit resume', () =>
  disk((_root, path) => {
    const s = new Store(path, () => 100, {
      management,
      retention: {
        storage_total_bytes: 1_048_576,
        storage_reserve_bytes: 65_536,
        content_bytes: 100_000,
        handle_payload_bytes: 10_000,
        call_metadata_bytes: 100_000,
        audit_bytes: 100_000,
        security_metadata_bytes: 100_000,
        backup_bytes: 100_000,
      },
    });
    try {
      const d = connected(s),
        h = s.openHistory('alice', d.target, 1),
        o = options({ history: { history_epoch: h.history_epoch, client_request_key: 'k' } });
      const c = s.createCall('alice', d.target, { method: 'ping' }, o);
      const junk = join(path, '..', 'pressure');
      writeFileSync(junk, Buffer.alloc(1_000_000));
      assert.throws(() => s.dispatch('alice', c.call_id, d.epoch), /storage_degraded/);
      rmSync(junk);
      assert.throws(() => s.dispatch('alice', c.call_id, d.epoch), /storage_degraded/);
      s.resumeStorage();
      assert.equal(s.createCall('alice', d.target, { method: 'ping' }, o).call_id, c.call_id);
    } finally {
      s.close();
    }
  }));
test('SQLite metadata-only backup opens quarantined; restored credentials, enrollments, scopes and providers stay fenced', () =>
  disk((root, path) => {
    const backupDirectory = join(root, 'backups');
    mkdirSync(backupDirectory, { mode: 0o700 });
    const destination = join(backupDirectory, 'snapshot');
    const s = new Store(path, () => 100, { management, backupDirectory });
    let credential = '',
      token = '',
      machine = '',
      target: ReturnType<typeof connected>['target'];
    let oldBinding: AttemptBinding;
    try {
      const d = connected(s);
      credential = d.credential;
      machine = d.machine_id;
      target = d.target;
      const pending = s.register('pending');
      token = s.issueEnrollment(pending.machine_id);
      const c = s.createCall(
        'alice',
        d.target,
        { method: 'ping', params: { secret: 'backup-fake-secret' } },
        options(),
      );
      oldBinding = s.dispatch('alice', c.call_id, d.epoch);
      respond(s, oldBinding, { result: { secret: 'output-fake-secret' } }, 100);
      s.backup(destination);
      s.revoke(d.machine_id);
      const bytes = readFileSync(destination);
      for (const secret of [credential, token, 'backup-fake-secret', 'output-fake-secret'])
        assert(!bytes.includes(Buffer.from(secret)));
    } finally {
      s.close();
    }
    const restored = new Store(destination, () => 100, { management });
    try {
      assert.equal(restored.health().mode, 'recovery_quarantined');
      assert.notEqual(restored.generation(), oldBinding!.recovery_generation);
      assert.throws(() => restored.connect(machine, credential), /recovery_quarantined/);
      assert.throws(() => restored.redeem(token), /recovery_quarantined/);
      assert.throws(() => restored.issueEnrollment(machine), /recovery_quarantined/);
      assert.throws(
        () => restored.createCall('alice', target!, { method: 'ping' }, options()),
        /recovery_quarantined/,
      );
      restored.completeRecovery();
      assert.throws(() => restored.connect(machine, credential), /invalid_device_credential/);
      assert.throws(() => restored.redeem(token), /invalid_enrollment/);
      assert.equal(restored.provider(machine, 'provider')!.enabled, false);
      assert.throws(() => restored.responseAnchor(oldBinding!), /provider_disabled/);
      const fresh = restored.redeem(restored.issueEnrollment(machine));
      restored.connect(machine, fresh.credential);
      restored.setProviderEnabled(machine, 'provider', 2, true);
      assert.throws(() => restored.responseAnchor(oldBinding!), /provider_binding_mismatch/);
    } finally {
      restored.close();
    }
  }));
test('SQLite private paths, symlinks, corruption and abandoned crash locks fail closed', () =>
  disk((root, path) => {
    const open = new Store(path);
    open.close();
    const publicDirectory = join(root, 'public');
    mkdirSync(publicDirectory, { mode: 0o755 });
    chmodSync(publicDirectory, 0o755);
    assert.throws(
      () => new Store(join(publicDirectory, 'db')),
      /private_storage_directory_required/,
    );
    const link = join(root, 'linked');
    symlinkSync(join(root, 'state'), link);
    assert.throws(() => new Store(join(link, 'db')), /unsafe_storage_path/);
    const lock = path + '.lock';
    writeFileSync(lock, 'crash', { mode: 0o600 });
    assert.throws(() => new Store(path), /EEXIST/);
    assert(existsSync(lock));
    rmSync(lock);
    chmodSync(path, 0o644);
    assert.throws(() => new Store(path), /unsafe_storage_file/);
    chmodSync(path, 0o600);
    writeFileSync(path, 'corrupt SQLite');
    assert.throws(() => new Store(path), /database_open_failed/);
  }));
test('actual abrupt SQLite writer exit leaves lock; opening never auto-removes it', () =>
  disk((_root, path) => {
    const script = `import {Store} from ${JSON.stringify(new URL('../../src/store.ts', import.meta.url).pathname)};new Store(${JSON.stringify(path)});process.exit(17)`;
    const child = spawnSync(process.execPath, ['--no-env-file', '-e', script], {
      encoding: 'utf8',
    });
    assert.equal(child.status, 17, child.stderr);
    assert(existsSync(path + '.lock'));
    assert.throws(() => new Store(path), /EEXIST/);
  }));
test('invalid retention relations and missing management/confirmation replay reject allocation', () => {
  for (const retention of [
    { history_epoch_max_age: 3_000_000_000 },
    { call_metadata_ttl: 1 },
    { storage_reserve_bytes: 536_870_912 },
    { content_bytes: 1 },
    { dedup_ttl: NaN },
  ])
    assert.throws(() => new Store(':memory:', () => 100, { retention }), /invalid_storage_limits/);
  const s = new Store(':memory:', () => 100, {
    management: () => ({ actor: 'a', confirmation_id: 'same' }),
  });
  try {
    const m = s.register('a');
    s.defineProvider({
      machine_id: m.machine_id,
      provider_id: 'one',
      kind: 'luvus',
      config_ref: 'test',
      binding_revision: 1,
      enabled: true,
    });
    assert.throws(
      () => s.setProviderEnabled(m.machine_id, 'one', 1, false),
      /confirmation_replayed/,
    );
  } finally {
    s.close();
  }
  const denied = new Store(':memory:', () => 100);
  try {
    const m = denied.register('a');
    assert.throws(
      () =>
        denied.defineProvider({
          machine_id: m.machine_id,
          provider_id: 'p',
          kind: 'luvus',
          config_ref: 'test',
          binding_revision: 1,
          enabled: true,
        }),
      /management_authorization_required/,
    );
  } finally {
    denied.close();
  }
});
test('evidence planner exceptions do not publish a response or expose planted secret errors', () =>
  disk((_root, path) => {
    const s = new Store(path, () => 100, { management });
    try {
      const d = connected(s),
        c = s.createCall('alice', d.target, { method: 'ping' }, options()),
        b = s.dispatch('alice', c.call_id, d.epoch);
      assert.throws(
        () =>
          s.commitEvidence(b, () => {
            throw Error('planted-fake-secret');
          }),
        (e) => e instanceof Error && e.message === 'storage_degraded',
      );
      assert.equal(s.call('alice', c.call_id).response, null);
    } finally {
      s.close();
    }
  }));
