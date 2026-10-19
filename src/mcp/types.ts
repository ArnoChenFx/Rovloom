// 定义 MCP 与 CLI 宿主共享的参数、公开 DTO、受信 caller 和服务拒绝契约，不发行身份或权限。
import type { HistoryReference, JsonObject, ProviderKind, V2Target, ValidationMode } from '../wire/types.js'

export type PageArguments = { cursor?: string; limit?: number }
export type TargetArguments = { target: V2Target; expected_binding_revision: number }
export type ToolArguments = {
  machines_list: PageArguments
  machines_get: { machine_id: string; name?: never } | { name: string; machine_id?: never }
  machines_register: { name: string }
  machines_rename: { machine_id: string; name: string }
  machines_revoke: { machine_id: string; confirmation_id: string }
  providers_list: PageArguments & { machine_id: string }
  providers_get: { machine_id: string; provider_id: string }
  runtime_discover: TargetArguments & PageArguments
  runtime_describe: TargetArguments & { method: string }
  runtime_call: TargetArguments & {
    contract_ref: string
    native_request: { method: string; params?: unknown }
    deadline: number
    wait_ms?: number
    validation?: ValidationMode
    history?: HistoryReference & { recovery_generation: string }
  }
  runtime_call_get: { call_id: string; wait_ms?: number }
  runtime_call_cancel: { call_id: string }
  runtime_result_read: { result_id: string; cursor?: string; max_bytes?: number }
  runtime_response_discard: { call_id: string }
}
export type ToolName = keyof ToolArguments

export type MachineView = {
  machine_id: string
  name: string
  status: 'pending' | 'active' | 'revoked'
  link: 'offline' | 'unverified' | 'connected' | 'ready'
}
export type ProviderView = {
  machine_id: string
  provider_id: string
  kind: ProviderKind
  binding_revision: number
  enabled: boolean
  readiness: 'unavailable' | 'unverified' | 'ready'
}
export type Page<T> = { items: T[]; next_cursor?: string }
export type CallView = JsonObject & {
  call_id: string
  target: V2Target
  provider_kind: ProviderKind
  binding_revision: number
  contract_ref: string | null
  state: string
  delivery: string
  content_status: string
}
export type ReplyData = {
  machines_list: Page<MachineView>
  machines_get: MachineView
  machines_register: { registration_id: string; status: 'pending' }
  machines_rename: MachineView
  machines_revoke: { machine_id: string; status: 'revoked' }
  providers_list: Page<ProviderView>
  providers_get: ProviderView
  runtime_discover: Page<JsonObject>
  runtime_describe: JsonObject
  runtime_call: CallView
  runtime_call_get: CallView
  runtime_call_cancel: {
    call_id: string
    cancellation: 'waiting_stopped' | 'bridge_stopped' | 'native_confirmed' | 'unsupported' | 'outcome_unknown'
  }
  runtime_result_read: {
    result_id: string
    chunk: string
    encoding: 'utf8' | 'base64'
    next_cursor?: string
    eof: boolean
    total_bytes: number
    sha256: string
    expires_at: number
  }
  runtime_response_discard: { call_id: string; content_status: 'discarded' }
}

export type LocalOsIdentity = Readonly<{ uid: number; gid: number }>
export type CallerIdentity = Readonly<{ principal_id: string }>
// 仅由宿主的受保护本机配置解析。不得从 MCP arguments、_meta 或设备凭据构造身份。
export interface StdioCallerProvider {
  // 按当前 OS 身份解析受保护绑定；缺少有效绑定返回 null，不接受请求自报身份。
  resolve(identity: LocalOsIdentity): CallerIdentity | null | Promise<CallerIdentity | null>
}
export type ServiceContext = Readonly<{
  caller: CallerIdentity
  // 只结束前端等待；不能将它连接到原生执行的取消或重试。
  wait_signal: AbortSignal
}>
export type ServiceReply<K extends ToolName> = { data: ReplyData[K]; is_error?: boolean }

// 实现者负责完整 provider Target 的当前双端 ACL、管理权限、确认、读取/保留门禁和持久事务。
// execute 每次只调用一次；history/cursor 必须绑定 caller、查询范围和持久历史，不能由 facade 补造。
export interface GatewayService {
  // 执行当前授权与持久化门禁后返回可公开数据；每次请求只处理一次，不在此接口隐式重试。
  execute<K extends ToolName>(name: K, args: ToolArguments[K], context: ServiceContext): Promise<ServiceReply<K>>
}

export const SERVICE_ERROR_CODES = [
  'backend_unavailable',
  'invalid_arguments',
  'internal_error',
  'unauthenticated',
  'forbidden',
  'unavailable',
  'not_found',
  'conflict',
  'invalid_cursor',
  'binding_revision_conflict',
  'contract_unavailable',
  'unsupported',
  'confirmation_required',
  'dedup_history_unavailable',
  'storage_exhausted',
  'storage_degraded',
  'recovery_quarantined',
  'content_unavailable',
  'deadline_exceeded',
  'busy'
] as const
export type ServiceErrorCode = (typeof SERVICE_ERROR_CODES)[number]
export class FacadeServiceError extends Error {
  // 保存允许公开的服务拒绝码，固定异常文本以免泄露后端详情。
  constructor(readonly code: ServiceErrorCode) {
    super('Gateway service rejected the request')
    this.name = 'FacadeServiceError'
  }
}
