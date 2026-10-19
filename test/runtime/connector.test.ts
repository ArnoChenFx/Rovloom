// 检查 Connector 角色工厂的异步启动清理、长期关闭及释放失败语义，不创建真实设备身份。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConnectorRuntime } from '../../src/runtime/connector.js'
import type { ConnectorRuntimeOptions } from '../../src/runtime/types.js'
import { join } from 'node:path'
import { LuvusBoundDelegation, LuvusDispatchClaims } from '../../src/connector/luvus/index.js'
import { fixture as localFixture } from '../connector/luvus/helpers.js'
import { fixture as transportFixture, until } from '../transport/helpers.js'

/** 构造没有接收端的 loopback transport，使关闭测试不依赖生产网络或凭据。 */
function options(release: ConnectorRuntimeOptions['release']): ConnectorRuntimeOptions {
  return {
    transport: {
      url: 'ws://127.0.0.1:1/connector',
      developmentLoopback: true,
      credential: /** 自有测试身份仅用于不存在接收端的 loopback。 */ () => ({
        machine_id: 'm1',
        recovery_generation: 'r1',
        credential: 'fixture-only'
      })
    },
    session: /** 没有 Gateway，若错误建立会话则立即暴露测试失败。 */ () => {
      throw new Error('unexpected session')
    },
    release
  }
}

test(
  'Connector runtime close is shared, stops transport before release and releases once',
  /** 并发关闭持有同一 promise，资源释放时已禁止重连。 */ async () => {
    let releases = 0
    const runtime = await createConnectorRuntime(
      options(
        /** 检查释放顺序及唯一释放次数。 */ async () => {
          releases++
          assert.equal(runtime.transport.status().phase, 'stopped')
        }
      )
    )
    const first = runtime.close()
    assert.equal(runtime.close(), first)
    assert.equal(runtime.closed, first)
    await first
    assert.equal(releases, 1)
    assert.equal(runtime.close(), first)
  }
)

test(
  'Connector runtime release failure rejects the same closed result and is not retried',
  /** 失败关闭仍保持 stopped，并使所有观察者得到一致失败。 */ async () => {
    let releases = 0
    const runtime = await createConnectorRuntime(
      options(
        /** 注入不含秘密的测试释放失败。 */ async () => {
          releases++
          throw new Error('fixture failure')
        }
      )
    )
    await assert.rejects(runtime.close(), /connector_runtime_close_failed/)
    await assert.rejects(runtime.closed, new RegExp('connector_runtime_close_failed'))
    assert.equal(releases, 1)
    assert.equal(runtime.transport.status().phase, 'stopped')
  }
)

test(
  'Connector runtime rejects invalid startup only after completing owner release',
  /** 配置在 socket 前失败也必须等长期资源释放完成。 */ async () => {
    let released = false
    const input = options(
      /** 标记 startup 失败后的所有者释放。 */ async () => {
        released = true
      }
    )
    await assert.rejects(
      createConnectorRuntime({ ...input, transport: { ...input.transport, url: 'invalid' } }),
      new RegExp('connector_runtime_start_failed')
    )
    assert.equal(released, true)
  }
)

type ReentrantStage = 'session' | 'connection' | 'wire' | 'rpc' | 'readiness'

