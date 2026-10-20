/** 合成观察值只验证认证 Wire 协商、方向和形状，不建立原生执行许可。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeWireFrame, encodeWireFrame, negotiate, validateNegotiated } from '../../src/wire/index.js'
import type { VersionOffer } from '../../src/wire/types.js'
import { context, frame, provider } from './helpers.js'

const offer: VersionOffer = { major: 2, minor: 0, capabilities: ['rpc', 'terminal_execution_state'], required: ['rpc'] }

test(
  'terminal execution metadata is optional RPC state scoped to the authenticated machine and epoch',
  /** 旧客户端保持可连接；只允许本 epoch Connector 发布明确布尔值，不接收请求/环境扩展。 */ () => {
    const ctx = context('connector_to_gateway')
    ctx.connection.negotiated.capabilities = ['rpc', 'terminal_execution_state']
    const message = frame('terminal_execution_state', { binding: provider, enabled: false })
    const raw = encodeWireFrame(message, ctx)
    assert.deepEqual(decodeWireFrame(raw, ctx), message)
    assert.deepEqual(negotiate(offer, { ...offer, capabilities: ['rpc'] }).capabilities, ['rpc'])
    assert.throws(
      /** 元数据不独立于现有 RPC 通道工作。 */ () =>
        validateNegotiated({ major: 2, minor: 0, capabilities: ['terminal_execution_state'] }),
      /invalid_capabilities/
    )
    assert.throws(
      /** 反方向不能伪造机器本地开关。 */ () => decodeWireFrame(raw, { ...ctx, direction: 'gateway_to_connector' }),
      /wrong_direction/
    )
    assert.throws(
      /** 未协商的新消息保持拒绝。 */ () => decodeWireFrame(raw, context('connector_to_gateway')),
      /unsupported_capability/
    )
    assert.throws(
      /** 不借新连接恢复旧观察值。 */ () =>
        decodeWireFrame(JSON.stringify({ ...message, connection_epoch: 'old' }), ctx),
      /connection_binding_mismatch/
    )
    for (const payload of [
      { binding: provider, enabled: 'true' },
      { binding: provider },
      { binding: provider, enabled: null },
      { binding: provider, enabled: true, permission: true },
      { binding: { ...provider, machine_id: 'another_machine' }, enabled: true }
    ]) {
      assert.throws(
        /** 接收路径逐个拒绝隐式开启、跨机器和任意扩展。 */ () =>
          decodeWireFrame(JSON.stringify({ ...message, payload }), ctx)
      )
    }
  }
)
