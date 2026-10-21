// 计算登记请求摘要；同一 client_request_key 的重送靠摘要判定是否同一意图。
import type { RequestPayload } from './types.js'
import { validateAttempt } from './codec.js'
import { boundedJson, fields, object, id, uint, fail, hash, parseJson, text, oneOf } from './validation.js'

// 对登记的 v2 意图生成摘要；调用者身份和去重键查询由可信存储事务提供。
export function registeredRequestDigest(payload: RequestPayload, callerId: string): string {
  id(callerId)
  const p = object(parseJson(boundedJson(payload)))
  fields(p, ['attempt', 'expected_binding_revision', 'native_request', 'validation'])
  validateAttempt(p.attempt)
  uint(p.expected_binding_revision, true)
  oneOf(p.validation, ['strict', 'raw-contract'])
  if (p.expected_binding_revision !== p.attempt.binding_revision) {
    fail('provider_binding_mismatch')
  }
  const r = object(p.native_request)
  text(r.method, 256)
  if (Object.hasOwn(r, 'id') || Object.hasOwn(r, 'auth')) {
    fail('reserved_request_field')
  }
  return hash(
    boundedJson({
      wire_major: 2,
      caller_id: callerId,
      target: p.attempt.target,
      expected_binding_revision: p.expected_binding_revision,
      provider_kind: p.attempt.provider_kind,
      contract_ref: p.attempt.contract_ref,
      registration: p.attempt.registration,
      validation: p.validation,
      native_request: r
    })
  )
}
