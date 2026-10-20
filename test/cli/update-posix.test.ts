// 唯一CLI复用现行POSIX状态机；仅操作自有编译fixture和明确标注的服务模型，不接触系统注册。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { runCli, type CliRuntime } from '../../src/cli/run.js'
import { createPosixUpdater } from '../../src/update/posix/transaction.js'
import { cleanupBinaries, newVersion, oldVersion, setup } from '../update/posix/helpers.js'

// 捕获真实CLI的脱敏输出；可在版本检查结束时撤销调用方，防止进入真实文件事务。
async function capture(runtime: CliRuntime, signal?: AbortSignal, planned?: () => void) {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let out = ''
  let err = ''
  stdout.on('data', /* 更新状态不能进入协议stdout。 */ (chunk) => (out += chunk))
  stderr.on(
    'data',
    /* 只有固定版本状态和错误可以交付。 */ (chunk) => {
      err += chunk
      if (String(chunk).includes('status=available')) {
        planned?.()
      }
    }
  )
  const code = await runCli(
    ['update'],
    {
      stdin: new PassThrough(),
      stdout,
      stderr,
      signal: signal ?? new AbortController().signal
    },
    runtime
  )
  return { code, stdout: out, stderr: err }
}

test(
  '唯一CLI保留POSIX实际完成、已验证回滚和原角色恢复结果',
  { timeout: 45_000 },
  /* 原生fixture与更新模块沿用同一45秒集成预算，不能证明生产窗口业务就绪。 */ async () => {
    if (process.platform === 'win32') {
      return
    }
    for (const rollback of [false, true]) {
      const f = await setup(rollback ? ['gateway'] : [])
      try {
        if (rollback) {
          f.failNewHealth()
        }
        const updater = createPosixUpdater({ executable: f.executable, services: f.manager, verifyRoleReady: f.health })
        const result = await capture({
          update: {
            ...f.network,
            currentVersion: oldVersion,
            platform: process.platform,
            arch: process.arch,
            libc: process.platform === 'linux' ? 'glibc' : null,
            posixUpdater: updater
          }
        })
        assert.deepEqual(result, {
          code: rollback ? 6 : 0,
          stdout: '',
          stderr:
            `current=${oldVersion} target=${newVersion} status=available\n` +
            (rollback ? 'update: update_rolled_back\n' : `status=updated version=${newVersion}\n`)
        })
        await updater.settled()
        if (rollback) {
          assert.equal(f.snapshots.get('gateway')!.state, 'running')
          assert.equal(f.versions.get('gateway'), oldVersion)
        }
      } finally {
        await f.cleanup()
      }
    }
  }
)

test(
  'CLI与受信宿主取消都交给原事务，非零等待结果不伪装成完成',
  { timeout: 45_000 },
  /* 版本检查后立即取消，真实事务必须在任何安装访问或服务动作前返回原错误码。 */ async () => {
    if (process.platform === 'win32') {
      return
    }
    const f = await setup([])
    try {
      for (const source of ['cli', 'host']) {
        const stop = new AbortController()
        const updater = createPosixUpdater({ executable: f.executable, services: f.manager })
        const result = await capture(
          {
            update: {
              ...f.network,
              currentVersion: oldVersion,
              platform: process.platform,
              arch: process.arch,
              libc: process.platform === 'linux' ? 'glibc' : null,
              posixUpdater: updater,
              signal: source === 'host' ? stop.signal : undefined
            }
          },
          source === 'cli' ? stop.signal : undefined,
          /* 不抬高或重置原事务预算。 */ () => stop.abort()
        )
        assert.equal(result.code, 4)
        assert.equal(result.stdout, '')
        assert.equal(
          result.stderr,
          `current=${oldVersion} target=${newVersion} status=available\nupdate: update_io_pending\n`
        )
        await updater.settled()
        assert.equal(f.calls.length, 0)
      }
    } finally {
      await f.cleanup()
    }
  }
)

after(/* 回收的只是本文件自己编译的临时binary。 */ () => cleanupBinaries())
