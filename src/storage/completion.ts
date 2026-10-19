// 按持久化调用状态推导剩余收尾义务，为必要审计和终态元数据增长预留配额。
import { auditRecord } from './audit.js'
import { LIMITS } from '../wire/index.js'
import type { Row } from './model.js'
import type { Retention } from './config.js'

export const metadataFields = [
  'call_id',
  'principal',
  'target_json',
  'identity_json',
  'binding_json',
  'request_hash',
  'key_digest',
  'history_epoch',
  'state',
  'response_hash',
  'response_bytes',
  'created',
  'deadline',
  'content_expires',
  'metadata_expires',
  'dedup_expires',
  'content_status'
] as const
export type CompletionCall = Omit<Row, 'request_json' | 'response'>
// 以实际 JSON 编码的 UTF-8 字节数计量审计与元数据。
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
// 提取配额计量所需的调用元数据，不包含请求或响应原文。
export const metadataValue = (row: CompletionCall) =>
  Object.fromEntries(
    metadataFields.map(/* 按固定清单生成元数据字段与当前值的键值对。 */ (field) => [field, row[field]])
  )

// reserved 是持久化预约标记；剩余义务从同事务内的状态推导，不新增可丢失的内存计数器。
export function completionReservation(row: CompletionCall, limits: Retention, generation: string) {
  if (!row.reserved || !['dispatching', 'connector_accepted', 'outcome_unknown'].includes(row.state)) {
    return { audit: 0, metadata: 0 }
  }
  const at = Number.MAX_SAFE_INTEGER - limits.audit_ttl
  const eventId = 'event_' + '0'.repeat(36)
  // 按真实审计编码测量指定后续动作，使用最大安全时间和固定长度事件标识。
  const measure = (action: string, actor: string, state: Row['state'], extra: Record<string, unknown> = {}) =>
    size(auditRecord(eventId, action, actor, at, limits.audit_ttl, generation, { ...row, state }, extra))
  // 最多一次 accepted、一次 unknown、一次原生终态；按最长动作/状态及最大安全时间估计。
  let audit = 0
  if (row.state === 'dispatching') {
    audit += measure('connector_accepted', 'connector', 'connector_accepted')
  }
  if (row.state !== 'outcome_unknown') {
    audit += measure('deadline_exceeded', 'system', 'outcome_unknown')
  }
  audit += size(
    auditRecord(
      eventId,
      'late_evidence',
      'connector',
      at,
      limits.audit_ttl,
      generation,
      { ...row, state: 'responded', response_bytes: LIMITS.object_bytes },
      { response_hash: 'f'.repeat(64), category: 'result' }
    )
  )
  const future = {
    ...row,
    state: 'connector_accepted' as const,
    response_hash: 'f'.repeat(64),
    response_bytes: LIMITS.object_bytes,
    content_status: 'unavailable' as const
  }
  const metadata = Math.max(0, size(metadataValue(future)) - size(metadataValue(row)))
  return { audit, metadata }
}
