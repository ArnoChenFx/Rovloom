/**
 * macOS 本机身份原语（bun:ffi 调用 libSystem），对应 Linux 上的 SO_PEERCRED 与 /proc：
 * Unix socket 对端凭据（LOCAL_PEERCRED / LOCAL_PEERPID）、进程状态与启动时间（proc_pidinfo）、
 * 进程镜像路径（proc_pidpath）和命令行（sysctl KERN_PROCARGS2）。
 * 只在 darwin 上有效；其它平台调用即抛 `macos_platform_required`，不提供伪造的等价物。
 */
import { Socket } from 'node:net'
import { createRequire } from 'node:module'

export class MacosPlatformError extends Error {
  /** 只保留固定错误码，不携带路径、pid 或系统错误文本。 */
  constructor(readonly code: string) {
    super(code)
    this.name = 'MacosPlatformError'
  }
}

export type MacosPeer = Readonly<{ pid: number; uid: number; gid: number }>
export type MacosProcessState = Readonly<{ kind: 'dead' } | { kind: 'unknown' } | { kind: 'alive'; start: string }>

type Pointer = Uint8Array | null
type Libc = {
  getsockopt(fd: number, level: number, option: number, value: Pointer, length: Pointer): number
  proc_pidinfo(pid: number, flavor: number, argument: bigint, buffer: Pointer, size: number): number
  proc_pidpath(pid: number, buffer: Pointer, size: number): number
  sysctl(
    mib: Pointer,
    length: number,
    old: Pointer,
    oldLength: Pointer,
    replacement: Pointer,
    newLength: bigint
  ): number
}

const SOL_LOCAL = 0
const LOCAL_PEERCRED = 0x001
const LOCAL_PEERPID = 0x002
const PROC_PIDTBSDINFO = 3
const PROC_PIDPATHINFO_MAXSIZE = 4096
const BSDINFO_SIZE = 136
const XUCRED_SIZE = 76
const CTL_KERN = 1
const KERN_PROCARGS2 = 49
const ARGS_LIMIT = 1_048_576
// proc_bsdinfo.pbi_status：SIDL=1 SRUN=2 SSLEEP=3 SSTOP=4 SZOMB=5。
const SZOMB = 5

let libc: Libc | undefined

/** 懒加载 libSystem：Linux/Windows 上不会触碰 dylib。 */
function system(): Libc {
  if (process.platform !== 'darwin' || !process.versions.bun) {
    throw new MacosPlatformError('macos_platform_required')
  }
  if (!libc) {
    const { dlopen } = createRequire(import.meta.url)('bun:ffi') as {
      dlopen(path: string, symbols: Record<string, { args: string[]; returns: string }>): { symbols: unknown }
    }
    libc = dlopen('libSystem.B.dylib', {
      getsockopt: { args: ['int', 'int', 'int', 'ptr', 'ptr'], returns: 'int' },
      proc_pidinfo: { args: ['int', 'int', 'u64', 'ptr', 'int'], returns: 'int' },
      proc_pidpath: { args: ['int', 'ptr', 'u32'], returns: 'int' },
      sysctl: { args: ['ptr', 'u32', 'ptr', 'ptr', 'ptr', 'u64'], returns: 'int' }
    }).symbols as Libc
  }
  return libc
}

/** 同一已连接 Unix socket 的内核对端：LOCAL_PEERPID 给 pid，LOCAL_PEERCRED 给 uid/gid；拒绝无效/关闭的句柄。 */
export function macosPeer(socket: Socket): MacosPeer {
  try {
    const handle = (socket as Socket & { _handle?: { fd?: number } })._handle
    const fd = handle?.fd
    if (!(socket instanceof Socket) || socket.destroyed || socket.connecting || !Number.isInteger(fd) || fd! < 0) {
      throw new MacosPlatformError('macos_peer_unavailable')
    }
    const api = system()
    const pid = Buffer.alloc(4)
    const pidLength = Buffer.alloc(4)
    pidLength.writeUInt32LE(pid.length)
    const cred = Buffer.alloc(XUCRED_SIZE)
    const credLength = Buffer.alloc(4)
    credLength.writeUInt32LE(cred.length)
    if (
      api.getsockopt(fd!, SOL_LOCAL, LOCAL_PEERPID, pid, pidLength) !== 0 ||
      pidLength.readUInt32LE() !== pid.length ||
      api.getsockopt(fd!, SOL_LOCAL, LOCAL_PEERCRED, cred, credLength) !== 0 ||
      credLength.readUInt32LE() !== cred.length ||
      socket.destroyed ||
      (socket as Socket & { _handle?: unknown })._handle !== handle
    ) {
      throw new MacosPlatformError('macos_peer_unavailable')
    }
    // xucred：cr_version(0)、cr_uid(4)、cr_ngroups(8, short)、cr_groups(12)；有效 gid 是 cr_groups[0]。
    const peer = {
      pid: pid.readInt32LE(),
      uid: cred.readUInt32LE(4),
      gid: cred.readInt16LE(8) > 0 ? cred.readUInt32LE(12) : 0
    }
    if (peer.pid <= 0 || cred.readUInt32LE(0) !== 0) {
      throw new MacosPlatformError('macos_peer_unavailable')
    }
    return Object.freeze(peer)
  } catch (error) {
    throw error instanceof MacosPlatformError ? error : new MacosPlatformError('macos_peer_unavailable')
  }
}

