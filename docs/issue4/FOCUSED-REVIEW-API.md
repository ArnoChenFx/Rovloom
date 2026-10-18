# Rovloom Luvus validator：跨环境准确 API 快照

入口 src/native-contract/index.js。类型来自 src/native-contract/types.ts，保留其源文件相对 import 语义；这是文档快照，不是新增源码。Provider/权限来源须来自可信 resolver，禁止从 caller 自报构造。

类型源 SHA-256：`88c204fd3739eb4cba83f719e3ab6f22921e40e9baab625841ed1fcd2d51fca8`。

```ts
export const DEFAULT_LIMITS: Limits;
export function compileBundle(bytes: Uint8Array | string, options: CompileOptions): Check<CompiledContract>;
export function createNativeValidator(contract: CompiledContract): NativeValidator;
export function parseNativeJson(bytes: Uint8Array | string, overrides?: Partial<Limits>): Check<Json>;
export function inspectRequestGate(candidate: DispatchCandidate, input: DispatchAuthorization): Check<NativeRequestGate>;
export function checkDispatch(candidate: DispatchCandidate, input: DispatchAuthorization): Check<DispatchPermit>;
export function checkResultBoundary(permit: DispatchPermit, input: ResultAuthorization): Check<void>;
export function checkSequence(previous: number, incoming: number): Check<void>;
```

以下为完整原类型（含 NativeRequestGate、DispatchCandidate、DispatchAuthorization 与所有 NativeValidator 方法）：

