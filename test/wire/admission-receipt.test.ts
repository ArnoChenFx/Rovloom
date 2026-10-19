// 验证可选认证 receipt 的方向、协商、完整绑定及规范摘要；元数据校验不能建立执行锚点。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  admissionRequestDigest,
  admissionRegisteredRequestDigest,
  decodeWireFrame,
  encodeWireFrame,
  negotiate,
  validateNegotiated
} from '../../src/wire/index.js'
import { attempt, binding, context, frame, request } from './helpers.js'

test(
  'admission context is a separate optional capability and requires complete original metadata',
  /** 旧 receipt 不隐式升级；新能力依赖 rpc/receipt 且同帧 context 必须完整。 */ () => {
    const offered = {
      major: 2,
      minor: 0,
      capabilities: ['rpc', 'admission_receipt', 'admission_context'],
      required: ['rpc']
    }
    assert.deepEqual(negotiate(offered, { ...offered, capabilities: ['rpc', 'admission_receipt'] }).capabilities, [
      'admission_receipt',
      'rpc'
    ])
    assert.throws(
      /** 缺 receipt 的孤立 context 无效。 */ () =>
        validateNegotiated({ major: 2, minor: 0, capabilities: ['rpc', 'admission_context'] }),
      /invalid_capabilities/
    )
    const ctx = context()
    ctx.connection.negotiated.capabilities.push('admission_receipt', 'admission_context')
    const input = {
      binding,
      native_request: { method: 'task.add', params: { title: 'synthetic' } },
      validation: 'strict' as const
    }
    const receipt = frame('admission_receipt', {
      attempt,
      request_sha256: admissionRequestDigest(input),
      dedup_expires_at: 2000
    })
    assert.throws(
      /** 新能力已协商时不能降为 cutoff-only。 */ () => decodeWireFrame(JSON.stringify(receipt), ctx),
      /admission_context_required/
    )
    const full = {
      ...receipt,
      payload: {
        ...receipt.payload,
        context: {
          principal_id: 'synthetic',
          registered_request_sha256: admissionRegisteredRequestDigest(input, 'synthetic'),
          sequence: 1,
          fenced: false,
          anchor: {
            binding,
            method: 'task.add',
            mode: 'strict' as const,
            state: 'dispatching' as const,
            content_status: 'available' as const,
            content_expires_at: 1500,
            dedup_expires_at: 2000
          }
        }
      }
    }
    assert.equal(decodeWireFrame(encodeWireFrame(full, ctx), ctx).type, 'admission_receipt')
    const mismatch = structuredClone(full)
    mismatch.payload.context.anchor.dedup_expires_at++
    assert.throws(
      /** 内外原 dedup 截止必须完全相同。 */ () => decodeWireFrame(JSON.stringify(mismatch), ctx),
      /admission_context_mismatch/
    )
    ctx.connection.negotiated.capabilities = ['rpc', 'admission_receipt']
    assert.throws(
      /** 只协商旧能力时附加 context 必须拒绝。 */ () => decodeWireFrame(JSON.stringify(full), ctx),
      /unsupported_capability/
    )
  }
)

test(
  'admission receipt is optional, depends on rpc and requires both peers to advertise it',
  /** 旧默认只选 rpc，新 required 无交集必须拒绝，minor 不自动开启新能力。 */ () => {
    const offered = { major: 2, minor: 0, capabilities: ['rpc', 'admission_receipt'], required: ['rpc'] }
    const old = { major: 2, minor: 0, capabilities: ['rpc'], required: ['rpc'] }
    assert.deepEqual(negotiate(offered, old).capabilities, ['rpc'])
    assert.deepEqual(negotiate(offered, offered).capabilities, ['admission_receipt', 'rpc'])
    assert.throws(
      /** 新安全宿主要求 receipt 时不能默默降级。 */ () =>
        negotiate({ ...offered, required: ['rpc', 'admission_receipt'] }, old),
      /required_capability_unsupported/
    )
    assert.throws(
      /** 元数据能力不能离开普通 RPC 协议单独使用。 */ () =>
        validateNegotiated({ major: 2, minor: 0, capabilities: ['admission_receipt'] }),
      /invalid_capabilities/
    )
  }
)

