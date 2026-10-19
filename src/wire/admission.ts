// 定义认证通道交付的原截止元数据与规范请求摘要，不生成原生执行许可。
import type { AttemptBinding, JsonObject, ValidationMode } from './types.js'
import { assertBinding } from './codec.js'
import { boundedJson, fail, fields, hash, object, oneOf, sha, uint } from './validation.js'

export type AdmissionRequest = Readonly<{
  binding: AttemptBinding
  native_request: JsonObject
  validation: ValidationMode
}>
export type AdmissionReceiptRecord = Readonly<{
  binding: AttemptBinding
  request_sha256: string
  dedup_expires_at: number
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
  fields(receipt, ['binding', 'request_sha256', 'dedup_expires_at'])
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
}