type BsdInfo = Readonly<{ status: number; uid: number; started: string }>

/** proc_bsdinfo：进程状态、有效 uid 和启动时间；进程不存在或不可见返回 undefined。 */
function bsdInfo(pid: number): BsdInfo | undefined {
  const buffer = Buffer.alloc(BSDINFO_SIZE)
  if (system().proc_pidinfo(pid, PROC_PIDTBSDINFO, 0n, buffer, buffer.length) !== BSDINFO_SIZE) {
    return undefined
  }
  const seconds = buffer.readBigUInt64LE(120)
  const micros = buffer.readBigUInt64LE(128)
  return Object.freeze({
    status: buffer.readUInt32LE(4),
    uid: buffer.readUInt32LE(20),
    started: seconds.toString() + '.' + micros.toString().padStart(6, '0')
  })
}

/** 只有内核明确回答“无此进程”或进程已成僵尸才算已死；读取失败不是“已死”的证据。启动时间与 pid 一起防止复用。 */
export function macosProcessState(pid: number): MacosProcessState {
  try {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      return { kind: 'unknown' }
    }
    const info = bsdInfo(pid)
    if (info) {
      return info.status === SZOMB ? { kind: 'dead' } : { kind: 'alive', start: info.started }
    }
    try {
      process.kill(pid, 0)
      return { kind: 'unknown' }
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH' ? { kind: 'dead' } : { kind: 'unknown' }
    }
  } catch {
    return { kind: 'unknown' }
  }
}

/** 进程的有效 uid；不可见返回 undefined。 */
export function macosProcessUid(pid: number): number | undefined {
  try {
    return bsdInfo(pid)?.uid
  } catch {
    return undefined
  }
}

/** 进程可执行文件的真实路径（内核给出，不信任命令行文本）；不可见返回 undefined。 */
export function macosProcessImage(pid: number): string | undefined {
  try {
    const buffer = Buffer.alloc(PROC_PIDPATHINFO_MAXSIZE)
    const length = system().proc_pidpath(pid, buffer, buffer.length)
    return length > 0 ? buffer.subarray(0, length).toString('utf8') : undefined
  } catch {
    return undefined
  }
}

/** 进程的 argv（含 argv[0]），经 KERN_PROCARGS2 读取；非本用户进程或不可见返回 undefined。 */
export function macosProcessArgv(pid: number): readonly string[] | undefined {
  try {
    const api = system()
    const mib = Buffer.alloc(12)
    mib.writeInt32LE(CTL_KERN, 0)
    mib.writeInt32LE(KERN_PROCARGS2, 4)
    mib.writeInt32LE(pid, 8)
    const data = Buffer.alloc(ARGS_LIMIT)
    const size = Buffer.alloc(8)
    size.writeBigUInt64LE(BigInt(data.length))
    if (api.sysctl(mib, 3, data, size, null, 0n) !== 0) {
      return undefined
    }
    const used = Number(size.readBigUInt64LE())
    if (used < 4 || used > data.length) {
      return undefined
    }
    // 布局：int argc；exec_path\0；若干 \0 对齐填充；argc 个以 \0 结尾的 argv；其后是环境变量。
    const argc = data.readInt32LE(0)
    let offset = 4
    while (offset < used && data[offset] !== 0) {
      offset++
    }
    while (offset < used && data[offset] === 0) {
      offset++
    }
    const argv: string[] = []
    for (let index = 0; index < argc && offset < used; index++) {
      let end = offset
      while (end < used && data[end] !== 0) {
        end++
      }
      argv.push(data.subarray(offset, end).toString('utf8'))
      offset = end + 1
    }
    return argv.length === argc && argc > 0 ? Object.freeze(argv) : undefined
  } catch {
    return undefined
  }
}
