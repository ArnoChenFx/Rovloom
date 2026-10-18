import { canonical, GatewayError, validateRequest, validateTarget } from '../contracts.js';
import type { NativeRequest, Target } from '../contracts.js';

export const PROTOCOL_MAJOR = 1;
export const PROTOCOL_MINOR = 0;
export const MAX_FRAME_BYTES = 1_048_576;

type Correlation = { call_id: string; attempt_id: string };
export type Payloads = {
  request: Correlation & { target: Target; request: NativeRequest; deadline: number };
  accepted: Correlation;
  response: Correlation & { uhp_response: Record<string, unknown> };
  cancel: Correlation;
  heartbeat: { sequence: number };
};
export type Envelope = {
  [K in keyof Payloads]: {
    protocol_major: number;
    protocol_minor: number;
    type: K;
    message_id: string;
    connection_epoch: string;
    payload: Payloads[K];
  };
}[keyof Payloads];

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new GatewayError('invalid_frame');
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((k) => !Object.hasOwn(value, k))) {
    throw new GatewayError('invalid_frame_fields');
  }
}
function identifier(value: unknown): void {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value))
    throw new GatewayError('invalid_frame_id');
}

// 只解析认证完成后的业务帧；配对和认证握手不得混入本边界。
function decodeFrame(input: string, expectedEpoch: string): Envelope {
  if (typeof input !== 'string' || Buffer.byteLength(input) > MAX_FRAME_BYTES)
    throw new GatewayError('frame_limit');
  let decoded: unknown;
  try {
    decoded = JSON.parse(input);
  } catch {
    throw new GatewayError('invalid_frame_json');
  }
  canonical(decoded);
  const frame = object(decoded);
  fields(frame, [
    'protocol_major',
    'protocol_minor',
    'type',
    'message_id',
    'connection_epoch',
    'payload',
  ]);
  if (frame.protocol_major !== PROTOCOL_MAJOR || frame.protocol_minor !== PROTOCOL_MINOR) {
    throw new GatewayError('protocol_version_unsupported');
  }
  identifier(frame.message_id);
  identifier(frame.connection_epoch);
  if (frame.connection_epoch !== expectedEpoch) throw new GatewayError('stale_epoch');
  const payload = object(frame.payload);
  if (frame.type === 'heartbeat') {
    fields(payload, ['sequence']);
    if (!Number.isSafeInteger(payload.sequence) || (payload.sequence as number) < 0)
      throw new GatewayError('invalid_sequence');
  } else {
    identifier(payload.call_id);
    identifier(payload.attempt_id);
    switch (frame.type) {
      case 'accepted':
      case 'cancel':
        fields(payload, ['call_id', 'attempt_id']);
        break;
      case 'request': {
        fields(payload, ['call_id', 'attempt_id', 'target', 'request', 'deadline']);
        const target = object(payload.target);
        fields(
          target,
          target.profile === 'host'
            ? ['machine_id', 'profile']
            : ['machine_id', 'profile', 'session'],
        );
        validateTarget(target as Target);
        validateRequest(object(payload.request) as NativeRequest);
        if (!Number.isSafeInteger(payload.deadline) || (payload.deadline as number) <= 0)
          throw new GatewayError('invalid_deadline');
        break;
      }
      case 'response': {
        fields(payload, ['call_id', 'attempt_id', 'uhp_response']);
        const response = object(payload.uhp_response);
        // 不改写原生错误和扩展字段，也不把网关错误伪造成原生响应。
        if (Object.hasOwn(response, 'result') === Object.hasOwn(response, 'error'))
          throw new GatewayError('invalid_native_response');
        break;
      }
      default:
        throw new GatewayError('unsupported_frame_type');
    }
  }
  return decoded as Envelope;
}

// 旧基础层记录的严格只读审计；不产生 v2 执行上下文或默认 provider。
export function decodeFoundationV1History(input: string, expectedEpoch: string) {
  return {
    read_only: true as const,
    provider_resolution: 'unresolved' as const,
    frame: decodeFrame(input, expectedEpoch),
  };
}
