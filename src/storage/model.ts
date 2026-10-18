// 定义持久化账本、受保护宿主接口、回收通知及公开调用投影，避免暴露内部请求与证据字段。
import type { CallState } from '../contracts.js'
import type { ResponseAnchor } from '../wire/evidence.js'
import type { HistoryReference, ValidationMode } from '../wire/types.js'
import type { Retention } from './config.js'

export type Machine = { machine_id: string; name: string; status: string }
export type Metadata = { generation: string; mode: string; clock: number }
export type ManagementRequest = { action: string; target: string; fence: string }
export type LedgerInvalidation =
  | { kind: 'content' | 'fence'; machine_id: string; call_id: string }
  | { kind: 'device_fence'; machine_id: string }
  | { kind: 'closed' }
// 只传入身份校验所需的最小 fence，不接收凭据、普通 caller 身份或 verified 标志。
export type DeviceLifecycleRequest = Readonly<
  | { action: 'connect'; machine_id: string; recovery_generation: string }
  | {
      action: 'reset_enrollment'
      machine_id: string
      recovery_generation: string
      expected_epoch: string | null
    }
>
export type StoreOptions = {
  retention?: Partial<Retention>
  backupDirectory?: string
  maintenanceIntervalMs?: number
  // 只由受保护宿主注入，须核实独立权限、真实确认及准确 fence；普通工具参数不能传入。
  management?: (request: ManagementRequest) => { actor: string; confirmation_id: string }
  // 受保护宿主同步消费独立凭据校验证明，或复核身份库已按本次 fence 持久化 blocked；缺省拒绝。
  deviceLifecycle?: (request: DeviceLifecycleRequest) => boolean
  // 仅供隔离故障测试在固定写入阶段中断事务；生产宿主不从外部参数注入。
  fault?: (point: 'before_commit' | 'after_anchor' | 'evidence_commit') => void
}
export type CallOptions = {
  binding_revision: number
  contract_ref: string
  caller_policy_revision: string
  local_policy_revision: string
  validation?: ValidationMode
  timeoutMs?: number
  history?: HistoryReference
}
export type Call = {
  call_id: string
  principal: string
  machine_id: string
  provider_id: string
  binding_revision: number
  provider_kind: 'luvus' | 'herdr'
  state: CallState
  epoch: string | null
  attempt_id: string | null
  response: string | null
  target_json: string
  method: string
  deadline: number
  content_expires: number
  metadata_expires: number
  dedup_expires: number
  content_status: ResponseAnchor['content_status']
}
export type Row = Call & {
  identity_json: string
  binding_json: string | null
  request_json: string | null
  request_hash: string
  history_epoch: string | null
  key_digest: string | null
  created: number
  response_hash: string | null
  response_bytes: number | null
  reserved: number
  mode: ValidationMode
}
// 只投影公开调用字段，并按当前内容期限隐藏响应，不把内部请求或证据摘要暴露给读取方。
export const publicCall = (r: Row, now: number): Call => {
  const {
    call_id,
    principal,
    machine_id,
    provider_id,
    binding_revision,
    provider_kind,
    state,
    epoch,
    attempt_id,
    response,
    target_json,
    method,
    deadline,
    content_expires,
    metadata_expires,
    dedup_expires,
    content_status
  } = r
  return {
    call_id,
    principal,
    machine_id,
    provider_id,
    binding_revision,
    provider_kind,
    state,
    epoch,
    attempt_id,
    response: content_status === 'available' && now < content_expires ? response : null,
    target_json,
    method,
    deadline,
    content_expires,
    metadata_expires,
    dedup_expires,
    content_status: content_status === 'available' && now >= content_expires ? 'expired' : content_status
  }
}
