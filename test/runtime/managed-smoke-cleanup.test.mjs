// 用真实自有临时目录回归验收脚本的启动失败清理，不以模拟 native 成功删除未确认所有权证据。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OwnedProcessShutdownError } from '../../src/runtime/native-process.ts'
import { createManagedSmokeCleanup } from '../../scripts/runtime/managed-smoke-cleanup.mjs'

/** 每项测试独占真实 0700 目录，锁内容只含合成标记，不启动原生程序或触碰用户配置。 */
function directory() {
  const root = mkdtempSync(join(process.env.LUVUS_TEST_ROOT ?? tmpdir(), 'managed-cleanup-'))
  mkdirSync(join(root, 'control'), { mode: 0o700 })
  return root
}

test(
  'startup failure without a returned owner preserves the actual root and native owner lock',
  /** 复现 startManagedLuvus 抛真实错误类型但尚未赋值 processOwner 的分支。 */ async () => {
    const root = directory()
    const lock = join(root, 'control', 'root.json.owner.lock')
    const bytes = '{"synthetic_owner":"pending_exit"}'
    writeFileSync(lock, bytes, { mode: 0o600 })
    const cleanup = createManagedSmokeCleanup(root)
    try {
      let owner
      try {
        owner = await Promise.reject(new OwnedProcessShutdownError('owned_process_exit_timeout', [], false))
      } catch (error) {
        cleanup.observeFailure(error)
      }
      assert.equal(owner, undefined)
      const result = cleanup.finish()
      assert.deepEqual(result, { cleanup_pending: true, root_retained: true, exit_confirmed: false })
      assert.equal(existsSync(root), true)
      assert.equal(readFileSync(lock, 'utf8'), bytes)
      assert.equal(statSync(root).mode & 0o777, 0o700)
      assert.equal(statSync(lock).mode & 0o777, 0o600)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  'a pending startup flag preserves the root even before the owner lock can be observed',
  /** 两种独立失败标记都不能依赖 processOwner 已返回或文件已存在。 */ () => {
    for (const error of [{ cleanup_pending: true }, { exit_confirmed: false }]) {
      const root = directory()
      const cleanup = createManagedSmokeCleanup(root)
      try {
        cleanup.observeFailure(error)
        // 后续普通错误或同形确认字段不能抹掉先前未确认的物理退出事实。
        cleanup.observeFailure({ exit_confirmed: true, cleanup_pending: false })
        assert.equal(cleanup.finish().root_retained, true)
        assert.equal(cleanup.finish().exit_confirmed, false)
        assert.equal(existsSync(root), true)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  }
)

test(
  'an actual remaining owner lock prevents deletion independently of error shape',
  /** 新旧错误包装遗漏标记时，删除前实际文件仍能保住原生所有权证据。 */ () => {
    const root = directory()
    const lock = join(root, 'control', 'root.json.owner.lock')
    writeFileSync(lock, 'owned-synthetic', { mode: 0o600 })
    const cleanup = createManagedSmokeCleanup(root)
    try {
      cleanup.observeFailure(new Error('ordinary_synthetic_failure'))
      assert.equal(cleanup.finish().root_retained, true)
      assert.equal(readFileSync(lock, 'utf8'), 'owned-synthetic')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  'cleanup failure retains the root and its safe result contains no underlying exception text',
  /** 清理失败仍可安全报告，且不能借其它资源的关闭结果伪造 native exit_confirmed。 */ () => {
    const root = directory()
    const cleanup = createManagedSmokeCleanup(root)
    try {
      cleanup.cleanupFailure(new Error('synthetic_private_exception'))
      assert.deepEqual(cleanup.finish(), { cleanup_pending: true, root_retained: true })
      assert.equal(JSON.stringify(cleanup.finish()).includes('synthetic_private_exception'), false)
      assert.equal(existsSync(root), true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  'an empty owned root with no process or pending cleanup is removed without claiming native exit',
  /** 此分支实际未启动任何 child，只验证普通临时目录清理，绝不模拟成功停止 native。 */ () => {
    const root = directory()
    const cleanup = createManagedSmokeCleanup(root)
    try {
      assert.deepEqual(cleanup.finish(), { cleanup_pending: false, root_retained: false })
      assert.equal(existsSync(root), false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)
