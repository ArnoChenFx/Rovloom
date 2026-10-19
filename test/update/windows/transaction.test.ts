// 闭环原生验收只操作本测试创建的临时安装与子进程；Task Scheduler 状态明确仍为模型。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { setTimeout as pause } from 'node:timers/promises'
import { handleWindowsUpdateHelperCommand } from '../../../src/update/windows/transaction.js'
import { WindowsPathLease, readWindowsExecutable } from '../../../src/update/windows/files.js'
import { parseWindowsReceipt, windowsReceiptExit } from '../../../src/update/windows/protocol.js'
import { runSystemCommand } from '../../../src/service/runner.js'
import { windowsLibrary } from '../../../src/update/windows/native.js'

declare const Bun: { build(options: unknown): Promise<{ success: boolean }> }
let binaries: Promise<{ root: string; old: string; next: string }> | undefined

// 两份样例只编译一次；它们包含固定 helper 接缝，未创建第二产品 CLI。
async function compiled() {
  binaries ??= /* 输出仅位于测试自有私有目录。 */ (async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'rovloom-windows-helper-binaries-')))
    const result = { root, old: join(root, 'old.exe'), next: join(root, 'next.exe') }
    for (const [version, output] of [
      ['0.1.0-dev', result.old],
      ['0.1.1', result.next]
    ]) {
      const built = await Bun.build({
        entrypoints: [fileURLToPath(new URL('./fixture.ts', import.meta.url))],
        target: 'bun',
        env: 'disable',
        define: { WINDOWS_FIXTURE_VERSION: JSON.stringify(version) },
        compile: {
          outfile: output!,
          autoloadDotenv: false,
          autoloadBunfig: false,
          autoloadTsconfig: false,
          autoloadPackageJson: false
        }
      })
      assert.equal(built.success, true)
    }
    return result
  })()
  return binaries
}

// 每项文件轮询有界；超时保留仍有进程占用的目录，不在未知进程存活时递归删除。
async function marker(path: string, timeout = 20000): Promise<string> {
  const until = performance.now() + timeout
  while (performance.now() < until) {
    try {
      return await fs.readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
    await pause(20)
  }
  throw new Error('fixture_marker_timeout')
}

// 只读观察本测试私有 marker 中仍等待 finish 的自有 helper；映像/出生时间吻合后持有内核对象，绝不取得终止权限。
function observeHelper(pid: number, expected: { image: string; born: string }, image: string) {
  assert.equal(expected.image, image)
  assert(Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffffffff)
  const k = windowsLibrary<{
    OpenProcess(access: number, inherit: number, pid: number): bigint
    GetProcessTimes(handle: bigint, born: Buffer, exit: Buffer, kernel: Buffer, user: Buffer): number
    QueryFullProcessImageNameW(handle: bigint, flags: number, text: Buffer, length: Buffer): number
    WaitForSingleObject(handle: bigint, milliseconds: number): number
    GetExitCodeProcess(handle: bigint, code: Buffer): number
    CloseHandle(handle: bigint): number
  }>('kernel32', {
    OpenProcess: { args: ['u32', 'i32', 'u32'], returns: 'u64' },
    GetProcessTimes: { args: ['u64', 'buffer', 'buffer', 'buffer', 'buffer'], returns: 'i32' },
    QueryFullProcessImageNameW: { args: ['u64', 'u32', 'buffer', 'buffer'], returns: 'i32' },
    WaitForSingleObject: { args: ['u64', 'u32'], returns: 'u32' },
    GetExitCodeProcess: { args: ['u64', 'buffer'], returns: 'i32' },
    CloseHandle: { args: ['u64'], returns: 'i32' }
  })
  const handle = k.OpenProcess(0x101000, 0, pid)
  assert(handle !== 0n && handle !== 0xffffffffffffffffn)
  try {
    const born = Buffer.alloc(8)
    assert(k.GetProcessTimes(handle, born, Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)))
    assert.equal(born.readBigUInt64LE().toString(), expected.born)
    const text = Buffer.alloc(32768 * 2)
    const length = Buffer.alloc(4)
    length.writeUInt32LE(32768)
    assert(k.QueryFullProcessImageNameW(handle, 0, text, length))
    assert.equal(text.toString('utf16le', 0, length.readUInt32LE() * 2), image)
  } catch (error) {
    k.CloseHandle(handle)
    throw error
  }
  return {
    // 同一对象已 signaled 才读取真实退出码；超时保留 fixture 而不强杀或猜测 PID 状态。
    exit: async () => {
      try {
        const until = performance.now() + 10000
        while (k.WaitForSingleObject(handle, 0) === 258) {
          assert(performance.now() < until, 'owned helper did not physically exit')
          await pause(20)
        }
        assert.equal(k.WaitForSingleObject(handle, 0), 0)
        const code = Buffer.alloc(4)
        assert(k.GetExitCodeProcess(handle, code))
        return code.readUInt32LE()
      } finally {
        assert(k.CloseHandle(handle))
      }
    }
  }
}

