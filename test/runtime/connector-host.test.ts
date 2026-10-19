// 验证中性 Connector 角色的共享关闭、真实 welcome 重入和 provider 资源回收，不冒充任何原生协议。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GatewayError } from '../../src/contracts.js'
import { createProviderConnectorRuntime } from '../../src/runtime/connector-host.js'
import type { ConnectorHostOptions } from '../../src/runtime/connector-host.js'
import type { Connection, ConnectorWireSession } from '../../src/transport/index.js'
import { decodeWireFrame, encodeWireFrame } from '../../src/wire/index.js'
import { fixture, until } from '../transport/helpers.js'

const privateFailure = 'ISOLATED_PRIVATE_PROVIDER_FAILURE /not-a-real-private-path'

/** 无 Gateway 的启动/关闭测试只提供未使用的隔离凭据，不能建立任何 provider 来源。 */
function options(release: ConnectorHostOptions['release']): ConnectorHostOptions {
  return {
    transport: {
      url: 'ws://127.0.0.1:1/connector',
      developmentLoopback: true,
      credential: /** 此端口没有接收方，凭据仅供本进程关闭回归。 */ () => ({
        machine_id: 'isolated_machine',
        recovery_generation: 'isolated_generation',
        credential: 'isolated_unused_credential'
      })
    },
    /** 无 Gateway 时不能意外创建会话，也没有默认原生 adapter。 */
    session() {
      throw new Error('unexpected_session')
    },
    release
  }
}

/** 只接纳稳定的中性错误码，provider 的原始异常不能进入公开结果。 */
function failure(code: string) {
  return /** 核对类型、码和全部 message，不接受带路径或原始异常的包装。 */ (error: unknown) => {
    assert(error instanceof GatewayError)
    assert.equal(error.code, code)
    assert.equal(error.message, code)
    assert.equal(error.message.includes(privateFailure), false)
    return true
  }
}

test(
  'provider Connector shares close and closed, stops before release and releases once under reentry',
  /** 释放回调重入只观察同一个 Promise，连接拒绝与客户端状态不改变角色关闭顺序。 */ async () => {
    let releases = 0
    const runtime = await createProviderConnectorRuntime(
      options(
        /** 真实 transport 已停止后才可释放长期 provider 资源。 */ async () => {
          releases++
          assert.equal(runtime.transport.status().phase, 'stopped')
          assert.equal(runtime.close(), runtime.closed)
        }
      )
    )
    try {
      const first = runtime.close()
      assert.equal(first, runtime.closed)
      assert.equal(runtime.close(), first)
      await first
      assert.equal(runtime.close(), first)
      assert.equal(releases, 1)
      assert.equal(runtime.transport.status().phase, 'stopped')
    } finally {
      await runtime.close()
    }
  }
)

test(
  'provider Connector release failure rejects its shared close result without exposing the owner error',
  /** 释放失败仍保持 stopped，不重试释放，也不能把 raw provider 异常交给上层。 */ async () => {
    let releases = 0
    const runtime = await createProviderConnectorRuntime(
      options(
        /** 故意失败的长期所有者不包含任何真实秘密。 */ async () => {
          releases++
          throw new Error(privateFailure)
        }
      )
    )
    const first = runtime.close()
    assert.equal(runtime.closed, first)
    assert.equal(runtime.close(), first)
    await assert.rejects(first, failure('connector_runtime_close_failed'))
    await assert.rejects(runtime.closed, failure('connector_runtime_close_failed'))
    assert.equal(runtime.close(), first)
    assert.equal(runtime.transport.status().phase, 'stopped')
    assert.equal(releases, 1)
  }
)

test(
  'provider Connector invalid startup waits for owner release and returns a stable startup error',
  /** 非法地址在原 transport 中失败，工厂仍等真实 release 收尾，不产生替代连接或协议。 */ async () => {
    let released = false
    const input = options(
      /** 通过实际异步步骤确认启动拒绝不会越过尚未完成的释放。 */ async () => {
        await Promise.resolve()
        released = true
      }
    )
    await assert.rejects(
      createProviderConnectorRuntime({ ...input, transport: { ...input.transport, url: 'invalid' } }),
      failure('connector_runtime_start_failed')
    )
    assert.equal(released, true)
  }
)

