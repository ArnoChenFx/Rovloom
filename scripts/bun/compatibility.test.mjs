import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { Store } from '../../src/store.ts';
import { toolchain } from './toolchain.mjs';

test('pinned Bun reports real SQLite; parameter binding, changes, BLOB and SQL rollback', () => {
  assert.equal(toolchain().version, '1.4.3');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, text TEXT, payload BLOB)');
    const bytes = Buffer.from('汉字🙂\u0000bytes');
    assert.equal(db.prepare('INSERT INTO t VALUES(?,?,?)').run(1, 'UTF8汉字', bytes).changes, 1);
    const row = db.prepare('SELECT * FROM t WHERE id=?').get(1);
    assert.equal(row.text, 'UTF8汉字');
    assert.deepEqual(Buffer.from(row.payload), bytes);
    assert.equal(db.prepare('UPDATE t SET text=? WHERE id=?').run('new', 99).changes, 0);
    db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE t SET text=? WHERE id=?').run('rollback', 1);
    assert.throws(() => db.prepare('INSERT INTO t VALUES(?,?,?)').run(1, '', bytes));
    db.exec('ROLLBACK');
    assert.equal(db.prepare('SELECT text FROM t WHERE id=?').get(1).text, 'UTF8汉字');
  } finally {
    db.close();
  }
});

test('real file Store transaction failure rolls back token consumption; modes and lock remain enforced', () => {
  const dir = mkdtempSync(join(tmpdir(), 'luvus-bun-rollback-'));
  const path = join(dir, 'db');
  let store, inspect;
  try {
    store = new Store(path);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(path + '.lock').mode & 0o777, 0o600);
    assert.throws(() => new Store(path), /EEXIST/);
    const machine = store.register('rollback');
    const token = store.issueEnrollment(machine.machine_id);
    inspect = new DatabaseSync(path);
    inspect.exec(
      "CREATE TRIGGER reject_redeem BEFORE UPDATE ON machines BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
    );
    assert.throws(() => store.redeem(token), /synthetic failure/);
    assert.equal(inspect.prepare('SELECT consumed FROM enrollments').get().consumed, 0);
    assert.equal(store.machine(machine.machine_id).status, 'pending');
    inspect.exec('DROP TRIGGER reject_redeem');
    assert.equal(store.redeem(token).machine_id, machine.machine_id);
    assert.throws(() => store.redeem(token), /invalid_enrollment/);
  } finally {
    inspect?.close();
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  'Bun child stdio remains separate and SIGTERM is delivered without hanging',
  { timeout: 5000 },
  async () => {
    const child = spawn(
      process.execPath,
      [
        '--no-env-file',
        '-e',
        'process.on("SIGTERM",()=>{console.error("terminated");process.exit(0)});console.log("ready");setInterval(()=>{},1000)',
      ],
      { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (bytes) => {
      stderr += bytes;
    });
    const closed = once(child, 'close');
    try {
      const [stdout] = await once(child.stdout, 'data');
      assert.equal(stdout.toString(), 'ready\n');
      assert.equal(child.kill('SIGTERM'), true);
      assert.deepEqual(await closed, [0, null]);
      assert.equal(stderr, 'terminated\n');
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  },
);

test('subprocess timeout kills only its synthetic child and leaves no child alive', () => {
  const result = spawnSync(process.execPath, ['--no-env-file', '-e', 'setInterval(()=>{},1000)'], {
    env: { PATH: process.env.PATH },
    timeout: 50,
    killSignal: 'SIGKILL',
    encoding: 'utf8',
  });
  assert.equal(result.error?.code, 'ETIMEDOUT');
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.throws(() => process.kill(result.pid, 0), /ESRCH/);
});

test('synthetic .env is ignored by flag and repository env=false configuration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'luvus-bun-env-'));
  const env = { PATH: process.env.PATH };
  const code = 'if(process.env.LUVUS_SYNTHETIC_ENV)process.exit(71);console.log("ignored")';
  try {
    writeFileSync(join(dir, '.env'), 'LUVUS_SYNTHETIC_ENV=non_sensitive_test_value\n');
    writeFileSync(join(dir, 'bunfig.toml'), 'env = false\n');
    for (const args of [
      ['--no-env-file', '-e', code],
      ['-e', code],
    ]) {
      const result = spawnSync(process.execPath, args, { cwd: dir, env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'ignored\n');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
