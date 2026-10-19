// 验证单帧 provider snapshot 的严格形状、认证方向、epoch 与可选协商；不构造原生可信来源。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decodeWireFrame,
  encodeWireFrame,
  negotiate,
  validateNegotiated,
  validateProviderSnapshot,
  LIMITS
} from '../../src/wire/index.js'
import type { AuthenticatedEnvelope, ProviderSnapshot } from '../../src/wire/index.js'
import { context, identity, provider, source, attempt } from './helpers.js'

/** 只生成传输元数据夹具；caps 实质与静态 pin 接纳由 runtime 另外核对。 */
function snapshot(): ProviderSnapshot {
  return {
    binding: structuredClone(provider),
    target: structuredClone(attempt.target),
    source: { ...source, runtime_generation: 'native_generation' },
    capabilities: {
      id: 'native_caps',
      result: { session: attempt.target.profile === 'session' ? attempt.target.session : '' }
    },
    capability_revision: 'a'.repeat(64)
  }
}
/** 已认证 epoch 明确协商新能力，codec 不为这个消息解析执行 attempt 或原生许可。 */
function setup() {
  const ctx = context('connector_to_gateway')
  assert(ctx.phase === 'authenticated')
  ctx.connection.negotiated.capabilities = ['rpc', 'provider_snapshot']
  const frame: Extract<AuthenticatedEnvelope, { type: 'provider_snapshot' }> = {
    protocol_major: 2,
    protocol_minor: 0,
    type: 'provider_snapshot',
    message_id: 'snapshot_1',
    ...identity,
    payload: snapshot()
  }
  return { ctx, frame }
}

test(
  'provider_snapshot 为显式可选 rpc 能力，默认广告和缺依赖不会隐式启用',
  /** 旧模式继续仅 rpc；双方不共同支持的必需快照能力拒绝握手。 */ () => {
    const old = { major: 2, minor: 0, capabilities: ['rpc'], required: ['rpc'] }
    const remote = { ...old, capabilities: ['rpc', 'provider_snapshot'] }
    assert.deepEqual(negotiate(old, remote).capabilities, ['rpc'])
    assert.deepEqual(negotiate(remote, remote).capabilities, ['provider_snapshot', 'rpc'])
    assert.throws(
      /** 没有 rpc 的选定结果不能接收来源快照。 */ () =>
        validateNegotiated({ major: 2, minor: 0, capabilities: ['provider_snapshot'] }),
      /invalid_capabilities/
    )
    assert.throws(
      /** 必需来源能力不静默降级为旧模式。 */ () =>
        negotiate(old, { ...remote, required: ['rpc', 'provider_snapshot'] }),
      /required_capability_unsupported/
    )
  }
)

test(
  '合法 snapshot 只在当前认证 Connector→Gateway 方向往返，不发执行许可',
  /** 完整 frame 限额与现行 epoch 相同，不能从 metadata 建立调用锚点。 */ () => {
    const { ctx, frame } = setup()
    const raw = encodeWireFrame(frame, ctx)
    assert.deepEqual(decodeWireFrame(raw, ctx), frame)
    assert.equal('attempt' in frame.payload, false)
    assert.throws(
      /** 来源不能借反方向发送。 */ () => decodeWireFrame(raw, { ...ctx, direction: 'gateway_to_connector' }),
      /wrong_direction/
    )
    assert.throws(
      /** preauth 输入没有来源接纳权限。 */ () =>
        decodeWireFrame(raw, { phase: 'preauth', direction: 'connector_to_gateway' }),
      /authentication_required|invalid_frame_fields/
    )
    assert.throws(
      /** 原 snapshot 不可迁入新 epoch。 */ () =>
        decodeWireFrame(JSON.stringify({ ...frame, connection_epoch: 'other_epoch' }), ctx),
      /connection_binding_mismatch/
    )
    const missing: typeof ctx = {
      ...ctx,
      connection: { ...ctx.connection, negotiated: { major: 2, minor: 0, capabilities: ['rpc'] } }
    }
    assert.throws(/** 未协商能力不解释此业务帧。 */ () => decodeWireFrame(raw, missing), /unsupported_capability/)
  }
)

test(
  'snapshot 严格限制单Luvus session、同机完整Target、source及SHA字段，不接收schema/permit扩展',
  /** 形状错误、伪造身份和未知扩展均在原 Wire 解码中拒绝。 */ () => {
    const { ctx, frame } = setup()
    const variants: unknown[] = [
      { ...frame.payload, schema: {} },
      { ...frame.payload, permit: {} },
      { ...frame.payload, authenticated: true },
      { ...frame.payload, binding: { ...frame.payload.binding, kind: 'herdr' } },
      { ...frame.payload, target: { ...frame.payload.target, machine_id: 'other' } },
      { ...frame.payload, target: { ...frame.payload.target, provider_id: 'other' } },
      {
        ...frame.payload,
        target: { machine_id: identity.machine_id, provider_id: provider.provider_id, profile: 'host' }
      },
      { ...frame.payload, source: { ...frame.payload.source, runtime_generation: null } },
      { ...frame.payload, source: { ...frame.payload.source, support_basis: 'schema_and_version' } },
      { ...frame.payload, capability_revision: 'not_a_sha' },
      { ...frame.payload, capabilities: [] }
    ]
    for (const payload of variants) {
      assert.throws(
        /** 每个坏快照都通过同一个 decoder 验证，不能只测辅助函数。 */ () =>
          decodeWireFrame(JSON.stringify({ ...frame, payload }), ctx)
      )
    }
    const foreign = snapshot()
    foreign.binding.machine_id = foreign.target.machine_id = 'another_machine'
    assert.throws(
      /** 本身同机仍不能冒充当前已认证机器。 */ () =>
        decodeWireFrame(JSON.stringify({ ...frame, payload: foreign }), ctx),
      /target_machine_mismatch/
    )
    assert.throws(
      /** capabilities 非普通有界JSON不能进入宿主。 */ () =>
        validateProviderSnapshot({ ...frame.payload, capabilities: { value: 'x'.repeat(LIMITS.frame_bytes) } })
    )
    assert.throws(
      /** 大 snapshot 不改原单frame预算。 */ () =>
        decodeWireFrame(
          JSON.stringify({
            ...frame,
            payload: { ...frame.payload, capabilities: { value: 'x'.repeat(LIMITS.frame_bytes) } }
          }),
          ctx
        )
    )
  }
)
