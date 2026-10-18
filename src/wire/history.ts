import type { HistoryReference, RequestPayload } from './types.js';
import { validateAttempt } from './codec.js';
import {
  boundedJson,
  fields,
  object,
  id,
  uint,
  sha,
  fail,
  hash,
  parseJson,
  text,
  oneOf,
} from './validation.js';

// 对已经登记的 v2 意图作摘要；caller 来源及 key 查询仍须由 #5 可信事务提供。
export function registeredRequestDigest(payload: RequestPayload, callerId: string): string {
  id(callerId);
  const p = object(parseJson(boundedJson(payload)));
  fields(p, ['attempt', 'expected_binding_revision', 'native_request', 'validation']);
  validateAttempt(p.attempt);
  uint(p.expected_binding_revision, true);
  oneOf(p.validation, ['strict', 'raw-contract']);
  if (p.expected_binding_revision !== p.attempt.binding_revision) fail('provider_binding_mismatch');
  const r = object(p.native_request);
  text(r.method, 256);
  if (Object.hasOwn(r, 'id') || Object.hasOwn(r, 'auth')) fail('reserved_request_field');
  return hash(
    boundedJson({
      wire_major: 2,
      caller_id: callerId,
      target: p.attempt.target,
      expected_binding_revision: p.expected_binding_revision,
      provider_kind: p.attempt.provider_kind,
      contract_ref: p.attempt.contract_ref,
      registration: p.attempt.registration,
      validation: p.validation,
      native_request: r,
    }),
  );
}

export type HistoryScope = {
  history_epoch: string;
  recovery_generation: string;
  status: 'active' | 'retired';
  scope_created_at: number;
  accept_new_until: number;
  frozen_dedup_ttl: number;
};
export type HistoryRecord = {
  history_epoch: string;
  recovery_generation: string;
  key_digest: string;
  request_digest: string;
  call_id: string;
  call_created_at: number;
  dedup_expires_at: number;
};
export type HistoryDecision =
  | { action: 'return_existing'; call_id: string }
  | { action: 'register_new'; dedup_expires_at: number };
// scope/key 查询及本判断必须由 #5 在同一 writer 事务内使用；不发放范围、不改绑旧重试。
export function planHistoryAdmission(
  reference: HistoryReference,
  generation: string,
  requestDigest: string,
  scope: HistoryScope | undefined,
  record: HistoryRecord | undefined,
  now: number,
): HistoryDecision {
  const r = object(reference);
  fields(r, ['history_epoch', 'client_request_key']);
  id(r.history_epoch);
  id(r.client_request_key);
  id(generation);
  sha(requestDigest);
  uint(now);
  if (!scope) fail('dedup_history_unavailable');
  id(scope.history_epoch);
  id(scope.recovery_generation);
  if (scope.history_epoch !== reference.history_epoch || scope.recovery_generation !== generation)
    fail('dedup_history_unavailable');
  uint(scope.scope_created_at);
  uint(scope.accept_new_until, true);
  uint(scope.frozen_dedup_ttl, true);
  if (
    !['active', 'retired'].includes(scope.status) ||
    scope.accept_new_until <= scope.scope_created_at ||
    !Number.isSafeInteger(scope.scope_created_at + scope.frozen_dedup_ttl) ||
    scope.accept_new_until > scope.scope_created_at + scope.frozen_dedup_ttl
  )
    fail('invalid_history_scope');
  if (now < scope.scope_created_at) fail('clock_untrusted');
  if (record) {
    id(record.call_id);
    uint(record.call_created_at);
    uint(record.dedup_expires_at, true);
    sha(record.key_digest);
    sha(record.request_digest);
    if (
      record.history_epoch !== reference.history_epoch ||
      record.recovery_generation !== generation ||
      record.key_digest !== hash(reference.client_request_key)
    )
      fail('history_record_mismatch');
    if (
      record.call_created_at < scope.scope_created_at ||
      record.call_created_at >= scope.accept_new_until ||
      record.dedup_expires_at !== record.call_created_at + scope.frozen_dedup_ttl
    )
      fail('invalid_history_record');
    if (now < record.call_created_at) fail('clock_untrusted');
    if (now >= record.dedup_expires_at) fail('dedup_history_unavailable');
    if (record.request_digest !== requestDigest) fail('request_key_conflict');
    return { action: 'return_existing', call_id: record.call_id };
  }
  if (scope.status !== 'active' || now >= scope.accept_new_until) fail('dedup_history_unavailable');
  const dedup_expires_at = now + scope.frozen_dedup_ttl;
  if (!Number.isSafeInteger(dedup_expires_at)) fail('invalid_history_scope');
  return { action: 'register_new', dedup_expires_at };
}
