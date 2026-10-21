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
    'dispatch_refusal',
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
  '已失效 provider 的迟到 dispatch_refused 只作丢弃，不生成确定拒绝或恢复原请求许可',
  /** 固定拒绝仍须实际协商，不能接受任意错误码、跨 epoch 帧或其它来源。 */ () => {
    const ctx = authenticated()
    ctx.resolveAttempt = /** 丢弃路径不得重新建立原锚点或 permit。 */ () => {
      throw new Error('native_context_must_not_run')
    }
    const refusal = frame('dispatch_refused', { attempt, code: 'terminal_execution_disabled' })
    assert.equal(discardFencedWireFrame(JSON.stringify(refusal), ctx, [provider]), true)
    assert.equal(discardFencedWireFrame(JSON.stringify(refusal), ctx, [{ ...provider, provider_id: 'other' }]), false)
    rejects(
      /** 不协商确定拒绝能力时仍拒绝消息。 */ () => {
        const other = authenticated()
        other.connection.negotiated.capabilities = other.connection.negotiated.capabilities.filter(
          /** 去掉独立能力而保留隔离。 */ (capability) => capability !== 'dispatch_refusal'
        )
        discardFencedWireFrame(JSON.stringify(refusal), other, [provider])
      },
      'unsupported_capability'
    )
    rejects(
      /** 已失效也不放宽固定拒绝枚举。 */ () =>
        discardFencedWireFrame(
          JSON.stringify({ ...refusal, payload: { ...refusal.payload, code: 'arbitrary_error' } }),
          ctx,
          [provider]
        ),
      'invalid_enum'
    )
    rejects(
      /** 旧连接的迟到拒绝不能用于当前连接。 */ () =>
        discardFencedWireFrame(JSON.stringify({ ...refusal, connection_epoch: 'old_epoch' }), ctx, [provider]),
      'connection_binding_mismatch'
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
