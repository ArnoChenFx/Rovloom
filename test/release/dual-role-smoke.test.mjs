/** 真实短期子进程验证smoke失败清理，不向生产工厂提供任何假native来源或成功响应。 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { startDualRoleSmokeProcess } from '../../scripts/release/dual-role-smoke.mjs'

/** 只构造不读取环境或运行用户命令的受控shell child，所有输出和状态均为本轮合成值。 */
function fixture(body, limits) {
  const root = mkdtempSync(join(fileURLToPath(new URL('../../', import.meta.url)), '.dual-role-process-'))
  const script = join(root, 'child.sh')
  const marker = join(root, 'ready')
  const path = join(root, 'empty-path')
  mkdirSync(path, { mode: 0o700 })
  writeFileSync(script, body, { mode: 0o700 })
  const child = startDualRoleSmokeProcess('/bin/sh', script, marker, root, { PATH: path, HOME: root }, limits)
  return {
    child,
    marker,
    /** 失败stop也必须真实回收直接child后才能删除测试根。 */
    async close() {
      try {
        await child.stop()
      } catch {
        // 预期失败在测试主体断言，此处仍独立核对物理退出。
      }
      assert.equal(existsSync(`/proc/${child.child.pid}`), false, 'synthetic_child_not_reaped')
      rmSync(root, { recursive: true, force: true })
    }
  }
}

/** 有界等待自己的标记文件，不能按PID或名字接管其它进程。 */
async function until(path) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(path)) {
      return
    }
    await pause(10)
  }
  assert.fail('synthetic_child_marker_timeout')
}

test(
  'dual-role stop is idempotent and waits for the real child close',
  { skip: process.platform !== 'linux' },
  /** TERM处理只由本轮shell响应，不模拟任何产品或native协议。 */ async () => {
    const f = fixture('trap \'exit 0\' TERM\n: > "$2"\nwhile :; do /bin/sleep 0.02; done\n', { timeout: 2000 })
    try {
      await until(f.marker)
      const first = f.child.stop()
      assert.equal(f.child.stop(), first)
      await first
      assert.equal(existsSync(`/proc/${f.child.child.pid}`), false)
    } finally {
      await f.close()
    }
  }
)

test(
  'dual-role timeout requests TERM and retains the original failure',
  { skip: process.platform !== 'linux' },
  /** 本轮标记证明先收到正常TERM，正常退出不能把原超时改判成功。 */ async () => {
    const f = fixture('trap \': > "$2.term"; exit 0\' TERM\n: > "$2"\nwhile :; do /bin/sleep 0.02; done\n', {
      timeout: 250,
      killAfter: 1000
    })
    try {
      await until(f.marker + '.term')
      await assert.rejects(f.child.stop(), /dual_role_smoke_timeout/u)
      assert.equal(existsSync(`/proc/${f.child.child.pid}`), false)
    } finally {
      await f.close()
    }
  }
)

test(
  'dual-role ignored TERM requires bounded KILL and remains a failure',
  { skip: process.platform !== 'linux' },
  /** exec沿用本例唯一child与忽略TERM状态，不创建需要追踪或补杀的孙进程。 */ async () => {
    const f = fixture('trap "" TERM\n: > "$2"\nexec /bin/sleep 30\n', { timeout: 2000, killAfter: 100 })
    try {
      await until(f.marker)
      await assert.rejects(f.child.stop(), /dual_role_shutdown_timeout/u)
      assert.equal(existsSync(`/proc/${f.child.child.pid}`), false)
    } finally {
      await f.close()
    }
  }
)
