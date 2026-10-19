// 暴露 Wire v2 编解码入口；业务帧要求认证上下文，握手使用认证前上下文，不提供旧 v1 执行入口。
import { decodeWireFrame, encodeWireFrame } from './wire/codec.js'
import { WIRE_MAJOR, WIRE_MINOR } from './wire/negotiation.js'
import { LIMITS, fail } from './wire/validation.js'
import type { CodecContext, WireEnvelope } from './wire/types.js'

export const PROTOCOL_MAJOR = WIRE_MAJOR
export const PROTOCOL_MINOR = WIRE_MINOR
export const MAX_FRAME_BYTES = LIMITS.frame_bytes
export type Envelope = WireEnvelope
export type { Payloads } from './wire/types.js'
// 协议入口只支持 v2，不提供未发布 v1 的兼容解析或执行入口。
// 单独 epoch 无法证明认证来源，不能据此构造可执行上下文。
export function decodeFrame(input: string | Uint8Array, context: CodecContext | string): Envelope {
  if (typeof context === 'string') {
    fail('authenticated_context_required')
  }
  return decodeWireFrame(input, context)
}
// 要求调用方提供编解码上下文，再按 Wire v2 限制校验并序列化帧。
export function encodeFrame(frame: Envelope, context?: CodecContext): string {
  if (!context) {
    fail('authenticated_context_required')
  }
  return encodeWireFrame(frame, context)
}