type Stage = 'none' | 'session' | 'adapter' | 'readiness' | 'reconnect'
type CleanupFailure = 'none' | 'adapter' | 'resource' | 'async_resource' | 'release'

/** 仅处理真实 Wire 握手后的心跳；没有原生 validator、方法分类或可执行请求，不能冒充 Herdr/UHP。 */
function dummySession(
  connection: Connection,
  callbacks: {
    adapter(): void
    readiness(): void
    adapterClose(): void
    resourceClose(): unknown
  }
): ConnectorWireSession {
  let closed = false
  const adapter = {
    /** 心跳继续使用既有 Wire codec，不在测试中重写 envelope 或 native 协议。 */
    encode(
      frame: Parameters<ConnectorWireSession['adapter']['encode']>[0],
      direction: Parameters<ConnectorWireSession['adapter']['encode']>[1]
    ) {
      assert.equal(closed, false)
      return encodeWireFrame(frame, { phase: 'authenticated', direction, connection })
    },
    /** 对端心跳也由真实 codec 验证；缺原生门禁的 request 无法因此获得执行许可。 */
    decode(input: string | Uint8Array, direction: Parameters<ConnectorWireSession['adapter']['decode']>[1]) {
      assert.equal(closed, false)
      return decodeWireFrame(input, { phase: 'authenticated', direction, connection })
    },
    /** 本文件不发送重复业务消息；这里只让心跳经过 transport 的既有观察路径。 */
    observeMessage() {
      return 'new' as const
    },
    /** 回收本 dummy adapter 并统计角色实际调用次数。 */
    close() {
      closed = true
      callbacks.adapterClose()
    }
  } as unknown as ConnectorWireSession['adapter']
  return {
    /** 属性读取本身也可同步触发角色关闭，模拟 provider 交付期间的重入。 */
    get adapter() {
      callbacks.adapter()
      return adapter
    },
    /** 空 provider 集合只表示没有实例就绪，不能据此建立任何 native 来源。 */
    readiness() {
      callbacks.readiness()
      return { policy_revision: 'isolated_policy', peer_policy_revision: 'isolated_policy', providers: [] }
    },
    /** 此生命周期 fixture 从不派发原生请求；意外调用必须立即失败。 */
    async executeWire() {
      throw new Error('unexpected_native_execution')
    },
    /** 所有者实际清理仍由 provider 交付，角色只计量失败。 */
    close() {
      return callbacks.resourceClose() as void
    }
  }
}

