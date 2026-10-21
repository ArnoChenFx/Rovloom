/** 进程身份与端点监听探测：崩溃恢复的“旧 owner 已死、端点无人监听”证据，在 Linux（/proc）与 Windows（Win32）有效。 */
import { connect } from 'node:net'
import { readFileSync } from 'node:fs'
import { windowsProcessState } from '../platform/windows.js'

export type ProcessIdentity = Readonly<{ pid: number; start: string }>

/** Linux 内核启动 tick 或 Windows 进程创建时间区分已退出进程与复用同一 PID 的无关进程；其它平台没有该证据。 */
export function currentProcessIdentity(pid = process.pid): ProcessIdentity | undefined {
  if (process.platform !== 'linux' && process.platform !== 'win32') {
    return undefined
  }
  const state = processState(pid)
  return state.kind === 'alive' ? Object.freeze({ pid, start: state.start }) : undefined
}

export type ProcessState = Readonly<{ kind: 'dead' } | { kind: 'unknown' } | { kind: 'alive'; start: string }>

/** 只有进程文件明确不存在或为僵尸才算已死；读取失败不是“已死”的证据。 */
export function processState(pid: number): ProcessState {
  if (process.platform === 'win32') {
    return windowsProcessState(pid)
  }
  try {
    const line = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = line
      .slice(line.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/u)
    // 僵尸进程仍占着 PID，但其资源已释放，不再持有端点。
    if (fields[0] === 'Z' || fields[0] === 'X') {
      return { kind: 'dead' }
    }
    return /^\d+$/u.test(fields[19] ?? '') ? { kind: 'alive', start: fields[19]! } : { kind: 'unknown' }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'dead' } : { kind: 'unknown' }
  }
}

/** 只回答“此刻是否有监听者”；任何不确定结果（超时、权限等）都按有监听者处理。 */
export function listening(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path)
    const done = (value: boolean) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => done(true), 1000)
    socket.once('connect', () => done(true))
    socket.once('error', (error: NodeJS.ErrnoException) =>
      done(error.code !== 'ECONNREFUSED' && error.code !== 'ENOENT')
    )
  })
}

/** 记录的 owner 进程已死的证据：进程不存在、是僵尸，或同 PID 但启动 tick 不同（PID 复用）。不确定一律为否。 */
export function ownerIsDead(recorded: ProcessIdentity): boolean {
  if ((process.platform !== 'linux' && process.platform !== 'win32') || recorded.pid === process.pid) {
    return false
  }
  const owner = processState(recorded.pid)
  return !(owner.kind === 'unknown' || (owner.kind === 'alive' && owner.start === recorded.start))
}
