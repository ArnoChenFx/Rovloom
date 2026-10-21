// 定义独立的 Wire v2 消息、调用身份、provider 权限及原生校验接口类型。
export type JsonObject = Record<string, unknown>
export type Direction = 'gateway_to_connector' | 'connector_to_gateway'
export type ProviderKind = 'luvus' | 'herdr'
// Wire v2 隔离类型，不扩展尚待统一迁移的公共 contracts.Target。
export type V2Target = { machine_id: string; provider_id: string } & (
  | { profile: 'session'; session: string }
  | { profile: 'host'; session?: never }
)
export type ProviderBinding = {
  machine_id: string
  provider_id: string
  kind: ProviderKind
  config_ref: string
  binding_revision: number
  enabled: boolean
}
export type ContractSource = {
  provider_kind: ProviderKind
  protocol_family: 'uhp' | 'herdr-json'
  binary_version: string
  binary_sha256: string
  schema_sha256: string
  schema_origin: 'installed_cli'
  schema_command: 'luvus uhp schema' | 'herdr api schema --json'
  server_version: string | null
  native_protocol_version: string | null
  runtime_generation: string | null
  adapter_revision: string
  classification_revision: string | null
  support_basis: 'live_catalog' | 'schema_and_version'
}
export type ContractRecord = { source: ContractSource; support_status: 'candidate' | 'validated' }
export type Capability =
  | 'rpc'
  | 'provider_fence'
  | 'dispatch_refusal'
  | 'provider_snapshot'
  | 'terminal_execution_state'
  | 'admission_receipt'
  | 'admission_context'
  | 'history_scope'
  | 'late_evidence'
export type VersionOffer = {
  major: number
  minor: number
  capabilities: string[]
  required: string[]
}
export type Negotiated = { major: number; minor: number; capabilities: Capability[] }
export type ConnectionIdentity = {
  machine_id: string
  recovery_generation: string
  connection_epoch: string
}
export type HistoryReference = { history_epoch: string; client_request_key: string }
export type AttemptRegistration = {
  deadline: number
  history: HistoryReference | null
  caller_policy_revision: string
  local_policy_revision: string
}
export type AttemptIdentity = {
  call_id: string
  attempt_id: string
  native_request_id: string
  target: V2Target
  provider_kind: ProviderKind
  binding_revision: number
  contract_ref: string
  registration: AttemptRegistration
}
export type AttemptBinding = ConnectionIdentity & AttemptIdentity
export type ValidationMode = 'strict' | 'raw-contract'
export type ProviderAction = 'dispatch' | 'read' | 'cancel'
// 每条 grant 是一个完整 route tuple；不得拆成机器/provider/session 数组后求笛卡尔积。
export type ProviderGrant = { target: V2Target; methods: string[]; actions: ProviderAction[] }
export type ProviderPolicy = { revision: string; grants: ProviderGrant[] }
export type ProviderPolicies = { caller: ProviderPolicy; local: ProviderPolicy }
// 由原生模块的多轴可信 gate 生成，不从 wire/caller 自报重建分类。
export type RequestGate = {
  classification_status: 'trusted_complete' | 'missing' | 'unknown' | 'invalid' | 'untrusted'
  schema_status: 'complete' | 'generic' | 'unavailable'
  transport_status: 'supported' | 'unsupported'
  authorized: boolean
  secret_result_authorized: boolean
  raw_contract_authorized: boolean
}
export type NativeValidationContext = {
  binding: AttemptBinding
  mode: ValidationMode
  method: string
  // opaque handle/source 只从独立可信上下文注入；不会序列化或由消息构造。
  native_handle?: unknown
  trusted_source?: unknown
}
export type ResolvedAttempt = NativeValidationContext
export interface NativePayloadValidator {
  requestGate(request: JsonObject, context: NativeValidationContext): RequestGate
  validateRequest(request: JsonObject, context: NativeValidationContext): void
  validateResponse(response: JsonObject, context: NativeValidationContext): void
}
export type RequestPayload = {
  attempt: AttemptIdentity
  expected_binding_revision: number
  native_request: JsonObject
  validation: ValidationMode
}
export type DispatchRefusalCode = 'terminal_execution_disabled'
export type TerminalExecutionState = Readonly<{ binding: ProviderBinding; enabled: boolean }>
export type Payloads = {
  provider_fenced: { binding: ProviderBinding }
  terminal_execution_state: TerminalExecutionState
  provider_snapshot: {
    binding: ProviderBinding
    target: V2Target
    source: ContractSource
    capabilities: JsonObject
    capability_revision: string
  }
  admission_receipt: {
    attempt: AttemptIdentity
    request_sha256: string
    dedup_expires_at: number
    context?: import('./admission.js').AdmissionReceiptContext
  }
  request: RequestPayload
  accepted: { attempt: AttemptIdentity }
  dispatch_refused: { attempt: AttemptIdentity; code: DispatchRefusalCode }
  response: { attempt: AttemptIdentity; native_response: JsonObject }
  cancel: { attempt: AttemptIdentity; reason: 'caller_cancelled' | 'deadline_exceeded' }
  heartbeat: { sequence: number }
  error: WireErrorPayload
}
/** 同一认证 epoch 的单 provider 来源快照；不包含 schema、原生凭据或任何执行许可。 */
export type ProviderSnapshot = Payloads['provider_snapshot']
export type WireErrorPayload = {
  source: 'gateway' | 'transport'
  code: string
  retryable: boolean
  cause_message_id?: string
}
type Base<K extends string, P> = {
  protocol_major: number
  protocol_minor: number
  type: K
  message_id: string
  payload: P
}
export type AuthenticatedEnvelope = {
  [K in keyof Payloads]: Base<K, Payloads[K]> & ConnectionIdentity
}[keyof Payloads]
export type PreAuthEnvelope =
  | Base<
      'enroll',
      {
        registration_id: string
        connector_instance_id: string
        enrollment_credential: string
        offer: VersionOffer
      }
    >
  | Base<
      'authenticate',
      {
        machine_id: string
        recovery_generation: string
        connector_instance_id: string
        device_credential: string
        offer: VersionOffer
      }
    >
  | Base<'welcome', ConnectionIdentity & { in_reply_to: string; selected: Negotiated }>
  | Base<'error', WireErrorPayload>
export type WireEnvelope = PreAuthEnvelope | AuthenticatedEnvelope
export type AuthenticatedContext = {
  phase: 'authenticated'
  direction: Direction
  // 外部认证事实，不是 codec 产生的认证证明。
  connection: ConnectionIdentity & { authenticated: true; active: true; negotiated: Negotiated }
  policies?: ProviderPolicies
  resolveProvider?: (target: V2Target) => ProviderBinding | undefined
  resolveContract?: (contract_ref: string) => ContractRecord | undefined
  validators?: Partial<Record<ProviderKind, NativePayloadValidator>>
  resolveAttempt?: (attempt: AttemptIdentity) => ResolvedAttempt | undefined
  resolveNativeSource?: (binding: AttemptBinding) => unknown
}
export type CodecContext =
  | { phase: 'preauth'; direction: Direction; offer?: VersionOffer; handshake_message_id?: string }
  | AuthenticatedContext
