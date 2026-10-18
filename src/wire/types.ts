import type { Target } from '../contracts.js';

export type JsonObject = Record<string, unknown>;
export type Direction = 'gateway_to_connector' | 'connector_to_gateway';
export type Capability = 'rpc' | 'history_scope' | 'late_evidence' | 'objects' |
  'events' | 'terminal_observe' | 'terminal_control';
export type VersionOffer = { major: number; minor: number; capabilities: string[]; required: string[] };
export type Negotiated = { major: number; minor: number; capabilities: Capability[] };
export type ConnectionIdentity = {
  machine_id: string; recovery_generation: string; connection_epoch: string;
};
export type AttemptIdentity = {
  call_id: string; attempt_id: string; native_request_id: string;
  target: Target; contract_revision: string; contract_digest: string;
};
export type AttemptBinding = ConnectionIdentity & AttemptIdentity;
export type HistoryReference = { history_epoch: string; client_request_key: string };
export type ValidationMode = 'strict' | 'raw-contract';
export type StreamFeature = 'events' | 'terminal_observe' | 'terminal_control';

// 本接口只接收可信集成层的判断；不能从 wire payload 或 caller 自报字段构造。
export type RequestGate = {
  classification_status: 'trusted_complete' | 'missing' | 'unknown' | 'invalid' | 'untrusted';
  schema_status: 'complete' | 'incomplete' | 'unavailable';
  transport_status: 'supported' | 'unsupported';
  authorized: boolean; secret_result_authorized: boolean; raw_contract_authorized: boolean;
};
export type NativeValidationContext = {
  binding: AttemptBinding; mode: ValidationMode; method: string;
  transport: 'rpc' | 'stream'; feature?: StreamFeature;
};
export type ResolvedAttempt = NativeValidationContext;
// 必须验证完整根 schema/条件/$ref；raw 只允许放宽 params，不能跳过根与安全门禁。
export interface NativePayloadValidator {
  requestGate(request: JsonObject, context: NativeValidationContext): RequestGate;
  validateRequest(request: JsonObject, context: NativeValidationContext): void;
  validateResponse(response: JsonObject, context: NativeValidationContext): void;
  validateStreamFrame?(frame: JsonObject, context: NativeValidationContext & {
    feature: StreamFeature; direction: 'data' | 'input';
  }): void;
}
export type RequestPayload = {
  attempt: AttemptIdentity; uhp_request: JsonObject; deadline: number;
  validation: ValidationMode; history?: HistoryReference;
};
export type Payloads = {
  request: RequestPayload;
  accepted: { attempt: AttemptIdentity };
  response: { attempt: AttemptIdentity; uhp_response: JsonObject };
  cancel: { attempt: AttemptIdentity; reason: 'caller_cancelled' | 'deadline_exceeded' };
  heartbeat: { sequence: number };
  stream_open: RequestPayload & { stream_id: string; feature: StreamFeature };
  stream_data: { attempt: AttemptIdentity; stream_id: string; feature: StreamFeature; sequence: number; frame: JsonObject };
  stream_input: { attempt: AttemptIdentity; stream_id: string; feature: StreamFeature; sequence: number; frame: JsonObject };
  stream_close: { attempt: AttemptIdentity; stream_id: string;
    reason: 'normal' | 'cancelled' | 'overflow' | 'resync_required' | 'transport_error' };
  object_chunk: { object_id: string; kind: 'envelope' | 'schema_bundle'; total_bytes: number;
    sha256: string; chunk_count: number; index: number; data: string };
  error: WireErrorPayload;
};
export type WireErrorPayload = {
  source: 'gateway' | 'transport'; code: string; retryable: boolean; cause_message_id?: string;
};
type Base<K extends string, P> = {
  protocol_major: number; protocol_minor: number; type: K; message_id: string; payload: P;
};
export type AuthenticatedEnvelope = { [K in keyof Payloads]:
  Base<K, Payloads[K]> & ConnectionIdentity
}[keyof Payloads];
export type PreAuthEnvelope =
  | Base<'enroll', { registration_id: string; connector_instance_id: string; enrollment_credential: string; offer: VersionOffer }>
  | Base<'authenticate', { machine_id: string; recovery_generation: string; connector_instance_id: string;
    device_credential: string; offer: VersionOffer }>
  | Base<'welcome', ConnectionIdentity & { in_reply_to: string; selected: Negotiated }>
  | Base<'error', WireErrorPayload>;
export type WireEnvelope = PreAuthEnvelope | AuthenticatedEnvelope;
export type CodecContext = {
  phase: 'preauth'; direction: Direction;
  // welcome 必须与本地保存的 offer 和握手 ID 核对。
  offer?: VersionOffer; handshake_message_id?: string;
} | {
  phase: 'authenticated'; direction: Direction;
  // 这两个 true 是外部认证层的事实；codec 不签发、不验证凭据、不证明 socket 身份。
  connection: ConnectionIdentity & { authenticated: true; active: true; negotiated: Negotiated };
  native?: NativePayloadValidator;
  // 必须查询原持久化锚点，不能使用收到的 attempt 构造。
  resolveAttempt?: (attempt: AttemptIdentity) => ResolvedAttempt | undefined;
};