test(
  'a receipt uses original authenticated Wire checks without creating or resolving a native permit',
  /** 独立 receipt 在请求锚点尚不存在时可传递，但不能令普通 request 越过原 resolver。 */ () => {
    const ctx = context()
    ctx.connection.negotiated.capabilities.push('admission_receipt')
    ctx.resolveAttempt = /** receipt 不应访问此入口；普通请求仍必须失败。 */ () => {
      throw new Error('no_native_permit')
    }
    const receipt = frame('admission_receipt', { attempt, request_sha256: 'a'.repeat(64), dedup_expires_at: 2000 })
    assert.equal(decodeWireFrame(encodeWireFrame(receipt, ctx), ctx).type, 'admission_receipt')
    assert.throws(
      /** 只收到元数据没有独立执行锚点，不构成 request 的许可。 */ () => decodeWireFrame(JSON.stringify(request), ctx),
      /no_native_permit/
    )
    const wrongEpoch = { ...receipt, connection_epoch: 'other_epoch' }
    assert.throws(
      /** 当前认证 socket 不能导入另一个 epoch 的截止。 */ () => decodeWireFrame(JSON.stringify(wrongEpoch), ctx),
      /connection_binding_mismatch/
    )
    assert.throws(
      /** Connector 不能向 Gateway 回传该专用元数据帧。 */ () =>
        decodeWireFrame(JSON.stringify(receipt), { ...ctx, direction: 'connector_to_gateway' }),
      /wrong_direction/
    )
    ctx.connection.negotiated.capabilities = ctx.connection.negotiated.capabilities.filter(
      /** 撤去本测试显式启用的新能力。 */ (cap) => cap !== 'admission_receipt'
    )
    assert.throws(
      /** 未协商能力时同形 JSON 仍拒绝。 */ () => decodeWireFrame(JSON.stringify(receipt), ctx),
      /unsupported_capability/
    )
  }
)

test(
  'receipt rejects invalid cutoff and hash while canonical digest covers all nested request fields',
  /** 完整 binding、模式和原生正文都参与摘要；只改变属性顺序不能改变规范摘要。 */ () => {
    const ctx = context()
    ctx.connection.negotiated.capabilities.push('admission_receipt')
    const receipt = frame('admission_receipt', { attempt, request_sha256: 'a'.repeat(64), dedup_expires_at: 999 })
    assert.throws(
      /** 去重原截止必须覆盖固定执行 deadline。 */ () => decodeWireFrame(JSON.stringify(receipt), ctx),
      /admission_receipt_deadline_invalid/
    )
    receipt.payload.dedup_expires_at = 2000
    receipt.payload.request_sha256 = 'not_a_hash'
    assert.throws(
      /** 摘要只接受规范小写 SHA-256。 */ () => decodeWireFrame(JSON.stringify(receipt), ctx),
      /invalid_digest/
    )
    const first = {
      binding,
      validation: 'strict' as const,
      native_request: { method: 'task.add', params: { a: 1, nested: { x: 1, y: 2 } } }
    }
    const reordered = {
      native_request: { params: { nested: { y: 2, x: 1 }, a: 1 }, method: 'task.add' },
      validation: 'strict' as const,
      binding: structuredClone(binding)
    }
    assert.equal(admissionRequestDigest(first), admissionRequestDigest(reordered))
    assert.notEqual(admissionRequestDigest(first), admissionRequestDigest({ ...first, validation: 'raw-contract' }))
    assert.notEqual(
      admissionRequestDigest(first),
      admissionRequestDigest({ ...first, binding: { ...binding, connection_epoch: 'other' } })
    )
    assert.throws(
      /** caller 不能在正文里提供原生 auth 或 id。 */ () =>
        admissionRequestDigest({ ...first, native_request: { ...first.native_request, auth: 'caller' } }),
      /reserved_request_field/
    )
  }
)