```ts
import type { Policy, Target } from '../contracts.js';

export type Json = null | boolean | number | string | readonly Json[] | JsonObject;
export type JsonObject = { readonly [key: string]: Json };
export type Check<T> = { ok: true; value: T } | { ok: false; error: NativeContractFailure };
export type NativeContractFailure = Readonly<{
  origin: 'contract' | 'authorization'; code: string; stage: string; reason?: string;
}>;
export type ContractIdentity = Readonly<{
  binary_sha256: string; schema_sha256: string; revision: string;
}>;
export type NativeBinding = Readonly<{
  kind: 'luvus'; provider_id: string; binding_revision: string | number; contract_source_ref: string;
  target: Target; server_generation: string | null; connection_epoch: string;
  recovery_generation: string; capability_revision: string;
  caller_policy_revision: string; local_policy_revision: string;
  classification_revision: string; contract: ContractIdentity;
}>;
// 这是受信调用方提供的证明输入；本模块不执行 socket、TLS 或身份认证。
export type TrustedNativeContext = Readonly<{
  binding: NativeBinding; authenticated: boolean; source_verified: boolean;
}>;
export type Limits = Readonly<{
  object_bytes: number; object_depth: number; object_nodes: number;
  bundle_bytes: number; bundle_nodes: number; documents: number;
  document_bytes: number; references: number; reference_depth: number;
  terminal_frame_bytes: number;
}>;
export type CompileOptions = Readonly<{
  identity: ContractIdentity; limits?: Partial<Limits>;
}>;
export type ParameterValidation = 'schema' | 'generic' | 'unavailable';
export type SchemaStatus = 'conditional_branch' | 'generic_params_only' | 'unavailable';
export type NativeTransport = 'single_request_rpc' | 'host_stdio_proxy' | 'persistent_local_stream';
export type NativeMethodContract = Readonly<{
  method: string; access: 'read' | 'write'; scope: string; idempotent: boolean;
}>;
export type MethodDescriptor = Readonly<{
  method: string; profile: 'session' | 'host'; transport: NativeTransport | 'unclassified';
  schema_status: SchemaStatus; branch_paths: readonly string[];
  classification_status: 'not_evaluated'; native_contract: NativeMethodContract;
}>;
// handle 仅由内存工厂建立；反序列化的同形对象不能用作校验或派发凭证。
export type CompiledContract = Readonly<{ identity: ContractIdentity; documents: readonly string[] }>;
export type CapabilityView = Readonly<{ binding: NativeBinding; methods: readonly MethodDescriptor[] }>;
export type CheckedRequest = Readonly<{
  kind: 'request'; request: JsonObject; binding: NativeBinding;
  method: string; validation: 'schema' | 'generic'; schema_status: SchemaStatus;
}>;
export type RawRequestCandidate = Readonly<{
  kind: 'raw_request'; request: JsonObject; binding: NativeBinding;
  method: string; validation: 'unavailable'; schema_status: 'unavailable';
}>;
export type CheckedControl = Readonly<{
  kind: 'control'; frame: JsonObject; binding: NativeBinding;
  method: 'terminal.backend.control'; action: string; validation: 'schema';
}>;
export type DispatchCandidate = CheckedRequest | RawRequestCandidate | CheckedControl;
export type CheckedResponse = Readonly<{
  response: JsonObject; identity: ContractIdentity; bound: boolean;
}>;
export type StreamMode = 'general_events' | 'terminal_events' | 'observe' | 'control';
export type CheckedStream = Readonly<{
  binding: NativeBinding; method: string; mode: StreamMode; sequence: number;
}>;
export type CheckedEvent = Readonly<{ event: JsonObject; requires_resync: boolean }>;

export type SafetyClassification = Readonly<{
  method: string; action?: string; revision: string; contract: ContractIdentity;
  native: NativeMethodContract; transport: NativeTransport;
  effect: 'read' | 'write' | 'execute' | 'external'; requires_owner: boolean;
  management_permission: string | null; confirmation_required: boolean;
  result: Readonly<{
    boundary: 'ordinary' | 'protected_secret'; sensitivity: 'public' | 'potentially_sensitive' | 'credential';
    read_authorization: 'required'; retention: 'caller_policy' | 'none'; delivery: 'ordinary' | 'custody';
  }>;
  sub_action?: Readonly<{ pointer: string; value: Json }>;
}>;
export type RawContractGrant = Readonly<{
  id: string; source_verified: boolean; principal_id: string; binding: NativeBinding;
  methods: readonly string[]; actions?: readonly string[]; expires_at: number;
}>;
export type DispatchAuthorization = Readonly<{
  source: TrustedNativeContext; principal_id: string; classification_source_verified: boolean;
  classifications: readonly unknown[]; caller_policy: Policy; local_policy: Policy;
  permissions: readonly string[]; owner: boolean; confirmation_verified: boolean;
  custody_available: boolean; result_channel: 'ordinary' | 'custody';
  mode: 'strict' | 'raw_contract'; raw_requested: boolean;
  raw_grant?: RawContractGrant; now: number; supported_control_actions?: readonly string[];
  supported_transports?: readonly NativeTransport[];
}>;
export type DispatchPermit = Readonly<{
  kind: 'permit'; binding: NativeBinding; method: string;
  mode: 'strict' | 'raw_contract'; validation: ParameterValidation;
  classification_revision: string; raw_grant_id?: string;
}>;
export type NativeRequestGate = Readonly<{
  classification_status: 'trusted_complete' | 'missing' | 'unknown' | 'invalid' | 'untrusted';
  schema_status: 'complete' | 'incomplete' | 'unavailable';
  transport_status: 'supported' | 'unsupported'; authorized: boolean;
  secret_result_authorized: boolean; raw_contract_authorized: boolean;
}>;
export type ResultAuthorization = Readonly<{
  principal_id: string; caller_policy_allowed: boolean; local_policy_allowed: boolean;
  classification_source_verified: boolean; classification_revision: string;
  channel: 'ordinary' | 'custody'; content_status: 'available' | 'expired' | 'discarded';
}>;

export interface NativeValidator {
  bindCapabilities(response: unknown, source: TrustedNativeContext): Check<CapabilityView>;
  describe(view: CapabilityView, method: string): Check<MethodDescriptor>;
  checkRequest(view: CapabilityView, request: unknown): Check<CheckedRequest>;
  checkRawRequest(view: CapabilityView, request: unknown): Check<CheckedRequest | RawRequestCandidate>;
  checkResponseShape(response: unknown, family?: 'general' | 'terminal'): Check<CheckedResponse>;
  checkResponse(context: CheckedRequest | DispatchPermit, response: unknown, source: TrustedNativeContext): Check<CheckedResponse>;
  openStream(permit: DispatchPermit, acknowledgement: CheckedResponse): Check<CheckedStream>;
  checkEvent(stream: CheckedStream, event: unknown, source: TrustedNativeContext): Check<CheckedEvent>;
  checkControl(stream: CheckedStream, frame: unknown): Check<CheckedControl>;
}
```

绑定细节及 Wire raw-contract→raw_contract 映射见 IMPLEMENTATION-API.md。openStream 的 ack 须由相同 permit 的 checkResponse 产生；Check.ok 或 bound=true 均不是独立授权证明。
