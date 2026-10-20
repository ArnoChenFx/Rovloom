// 定义认证通道交付的原截止元数据与规范请求摘要，不生成原生执行许可。
import type { ResponseAnchor } from './evidence.js'
import type { LedgerInvalidation } from '../storage/model.js'
import { registeredRequestDigest } from './history.js'
import type { AttemptBinding, JsonObject, ValidationMode } from './types.js'
import { assertBinding } from './codec.js'
import { boundedJson, fail, fields, hash, object, oneOf, sha, uint, id, text } from './validation.js'

export type AdmissionRequest = Readonly<{
  binding: AttemptBinding
  native_request: JsonObject
  validation: ValidationMode
}>
export type AdmissionReceiptContext = Readonly<{
  principal_id: string
  registered_request_sha256: string
  anchor: ResponseAnchor
  sequence: number
  fenced: boolean
}>
export type TrustedAdmissionSnapshot = Readonly<{
  binding: AttemptBinding
  principal_id: string
  request_sha256: string
  registered_request_sha256: string
  anchor: ResponseAnchor
  sequence: number
  fenced: boolean
}>
export interface AdmissionContextReader {
  snapshot(binding: AttemptBinding): TrustedAdmissionSnapshot
  subscribeInvalidation(listener: (event: LedgerInvalidation) => void): () => void
}
export type AdmissionReceiptRecord = Readonly<{
  binding: AttemptBinding
  request_sha256: string
  dedup_expires_at: number
  context?: AdmissionReceiptContext
}>

/** 对完整绑定、原始无 auth/id 请求和验证模式求规范摘要；嵌套对象同样由 boundedJson 排序。 */
export function admissionRequestDigest(request: AdmissionRequest): string {
  const snapshot = object(request)
  fields(snapshot, ['binding', 'native_request', 'validation'])
  fields(object(request.binding), [
    'machine_id',
    'recovery_generation',
    'connection_epoch',
    'call_id',
    'attempt_id',
    'native_request_id',
    'target',
    'provider_kind',
    'binding_revision',
    'contract_ref',
    'registration'
  ])
  assertBinding(request.binding, request.binding)
  if (request.binding.target.machine_id !== request.binding.machine_id) {
    fail('target_machine_mismatch')
  }
  oneOf(request.validation, ['strict', 'raw-contract'])
  const native = object(request.native_request)
  if (Object.hasOwn(native, 'id') || Object.hasOwn(native, 'auth')) {
    fail('reserved_request_field')
  }
  return hash(boundedJson(request))
}

/** 严格核对持久 receipt 形状和原截止覆盖执行期限；本函数不证明数据来自认证通道。 */
export function validateAdmissionReceipt(value: unknown): asserts value is AdmissionReceiptRecord {
  const receipt = object(value)
  fields(receipt, ['binding', 'request_sha256', 'dedup_expires_at'], ['context'])
  const binding = receipt.binding as AttemptBinding
  fields(object(binding), [
    'machine_id',
    'recovery_generation',
    'connection_epoch',
    'call_id',
    'attempt_id',
    'native_request_id',
    'target',
    'provider_kind',
    'binding_revision',
    'contract_ref',
    'registration'
  ])
  assertBinding(binding, binding)
  if (binding.target.machine_id !== binding.machine_id) {
    fail('target_machine_mismatch')
  }
  sha(receipt.request_sha256)
  uint(receipt.dedup_expires_at, true)
  if (receipt.dedup_expires_at < binding.registration.deadline) {
    fail('admission_receipt_deadline_invalid')
  }
  if (receipt.context !== undefined) {
    validateAdmissionContext(receipt.context, binding, receipt.dedup_expires_at)
  }
}

/** 完整登记摘要严格复用 Store 算法；执行 ID 与连接身份仍由独立完整 binding 核对。 */
export function admissionRegisteredRequestDigest(request: AdmissionRequest, principalId: string): string {
  admissionRequestDigest(request)
  const {
    machine_id: _machine,
    recovery_generation: _generation,
    connection_epoch: _epoch,
    ...attempt
  } = request.binding
  return registeredRequestDigest(
    {
      attempt,
      expected_binding_revision: request.binding.binding_revision,
      native_request: request.native_request,
      validation: request.validation
    },
    principalId
  )
}

/** 校验附加上下文全部来源字段，不从 receipt 建立原生许可或 caller 权限。 */
export function validateAdmissionContext(
  context: unknown,
  binding: AttemptBinding,
  dedup: number
): asserts context is AdmissionReceiptContext {
  const value = object(context)
  fields(value, ['principal_id', 'registered_request_sha256', 'anchor', 'sequence', 'fenced'])
  id(value.principal_id)
  sha(value.registered_request_sha256)
  uint(value.sequence, true)
  if (typeof value.fenced !== 'boolean') {
    fail('invalid_admission_context')
  }
  const anchor = object(value.anchor)
  fields(
    anchor,
    ['binding', 'method', 'mode', 'state', 'content_status', 'content_expires_at', 'dedup_expires_at'],
    ['evidence']
  )
  fields(object(anchor.binding), Object.keys(binding))
  assertBinding(anchor.binding as AttemptBinding, binding)
  text(anchor.method, 256)
  oneOf(anchor.mode, ['strict', 'raw-contract'])
  oneOf(anchor.state, ['dispatching', 'connector_accepted', 'outcome_unknown', 'responded', 'not_dispatched'])
  oneOf(anchor.content_status, ['available', 'expired', 'discarded', 'unavailable'])
  uint(anchor.content_expires_at, true)
  uint(anchor.dedup_expires_at, true)
  if (anchor.dedup_expires_at !== dedup) {
    fail('admission_context_mismatch')
  }
  if (anchor.evidence !== undefined) {
    const evidence = object(anchor.evidence)
    fields(evidence, ['response_hash', 'response_bytes'])
    sha(evidence.response_hash)
    uint(evidence.response_bytes, true)
    if (anchor.state !== 'responded') {
      fail('admission_context_mismatch')
    }
  } else if (anchor.state === 'responded') {
    fail('admission_context_mismatch')
  }
}
