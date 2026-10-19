// 定义 v5 存储保留期和分类预算，并校验覆盖配置的整数、期限及总量约束。
import { GatewayError } from '../contracts.js'

const MiB = 1_048_576
export const DEFAULT_RETENTION = Object.freeze({
  content_ttl: 3_600_000,
  content_bytes: 128 * MiB,
  handle_ttl: 3_600_000,
  handle_payload_bytes: 16 * MiB,
  call_metadata_ttl: 30 * 86_400_000,
  dedup_ttl: 30 * 86_400_000,
  call_metadata_bytes: 64 * MiB,
  history_epoch_max_age: 86_400_000,
  audit_ttl: 30 * 86_400_000,
  audit_bytes: 64 * MiB,
  security_metadata_bytes: 16 * MiB,
  backup_ttl: 7 * 86_400_000,
  backup_max_count: 2,
  backup_bytes: 128 * MiB,
  storage_total_bytes: 512 * MiB,
  storage_reserve_bytes: 64 * MiB,
  // 每次派发预约最小终态与必要审计；原文不足配额时只保留证据。
  attempt_reserve_bytes: 16_384
})
export type Retention = { [K in keyof typeof DEFAULT_RETENTION]: number }
// 合并默认配置并检查期限和配额相互约束，返回冻结的有效配置。
export function retention(overrides: Partial<Retention> = {}): Retention {
  const c = { ...DEFAULT_RETENTION, ...overrides }
  if (
    Object.values(c).some(/* 检测不是正安全整数的保留期或容量配置。 */ (v) => !Number.isSafeInteger(v) || v <= 0) ||
    c.call_metadata_ttl < c.dedup_ttl ||
    c.history_epoch_max_age > c.dedup_ttl ||
    c.handle_payload_bytes > c.content_bytes ||
    c.storage_reserve_bytes >= c.storage_total_bytes ||
    c.attempt_reserve_bytes > c.storage_reserve_bytes ||
    ['content_bytes', 'call_metadata_bytes', 'audit_bytes', 'security_metadata_bytes', 'backup_bytes'].some(
      /* 检测任一独立分类预算是否超过存储总量。 */ (k) => c[k as keyof Retention] > c.storage_total_bytes
    )
  ) {
    throw new GatewayError('invalid_storage_limits')
  }
  return Object.freeze(c)
}
