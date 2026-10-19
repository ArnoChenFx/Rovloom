// 验证固定 Bun 的 SQLite、存储降级恢复、子进程及环境文件行为满足运行约束。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { Store } from '../../src/store.ts'
import { toolchain } from './toolchain.mjs'

test(
  'pinned Bun reports real SQLite; parameter binding, changes, BLOB and SQL rollback',
  /* 验证 SQLite 绑定、变更计数、二进制往返及失败后的事务回滚。 */ () => {
    assert.equal(toolchain().version, '1.4.3')
    const db = new DatabaseSync(':memory:')
    try {
      db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, text TEXT, payload BLOB)')
      const bytes = Buffer.from('汉字🙂\u0000bytes')
      assert.equal(db.prepare('INSERT INTO t VALUES(?,?,?)').run(1, 'UTF8汉字', bytes).changes, 1)
      const row = db.prepare('SELECT * FROM t WHERE id=?').get(1)
      assert.equal(row.text, 'UTF8汉字')
      assert.deepEqual(Buffer.from(row.payload), bytes)
      assert.equal(db.prepare('UPDATE t SET text=? WHERE id=?').run('new', 99).changes, 0)
      db.exec('BEGIN IMMEDIATE')
      db.prepare('UPDATE t SET text=? WHERE id=?').run('rollback', 1)
      assert.throws(
        /* 重复主键插入必须失败，以触发回滚验证。 */ () => db.prepare('INSERT INTO t VALUES(?,?,?)').run(1, '', bytes)
      )
      db.exec('ROLLBACK')
      assert.equal(db.prepare('SELECT text FROM t WHERE id=?').get(1).text, 'UTF8汉字')
    } finally {
      db.close()
    }
  }
)

test(
  'real file Store transaction failure rolls back token consumption; modes and lock remain enforced',
  /* 验证权限与独占锁，并证明存储故障回滚令牌消费且需显式恢复后才能继续兑换。 */ () => {
    const dir = mkdtempSync(join(tmpdir(), 'luvus-bun-rollback-'))
    const path = join(dir, 'db')
    let store
    let inspect
    try {
      store = new Store(path, Date.now, {
        // 为测试中的显式存储恢复提供合成管理员及确认凭据。
        management: () => ({ actor: 'synthetic_admin', confirmation_id: 'synthetic_resume' })
      })
      assert.equal(statSync(path).mode & 0o777, 0o600)
      assert.equal(statSync(path + '.lock').mode & 0o777, 0o600)
      assert.throws(/* 再次打开同一数据库应被现有锁拒绝。 */ () => new Store(path), /EEXIST/)
      const machine = store.register('rollback')
      const token = store.issueEnrollment(machine.machine_id)
      inspect = new DatabaseSync(path)
      inspect.exec(
        "CREATE TRIGGER reject_redeem BEFORE UPDATE ON machines BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END"
      )
      assert.throws(
        /* 让触发器中止兑换，验证写入失败使存储进入降级模式。 */ () => store.redeem(token),
        /storage_degraded/
      )
      assert.equal(store.health().mode, 'storage_degraded')
      assert.equal(inspect.prepare('SELECT consumed FROM enrollments').get().consumed, 0)
      assert.equal(store.machine(machine.machine_id).status, 'pending')
      inspect.exec('DROP TRIGGER reject_redeem')
      store.resumeStorage()
      assert.equal(store.redeem(token).machine_id, machine.machine_id)
      assert.throws(/* 已成功消费的注册令牌不能再次兑换。 */ () => store.redeem(token), /invalid_enrollment/)
    } finally {
      inspect?.close()
      store?.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)

test(
  'Bun child stdio remains separate and SIGTERM is delivered without hanging',
  { timeout: 5000 },
  /* 核验子进程标准流隔离及 SIGTERM 退出，并在异常时强制清理。 */ async () => {
    const child = spawn(
      process.execPath,
      [
        '--no-env-file',
        '-e',
        'process.on("SIGTERM",()=>{console.error("terminated");process.exit(0)});console.log("ready");setInterval(()=>{},1000)'
      ],
      { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let stderr = ''
    child.stderr.on(
      'data',
      /* 收集终止处理器写入的错误流以核对输出归属。 */ (bytes) => {
        stderr += bytes
      }
    )
    const closed = once(child, 'close')
    try {
      const [stdout] = await once(child.stdout, 'data')
      assert.equal(stdout.toString(), 'ready\n')
      assert.equal(child.kill('SIGTERM'), true)
      assert.deepEqual(await closed, [0, null])
      assert.equal(stderr, 'terminated\n')
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGKILL')
      }
    }
  }
)

test(
  'subprocess timeout kills only its synthetic child and leaves no child alive',
  /* 验证同步子进程超时使用 SIGKILL，并确认进程已不存在。 */ () => {
    const result = spawnSync(process.execPath, ['--no-env-file', '-e', 'setInterval(()=>{},1000)'], {
      env: { PATH: process.env.PATH },
      timeout: 50,
      killSignal: 'SIGKILL',
      encoding: 'utf8'
    })
    assert.equal(result.error?.code, 'ETIMEDOUT')
    assert.equal(result.signal, 'SIGKILL')
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
    assert.throws(/* 用零信号探测超时子进程必须得到进程不存在错误。 */ () => process.kill(result.pid, 0), /ESRCH/)
  }
)

test(
  'synthetic .env is ignored by flag and repository env=false configuration',
  /* 在临时项目中分别验证启动参数和配置都阻止自动加载环境文件。 */ () => {
    const dir = mkdtempSync(join(tmpdir(), 'luvus-bun-env-'))
    const env = { PATH: process.env.PATH }
    const code = 'if(process.env.LUVUS_SYNTHETIC_ENV)process.exit(71);console.log("ignored")'
    try {
      writeFileSync(join(dir, '.env'), 'LUVUS_SYNTHETIC_ENV=non_sensitive_test_value\n')
      writeFileSync(join(dir, 'bunfig.toml'), 'env = false\n')
      for (const args of [
        ['--no-env-file', '-e', code],
        ['-e', code]
      ]) {
        const result = spawnSync(process.execPath, args, { cwd: dir, env, encoding: 'utf8' })
        assert.equal(result.status, 0, result.stderr)
        assert.equal(result.stdout, 'ignored\n')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
