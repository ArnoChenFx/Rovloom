/** 仅测量 Linux 同一已连接 Unix socket 的内核 peer；进程归属仍须由受保护实例证明。 */
import { createRequire } from 'node:module'
import { Socket } from 'node:net'
import { LuvusAdapterError } from './types.js'
import type { PeerIdentity } from './types.js'

type Libc = {
  symbols: { getsockopt(fd: number, level: number, option: number, value: number, length: number): number }
}
type BunFfi = {
  dlopen(path: string, symbols: Record<string, { args: string[]; returns: string }>): Libc
  ptr(value: Uint8Array): number
}
let ffi: BunFfi | undefined
let libc: Libc | undefined

/** 延迟加载 Bun 的系统 libc 入口；其它运行时和平台不能用合成结果降级放行。 */
function kernel(): { ffi: BunFfi; libc: Libc } {
  if (process.platform !== 'linux' || !process.versions.bun) {
    throw new LuvusAdapterError('linux_peer_unavailable')
  }
  if (!ffi || !libc) {
    ffi = createRequire(import.meta.url)('bun:ffi') as BunFfi
    libc = ffi.dlopen('libc.so.6', {
      getsockopt: { args: ['int', 'int', 'int', 'ptr', 'ptr'], returns: 'int' }
    })
  }
  return { ffi, libc }
}

/** 同步读取 SO_PEERCRED；拒绝无效/关闭句柄，不把地址、广告 PID 或调用者 JSON 当作内核证据。 */
export function readLinuxLuvusPeer(socket: Socket): PeerIdentity {
  try {
    const handle = (socket as Socket & { _handle?: { fd?: number } })._handle
    const fd = handle?.fd
    if (!(socket instanceof Socket) || socket.destroyed || socket.connecting || !Number.isInteger(fd) || fd! < 0) {
      throw new LuvusAdapterError('linux_peer_unavailable')
    }
    const { ffi, libc } = kernel()
    const value = Buffer.alloc(12)
    const length = Buffer.alloc(4)
    length.writeUInt32LE(value.length)
    if (
      libc.symbols.getsockopt(fd!, 1, 17, ffi.ptr(value), ffi.ptr(length)) !== 0 ||
      length.readUInt32LE() !== value.length ||
      socket.destroyed ||
      (socket as Socket & { _handle?: unknown })._handle !== handle
    ) {
      throw new LuvusAdapterError('linux_peer_unavailable')
    }
    const peer = { pid: value.readInt32LE(), uid: value.readUInt32LE(4), gid: value.readUInt32LE(8) }
    if (peer.pid <= 0) {
      throw new LuvusAdapterError('linux_peer_unavailable')
    }
    return Object.freeze(peer)
  } catch (error) {
    throw error instanceof LuvusAdapterError ? error : new LuvusAdapterError('linux_peer_unavailable')
  }
}
