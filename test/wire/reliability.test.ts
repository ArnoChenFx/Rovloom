// 用合成调用验证历史去重准入、迟到响应证据规划和连接内消息去重边界。
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
// 用固定引用和请求摘要规划准入，允许替换时间、范围与墓碑，不执行持久化。
const admit = (now: number, s: HistoryScope | undefined = scope, r: HistoryRecord | undefined = undefined) =>
  planHistoryAdmission(reference, binding.recovery_generation, record.request_digest, s, r, now)
test(
  'history 范围严格截止、冻结 TTL、退役只返已有 key，未知/旧代次绝不补建',
  /* 在截止前后比较新登记与墓碑复用，核对退役、代次、时钟和冻结 TTL，且不修改历史引用。 */ () => {
    assert.deepEqual(admit(199), { action: 'register_new', dedup_expires_at: 1199 })
    rejects(/* 在范围截止时刻申请新登记，要求拒绝。 */ () => admit(200), 'dedup_history_unavailable')
    assert.deepEqual(admit(199, scope, record), {
      action: 'return_existing',
      call_id: binding.call_id
    })
    assert.deepEqual(admit(500, { ...scope, status: 'retired' }, record), {
      action: 'return_existing',
      call_id: binding.call_id
    })
    rejects(
      /* 在退役范围申请未登记的键，要求拒绝。 */ () => admit(500, { ...scope, status: 'retired' }),
      'dedup_history_unavailable'
    )
    rejects(
      /* 不提供历史范围，要求拒绝且不补建范围。 */ () =>
        planHistoryAdmission(reference, binding.recovery_generation, record.request_digest, undefined, undefined, 199),
      'dedup_history_unavailable'
    )
    rejects(
      /* 将范围恢复代次设为旧值，要求拒绝跨恢复历史复用。 */ () =>
        admit(199, { ...scope, recovery_generation: 'previous_recovery' }),
      'dedup_history_unavailable'
    )
    rejects(
      /* 让范围 epoch 与当前引用不符，要求拒绝。 */ () => admit(199, { ...scope, history_epoch: 'previous_history' }),
      'dedup_history_unavailable'
    )
    rejects(
      /* 传入空历史 epoch，验证标识格式会先于历史准入检查。 */ () =>
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
    rejects(
      /* 在墓碑到期时重试，要求拒绝且不延长保留期限。 */ () => admit(1150, scope, record),
      'dedup_history_unavailable'
    )
    rejects(/* 让当前时间早于范围创建时刻，要求拒绝不可信时钟。 */ () => admit(99), 'clock_untrusted')
    rejects(
      /* 让准入截止超出冻结 TTL 边界，要求拒绝无效范围。 */ () => admit(199, { ...scope, frozen_dedup_ttl: 99 }),
      'invalid_history_scope'
    )
    rejects(
      /* 使范围创建时间加 TTL 溢出安全整数，要求拒绝。 */ () =>
        admit(199, { ...scope, frozen_dedup_ttl: Number.MAX_SAFE_INTEGER }),
      'invalid_history_scope'
    )
    rejects(
      /* 在已有键上提供不同请求摘要，要求报冲突而非复用原调用。 */ () =>
        planHistoryAdmission(reference, binding.recovery_generation, 'c'.repeat(64), scope, record, 199),
      'request_key_conflict'
    )
    rejects(
      /* 使墓碑期限偏离创建时刻加冻结 TTL，要求拒绝。 */ () => admit(199, scope, { ...record, dedup_expires_at: 999 }),
      'invalid_history_record'
    )
    rejects(
      /* 让墓碑键摘要与当前客户端键不符，要求拒绝错配。 */ () =>
        admit(199, scope, { ...record, key_digest: 'c'.repeat(64) }),
      'history_record_mismatch'
    )
    rejects(
      /* 把墓碑创建时刻放在准入截止点，要求拒绝范围外记录。 */ () =>
        admit(199, scope, { ...record, call_created_at: 200, dedup_expires_at: 1200 }),
      'invalid_history_record'
    )
    assert.deepEqual(reference, { history_epoch: 'history_1', client_request_key: 'key_1' })
  }
)

const anchor: ResponseAnchor = {
  binding,
  method: 'ping',
  mode: 'strict',
  state: 'outcome_unknown',
  content_status: 'available',
  content_expires_at: 500,
  dedup_expires_at: 2000
}
test(
  '同一 unknown attempt 的可靠回复只给追加意图，期限/原 unknown 锚点不改、不重派',
  /* 用结果未知锚点规划追加与重复回复，核对固定期限、锚点不变及冲突证据拒绝。 */ () => {
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
      /* 给已响应锚点附上不同摘要，要求拒绝冲突证据。 */ () =>
        planResponseEvidence(
          response,
          ctx,
          { ...anchor, state: 'responded', evidence: { ...evidence, response_hash: 'b'.repeat(64) } },
          450
        ),
      'response_evidence_conflict'
    )
    rejects(
      /* 将锚点标为已响应却不附既有证据，要求拒绝。 */ () =>
        planResponseEvidence(response, ctx, { ...anchor, state: 'responded' }, 450),
      'evidence_anchor_unavailable'
    )
  }
)