/** 通过真实 authenticate/welcome 回调重入关闭；本机安装、原生权限和设备身份仅属隔离 fixture。 */
async function welcomeReentry(stage: ReentrantStage, lazy = false, failingClose = false): Promise<void> {
  const native = await localFixture()
  const gateway = transportFixture()
  const paired = gateway.pair('isolated_reentrant_connector')
  const claims = new LuvusDispatchClaims({
    path: join(native.root, 'reentrant-claims.db'),
    mode: 'create',
    ledger_id: 'isolated_reentrant_claims',
    limits: { entries: 128, bytes: 1_048_576 },
    now: /** 本回归不派发，仍使用 fixture 的单调可信时间。 */ () => native.state.now
  })
  let runtime!: Awaited<ReturnType<typeof createConnectorRuntime>>
  let callbackClose: Promise<void> | undefined
  let sessionCalls = 0
  let resourceCloses = 0
  let delegationCloses = 0
  let lazyCalls = 0
  let subscriptions = 0
  let unsubscribes = 0
  let releases = 0
  let direct: LuvusBoundDelegation | undefined

  /** 只在已分配真实 epoch 的回调栈内关闭；重入观察者必须共享同一个完成结果。 */
  function stopFromCallback(): void {
    callbackClose ??= runtime.close()
    assert.equal(runtime.close(), callbackClose)
  }

  /** 给直接交付对象计量关闭，不从 lazy 关闭路径补造委托。 */
  function delegation(): LuvusBoundDelegation {
    const value = new LuvusBoundDelegation({
      config_ref: native.config.config_ref,
      binding: native.native,
      scopes: ['read', 'orchestration'],
      methods: ['task.add'],
      token: 'isolated_reentry_token',
      issued_at: native.state.now,
      expires_at: native.state.now + 60_000
    })
    const close = value.close.bind(value)
    value.close = /** 保留真实 token 清理，同时计量工厂关闭次数。 */ () => {
      delegationCloses++
      close()
    }
    return value
  }

  try {
    runtime = await createConnectorRuntime({
      transport: {
        url: gateway.gateway.url,
        developmentLoopback: true,
        credential: /** 使用真实配对结果完成隔离设备认证。 */ () => paired.credential,
        now: /** 与 Gateway fixture 的可信时钟保持一致。 */ () => gateway.now,
        limits: { heartbeat_ms: 30, idle_ms: 1500, handshake_ms: 1000, reconnect_ms: 100 }
      },
      /** welcome 只有经过实际认证才交付 connection；关闭回调仍返回需要清理的资源。 */
      session(connection) {
        sessionCalls++
        assert.equal(connection.authenticated, true)
        assert.equal(connection.machine_id, paired.machine_id)
        gateway.store.assertConnection(connection)
        const backend = {
          ...native.backend,
          /** 连接复核也是可同步重入的宿主回调，不能在返回后继续装配。 */
          connection() {
            if (stage === 'connection') {
              stopFromCallback()
            }
            return connection
          },
          /** 实际 Wire/RPC 构造各安装一次订阅，复验失败必须将已建资源全部退订。 */
          subscribeInvalidation() {
            subscriptions++
            if ((stage === 'wire' && subscriptions === 1) || (stage === 'rpc' && subscriptions === 2)) {
              stopFromCallback()
            }
            return /** 每个真实 adapter 关闭都须释放自己的订阅。 */ () => {
              unsubscribes++
            }
          }
        }
        if (!lazy) {
          direct = delegation()
        }
        const resource: ReturnType<ConnectorRuntimeOptions['session']> = {
          backend,
          config: { ...native.config, transport: 'ipc' },
          delegation: lazy
            ? /** 关闭阶段绝不应为了清理而调用此入口。 */ () => {
                lazyCalls++
                return delegation()
              }
            : direct!,
          claims,
          verifyPeer: native.host.verifyPeer!,
          dedupExpires: /** 无请求，任何固定截止查询都表示错误派发。 */ () => {
            throw new Error('unexpected_dedup')
          },
          assertEvidence: /** 无请求，不能进入原生证据检查。 */ () => {
            throw new Error('unexpected_native_evidence')
          },
          /** 注册后的健康回调关闭也必须使返回值失效，并清理已注册 session。 */
          readiness() {
            if (stage === 'readiness') {
              stopFromCallback()
            }
            return { policy_revision: 'isolated', peer_policy_revision: 'isolated', providers: [] }
          },
          /** 真实资源返回后即归角色所有；清理失败必须影响同一个 closed 结果。 */
          close() {
            resourceCloses++
            if (failingClose) {
              throw new Error('isolated_resource_close_failure')
            }
          }
        }
        if (stage === 'session') {
          stopFromCallback()
        }
        return resource
      },
      /** 长期资源释放只能发生在同步构建回滚完成之后。 */
      async release() {
        releases++
        assert.equal(resourceCloses, 1)
        assert.equal(subscriptions, unsubscribes)
        assert.equal(delegationCloses, lazy ? 0 : 1)
        claims.close()
      }
    })
    await until(/** 真实 welcome 或后续宿主回调必须实际触发关闭。 */ () => callbackClose !== undefined)
    if (failingClose) {
      await assert.rejects(callbackClose!, /connector_runtime_close_failed/)
      await assert.rejects(runtime.closed, /connector_runtime_close_failed/)
    } else {
      await callbackClose
      await runtime.closed
    }
    assert.equal(runtime.close(), callbackClose)
    assert.equal(sessionCalls, 1)
    assert.equal(resourceCloses, 1)
    assert.equal(releases, 1)
    assert.equal(lazyCalls, 0)
    assert.equal(delegationCloses, lazy ? 0 : 1)
    assert.equal(subscriptions, stage === 'session' || stage === 'connection' ? 0 : stage === 'wire' ? 1 : 2)
    assert.equal(unsubscribes, subscriptions)
    assert.equal(runtime.transport.status().phase, 'stopped')
    assert.equal(native.state.responses, 0)
    if (direct) {
      assert.throws(
        /** 直接交付且未使用的委托也已不可逆关闭。 */ () =>
          direct!.read(
            { config_ref: native.config.config_ref, binding: native.native },
            native.source(),
            'task.add',
            native.state.now
          ),
        /native_delegation_unavailable/
      )
    }
  } finally {
    try {
      await runtime?.close().catch(/** 失败关闭已经在断言中验证，清理阶段继续停止隔离资源。 */ () => {})
    } finally {
      claims.close()
      gateway.stop()
      await native.close()
    }
  }
}

for (const stage of ['session', 'connection', 'wire', 'rpc', 'readiness'] as const) {
  test(
    'Connector cleans resources when a real welcome ' + stage + ' callback reenters close',
    /** 各个真实构建边界都必须回收返回的直接委托、Wire/RPC 和宿主资源。 */ async () => welcomeReentry(stage)
  )
}

test(
  'Connector welcome reentry does not resolve an unused lazy delegation',
  /** session 回调返回 lazy 资源时，同步关闭只清理所有者而不创建 token。 */ async () => welcomeReentry('session', true)
)

test(
  'Connector welcome reentry cleanup failure rejects the original closed result',
  /** 回调重入后的清理错误不能被先前安排的成功 closed 覆盖。 */ async () => welcomeReentry('session', false, true)
)
