import { decodeWireFrame, encodeWireFrame } from './wire/codec.js';
import { WIRE_MAJOR, WIRE_MINOR } from './wire/negotiation.js';
import { LIMITS, fail } from './wire/validation.js';
import type { CodecContext, WireEnvelope } from './wire/types.js';

export const PROTOCOL_MAJOR = WIRE_MAJOR;
export const PROTOCOL_MINOR = WIRE_MINOR;
export const MAX_FRAME_BYTES = LIMITS.frame_bytes;
export type Envelope = WireEnvelope;
export type { Payloads } from './wire/types.js';
// 只给 epoch 的旧草稿调用无法证明认证来源，必须拒绝；保留名称便于调用方明确迁移。
export function decodeFrame(input: string | Uint8Array, context: CodecContext | string): Envelope {
  if (typeof context === 'string') fail('authenticated_context_required');
  return decodeWireFrame(input, context);
}
export function encodeFrame(frame: Envelope, context?: CodecContext): string {
  if (!context) fail('authenticated_context_required');
  return encodeWireFrame(frame, context);
}
