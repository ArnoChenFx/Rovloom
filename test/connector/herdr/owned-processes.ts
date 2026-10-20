/** 仅为真实隔离验收监管直接 Herdr 子进程与原生端口返回的自有终端 PID，不扫描系统进程。 */
import { createRequire } from 'node:module'
import type { ChildProcess } from 'node:child_process'
import { object } from '../../../src/wire/index.js'
import type { JsonObject } from '../../../src/wire/types.js'

type Libc = {
  close(): void
  symbols: {
    prctl(a: number, b: number, c: number, d: number, e: number): number
    waitpid(pid: number, status: number, flags: number): number
  }
}
type Ffi = {
  dlopen(path: string, symbols: Record<string, { args: string[]; returns: string }>): Libc
  ptr(value: Uint8Array): number
}
type OwnedProcessSummary = {
  owned_child_exited: boolean
  owned_terminals_reaped: boolean
  known_terminal_pids: number
}

/** 有界让出事件循环，不以等待本身证明进程退出。 */
async function pause(): Promise<void> {
  await new Promise<void>(/** 只等待下一次所属 PID 的内核退出检查。 */ (resolve) => setTimeout(resolve, 25))
}

/** 保存原 subreaper 设置，关闭时仅 waitpid 已知自有 PID，并恢复原设置。 */
export function createOwnedHerdrProcesses() {
  if (process.platform !== 'linux') {
    throw new Error('owned_process_platform_unsupported')
  }
  const ffi = createRequire(import.meta.url)('bun:ffi') as Ffi
  const libc = ffi.dlopen('libc.so.6', {
    prctl: { args: ['int', 'u64', 'u64', 'u64', 'u64'], returns: 'int' },
    waitpid: { args: ['int', 'ptr', 'int'], returns: 'int' }
  })
  const previous = Buffer.alloc(4)
  if (libc.symbols.prctl(37, ffi.ptr(previous), 0, 0, 0) !== 0 || libc.symbols.prctl(36, 1, 0, 0, 0) !== 0) {
    libc.close()
    throw new Error('owned_subreaper_unavailable')
  }
  const pids = new Set<number>()
  let closing: Promise<OwnedProcessSummary> | undefined

  /** PID 只接受真实原生进程信息中的正安全整数，不接受方法参数、自报文件或进程名称。 */
  function add(value: unknown): void {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value !== process.pid) {
      pids.add(value)
    }
  }

  return {
    /** 仅消费本次受监管实例的 pane.process_info 原生响应，不把 PID 当作授权或安装证据。 */
    observe(response: JsonObject): void {
      if (response.error) {
        return
      }
      const result = object(response.result)
      if (result.type !== 'pane_process_info') {
        return
      }
      const info = object(result.process_info)
      add(info.shell_pid)
      for (const entry of Array.isArray(info.foreground_processes) ? info.foreground_processes : []) {
        add(object(entry).pid)
      }
    },
    /** 并发关闭共享同一结果；只向直接 ChildProcess 发退出信号，再回收已知后代。 */
    close(child?: ChildProcess) {
      closing ??= /** 子进程退出与已知 PID 回收共同决定一次最终摘要。 */ (async () => {
        let restored = false
        let result: OwnedProcessSummary
        try {
          if (child && child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM')
            const deadline = Date.now() + 3000
            while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
              await pause()
            }
            if (child.exitCode === null && child.signalCode === null) {
              child.kill('SIGKILL')
            }
          }
          const deadline = Date.now() + 5000
          const pending = new Set(pids)
          const status = Buffer.alloc(4)
          while (Date.now() < deadline) {
            for (const pid of pending) {
              if (libc.symbols.waitpid(pid, ffi.ptr(status), 1) === pid) {
                pending.delete(pid)
                continue
              }
              try {
                process.kill(pid, 0)
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
                  pending.delete(pid)
                }
              }
            }
            if (!pending.size && (!child || child.exitCode !== null || child.signalCode !== null)) {
              break
            }
            await pause()
          }
          result = {
            owned_child_exited: !child || child.exitCode !== null || child.signalCode !== null,
            owned_terminals_reaped: pending.size === 0,
            known_terminal_pids: pids.size
          }
        } finally {
          restored = libc.symbols.prctl(36, previous.readInt32LE(), 0, 0, 0) === 0
          libc.close()
        }
        if (!restored) {
          throw new Error('owned_subreaper_restore_failed')
        }
        return result
      })()
      return closing
    }
  }
}