/** 用已有隔离身份 fixture 完成真实 authenticate/welcome，只验证角色资源，不调用 native 方法。 */
async function welcome(stage: Stage, cleanupFailure: CleanupFailure = 'none'): Promise<void> {
  const gateway = fixture()
  const paired = gateway.pair('isolated_provider_host')
  let runtime!: Awaited<ReturnType<typeof createProviderConnectorRuntime>>
  let callbackClose: Promise<void> | undefined
  let sessionCalls = 0
  let adapterCloses = 0
  let resourceCloses = 0
  let releases = 0

  /** 实际认证回调中的关闭必须与后续观察者使用同一个最终 Promise。 */
  function stopFromCallback(): void {
    callbackClose ??= runtime.close()
    assert.equal(runtime.close(), callbackClose)
  }

  try {
    runtime = await createProviderConnectorRuntime({
      transport: {
        url: gateway.gateway.url,
        developmentLoopback: true,
        credential: /** 只使用本 fixture 真实一次性配对后的合成设备凭据。 */ () => paired.credential,
        now: /** 设备通道共用 fixture 的可信时间，不给原生执行提供时间来源。 */ () => gateway.now,
        limits: { heartbeat_ms: 30, idle_ms: 1500, handshake_ms: 1000, reconnect_ms: 30, reconnect_max_ms: 30 }
      },
      /** 只有真实 welcome 才交付本机对应连接；provider 在返回前关闭也必须被工厂回收。 */
      session(connection) {
        sessionCalls++
        assert.equal(connection.authenticated, true)
        assert.equal(connection.machine_id, paired.machine_id)
        gateway.store.assertConnection(connection)
        const result = dummySession(connection, {
          /** 在读取已返回的 adapter 时重入关闭，不能继续注册该会话。 */
          adapter() {
            if (stage === 'adapter') {
              stopFromCallback()
            }
          },
          /** 注册后健康查询重入关闭，返回值不能让 stopped 变回 authenticated。 */
          readiness() {
            if (stage === 'readiness') {
              stopFromCallback()
            }
          },
          /** adapter 清理异常也须影响角色结果，同时不能阻止 resource 清理。 */
          adapterClose() {
            adapterCloses++
            if (cleanupFailure === 'adapter') {
              throw new Error(privateFailure)
            }
          },
          /** 逐次关闭 provider 所有者；非法异步返回也必须失败并消费其拒绝。 */
          resourceClose() {
            resourceCloses++
            if (cleanupFailure === 'resource') {
              throw new Error(privateFailure)
            }
            if (cleanupFailure === 'async_resource') {
              return Promise.reject(new Error(privateFailure))
            }
          }
        })
        if (stage === 'session') {
          stopFromCallback()
        }
        return result
      },
      /** 回滚及全部 epoch 资源同步回收后，才释放唯一长期所有者。 */
      async release() {
        releases++
        assert.equal(runtime.transport.status().phase, 'stopped')
        assert.equal(resourceCloses, sessionCalls)
        assert.equal(adapterCloses, sessionCalls)
        if (cleanupFailure === 'release') {
          throw new Error(privateFailure)
        }
      }
    })
    await until(/** 等待实际 welcome 而非 TCP 打开。 */ () => sessionCalls > 0)
    if (stage === 'reconnect') {
      gateway.gateway.disconnect(paired.machine_id)
      await until(/** 新 epoch 必须真正再次认证并创建独立 provider 会话。 */ () => sessionCalls === 2)
    }
    if (stage === 'none' || stage === 'reconnect') {
      callbackClose = runtime.close()
    } else {
      await until(/** session、adapter 或健康回调须实际触发关闭。 */ () => callbackClose !== undefined)
    }
    assert.equal(runtime.closed, callbackClose)
    assert.equal(runtime.close(), callbackClose)
    if (cleanupFailure === 'none') {
      await callbackClose
    } else {
      await assert.rejects(callbackClose!, failure('connector_runtime_close_failed'))
      await assert.rejects(runtime.closed, failure('connector_runtime_close_failed'))
    }
    assert.equal(sessionCalls, stage === 'reconnect' ? 2 : 1)
    assert.equal(adapterCloses, sessionCalls)
    assert.equal(resourceCloses, sessionCalls)
    assert.equal(releases, 1)
    assert.equal(runtime.transport.status().phase, 'stopped')
    assert.equal(gateway.executions, 0)
  } finally {
    try {
      await runtime?.close().catch(/** 已验证的关闭失败不阻止 fixture 释放自有 Gateway。 */ () => {})
    } finally {
      gateway.stop()
    }
  }
}

for (const stage of ['none', 'session', 'adapter', 'readiness', 'reconnect'] as const) {
  test(
    'provider Connector owns real welcome sessions across ' + stage + ' lifecycle',
    /** 各个真实回调边界都须维持最终 stopped、独立 epoch 和一次资源回收。 */ async () => welcome(stage)
  )
}

for (const cleanupFailure of ['adapter', 'resource', 'async_resource', 'release'] as const) {
  test(
    'provider Connector propagates ' + cleanupFailure + ' failure after welcome reentrant rollback',
    /** 关闭失败不能被 transport 的内部捕获或较早安排的成功 closed 覆盖。 */ async () =>
      welcome('session', cleanupFailure)
  )
}
