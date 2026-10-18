import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planHistoryAdmission, planResponseEvidence, MessageWindow, hash, boundedJson } from '../../src/wire/index.js'
import type { HistoryScope, HistoryRecord, ResponseAnchor } from '../../src/wire/index.js'
import { response, binding, context, rejects, frame } from './helpers.js'

const reference = { history_epoch: 'history_1', client_request_key: 'key_1' }
const scope: HistoryScope = {
  history_epoch: reference.history_epoch,
  recovery_generation: binding.recovery_generation,
  scope_created_at: 100,
  accept_new_until: 200,
  frozen_dedup_ttl: 1000,
  status: 'active'
}
const record: HistoryRecord = {
  history_epoch: reference.history_epoch,
  recovery_generation: binding.recovery_generation,
  key_digest: hash(reference.client_request_key),
  request_digest: 'b'.repeat(64),
  call_id: binding.call_id,
  call_created_at: 150,
  dedup_expires_at: 1150
}
const admit = (now: number, s: HistoryScope | undefined = scope, r: HistoryRecord | undefined = undefined) =>
  planHistoryAdmission(reference, binding.recovery_generation, record.request_digest, s, r, now)
test('history 范围严格截止、冻结 TTL、退役只返已有 key，未知/旧代次绝不补建', () => {
  assert.deepEqual(admit(199), { action: 'register_new', dedup_expires_at: 1199 })
  rejects(() => admit(200), 'dedup_history_unavailable')
  assert.deepEqual(admit(199, scope, record), {
    action: 'return_existing',
    call_id: binding.call_id
  })
  assert.deepEqual(admit(500, { ...scope, status: 'retired' }, record), {
    action: 'return_existing',
    call_id: binding.call_id
  })
  rejects(() => admit(500, { ...scope, status: 'retired' }), 'dedup_history_unavailable')
  rejects(
    () =>
      planHistoryAdmission(reference, binding.recovery_generation, record.request_digest, undefined, undefined, 199),
    'dedup_history_unavailable'
  )
  rejects(() => admit(199, { ...scope, recovery_generation: 'previous_recovery' }), 'dedup_history_unavailable')
  rejects(() => admit(199, { ...scope, history_epoch: 'previous_history' }), 'dedup_history_unavailable')
  rejects(
    () =>
      planHistoryAdmission(
        { ...reference, history_epoch: '' },
        binding.recovery_generation,
        record.request_digest,
        scope,
        undefined,
        199
      ),
    'invalid_frame_id'
  )
  rejects(() => admit(1150, scope, record), 'dedup_history_unavailable')
  rejects(() => admit(99), 'clock_untrusted')
  rejects(() => admit(199, { ...scope, frozen_dedup_ttl: 99 }), 'invalid_history_scope')
  rejects(() => admit(199, { ...scope, frozen_dedup_ttl: Number.MAX_SAFE_INTEGER }), 'invalid_history_scope')
  rejects(
    () => planHistoryAdmission(reference, binding.recovery_generation, 'c'.repeat(64), scope, record, 199),
    'request_key_conflict'
  )
  rejects(() => admit(199, scope, { ...record, dedup_expires_at: 999 }), 'invalid_history_record')
  rejects(() => admit(199, scope, { ...record, key_digest: 'c'.repeat(64) }), 'history_record_mismatch')
  rejects(
    () => admit(199, scope, { ...record, call_created_at: 200, dedup_expires_at: 1200 }),
    'invalid_history_record'
  )
  assert.deepEqual(reference, { history_epoch: 'history_1', client_request_key: 'key_1' })
})

const anchor: ResponseAnchor = {
  binding,
  method: 'ping',
  mode: 'strict',
  state: 'outcome_unknown',
  content_status: 'available',
  content_expires_at: 500,
  dedup_expires_at: 2000
}
test('同一 unknown attempt 的可靠回复只给追加意图，期限/原 unknown 锚点不改、不重派', () => {
  const saved = structuredClone(anchor)
  const ctx = context('connector_to_gateway')
  const policy = {
    classification_status: 'trusted_complete' as const,
    retain_content_authorized: true
  }
  const plan = planResponseEvidence(response, ctx, anchor, 400, policy)
  assert.equal(plan.action, 'append')
  assert.equal(plan.late_evidence, true)
  assert.equal(plan.dispatch, false)
  assert.deepEqual(plan.content, {
    status: 'available',
    expires_at: 500,
    delivery: 'payload',
    native_response: response.payload.native_response
  })
  assert.equal(plan.evidence.response_hash, hash(boundedJson(response.payload.native_response)))
  assert.equal(plan.evidence.category, 'result')
  assert.deepEqual(anchor, saved)
  const evidence = {
    response_hash: plan.evidence.response_hash,
    response_bytes: plan.evidence.response_bytes
  }
  const duplicate = planResponseEvidence(response, ctx, { ...anchor, state: 'responded', evidence }, 450)
  assert.equal(duplicate.action, 'duplicate')
  assert.equal(duplicate.dispatch, false)
  assert.equal(duplicate.content.native_response, undefined)
  assert.equal(duplicate.content.expires_at, 500)
  rejects(
    () =>
      planResponseEvidence(
        response,
        ctx,
        { ...anchor, state: 'responded', evidence: { ...evidence, response_hash: 'b'.repeat(64) } },
        450
      ),
    'response_evidence_conflict'
  )
  rejects(
    () => planResponseEvidence(response, ctx, { ...anchor, state: 'responded' }, 450),
    'evidence_anchor_unavailable'
  )
})

