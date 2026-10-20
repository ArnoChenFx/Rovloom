// 固定Bun超时不会自动中止异步回调；本测试作用域显式取消等待并在after中排空实际拥有的资源。
import type { TestContext } from 'node:test'
import type { GatewayService } from '../../src/mcp/types.js'

type Cleanup = 'not_started' | 'clients' | 'listener' | 'http' | 'service' | 'runtime' | 'complete'
type Timing = { side: 'client' | 'server'; operation: string; elapsed_ms: number }
const operations = new Set([
  'initialize',
  'ping',
  'runtime_call',
  'runtime_call_get',
  'runtime_call_cancel',
  'runtime_result_read',
  'machines_list'
])

/** 只管理本测试资源和诊断，不修改产品deadline、重放请求或将客户端取消转成原生取消。 */
export function sdkTestLifecycle(context: TestContext, name: 'runtime-sdk' | 'http-sessions', timeout: number) {
  const controller = new AbortController()
  const deadline = performance.now() + timeout
  const owned: { stage: Cleanup; close(): void | Promise<void> }[] = []
  const acquiring = new Set<Promise<unknown>>()
  const pending = new Map<object, { side: 'client' | 'server'; operation: string; started: number }>()
  const timings: Timing[] = []
  let phase = name === 'runtime-sdk' ? 'fixture_import' : 'connect'
  let cleanup: Cleanup = 'not_started'
  let complete = false
  let failedCleanup = false
  let closing: Promise<void> | undefined
  let callbackDone: Promise<void> | undefined
  let callbackFinished = false
  let expected = performance.now() + 100
  let lag = 0
  const observer = setInterval(
    /** 只统计本测试的事件循环延迟，不采集业务值或环境。 */ () => {
      const now = performance.now()
      lag = Math.max(lag, now - expected)
      expected = now + 100
    },
    100
  )
  observer.unref()

  /** 先发布幂等结果再abort，重入finally不能执行第二轮清理；失败也尝试所有资源。 */
  function close(): Promise<void> {
    if (!closing) {
      let resolve!: () => void
      let reject!: (error: Error) => void
      closing = new Promise<void>(
        /** 清理重入都等待同一结算。 */ (done, failed) => {
          resolve = done
          reject = failed
        }
      )
      void closing.catch(/** 主路径和after仍观察失败，不产生无人处理的拒绝。 */ () => {})
      controller.abort()
      clearInterval(observer)
      void (
        /** 依照所有权逆序关闭，不能以超时为由遗留上一测试的HTTP或SQLite角色。 */ (async () => {
          while (acquiring.size) {
            await Promise.allSettled(acquiring)
          }
          while (owned.length) {
            const resource = owned.pop()!
            cleanup = resource.stage
            try {
              await resource.close()
            } catch {
              failedCleanup = true
            }
          }
          cleanup = 'complete'
          if (failedCleanup) {
            reject(new Error('sdk_test_cleanup_failed'))
          } else {
            resolve()
          }
        })()
      )
    }
    return closing
  }

  context.after(
    /** 原超时失败保留；after等待真实收尾，下一测试不得与旧回调共享活资源。 */ async () => {
      const report = !complete || cleanup !== 'complete' || failedCleanup
      if (report) {
        console.error(`[mcp-http-failure] case=${name} phase=${phase} cleanup=${cleanup}`)
      }
      try {
        try {
          await close()
        } finally {
          await callbackDone
        }
      } finally {
        if (report || process.env.ROVLOOM_MCP_TEST_DIAGNOSTICS === '1') {
          console.error(
            JSON.stringify({
              kind: 'mcp_http_test_diagnostics',
              case: name,
              phase,
              cleanup,
              callback_finished: callbackFinished,
              acquisitions: acquiring.size,
              event_loop_max_lag_ms: Math.round(lag),
              pending: [...pending.values()].slice(0, 4).map(
                /** 只记录固定操作名和等待时长，不输出ID、请求或结果。 */ (entry) => ({
                  side: entry.side,
                  operation: entry.operation,
                  elapsed_ms: Math.round(performance.now() - entry.started)
                })
              ),
              timings
            })
          )
        }
      }
    }
  )

  /** 实际SDK与服务入口分别计时；仅固定操作枚举和数字可以进入失败诊断。 */
  async function observe<T>(side: 'client' | 'server', operation: string, action: () => T | Promise<T>): Promise<T> {
    const token = {}
    const entry = { side, operation: operations.has(operation) ? operation : 'other', started: performance.now() }
    pending.set(token, entry)
    try {
      return await action()
    } finally {
      pending.delete(token)
      if (timings.length === 32) {
        timings.shift()
      }
      timings.push({ side, operation: entry.operation, elapsed_ms: Math.round(performance.now() - entry.started) })
    }
  }

  /** 取得开始即登记；迟到资源交回同一清理栈，中止后的import不能继续建立fixture。 */
  function acquire<T>(
    open: () => T | Promise<T>,
    resource?: { stage: Cleanup; release(value: T): void | Promise<void> }
  ): Promise<T> {
    const task: Promise<T> = Promise.resolve()
      .then(
        /** 关闭已开始时不调用新的资源工厂。 */ () => {
          if (controller.signal.aborted) {
            throw new Error('sdk_test_aborted')
          }
          return open()
        }
      )
      .then(
        /** 成功取得先交回所有权，再判断是否还能交付测试主体。 */ (value) => {
          if (resource) {
            owned.push({
              stage: resource.stage,
              close: /** 只释放本次实际取得的对象。 */ () => resource.release(value)
            })
          }
          if (controller.signal.aborted) {
            throw new Error('sdk_test_aborted')
          }
          return value
        }
      )
      .finally(/** close等待实际取得结算，不以取消等待冒充资源已交回。 */ () => acquiring.delete(task))
    acquiring.add(task)
    void task.catch(/** 原拒绝仍交回调用者，清理期间没有无人观察的迟到拒绝。 */ () => {})
    return task
  }

  return {
    signal: controller.signal,
    close,
    run: /** after也等待主体完成；主体finally可等待同一close，不形成循环。 */ <T>(
      action: () => Promise<T>
    ): Promise<T> => {
      if (callbackDone || controller.signal.aborted) {
        throw new Error('sdk_test_callback_invalid')
      }
      const result = Promise.resolve().then(action).finally(close)
      callbackDone = result.then(
        /** 主体正常结束须在after返回前得到观察。 */ () => {
          callbackFinished = true
        },
        /** 原失败由runner观察；after只等待完成，不把失败改判通过。 */ () => {
          callbackFinished = true
        }
      )
      return result
    },
    load: /** 中止后不交付迟到模块，下一阶段不会再调用其资源工厂。 */ <T>(open: () => Promise<T>) => acquire(open),
    acquire: /** 异步fixture从开始取得起归本作用域所有，不等主体恢复后才登记。 */ <T>(
      stage: Cleanup,
      open: () => Promise<T>,
      release: (value: T) => void | Promise<void>
    ) => acquire(open, { stage, release }),
    phase: /** 固定阶段由用例显式推进，不能从业务数据推导诊断。 */ (value: string) => {
      phase = value
    },
    complete: /** 只有所有原业务断言通过后才标记成功，after仍核对资源收尾。 */ () => {
      complete = true
    },
    own: /** 晚于超时才交回的资源立即关闭，不得逃逸已经结束的测试。 */ async (
      stage: Cleanup,
      release: () => void | Promise<void>
    ) => {
      if (closing || controller.signal.aborted) {
        await release()
        throw new Error('sdk_test_aborted')
      }
      owned.push({ stage, close: release })
    },
    options: /** 每次SDK调用只使用原测试剩余期限，不能在超时后继续占用默认60秒等待。 */ () => {
      controller.signal.throwIfAborted()
      const remaining = Math.ceil(deadline - performance.now())
      if (remaining <= 0) {
        throw new Error('sdk_test_deadline')
      }
      return { signal: controller.signal, timeout: remaining }
    },
    wait: /** 业务latch仍须由真实入口推进，abort只拒绝等待，不伪造ready或成功。 */ <T>(
      promise: Promise<T>
    ): Promise<T> =>
      new Promise<T>(
        /** 为不支持signal的测试握手绑定本作用域中止，并排空监听器。 */ (resolve, reject) => {
          const abort = /** 中止不会把未观察到的握手改判成功。 */ () => reject(new Error('sdk_test_aborted'))
          controller.signal.addEventListener('abort', abort, { once: true })
          void promise.then(
            /** 交付前仍检查测试作用域没有关闭。 */ (value) => {
              controller.signal.removeEventListener('abort', abort)
              if (controller.signal.aborted) {
                abort()
              } else {
                resolve(value)
              }
            },
            /** 原握手失败保留拒绝，不能被清理吞掉。 */ (error: unknown) => {
              controller.signal.removeEventListener('abort', abort)
              reject(error)
            }
          )
          if (controller.signal.aborted) {
            abort()
          }
        }
      ),
    call: /** 原SDK调用只执行一次；超时诊断不读取或重放业务参数。 */ <T>(operation: string, action: () => Promise<T>) =>
      observe('client', operation, action),
    service: /** 业务仍逐次委托同一正式服务，包装只统计进入/完成的时长。 */ (
      service: GatewayService
    ): GatewayService => ({
      /** 原服务接收同一认证上下文，计时层不补造权限或业务结果。 */
      async execute(operation, args, context) {
        return observe(
          'server',
          operation,
          /** 参数、上下文和结果都保持原对象及原语义。 */ () => service.execute(operation, args, context)
        )
      }
    })
  }
}
