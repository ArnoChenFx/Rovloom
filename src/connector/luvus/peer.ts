/** 对端证明的平台入口：Linux 读同一 socket 的 SO_PEERCRED，macOS 读 LOCAL_PEERPID/LOCAL_PEERCRED；Windows 由命名管道名向内核查询服务端 PID。 */
import type { Socket } from 'node:net'
import { macosPeer } from '../../platform/macos.js'
import { windowsPipeServerPid } from '../../platform/windows.js'
import { readLinuxLuvusPeer } from './linux-peer.js'
import { LuvusAdapterError } from './types.js'
import type { EndpointIdentity, PeerIdentity } from './types.js'

/** Windows 没有 uid/gid：uid/gid 为占位 0，用户一致性由路径属主/ACL 与进程镜像身份保证。 */
export function readWindowsLuvusPeer(endpoint: EndpointIdentity): PeerIdentity {
  try {
    return Object.freeze({ pid: windowsPipeServerPid(endpoint.address), uid: 0, gid: 0 })
  } catch {
    throw new LuvusAdapterError('windows_peer_unavailable')
  }
}

/** 同一已连接 socket 的 macOS 内核对端；失败统一为 macos_peer_unavailable。 */
export function readMacosLuvusPeer(socket: Socket): PeerIdentity {
  try {
    return macosPeer(socket)
  } catch {
    throw new LuvusAdapterError('macos_peer_unavailable')
  }
}

/** 不把平台内核事实当作 Luvus 的原生执行保证；只回答“谁在服务这个端点”。 */
export function readLuvusPeer(socket: Socket, endpoint: EndpointIdentity): PeerIdentity {
  if (process.platform === 'win32') {
    return readWindowsLuvusPeer(endpoint)
  }
  return process.platform === 'darwin' ? readMacosLuvusPeer(socket) : readLinuxLuvusPeer(socket)
}
