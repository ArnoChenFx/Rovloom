// 数据库别名互斥回归：真实SQLite与独立子进程只操作自有临时资源，不签发身份或连接模型。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/store.js'
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

test(
  '数据库软链接循环有界拒绝且不创建写锁',
  /* 只构造本例自引用文件名，不修改系统链接。 */ () => {
    temporary(
      /* 失败必须发生在任何SQLite打开或恢复之前。 */ (root) => {
        const path = join(root, 'loop.db')
        symlinkSync(path, path, 'file')
        assert.throws(/* 文件系统坏输入不能无限解析。 */ () => new Store(path), { code: 'database_symlink_loop' })
        assert.equal(existsSync(path + '.lock'), false)
      }
    )
  }
)

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
            const childOptions = {
              cwd: root,
              env: {
                PATH: process.env.PATH ?? '',
                HOME: root,
                USERPROFILE: root,
                TEMP: root,
                TMP: root,
                ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {})
              },
              encoding: 'utf8' as const,
              timeout: 5000
            }
            const child = spawnSync(process.execPath, ['--no-env-file', '-e', script], childOptions)
            if (aliasKind === 'hardlink') {
              // SQLite不支持多名称数据库；先移除测试别名，再核对原连接和持久业务状态。
              rmSync(alias)
            }
            // 必须先检查业务未被另一个构造器恢复；只拒绝后续写入不足以修复这个问题。
            if (aliasKind !== 'hardlink' || process.platform !== 'darwin') {
              assert.equal(store.machine(device.machine_id).status, 'online')
              assert.equal(store.call('alice', call.call_id).state, 'dispatching')
              store.assertConnection({
                machine_id: binding.machine_id,
                recovery_generation: binding.recovery_generation,
                connection_epoch: binding.connection_epoch
              })
            }
            assert.equal(existsSync(alias + '.lock'), false)
            assert.equal(existsSync(path + '.lock'), true)
            // macOS在活跃库出现硬链接后保留VNODE拒绝；关闭后由全新只读进程核对落盘事实。
            // 不使用Store构造器读回，因为它本来就会恢复在线设备和在途调用。
            store.close()
            const readbackScript = `import {DatabaseSync} from 'node:sqlite';
              const db=new DatabaseSync(${JSON.stringify(path)},{readOnly:true});
              try {
                const m=db.prepare('SELECT status,epoch FROM machines WHERE machine_id=?').get(${JSON.stringify(device.machine_id)});
                const c=db.prepare('SELECT state FROM calls WHERE call_id=?').get(${JSON.stringify(call.call_id)});
                process.stdout.write(JSON.stringify({status:m.status,epoch:m.epoch,call_state:c.state}));
              } finally {db.close()}`
            const readback = spawnSync(process.execPath, ['--no-env-file', '-e', readbackScript], childOptions)
            assert.equal(readback.error, undefined)
            assert.equal(readback.status, 0, readback.stderr)
            assert.deepEqual(JSON.parse(readback.stdout), {
              status: 'online',
              epoch: binding.connection_epoch,
              call_state: 'dispatching'
            })
            assert.equal(child.error, undefined)
            assert.equal(child.status, 0, child.stderr)
            assert.equal(child.stdout, 'blocked')
            assert.equal(existsSync(path + '.lock'), false)
          } finally {
            store.close()
          }
          if (existsSync(alias)) {
            rmSync(alias)
          }
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
