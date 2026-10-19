// 定义独立管理认证、共享政策和完整 WebUI 服务契约；不发行身份、确认、凭据或持久操作历史。
import type { Principal } from '../router.js'
import type { CallerIdentity, Page, ProviderView } from './types.js'

export type ManagementPermission =
  | 'gateway_read'
  | 'devices_read'
  | 'devices_register'
  | 'devices_rename'
  | 'devices_disconnect'
  | 'devices_revoke'
  | 'providers_read'
  | 'providers_manage'
  | 'permissions_read'
export type ManagementGrant =
  | { action: 'gateway_read' | 'devices_register' }
  | {
      action: 'devices_read' | 'devices_rename' | 'devices_disconnect' | 'devices_revoke' | 'permissions_read'
      machine_id: string
    }
  | { action: 'providers_read' | 'providers_manage'; machine_id: string; provider_id: string }
export type Administrator = {
  principal_id: string
  session_ref: string
  assurance: 'administrator' | 'recovery_local'
  policy_revision: string
  grants: readonly ManagementGrant[]
}
export interface GatewayIdentitySource {
  // 从同一身份/政策后端重新解析现有 Router Principal；不存在或失效时返回 null。
  principal(caller: CallerIdentity): Principal | null
  // 验证独立管理会话及当前管理授权；设备凭据和 MCP 身份不能替代该会话。
  administrator(caller: CallerIdentity, sessionRef: string): Administrator | null
}
export type AdminContext = Readonly<{
  caller: CallerIdentity
  // 仅由独立管理认证中间件注入，不属于 HTTP 请求体；每次都由 identitySource 重新验证。
  management_session_ref: string
  wait_signal: AbortSignal
}>
export type GatewayMode = 'active' | 'storage_degraded' | 'recovery_quarantined'
export type Observed<T> =
  | {
      verification: 'verified'
      observed_at: number
      source: 'store' | 'gateway_transport' | 'native_adapter'
      value: T
    }
  | { verification: 'unverified'; reason_code: 'backend_unavailable' | 'not_recorded' | 'stale' }
export type DeviceSnapshot = {
  machine_id: string
  name: string
  labels: readonly string[] | null
  persisted_state: 'pending' | 'offline' | 'online' | 'revoked'
  // Store 当前无独立设备管理 revision；缺少真实来源时必须为 null，不能以时间或 binding revision 代替。
  resource_revision: number | null
  observed_at: number
  connection: Observed<{
    state: 'connecting' | 'reconnecting' | 'online' | 'degraded' | 'offline'
    connection_epoch_ref: string | null
    last_heartbeat_at: number | null
  }>
  authentication: Observed<{
    state: 'pending' | 'authenticated' | 'failed' | 'expired' | 'revoked'
    last_failure: {
      reason_code:
        | 'auth_failed'
        | 'credential_expired'
        | 'heartbeat_timeout'
        | 'protocol_error'
        | 'connection_closed'
        | 'binding_mismatch'
      occurred_at: number
    } | null
  }>
}
export type ProviderSnapshot = ProviderView & {
  config_ref: string | null
  observed_at: number
  runtime: Observed<{
    state: 'ready' | 'unreachable' | 'binding_mismatch' | 'migration_unresolved'
    contract_ref: string | null
    binary_sha256: string | null
    schema_sha256: string | null
    classification_revision: string | null
    supported_transports: readonly ('rpc' | 'events' | 'terminal_observe' | 'terminal_control')[]
  }>
}
export type ManagementStatus = {
  server_time: number
  observed_at: number
  mode: GatewayMode
  recovery_generation: string
  policy_revision: string
  refresh_after_ms: 5000
  stale_after_ms: 15000
  // GET 只能返回已存在的范围，不能创建、续期或从业务 history 借用管理员范围。
  history: { history_epoch: string; accept_new_until: number } | null
  components: {
    store: 'available' | 'degraded' | 'quarantined'
    transport: 'available' | 'degraded' | 'unavailable' | 'unverified'
    native: 'available' | 'degraded' | 'unavailable' | 'unverified'
  }
}
export type ManagementAction =
  | 'pairing_create'
  | 'pairing_cancel'
  | 'device_disconnect'
  | 'device_revoke'
  | 'provider_disable'
  | 'provider_enable'
export type ResourceTarget = { machine_id: string; provider_id?: string }
export type ManagementIntent =
  | { action: 'pairing_create'; target: { name: string; policy_ref: string; labels: readonly string[] } }
  | { action: 'pairing_create'; target: { machine_id: string; policy_ref: string } }
  | { action: 'pairing_cancel'; target: { machine_id: string; pairing_id: string } }
  | {
      action: 'device_disconnect'
      target: { machine_id: string }
      expected_connection_epoch: string
    }
  | { action: 'device_revoke'; target: { machine_id: string } }
  | {
      action: 'provider_disable' | 'provider_enable'
      target: { machine_id: string; provider_id: string; kind: 'luvus' | 'herdr' }
      expected_binding_revision: number
    }
