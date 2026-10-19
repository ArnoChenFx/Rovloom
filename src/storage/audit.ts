// 编码有界调用审计详情，保留关联元数据并剔除历史引用中的客户端明文键。
import { boundedJson } from '../wire/index.js'
import type { Row } from './model.js'

export type AuditCall = Pick<
  Row,
  | 'call_id'
  | 'machine_id'
  | 'provider_id'
  | 'binding_revision'
  | 'provider_kind'
  | 'target_json'
  | 'method'
  | 'state'
  | 'binding_json'
  | 'identity_json'
  | 'response_bytes'
>
// 生成带保留期限的审计记录，按统一编码计量详情且不附带调用参数或响应原文。
export function auditRecord(
  eventId: string,
  action: string,
  actor: string,
  now: number,
  ttl: number,
  generation: string,
  row?: AuditCall,
  extra: Record<string, unknown> = {}
) {
  const details = row
    ? {
        generation,
        machine_id: row.machine_id,
        provider_id: row.provider_id,
        binding_revision: row.binding_revision,
        provider_kind: row.provider_kind,
        target: JSON.parse(row.target_json),
        method: row.method,
        state: row.state,
        attempt: /* 复制调用绑定，仅保留历史范围标识并去除客户端重试键。 */ (() => {
          const binding = JSON.parse(row.binding_json ?? row.identity_json)
          return {
            ...binding,
            registration: {
              ...binding.registration,
              history: binding.registration.history
                ? { history_epoch: binding.registration.history.history_epoch }
                : null
            }
          }
        })(),
        bytes: row.response_bytes,
        ...extra
      }
    : extra
  // 实际写入和收尾预约使用同一编码，不保存参数、响应或客户端明文 key。
  return {
    event_id: eventId,
    action,
    actor,
    call_id: row?.call_id ?? null,
    at: now,
    expires: now + ttl,
    details: boundedJson(details)
  }
}
