import type { JsonObject } from './types.js';
import { fields, object, id, oneOf, uint, parseJson, fail } from './validation.js';

export type HistoricalV1 = {
  read_only: true;
  provider_resolution: 'unresolved';
  frame: JsonObject;
};
// 仅读取 v1 已保存记录，既不分配默认 provider，也不返回可供 v2 执行的 envelope/context。
export function decodeHistoricalV1(input: string | Uint8Array): HistoricalV1 {
  const f = object(parseJson(input));
  if (f.protocol_major !== 1 || f.protocol_minor !== 0) fail('historical_version_unsupported');
  oneOf(f.type, [
    'enroll',
    'authenticate',
    'welcome',
    'request',
    'accepted',
    'response',
    'cancel',
    'heartbeat',
    'stream_open',
    'stream_data',
    'stream_input',
    'stream_close',
    'error',
    'object_chunk',
  ]);
  id(f.message_id);
  const base = ['protocol_major', 'protocol_minor', 'type', 'message_id', 'payload'];
  const bound = Object.hasOwn(f, 'machine_id');
  fields(
    f,
    bound
      ? [...base, 'machine_id', 'recovery_generation', 'connection_epoch']
      : Object.hasOwn(f, 'connection_epoch')
        ? [...base, 'connection_epoch']
        : base,
  );
  if (Object.hasOwn(f, 'connection_epoch')) id(f.connection_epoch);
  if (bound) {
    id(f.machine_id);
    id(f.recovery_generation);
  }
  const p = object(f.payload);
  if (Object.hasOwn(p, 'attempt')) {
    const a = object(p.attempt);
    fields(a, [
      'call_id',
      'attempt_id',
      'native_request_id',
      'target',
      'contract_revision',
      'contract_digest',
    ]);
    id(a.call_id);
    id(a.attempt_id);
    const t = object(a.target);
    oneOf(t.profile, ['host', 'session']);
    fields(
      t,
      t.profile === 'host' ? ['machine_id', 'profile'] : ['machine_id', 'profile', 'session'],
    );
    id(t.machine_id);
  }
  // 历史读取只验证封装和旧目标形状，不把旧 payload 称作当前原生/分类验证通过。
  if (f.type === 'heartbeat') {
    fields(p, ['sequence']);
    uint(p.sequence);
  }
  return { read_only: true, provider_resolution: 'unresolved', frame: f };
}
