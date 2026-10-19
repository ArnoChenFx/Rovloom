// 把认证上下文绑定到具体 socket，并先同步拒绝业务与会话资源，再关闭底层通道。
import { fail, id } from '../wire/index.js'
import type { Connection, Session } from './common.js'
import { closeSession } from './common.js'

export interface ChannelHost {
  /** 同步拒绝该设备所有旧 socket 的业务，清除会话资源并关闭 socket，不操作 Store 事务。 */
  blockAndClose(machine: string): undefined
  /** 返回该具体认证 socket 的当前上下文；未认证或已封锁时拒绝。 */
  connection(): Connection
}
export interface SocketChannel extends ChannelHost {
  /** 在认证提交后仅绑定一次完整上下文，不从后续 Wire 帧更新身份。 */
  bind(connection: Connection): void
  /** 注册该 socket 的 adapter/订阅清理，封锁时须同步完成。 */
  attach(session: Session): void
  /** 幂等失效当前 socket 的业务许可并清理，不替 Store 断开 epoch。 */
  close(): void
}
type Entry = {
  identity?: Connection
  session?: Session
  active: boolean
  /** 由 listener 闭包关闭具体 socket，不能由业务 JSON 指定目标。 */
  closeSocket(): void
}

export class ChannelRegistry {
  private readonly entries = new Map<object, Entry>()
  /** 给真实 listener 的 socket 分配独立作用域；重复对象和超额连接均拒绝。 */
  open(socket: object, closeSocket: () => void): SocketChannel {
    if (this.entries.has(socket) || this.entries.size >= 128) {
      fail('channel_limit')
    }
    const entry: Entry = { active: true, closeSocket }
    this.entries.set(socket, entry)
    return {
      /** 只接收认证宿主返回的当前上下文并私有复制，socket 打开并不等于认证。 */
      bind(connection) {
        if (!entry.active || entry.identity || connection.authenticated !== true || connection.active !== true) {
          fail('connection_binding_mismatch')
        }
        id(connection.machine_id)
        id(connection.recovery_generation)
        id(connection.connection_epoch)
        entry.identity = structuredClone(connection)
      },
      /** 认证绑定之后只注册一个会话，关闭时以此释放 adapter 和订阅。 */
      attach(session) {
        if (!entry.active || !entry.identity || entry.session) {
          fail('connection_binding_mismatch')
        }
        entry.session = session
      },
      /** 只返回当前作用域的私有身份副本，旧 socket 的闭包不能切换到同设备新 epoch。 */
      connection() {
        if (!entry.active || !entry.identity) {
          fail('authentication_required')
        }
        return structuredClone(entry.identity)
      },
      /** 管理入口可以封锁该注册表中同设备的全部旧 socket，但不能制造任何认证上下文。 */
      blockAndClose: this.blockAndClose.bind(this),
      /** 使用本注册表的幂等关闭路径，避免迟到关闭事件误删新 socket。 */
      close: () => this.close(socket, entry)
    }
  }
  /** 先同步使指定 entry 不再可取身份，再释放会话；异常不恢复业务许可且仍关闭 socket。 */
  private close(socket: object, entry: Entry): void {
    if (!entry.active) {
      return
    }
    entry.active = false
    if (this.entries.get(socket) === entry) {
      this.entries.delete(socket)
    }
    const session = entry.session
    entry.session = undefined
    try {
      closeSession(session)
    } finally {
      entry.closeSocket()
    }
  }
  /** 在任何清理回调之前封锁全部匹配作用域，然后逐个清会话/关 socket；绝不调用业务 Store。 */
  blockAndClose(machine: string): undefined {
    id(machine)
    const matches: [object, Entry][] = []
    for (const [socket, entry] of this.entries) {
      if (entry.identity?.machine_id === machine) {
        entry.active = false
        this.entries.delete(socket)
        matches.push([socket, entry])
      }
    }
    let failed = false
    for (const [, entry] of matches) {
      const session = entry.session
      entry.session = undefined
      try {
        closeSession(session)
      } catch {
        failed = true
      } finally {
        try {
          entry.closeSocket()
        } catch {
          failed = true
        }
      }
    }
    if (failed) {
      fail('synchronous_channel_block_required')
    }
    return undefined
  }
}
