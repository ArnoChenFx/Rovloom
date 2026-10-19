// 仅把 transport 当前认证连接实际收到的 receipt 交给持久接收端，JSON 不能构造一次性证明。
import type { ConnectionIdentity } from '../wire/types.js'
import type { AdmissionReceiptRecord } from '../wire/admission.js'
import { boundedJson, fail, validateAdmissionReceipt } from '../wire/index.js'

const receiptBrand = Symbol('authenticated-admission-receipt')
export type AuthenticatedAdmissionReceipt = Readonly<{ [receiptBrand]: true }>
export type AdmissionReceiptSink = Readonly<{
  accept(proof: AuthenticatedAdmissionReceipt): void
  closeEpoch?(connection: ConnectionIdentity): void
  assertRequest(request: import('../wire/admission.js').AdmissionRequest): void
}>
type Delivery = { record: AdmissionReceiptRecord; current: () => boolean }
const deliveries = new WeakMap<AuthenticatedAdmissionReceipt, Delivery>()

/** 仅供原 Connector 接收路径在完整 codec/消息去重通过后调用，不从公共 transport 入口导出。 */
export function authenticateAdmissionReceipt(
  record: AdmissionReceiptRecord,
  current: () => boolean
): AuthenticatedAdmissionReceipt {
  validateAdmissionReceipt(record)
  if (current() !== true) {
    fail('connection_unavailable')
  }
  const proof = Object.freeze({ [receiptBrand]: true as const })
  deliveries.set(proof, { record: JSON.parse(boundedJson(record)) as AdmissionReceiptRecord, current })
  return proof
}

/** 同步一次性消费真实对象并复核原 socket 仍活跃；复制、JSON 复述和关闭后的证明全部拒绝。 */
export function consumeAuthenticatedAdmissionReceipt(proof: AuthenticatedAdmissionReceipt): AdmissionReceiptRecord {
  const delivery = deliveries.get(proof)
  deliveries.delete(proof)
  if (!delivery || delivery.current() !== true) {
    fail('admission_receipt_proof_required')
  }
  return JSON.parse(boundedJson(delivery.record)) as AdmissionReceiptRecord
}
