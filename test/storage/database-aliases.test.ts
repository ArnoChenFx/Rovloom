// 数据库别名互斥回归：真实SQLite与独立子进程只操作自有临时资源，不签发身份或连接模型。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/store.js'
import { IdentityStore } from '../../src/transport/identity-store.js'
import { connected, management, options } from './helpers.js'

declare const Bun: { gc(full: boolean): void }

// 业务断言和数据库关闭完成后清理自有根，不在业务打开路径中回收或移除他人锁。
function temporary(check: (root: string) => void): void {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'rovloom-database-alias-'))
  try {
    check(root)
  } finally {
    // Windows上的statement包装在关闭后才回收，不把GC当作事务完成。
    if (process.platform === 'win32') {
      Bun.gc(true)
    }
    rmSync(root, { recursive: true, force: true })
  }
}

for (const aliasKind of ['hardlink', 'symlink'] as const) {
  test(
    '数据库别名' + aliasKind + '不能创建第二writer或改变在线设备与在途调用',
    /* 子进程真实打开同一SQLite，避免只用进程内表掩盖别名恢复问题。 */ () => {
      temporary(
        /* 两个数据库名字和全部业务状态都属于本例临时目录。 */ (root) => {
          const path = join(root, 'gateway.db')
          const alias = join(root, 'alias.db')
          const store = new Store(path, /* 固定账本时间。 */ () => 100, { management })
          try {
            const device = connected(store)
            const call = store.createCall('alice', device.target, { method: 'ping' }, options())
            const binding = store.dispatch('alice', call.call_id, device.epoch)
            if (aliasKind === 'hardlink') {
              linkSync(path, alias)
            } else {
              symlinkSync(path, alias, 'file')
            }
            const entry = new URL('../../src/store.ts', import.meta.url).href
            const script = `import {Store} from ${JSON.stringify(entry)};
    try {const s=new Store(${JSON.stringify(alias)});s.close();process.stdout.write('opened');process.exitCode=9}
    catch(error){if(error?.code==='EEXIST'||error?.code==='database_hardlink_unsupported')process.stdout.write('blocked');else throw error}`
            const child = spawnSync(process.execPath, ['--no-env-file', '-e', script], {
              cwd: root,
              env: {
                PATH: process.env.PATH ?? '',
                HOME: root,
                USERPROFILE: root,
                TEMP: root,
                TMP: root,
                ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {})
              },
              encoding: 'utf8',
              timeout: 5000
            })
            // 必须先检查业务未被另一个构造器恢复；只拒绝后续写入不足以修复这个问题。
            assert.equal(store.machine(device.machine_id).status, 'online')
            assert.equal(store.call('alice', call.call_id).state, 'dispatching')
            store.assertConnection({
              machine_id: binding.machine_id,
              recovery_generation: binding.recovery_generation,
              connection_epoch: binding.connection_epoch
            })
            assert.equal(child.error, undefined)
            assert.equal(child.status, 0, child.stderr)
            assert.equal(child.stdout, 'blocked')
            assert.equal(existsSync(alias + '.lock'), false)
            assert.equal(existsSync(path + '.lock'), true)
          } finally {
            store.close()
          }
          rmSync(alias)
          new Store(path).close()
        }
      )
    }
  )
}

test(
  '数据库软链接和目录别名共用实际写锁，正常关闭后可以重开',
  /* 保留普通链接能力，锁和journal始终使用实际数据库名字。 */ () => {
    temporary(
      /* 文件和目录别名均不指向用户已有对象。 */ (root) => {
        const directory = join(root, 'state')
        mkdirSync(directory)
        const path = join(directory, 'gateway.db')
        new Store(path).close()
        const alias = join(root, 'database-link.db')
        symlinkSync(path, alias, 'file')
        const parent = join(root, 'directory-link')
        symlinkSync(directory, parent, process.platform === 'win32' ? 'junction' : 'dir')
        const store = new Store(alias)
        try {
          assert.equal(existsSync(path + '.lock'), true)
          assert.equal(existsSync(alias + '.lock'), false)
          assert.throws(/* 实际名字不能绕过软链接入口取得的writer锁。 */ () => new Store(path), /EEXIST/)
          assert.throws(/* 父目录别名也指向同一个writer锁。 */ () => new Store(join(parent, 'gateway.db')), /EEXIST/)
        } finally {
          store.close()
        }
        assert.equal(existsSync(path + '.lock'), false)
        new Store(path).close()
        new Store(alias).close()
      }
    )
  }
)

test(
  '身份数据库别名同样遵守单writer且不删除现有锁',
  /* 只打开空的合成身份账本，不签发任何凭据。 */ () => {
    temporary(
      /* 身份和业务库复用同一数据库路径规则。 */ (root) => {
        const path = join(root, 'identity.db')
        const settings = {
          generation: 'g1',
          guard: /* 合成空库没有外部业务状态。 */ () => {},
          checkBudget: /* 本例只核对打开互斥，不分配身份。 */ () => {}
        }
        const store = new IdentityStore(path, settings)
        const hard = join(root, 'hard.db')
        const alias = join(root, 'alias.db')
        try {
          linkSync(path, hard)
          assert.throws(/* 数据库硬链接在SQLite打开之前拒绝。 */ () => new IdentityStore(hard, settings), {
            code: 'database_hardlink_unsupported'
          })
          rmSync(hard)
          symlinkSync(path, alias, 'file')
          assert.throws(/* 软链接使用实际数据库旁的同一把锁。 */ () => new IdentityStore(alias, settings), /EEXIST/)
          assert.equal(existsSync(path + '.lock'), true)
          assert.equal(existsSync(alias + '.lock'), false)
        } finally {
          store.close()
        }
        new IdentityStore(alias, settings).close()
        assert.equal(existsSync(path + '.lock'), false)
      }
    )
  }
)
