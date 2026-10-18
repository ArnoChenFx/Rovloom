// 维护原生校验器的私有句柄登记与最小响应约束，阻止消息伪造可信上下文。
import type { ValidateFunction } from 'ajv'
import type {
  CapabilityView,
  CheckedControl,
  CheckedRequest,
  CheckedResponse,
  CheckedStream,
  CompiledContract,
  DispatchCandidate,
  DispatchPermit,
  JsonObject,
  Limits,
  MethodDescriptor,
  RawRequestCandidate,
  SafetyClassification,
  NativeBinding,
  ResponseOnlyContext
} from './types.js'

export const UHP = 'https://luvus.dev/protocol/uhp/v1/'
export const SCOPES = new Set(['read', 'workspace', 'agent', 'terminal', 'orchestration', 'extensions', 'admin'])
export const STREAM_METHODS = new Set([
  'events.subscribe',
  'terminal.backend.events.subscribe',
  'terminal.backend.observe',
  'terminal.backend.control'
])
export type ContractData = {
  bundle: JsonObject
  documents: Record<string, unknown>
  limits: Limits
  validators: Map<string, ValidateFunction>
  requestMethods: readonly string[]
  branches: Map<string, readonly string[]>
}
export type ViewData = {
  contract: CompiledContract
  capabilities: JsonObject
  methods: Map<string, MethodDescriptor>
}
export type CandidateData = {
  view: CapabilityView
  descriptor: MethodDescriptor
  stream?: CheckedStream
}
export type PermitData = {
  candidate: DispatchCandidate
  principal: string
  classification: SafetyClassification
  supportedActions: readonly string[]
}
export type StreamData = { permit: DispatchPermit; identity: JsonObject | null }
// WeakMap 防止从 JSON 伪造 handle；来源仍按各 handle 的 contract/binding 核对。
export const contracts = new WeakMap<CompiledContract, ContractData>()
export const views = new WeakMap<CapabilityView, ViewData>()
export const candidates = new WeakMap<CheckedRequest | RawRequestCandidate | CheckedControl, CandidateData>()
type PermitGroup = { entries: WeakMap<DispatchPermit, PermitData> | undefined }
const permitGroups = new WeakMap<DispatchPermit, PermitGroup>()
const candidateGroups = new WeakMap<DispatchCandidate, PermitGroup>()
// 候选只拥有一个可撤销分组；不枚举弱键、不积累强引用集合，撤销时一起断开正文与分类引用。
export const permits = {
  // 只有仍存活的候选分组才能解析许可；分组撤销后所有同候选许可同时失效。
  get(permit: DispatchPermit): PermitData | undefined {
    return permitGroups.get(permit)?.entries?.get(permit)
  },
  // 检查逻辑许可是否有效，而非仅检查其弱键是否仍被调用方持有。
  has(permit: DispatchPermit): boolean {
    return this.get(permit) !== undefined
  },
  // 将真实授权后的许可放入对应候选的弱键分组，保留原许可各自的 principal 与分类事实。
  set(permit: DispatchPermit, value: PermitData): void {
    let group = candidateGroups.get(value.candidate)
    if (!group) {
      group = { entries: new WeakMap() }
      candidateGroups.set(value.candidate, group)
    }
    group.entries!.set(permit, value)
    permitGroups.set(permit, group)
  },
  // 销毁整个请求分组；调用方即使还持有其它许可，也无法再从内部登记到达原请求或分类。
  revoke(candidate: DispatchCandidate): void {
    const group = candidateGroups.get(candidate)
    if (group) {
      group.entries = undefined
      candidateGroups.delete(candidate)
    }
  }
}
export const responses = new WeakMap<
  CheckedResponse,
  { candidate: DispatchCandidate | null; contract: CompiledContract; permit: DispatchPermit | null }
>()
export const streams = new WeakMap<CheckedStream, StreamData>()

export type ResponseRules = {
  terminal: boolean
  bind_native_identity: boolean
  expected_type?: string
  expected_mode?: string
  identities: JsonObject
}
export type ResponseContextData = {
  contract: CompiledContract
  binding: NativeBinding
  native_id: string
  method: string
  frame_bytes: number | null
  rules: ResponseRules
}
// 不保留 candidate、permit、request 或 capabilities 引用。
export const responseContexts = new WeakMap<ResponseOnlyContext, ResponseContextData>()