test('内容过期/discard/未知仅最小证据，不保存原文或产生句柄；删除历史不复活', () => {
  for (const content_status of ['expired', 'discarded', 'unavailable'] as const) {
    const plan = planResponseEvidence(response, context('connector_to_gateway'), { ...anchor, content_status }, 400)
    assert.equal(plan.content.status, content_status)
    assert.equal(plan.content.native_response, undefined)
    assert.equal(plan.content.expires_at, 500)
    assert.equal('result_id' in plan.content, false)
  }
  const expired = planResponseEvidence(response, context('connector_to_gateway'), anchor, 500)
  assert.equal(expired.content.status, 'expired')
  assert.equal(expired.content.native_response, undefined)
  rejects(
    () => planResponseEvidence(response, context('connector_to_gateway'), undefined, 400),
    'attempt_anchor_unavailable'
  )
  rejects(
    () => planResponseEvidence(response, context('connector_to_gateway'), anchor, 2000),
    'evidence_not_applicable'
  )
  rejects(
    () => planResponseEvidence(response, context('connector_to_gateway'), { ...anchor, state: 'not_dispatched' }, 400),
    'evidence_not_applicable'
  )
  const error = {
    ...response,
    payload: {
      ...response.payload,
      native_response: {
        id: binding.native_request_id,
        error: { code: 'timeout', message: 'synthetic', data: { retained: true } }
      }
    }
  }
  assert.equal(planResponseEvidence(error, context('connector_to_gateway'), anchor, 400).evidence.category, 'error')
  for (const policy of [
    undefined,
    { classification_status: 'trusted_complete' as const, retain_content_authorized: false },
    { classification_status: 'untrusted' as const, retain_content_authorized: true }
  ]) {
    const plan = planResponseEvidence(response, context('connector_to_gateway'), anchor, 400, policy)
    assert.equal(plan.content.delivery, 'metadata_only')
    assert.equal(plan.content.native_response, undefined)
  }
})

test('迟到回复逐一拒绝错机器/代次/epoch/call/attempt/native ID/target/契约与撤销来源', () => {
  for (const key of [
    'machine_id',
    'recovery_generation',
    'connection_epoch',
    'call_id',
    'attempt_id',
    'native_request_id',
    'binding_revision',
    'contract_ref'
  ] as const) {
    rejects(
      () =>
        planResponseEvidence(
          response,
          context('connector_to_gateway'),
          {
            ...anchor,
            binding: {
              ...binding,
              [key]: key === 'contract_ref' ? 'b'.repeat(64) : key === 'binding_revision' ? 2 : 'wrong'
            }
          },
          400
        ),
      'attempt_binding_mismatch'
    )
  }
  rejects(
    () =>
      planResponseEvidence(
        response,
        context('connector_to_gateway'),
        {
          ...anchor,
          binding: {
            ...binding,
            target: {
              machine_id: binding.machine_id,
              provider_id: binding.target.provider_id,
              profile: 'host'
            }
          }
        },
        400
      ),
    'attempt_binding_mismatch'
  )
  const inactive = context('connector_to_gateway')
  ;(inactive.connection as any).active = false
  rejects(() => planResponseEvidence(response, inactive, anchor, 400), 'authentication_required')
  rejects(
    () => planResponseEvidence(response, context('connector_to_gateway'), { ...anchor, method: 'changed' }, 400),
    'attempt_binding_mismatch'
  )
  const bad = {
    ...response,
    payload: { ...response.payload, native_response: { id: binding.native_request_id, error: {} } }
  }
  rejects(() => planResponseEvidence(bad, context('connector_to_gateway'), anchor, 400), 'native_response_invalid')
  const noLate = context('connector_to_gateway')
  noLate.connection.negotiated.capabilities = ['rpc']
  rejects(() => planResponseEvidence(response, noLate, anchor, 400), 'unsupported_capability')
})

test('message ID 窗口对相同内容幂等、冲突拒绝，容量与期限固定有界', () => {
  const window = new MessageWindow(2, 100)
  const ctx = context()
  const heartbeat = frame('heartbeat', { sequence: 0 })
  assert.equal(window.observe(heartbeat, ctx, 0), 'new')
  assert.equal(window.observe(heartbeat, ctx, 99), 'duplicate')
  assert.equal(window.observe({ ...heartbeat, message_id: 'message_2' }, ctx, 99), 'new')
  rejects(() => window.observe({ ...heartbeat, message_id: 'message_3' }, ctx, 99), 'dedup_window_full')
  rejects(() => window.observe({ ...heartbeat, payload: { sequence: 1 } }, ctx, 99), 'message_id_conflict')
  assert.equal(window.observe(heartbeat, ctx, 100), 'new')
  assert.equal(window.size, 2)
  rejects(() => window.observe(heartbeat, ctx, 99), 'clock_untrusted')
  rejects(() => new MessageWindow(4097), 'dedup_limit')
})
