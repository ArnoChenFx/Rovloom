import type { AttemptBinding, AuthenticatedEnvelope, CodecContext, StreamFeature } from './types.js';
import { assertBinding, decodeWireObject } from './codec.js';
import { boundedJson, LIMITS, fail, uint } from './validation.js';

export type StreamState = { binding: AttemptBinding; stream_id: string; feature: StreamFeature;
  state: 'opening' | 'open' | 'closed'; next_data_sequence: number; next_input_sequence: number };
// 仅维护外层流顺序；原生 generation/lease/ack 的状态必须由 native adapter 另行验证。
export function advanceStream(state: StreamState | undefined, frame: AuthenticatedEnvelope, context: CodecContext): StreamState {
  const valid = decodeWireObject(Buffer.from(boundedJson(frame, LIMITS.object_bytes)), context);
  if (!['stream_open', 'stream_data', 'stream_input', 'stream_close'].includes(valid.type)) fail('invalid_stream_transition');
  const p = valid.payload as Extract<AuthenticatedEnvelope, { type: 'stream_data' }>['payload'];
  const binding = { machine_id: valid.machine_id, recovery_generation: valid.recovery_generation,
    connection_epoch: valid.connection_epoch, ...p.attempt };
  if (!state) {
    if (valid.type !== 'stream_open') fail('stream_not_open');
    return { binding, stream_id: p.stream_id, feature: p.feature, state: 'opening', next_data_sequence: 0, next_input_sequence: 0 };
  }
  assertBinding(binding, state.binding);
  if (state.stream_id !== p.stream_id || (valid.type !== 'stream_close' && state.feature !== p.feature)) fail('stream_binding_mismatch');
  if (state.state === 'closed' || valid.type === 'stream_open') fail('invalid_stream_transition');
  if (valid.type === 'stream_close') return { ...state, state: 'closed' };
  uint(state.next_data_sequence); uint(state.next_input_sequence);
  const key = valid.type === 'stream_data' ? 'next_data_sequence' : 'next_input_sequence';
  if (valid.type === 'stream_input' && state.state !== 'open') fail('stream_not_ready');
  if (p.sequence !== state[key] || !Number.isSafeInteger(state[key] + 1)) fail('stream_sequence_mismatch');
  return { ...state, state: 'open', [key]: state[key] + 1 };
}
