/** 兼容 Luvus 已有 peer 接口，共用真实 Linux 内核测量，保留原错误类型。 */
import type { Socket } from 'node:net'
import { readLinuxPeer } from '../local/linux-peer.js'
import { LuvusAdapterError } from './types.js'
import type { PeerIdentity } from './types.js'

/** 不把通用内核事实当作 Luvus 或其它协议的原生执行保证。 */
export function readLinuxLuvusPeer(socket: Socket): PeerIdentity {
  try {
    return readLinuxPeer(socket)
  } catch {
    throw new LuvusAdapterError('linux_peer_unavailable')
  }
}
