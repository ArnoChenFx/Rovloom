// 检查 Connector 角色工厂的异步启动清理、长期关闭及释放失败语义，不创建真实设备身份。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConnectorRuntime } from '../../src/runtime/connector.js'
import type { ConnectorRuntimeOptions } from '../../src/runtime/types.js'

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