export type IntentFence = {
  recovery_generation: string
  expected_revision: number
  reason: string
}
export type ConfirmationDraft = ManagementIntent & IntentFence & { request_id: string; history_epoch: string }
export type ConfirmationView = {
  confirmation_id: string
  state: 'pending' | 'confirmed' | 'consumed' | 'expired'
  operation_digest: string
  summary: ManagementIntent & IntentFence
  expires_at: number
}
export type ManagementWrite = IntentFence & {
  request_id: string
  history_epoch: string
  confirmation_id: string
}
export type OperationReceipt = {
  request_id: string
  history_epoch: string
  recovery_generation: string
  operation_digest: string
  action: ManagementAction
  target: ResourceTarget | { pairing_id: string }
  operation_state: 'committed' | 'not_committed' | 'outcome_unknown'
  new_revision: number | null
  new_binding_revision: number | null
  observed_at: number
  audit_event_ids: readonly string[]
  evidence: 'current_durable' | 'backup_history'
  effects: {
    persistent_authorization: 'unchanged' | 'revoked' | 'unconfirmed'
    channel: 'unchanged' | 'disconnected' | 'unconfirmed'
    provider: 'unchanged' | 'disabled' | 'enabled' | 'unconfirmed'
    native_work: 'may_continue'
  }
}
export type PermissionDecision = {
  action: ManagementPermission
  allowed: boolean
  reason_code: 'allowed' | 'forbidden' | 'backend_unavailable' | 'recovery_quarantined' | 'storage_degraded'
}
export type PermissionSnapshot = {
  target: ResourceTarget
  principal_id: string
  policy_revision: string
  caller_policy_revision: string
  local_policy_revision: string | null
  recovery_generation: string
  observed_at: number
  expires_at: number
  // 仅作 UI 提示；每次写入仍须当前认证、授权、确认和事务 fence，不能据此自证授权。
  decisions: readonly PermissionDecision[]
}
export type AdminPage = { cursor?: string; limit?: number }
export type ManagementArguments = {
  status: Record<string, never>
  devices_list: AdminPage & { states?: readonly DeviceSnapshot['persisted_state'][] }
  devices_get: { machine_id: string }
  providers_list: AdminPage & { machine_id: string }
  providers_get: { machine_id: string; provider_id: string }
  permissions_get: ResourceTarget
  operations_get: { request_id: string; history_epoch: string; recovery_generation: string }
  confirmations_create: ConfirmationDraft
  confirmations_confirm: ManagementWrite & { operation_digest: string }
  pairings_create: ManagementWrite &
    (
      | { name: string; policy_ref: string; labels: readonly string[]; machine_id?: never }
      | { machine_id: string; policy_ref: string; name?: never; labels?: never }
    )
  pairings_cancel: ManagementWrite & { machine_id: string; pairing_id: string }
  devices_disconnect: ManagementWrite & { machine_id: string; expected_connection_epoch: string }
  devices_revoke: ManagementWrite & { machine_id: string }
  providers_disable: ManagementWrite & {
    machine_id: string
    provider_id: string
    kind: 'luvus' | 'herdr'
    expected_binding_revision: number
  }
  providers_enable: ManagementArguments['providers_disable']
}
export type ManagementReply = {
  status: ManagementStatus
  devices_list: Page<DeviceSnapshot>
  devices_get: DeviceSnapshot
  providers_list: Page<ProviderSnapshot>
  providers_get: ProviderSnapshot
  permissions_get: PermissionSnapshot
  operations_get: OperationReceipt
  confirmations_create: ConfirmationView
  confirmations_confirm: ConfirmationView
  pairings_create: OperationReceipt & {
    machine_id: string
    pairing_id: string
    status: 'pending'
    expires_at: number
    requires_local_issuance: true
  }
  pairings_cancel: OperationReceipt
  devices_disconnect: OperationReceipt
  devices_revoke: OperationReceipt
  providers_disable: OperationReceipt
  providers_enable: OperationReceipt
}
export type ManagementOperation = keyof ManagementArguments
export interface GatewayManagementService {
  // 经独立管理认证后执行固定操作；只在对应真实后端与原子回执存在时返回成功，不能自动重放写入。
  execute<K extends ManagementOperation>(
    name: K,
    args: ManagementArguments[K],
    context: AdminContext
  ): Promise<ManagementReply[K]>
}
