// 逐实例失效仅收窄当前认证连接的来源，迟到数据丢弃不交付原生上下文或许可。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeWireFrame, discardFencedWireFrame, negotiate, validateNegotiated } from '../../src/wire/index.js'
import { attempt, context, frame, provider, rejects } from './helpers.js'

/** 固定只包含当前普通 RPC 治理能力；对象分片尚无逐 provider 路由。 */
function authenticated() {
  const ctx = context('connector_to_gateway')
  ctx.connection.negotiated.capabilities = [
    'rpc',
    'provider_fence',
    'provider_snapshot',
    'admission_receipt',
    'admission_context'
  ]
  return ctx
}

test(
  'provider_fence 必须显式协商 rpc，治理消息只携带原 binding 并受当前 epoch 约束',
  /** codec 不从失效消息创建新 provider；原 binding 的独立归属核对由 session 端口完成。 */ () => {
    const offer = { major: 2, minor: 0, capabilities: ['rpc', 'provider_fence'], required: ['rpc'] }
    assert.deepEqual(negotiate(offer, offer).capabilities, ['provider_fence', 'rpc'])
    rejects(
      /** 没有 RPC 不允许广告此扩展。 */ () =>
        validateNegotiated({ major: 2, minor: 0, capabilities: ['provider_fence'] }),
      'invalid_capabilities'
    )
    rejects(
      /** 未提供对象归属时拒绝无法兑现的隔离组合。 */ () =>
        validateNegotiated({ major: 2, minor: 0, capabilities: ['rpc', 'provider_fence', 'objects'] }),
      'unsupported_capability_combination'
    )
    const message = frame('provider_fenced', { binding: provider })
    for (const direction of ['connector_to_gateway', 'gateway_to_connector'] as const) {
      const ctx = authenticated()
      ctx.direction = direction
      assert.deepEqual(decodeWireFrame(JSON.stringify(message), ctx), message)
    }
    rejects(
      /** 普通 RPC 连接不会隐式启用失效消息。 */ () =>
        decodeWireFrame(JSON.stringify(message), context('connector_to_gateway')),
      'unsupported_capability'
    )
    rejects(
      /** 旧 epoch 不得封锁当前来源。 */ () =>
        decodeWireFrame(JSON.stringify({ ...message, connection_epoch: 'old_epoch' }), authenticated()),
      'connection_binding_mismatch'
    )
    rejects(
      /** 原生载荷不能藏入固定治理消息。 */ () =>
        decodeWireFrame(
          JSON.stringify({ ...message, payload: { ...message.payload, native_response: {} } }),
          authenticated()
        ),
      'invalid_frame_fields'
    )
  }
)

test(
  '已失效来源的迟到数据只能丢弃，不能生成结果、原生来源或执行许可',
  /** 故意提供不能通过原生 schema 的合成正文；返回值只能是丢弃布尔值。 */ () => {
    const ctx = authenticated()
    ctx.resolveAttempt = /** 丢弃路径不得恢复旧原请求上下文。 */ () => {
      throw new Error('native_context_must_not_run')
    }
    ctx.resolveNativeSource = /** 丢弃路径不得重新查询旧原生身份。 */ () => {
      throw new Error('native_source_must_not_run')
    }
    const response = frame('response', { attempt, native_response: { synthetic_invalid_native: true } })
    assert.equal(discardFencedWireFrame(JSON.stringify(response), ctx, [provider]), true)
    assert.equal(discardFencedWireFrame(JSON.stringify(response), ctx, [{ ...provider, provider_id: 'other' }]), false)
    assert.equal(discardFencedWireFrame(JSON.stringify(response), ctx, [{ ...provider, binding_revision: 2 }]), false)
    rejects(
      /** 即使来源已失效，错误的认证 epoch 仍是协议错误。 */ () =>
        discardFencedWireFrame(JSON.stringify({ ...response, connection_epoch: 'old_epoch' }), ctx, [provider]),
      'connection_binding_mismatch'
    )
    rejects(
      /** 已失效也不接受错外层字段或无界结构。 */ () =>
        discardFencedWireFrame(JSON.stringify({ ...response, unexpected: true }), ctx, [provider]),
      'invalid_frame_fields'
    )
  }
)
