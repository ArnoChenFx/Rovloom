/** 真实认证 loopback/Store/Wire 加合成资源 getter；无真实设备配对或终端执行。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { fixture, rawConnect, until } from './helpers.js'
import { providerIsolationFixture } from './provider-isolation-helpers.js'
import { composeGatewaySessions } from '../../src/runtime/provider-sessions.js'

const offer = { major: 2, minor: 0, capabilities: ['rpc', 'terminal_execution_state'], required: ['rpc'] }

test(
  'local switch reports update on the same connection, deduplicate and vanish with their epoch',
  /** 观察值只供目录，原本机 guard 与原执行许可另行核验。 */ async () => {
    const f = fixture({
      offer,
      /** 实际生产组合层不得因为未协商隔离而丢失独立开关元数据。 */
      session(connection, channel) {
        return composeGatewaySessions(
          connection,
          [
            {
              providers: [{ binding, target: device.target }],
              session: f.session(connection, channel)
            }
          ],
          /** 与原 Store 相同的测试时钟。 */ () => f.now
        )
      }
    })
    const device = f.pair('synthetic_terminal_state')
    const binding = f.store.provider(device.machine_id, device.target.provider_id)!
    let enabled = false
    try {
      const client = f.connector(/** 仅使用 fixture 内存合成凭据。 */ () => device.credential, {
        offer,
        /** 原会话只增加合成观察 getter，不替换执行 adapter。 */
        session(connection) {
          return {
            ...f.session(connection),
            terminalExecutionState: /** 对本例唯一原配置报告开关。 */ () => [{ binding, enabled }]
          }
        }
      })
      await until(/** 收到真实认证帧才形成已关闭观察值。 */ () => f.gateway.terminalExecutionState(binding) === false)
      const epoch = client.status().connection_epoch
      enabled = true
      await until(
        /** 下一次原 tick 发布变更，不建立替代连接。 */ () => f.gateway.terminalExecutionState(binding) === true
      )
      await until(
        /** 至少两个心跳用于检验不变元数据去重。 */ () =>
          f.encoded.filter(/** 只统计协议心跳。 */ (raw) => JSON.parse(raw).type === 'heartbeat').length >= 4
      )
      const reports = f.encoded.filter(
        /** 只统计实际编码的观察帧。 */ (raw) => JSON.parse(raw).type === 'terminal_execution_state'
      )
      assert.equal(reports.length, 2)
      assert.equal(client.status().connection_epoch, epoch)
      assert.equal(f.gateway.terminalExecutionState({ ...binding, config_ref: 'other' }), undefined)
      client.stop()
      await until(/** 观察真实 socket 关闭。 */ () => f.gateway.status().connections === 0)
      assert.equal(f.gateway.terminalExecutionState(binding), undefined)
      const replacement = rawConnect(f.gateway.url, device.credential, offer)
      try {
        await until(/** 新 epoch 不继承上一连接的启用状态。 */ () => !!replacement.epoch)
        assert.notEqual(replacement.epoch, epoch)
        assert.equal(f.gateway.terminalExecutionState(binding), undefined)
      } finally {
        replacement.ws.close()
      }
      assert.equal(f.executions, 0)
    } finally {
      f.stop()
    }
  }
)

test(
  'unknown original provider binding cannot publish an enabled local switch',
  /** 合法机器认证不允许 metadata 补造 provider 或替换原配置。 */ async () => {
    const f = fixture({ offer })
    const device = f.pair('synthetic_terminal_mismatch')
    const binding = f.store.provider(device.machine_id, device.target.provider_id)!
    const raw = rawConnect(f.gateway.url, device.credential, offer)
    try {
      await until(/** 必须使用当前真实 welcome 的 epoch。 */ () => !!raw.epoch)
      raw.ws.send(
        JSON.stringify({
          protocol_major: 2,
          protocol_minor: 0,
          type: 'terminal_execution_state',
          message_id: randomUUID(),
          machine_id: device.machine_id,
          recovery_generation: device.credential.recovery_generation,
          connection_epoch: raw.epoch,
          payload: { binding: { ...binding, config_ref: 'other' }, enabled: true }
        })
      )
      await until(/** 错误完整绑定关闭当前连接。 */ () => raw.ws.readyState === WebSocket.CLOSED)
      assert.equal(f.gateway.terminalExecutionState(binding), undefined)
      assert.equal(f.executions, 0)
    } finally {
      raw.ws.close()
      f.stop()
    }
  }
)

test(
  'composed provider reports remain independent and a fence clears only the failed original binding',
  /** 双来源执行端口沿用明确合成 stub；本例完全不派发原生请求。 */ async () => {
    const switches = new Map([
      ['provider', true],
      ['second', false]
    ])
    const w = providerIsolationFixture(undefined, switches)
    const client = w.connect()
    const first = w.f.store.provider(w.device.machine_id, 'provider')!
    const second = w.f.store.provider(w.device.machine_id, 'second')!
    try {
      await until(
        /** 同一认证连接分别报告两个本地值。 */ () =>
          w.f.gateway.terminalExecutionState(first) === true && w.f.gateway.terminalExecutionState(second) === false
      )
      const epoch = client.status().connection_epoch
      w.state.connector.set('provider', false)
      await until(
        /** 撤回来源后启用观察立即失效，健康实例仍保持原值。 */ () =>
          w.f.gateway.terminalExecutionState(first) === undefined &&
          w.f.gateway.terminalExecutionState(second) === false
      )
      switches.set('provider', true)
      switches.set('second', true)
      await until(
        /** 健康原owner可更新观察，失效原owner不能由 getter 复活。 */ () =>
          w.f.gateway.terminalExecutionState(second) === true
      )
      assert.equal(w.f.gateway.terminalExecutionState(first), undefined)
      assert.equal(client.status().connection_epoch, epoch)
      assert.equal(client.status().reconnects, 0)
      assert.equal(w.state.executions.length, 0)
    } finally {
      w.stop()
    }
  }
)
