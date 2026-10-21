/** Connector 崩溃（kill -9 / 掉电）后的遗留清理：只有证明旧 owner 已死且端点无人监听才动手，其余一律保持 fail-closed。 */
import { connect } from 'node:net'
import { lstatSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { nativeRecordStamp, readNativeRecord, removeNativeRecord } from '../runtime/native-record-files.js'

export const HERDR_OWNER_FORMAT = 'rovloom-herdr-owner-v1'

export type HerdrOwnerProcess = Readonly<{ pid: number; start: string }>

/** Linux 内核启动 tick 区分已退出进程与复用同一 PID 的无关进程；其它平台没有该证据。 */
export function currentProcessIdentity(pid = process.pid): HerdrOwnerProcess | undefined {
  if (process.platform !== 'linux') {
    return undefined
  }
  const state = processState(pid)
  return state.kind === 'alive' ? Object.freeze({ pid, start: state.start }) : undefined
}

type ProcessState = Readonly<{ kind: 'dead' } | { kind: 'unknown' } | { kind: 'alive'; start: string }>

/** 只有进程文件明确不存在或为僵尸才算已死；读取失败不是“已死”的证据。 */
function processState(pid: number): ProcessState {
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
function listening(path: string): Promise<boolean> {
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

/** 存在则必须是本用户的指定类型文件，否则整个恢复放弃。 */
function owned(path: string, kind: 'socket' | 'file'): boolean | undefined {
  try {
    const info = lstatSync(path)
    if ((kind === 'socket' ? !info.isSocket() : !info.isFile()) || info.uid !== process.geteuid!()) {
      return undefined
    }
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : undefined
  }
}

export type HerdrCrashResidue = Readonly<{
  ownerPath: string
  /** 含 herdr.sock 的 session 目录。 */
  endpointDirectory: string
  /** claim 账本的互斥锁文件；账本本体及其中的派发墓碑永不触碰。 */
  claimsLockPath: string
}>

/**
 * 清理上一个已死 Connector 留下的 owner 记录、Herdr 端点与 claim 锁；返回是否清理过。
 * 证据缺一不可：owner 记录带进程身份且该进程已不存在，所有端点都无监听者，文件均为本用户普通类型。
 * 没有 owner 记录、旧格式记录、非 Linux、或任一证据不确定时返回 false，调用方沿用原 fail-closed 路径。
 */
export async function recoverHerdrCrashResidue(residue: HerdrCrashResidue): Promise<boolean> {
  if (owned(residue.ownerPath, 'file') !== true) {
    return false
  }
  let stamp: string
  let recorded: HerdrOwnerProcess
  try {
    const read = readNativeRecord(residue.ownerPath)
    const value = read.value as { format?: unknown; process?: { pid?: unknown; start?: unknown } }
    if (
      value.format !== HERDR_OWNER_FORMAT ||
      !Number.isSafeInteger(value.process?.pid) ||
      (value.process!.pid as number) <= 0 ||
      typeof value.process?.start !== 'string'
    ) {
      return false
    }
    stamp = read.stamp
    recorded = { pid: value.process.pid as number, start: value.process.start }
  } catch {
    return false
  }
  if (process.platform !== 'linux' || recorded.pid === process.pid) {
    return false
  }
  // 同 PID 但启动 tick 不同是 PID 复用，旧 owner 已死；无法判断时不动手。
  const owner = processState(recorded.pid)
  if (owner.kind === 'unknown' || (owner.kind === 'alive' && owner.start === recorded.start)) {
    return false
  }
  const sockets = [join(residue.endpointDirectory, 'herdr.sock'), join(residue.endpointDirectory, 'herdr-client.sock')]
  const present: string[] = []
  for (const path of sockets) {
    const state = owned(path, 'socket')
    if (state === undefined) {
      return false
    }
    if (state) {
      present.push(path)
    }
  }
  const lock = owned(residue.claimsLockPath, 'file')
  if (lock === undefined) {
    return false
  }
  for (const path of present) {
    if (await listening(path)) {
      return false
    }
  }
  try {
    // 先清端点与锁，owner 记录最后移除；中途再崩溃仍会留下记录并重入本流程。
    for (const path of present) {
      unlinkSync(path)
    }
    if (lock) {
      unlinkSync(residue.claimsLockPath)
    }
    if (nativeRecordStamp(residue.ownerPath) !== stamp) {
      return false
    }
    removeNativeRecord(residue.ownerPath, stamp)
  } catch {
    return false
  }
  return true
}