test(
  '内容过期/discard/未知仅最小证据，不保存原文或产生句柄；删除历史不复活',
  /* 让不可用内容或缺少保存授权的回复只生成元数据，并拒绝缺失锚点和失效历史，区分原生结果与错误。 */ () => {
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
      /* 未提供独立调用锚点，要求拒绝凭回复重建调用。 */ () =>
        planResponseEvidence(response, context('connector_to_gateway'), undefined, 400),
      'attempt_anchor_unavailable'
    )
    rejects(
      /* 在去重保留期限到达时处理回复，要求拒绝继续追加证据。 */ () =>
        planResponseEvidence(response, context('connector_to_gateway'), anchor, 2000),
      'evidence_not_applicable'
    )
    rejects(
      /* 将调用标为未派发，要求拒绝为其追加原生回复证据。 */ () =>
        planResponseEvidence(response, context('connector_to_gateway'), { ...anchor, state: 'not_dispatched' }, 400),
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
  }
)

test(
  '迟到回复逐一拒绝错机器/代次/epoch/call/attempt/native ID/target/契约与撤销来源',
  /* 逐项篡改完整绑定、方法和原生回复，并停用连接或迟到能力，核对证据规划的拒绝边界。 */ () => {
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
        /* 改动一个绑定字段，要求回复与独立锚点不匹配时拒绝。 */ () =>
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
    for (const changed of [
      { ...binding, provider_kind: 'herdr' as const },
      { ...binding, target: { ...binding.target, provider_id: 'other_provider' } },
      {
        ...binding,
        target: { ...binding.target, profile: 'session' as const, session: 'other_session' }
      },
      { ...binding, registration: { ...binding.registration, deadline: 2000 } },
      { ...binding, registration: { ...binding.registration, history: null } },
      {
        ...binding,
        registration: { ...binding.registration, caller_policy_revision: 'other_policy' }
      },
      {
        ...binding,
        registration: { ...binding.registration, local_policy_revision: 'other_policy' }
      }
    ]) {
      rejects(
        /* 替换 provider、目标或登记事实，要求完整绑定比较拒绝。 */ () =>
          planResponseEvidence(response, context('connector_to_gateway'), { ...anchor, binding: changed }, 400),
        'attempt_binding_mismatch'
      )
    }
    rejects(
      /* 把锚点目标改为 Host，要求拒绝跨 profile 复用回复。 */ () =>
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
    rejects(
      /* 停用当前连接，要求迟到证据也通过认证状态检查。 */ () => planResponseEvidence(response, inactive, anchor, 400),
      'authentication_required'
    )
    rejects(
      /* 让锚点方法与已解析的尝试方法不符，要求拒绝。 */ () =>
        planResponseEvidence(response, context('connector_to_gateway'), { ...anchor, method: 'changed' }, 400),
      'attempt_binding_mismatch'
    )
    const bad = {
      ...response,
      payload: { ...response.payload, native_response: { id: binding.native_request_id, error: {} } }
    }
    rejects(
      /* 传入结构不完整的原生 error，验证证据规划同样执行原生响应检查。 */ () =>
        planResponseEvidence(bad, context('connector_to_gateway'), anchor, 400),
      'native_response_invalid'
    )
    const noLate = context('connector_to_gateway')
    noLate.connection.negotiated.capabilities = ['rpc']
    rejects(
      /* 移除迟到证据能力，要求结果未知调用的回复被拒绝。 */ () => planResponseEvidence(response, noLate, anchor, 400),
      'unsupported_capability'
    )
  }
)

test(
  'message ID 窗口对相同内容幂等、冲突拒绝，容量与期限固定有界',
  /* 用固定容量和首见期限核对重复消息、摘要冲突及窗口回收，确认重复读取不续期且时钟不可回退。 */ () => {
    const window = new MessageWindow(2, 100)
    const ctx = context()
    const heartbeat = frame('heartbeat', { sequence: 0 })
    assert.equal(window.observe(heartbeat, ctx, 0), 'new')
    assert.equal(window.observe(heartbeat, ctx, 99), 'duplicate')
    assert.equal(window.observe({ ...heartbeat, message_id: 'message_2' }, ctx, 99), 'new')
    rejects(
      /* 在两条记录均未到期时引入第三个消息 ID，要求容量拒绝。 */ () =>
        window.observe({ ...heartbeat, message_id: 'message_3' }, ctx, 99),
      'dedup_window_full'
    )
    rejects(
      /* 沿用消息 ID 但更改心跳序号，要求报内容冲突。 */ () =>
        window.observe({ ...heartbeat, payload: { sequence: 1 } }, ctx, 99),
      'message_id_conflict'
    )
    assert.equal(window.observe(heartbeat, ctx, 100), 'new')
    assert.equal(window.size, 2)
    rejects(
      /* 在窗口已观察时刻 100 后回退到 99，要求拒绝不可信时钟。 */ () => window.observe(heartbeat, ctx, 99),
      'clock_untrusted'
    )
    rejects(/* 构造超过协议 4096 上限的窗口，要求拒绝配置。 */ () => new MessageWindow(4097), 'dedup_limit')
  }
)
