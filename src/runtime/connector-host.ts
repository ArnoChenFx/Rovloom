// 为各 provider 交付的已审 Wire 会话管理统一出站角色寿命，不解释原生协议或生成执行许可。
import { GatewayError } from '../contracts.js'
import { createConnector } from '../transport/index.js'
import type { Connection, ConnectorWireSession, WireConnectorOptions } from '../transport/index.js'
import { closeSession } from '../transport/common.js'

export type ConnectorHostOptions = Readonly<{
  transport: Omit<WireConnectorOptions, 'session'>
  // 每个认证 epoch 的 provider 自行交付已审 adapter、执行、readiness 和关闭资源。
  session(connection: Connection): ConnectorWireSession
  // 全部 epoch 停止后释放角色拥有的长期资源，不清除调用墓碑或宣称原生工作回滚。
  release(): Promise<void>
}>

/** 只复用现有 Connector 通道；身份、原生来源及逐 provider 授权仍由已审会话负责。 */
export async function createProviderConnectorRuntime(options: ConnectorHostOptions) {
  let stopping = false
  let cleanupFailed = false
  let transport: ReturnType<typeof createConnector> | undefined
  let resolveClosed!: () => void
  let rejectClosed!: (error: unknown) => void
  const closed = new Promise<void>(
    /** 并发关闭、回调重入和长期观察者共享同一个最终结果。 */ (resolve, reject) => {
      resolveClosed = resolve
      rejectClosed = reject
    }
  )
  void closed.catch(/** 内部观察失败，保留对外同一个拒绝结果而不产生无人消费的异常。 */ () => {})
  const sessions = new Set<ConnectorWireSession>()

  /** 逐项同步回收；非法异步关闭也标记失败并消费其晚到拒绝，错误原文不离开宿主。 */
  function cleanup(operations: readonly (() => unknown)[]): void {
    for (const operation of operations) {
      try {
        const returned = operation()
        if (returned !== undefined) {
          cleanupFailed = true
          void Promise.resolve(returned).catch(/** 消费违规异步清理的拒绝，不把它当作同步关闭完成。 */ () => {})
        }
      } catch {
        cleanupFailed = true
      }
    }
  }

  /** 先同步停止传输及全部会话，再释放长期所有者；关闭只安排一次。 */
  function close(): Promise<void> {
    if (!stopping) {
      stopping = true
      cleanup([/** 原通道负责停 timer、socket 与重连，不另建协议或连接。 */ () => transport?.stop()])
      for (const active of sessions) {
        cleanup([/** 原 closeSession 顺序保证 adapter 与 provider 资源均被回收。 */ () => closeSession(active)])
      }
      void Promise.resolve().then(
        /** 延后释放，使同步 session 构建回调的关闭回滚先完成并计入同一个结果。 */ async () => {
          try {
            await options.release()
          } catch {
            cleanupFailed = true
          }
          if (cleanupFailed) {
            rejectClosed(new GatewayError('connector_runtime_close_failed'))
          } else {
            resolveClosed()
          }
        }
      )
    }
    return closed
  }

  /** 对实际认证 welcome 返回的会话加关闭 fence，provider 回调重入不能晚注册资源。 */
  function session(connection: Connection): ConnectorWireSession {
    if (stopping) {
      throw new GatewayError('runtime_closed')
    }
    let resource: ConnectorWireSession | undefined
    let owned: ConnectorWireSession | undefined
    let originalAdapter: ConnectorWireSession['adapter'] | undefined
    let ended = false
    let adapterClosed = false

    /** 已关闭的角色或 epoch 不再接受新的读取、执行或注册。 */
    function assertOpen(): void {
      if (stopping || ended) {
        throw new GatewayError('runtime_closed')
      }
    }

    try {
      resource = options.session(structuredClone(connection))
      const current = resource
      /** transport 也会主动关闭 adapter；本层统一计量失败并只调用原关闭一次。 */
      function closeAdapter(): void {
        if (!adapterClosed) {
          adapterClosed = true
          cleanup([
            /** 未注册回滚也只在清理时取得原 adapter，内部状态与订阅仍由 provider 自己释放。 */ () =>
              (originalAdapter ?? current.adapter).close()
          ])
        }
      }
      const adapter = new Proxy({} as ConnectorWireSession['adapter'], {
        /** 仅包装关闭；其余方法绑定回原对象，兼容 provider 私有字段与原始方法语义。 */
        get(_target, property) {
          if (property === 'close') {
            return closeAdapter
          }
          const source = originalAdapter ?? current.adapter
          const value: unknown = Reflect.get(source, property, source)
          return typeof value === 'function' ? value.bind(source) : value
        }
      })
      owned = {
        adapter,
        /** 可选准入接收器仍由 provider 原样交付，宿主不解释其 receipt 或实现另一份协议。 */
        get admissions() {
          assertOpen()
          const admissions = current.admissions
          assertOpen()
          return admissions
        },
        /** 原 readiness 回调可能同步关闭角色，返回值不能越过关闭 fence。 */
        readiness() {
          assertOpen()
          const readiness = current.readiness()
          assertOpen()
          return readiness
        },
        /** 原始 Wire 与观察信号原样交给 provider；关闭后不再交付晚到结果。 */
        async executeWire(raw, signal) {
          assertOpen()
          const result = await current.executeWire(raw, signal)
          assertOpen()
          return result
        },
        /** 先移除本 epoch，再清 adapter 和 provider；同步重入不会重复回收。 */
        close() {
          if (ended) {
            return
          }
          ended = true
          sessions.delete(owned!)
          closeAdapter()
          cleanup([/** 只回收当前 provider 交付的会话所有者，不猜测其原生停止语义。 */ () => current.close()])
        }
      }
      assertOpen()
      originalAdapter = current.adapter
      assertOpen()
      sessions.add(owned)
      return owned
    } catch {
      cleanup([
        /** 回调先关闭再返回的会话尚未注册，仍须立即 rollback 原 adapter 与 provider 资源。 */ () =>
          closeSession(owned ?? resource)
      ])
      throw new GatewayError(stopping ? 'runtime_closed' : 'connector_runtime_session_failed')
    }
  }

  try {
    transport = createConnector({ ...options.transport, session })
  } catch {
    await close().catch(/** 启动失败仍等待所有者清理，公开结果只保留稳定启动错误。 */ () => {})
    throw new GatewayError('connector_runtime_start_failed')
  }
  return Object.freeze({ transport, closed, close })
}