test(
  'helper command seam hands ordinary CLI arguments back without touching a host',
  /* 不以注册空原生测试冒充 Windows 实测。 */ async () => {
    assert.equal(await handleWindowsUpdateHelperCommand(['gateway'], {} as never), undefined)
    assert.equal(
      await handleWindowsUpdateHelperCommand(['__rovloom-update-helper-v1', 'C:\\arbitrary.exe'], {} as never),
      2
    )
  }
)

if (process.platform === 'win32') {
  after(
    /* 全部子进程已 close 后才清理共享编译输出。 */ async () => {
      if (binaries) {
        await fs.rm((await binaries).root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      }
    }
  )
  for (const mode of [
    {
      name: 'updates only after its real parent exits and restores both registered roles',
      healthFailure: false,
      unknownTarget: false,
      code: 0,
      version: '0.1.1',
      state: 'updated'
    },
    {
      name: 'rolls back the old PE and both running roles when new-version health fails',
      healthFailure: true,
      unknownTarget: false,
      code: 6,
      version: '0.1.0-dev',
      state: 'rolled_back'
    },
    {
      name: 'retains recovery locks when old-role readiness swaps the restored file for an unknown object',
      healthFailure: true,
      unknownTarget: false,
      restoreUnknownTarget: true,
      code: 7,
      version: '0.1.0-dev',
      state: 'recovery_required'
    },
    {
      name: 'quiesces both new roles even when the first rollback journal write fails',
      healthFailure: true,
      unknownTarget: false,
      journalFailure: true,
      code: 7,
      version: '0.1.1',
      state: 'recovery_required'
    },
    {
      name: 'retains the old PE and all locks rather than overwriting an unknown target during rollback',
      healthFailure: true,
      unknownTarget: true,
      code: 7,
      version: '0.1.1',
      state: 'recovery_required'
    }
  ] as const) {
    test(
      `native Windows helper ${mode.name}`,
      { timeout: 45000 },
      /* 真实 PE、父/子进程退出、内核句柄和文件替换；系统服务监管保持显式模型。 */ async () => {
        const binary = await compiled()
        const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'rovloom-windows-helper-')))
        const executable = join(root, 'rovloom.exe')
        await fs.copyFile(binary.old, executable)
        await fs.copyFile(binary.next, join(root, 'next.exe'))
        await fs.writeFile(join(root, 'mode.json'), JSON.stringify(mode))
        for (const file of ['gateway.json', 'connector.json', 'state.db']) {
          await fs.writeFile(join(root, file), `unchanged ${file}`)
        }
        const arch = process.arch as 'x64' | 'arm64'
        const original = readWindowsExecutable(executable, arch)
        const child = spawn(executable, ['--fixture-update'], {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        })
        let output = ''
        let closed = false
        let directory: string | undefined
        let observation: ReturnType<typeof observeHelper> | undefined
        let failure: unknown
        child.stdout.on(
          'data',
          /* 本测试输出只含固定诊断，不包含 ticket 或配置。 */ (chunk: Buffer) => {
            output += chunk.toString()
          }
        )
        child.stderr.on(
          'data',
          /* helper 继承的 stderr 保持 close 边界直到其真正退出。 */ (chunk: Buffer) => {
            output += chunk.toString()
          }
        )
        const exit = new Promise<number | null>(
          /* 原父进程 exit 与包括 helper 继承流的 close 分开观察。 */ (resolve, reject) => {
            child.once('error', reject)
            child.once('exit', /* 记录原父进程真实退出码。 */ (code) => resolve(code))
          }
        )
        const complete = new Promise<void>(
          /* 不把父 exit 当作整个自有进程/流组已经静止。 */ (resolve, reject) => {
            child.once('error', reject)
            child.once(
              'close',
              /* 全部继承流已关闭后才清理。 */ () => {
                closed = true
                resolve()
              }
            )
          }
        )
        try {
          const pending = JSON.parse(await marker(join(root, 'parent-result.json')))
          assert.equal(pending.code, 4, pending.output + output)
          assert.match(pending.output, /status=handoff_pending/u)
          const transaction = /transaction=([0-9a-f]{32})/u.exec(pending.output)![1]!
          directory = join(root, `.rovloom-update-${transaction}`)
          const receiptPath = join(directory, 'receipt.json')
          assert.equal(parseWindowsReceipt(await fs.readFile(receiptPath)).state, 'prepared')
          assert.deepEqual(readWindowsExecutable(executable, arch), original)
          assert.equal(child.exitCode, null)
          const competing = WindowsPathLease.acquire(executable)
          try {
            assert.throws(/* 原生独占安装锁立即拒绝第二更新者。 */ () => competing.acquireInstallationLock(), {
              code: 'update_busy'
            })
          } finally {
            competing.close()
          }
          for (const role of ['gateway', 'connector']) {
            await fs.stat(join(root, `.rovloom-${role}.lock`))
          }
          await fs.writeFile(join(root, 'allow-parent-exit'), '')
          assert.equal(await exit, 4)
          const done = JSON.parse(await marker(join(root, 'helper-result.json')))
          observation = observeHelper(done.pid, done.self, join(directory, 'helper.exe'))
          assert.equal(done.code, mode.code, output)
          const receipt = parseWindowsReceipt(await fs.readFile(receiptPath))
          assert.equal(receipt.state, mode.state)
          assert.equal(windowsReceiptExit(receipt), mode.code)
          const changedDuringRestore = 'restoreUnknownTarget' in mode && mode.restoreUnknownTarget
          if (changedDuringRestore) {
            await assert.rejects(fs.stat(join(directory, 'previous.exe')), { code: 'ENOENT' })
            assert.equal(readWindowsExecutable(join(root, 'restored-moved.exe'), arch).fileId, original.fileId)
            const unknown = readWindowsExecutable(executable, arch)
            assert.notEqual(unknown.fileId, original.fileId)
            assert.equal(unknown.sha256, original.sha256)
            assert.equal(unknown.security, original.security)
            assert.match(await fs.readFile(join(root, 'observations.jsonl'), 'utf8'), /replaced_during_old_restore/u)
          } else if (mode.code === 6) {
            await assert.rejects(fs.stat(join(directory, 'previous.exe')), { code: 'ENOENT' })
          } else {
            assert.equal(readWindowsExecutable(join(directory, 'previous.exe'), arch).fileId, original.fileId)
          }
          const result = await runSystemCommand({ executable, args: ['--version'], timeout: 10000 })
          assert.deepEqual(result, { code: 0, stdout: '', stderr: `Rovloom ${mode.version}\n` })
          if (mode.code === 6) {
            assert.deepEqual(readWindowsExecutable(executable, arch), original)
          }
          for (const snapshot of done.snapshots) {
            assert.equal(snapshot.enabled, snapshot.spec.role === 'connector')
            assert.equal(snapshot.state, mode.code === 7 && !changedDuringRestore ? 'stopped' : 'running')
          }
          for (const file of ['gateway.json', 'connector.json', 'state.db']) {
            assert.equal(await fs.readFile(join(root, file), 'utf8'), `unchanged ${file}`)
          }
          for (const lock of ['.rovloom-update.lock', '.rovloom-gateway.lock', '.rovloom-connector.lock']) {
            if (mode.code === 7) {
              await fs.stat(join(root, lock))
            } else {
              await assert.rejects(fs.stat(join(root, lock)), { code: 'ENOENT' })
            }
          }
        } catch (error) {
          let phase = 'unavailable'
          let state = 'unavailable'
          let observations = ''
          try {
            phase = JSON.parse(await fs.readFile(join(directory!, 'journal.json'), 'utf8')).phase
          } catch {
            /* 诊断只读固定阶段，不回显封存票据、角色配置或绝对路径。 */
          }
          try {
            state = parseWindowsReceipt(await fs.readFile(join(directory!, 'receipt.json'))).state
          } catch {
            /* 回执缺失本身就是未完成证据。 */
          }
          try {
            observations = (await fs.readFile(join(root, 'observations.jsonl'), 'utf8')).slice(-4096)
          } catch {
            /* 仅自有动作/版本日志，不读取配置数据。 */
          }
          failure = new Error(
            `fixture_failed: ${error instanceof Error ? error.message : 'unknown'}; phase=${phase}; state=${state}; streamsClosed=${closed}; output=${output.slice(-4096)}; actions=${observations}`
          )
        } finally {
          try {
            await fs.writeFile(join(root, 'allow-parent-exit'), '')
            await fs.writeFile(join(root, 'finish-helper'), '')
            await complete
            if (observation) {
              assert.equal(await observation.exit(), mode.code, 'actual helper exit differs from its receipt')
              if (closed) {
                await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
              }
            }
          } catch (cleanup) {
            failure = failure ? new AggregateError([failure, cleanup], 'fixture and cleanup failed') : cleanup
          }
        }
        if (failure) {
          throw failure
        }
      }
    )
  }
}
