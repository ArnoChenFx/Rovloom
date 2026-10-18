import type {
  AttemptBinding,
  AuthenticatedEnvelope,
  CodecContext,
  JsonObject,
  ValidationMode,
  RequestGate
} from './types.js'
import { assertBinding, decodeWireObject } from './codec.js'
import { providerScopeAllowed } from './provider.js'
import { boundedJson, uint, hash, fail, LIMITS, sha } from './validation.js'

export type ResponseAnchor = {
  binding: AttemptBinding
  method: string
  mode: ValidationMode
  state: 'dispatching' | 'connector_accepted' | 'outcome_unknown' | 'responded' | 'not_dispatched'
  content_status: 'available' | 'expired' | 'discarded' | 'unavailable'
  content_expires_at: number
  dedup_expires_at: number
  evidence?: { response_hash: string; response_bytes: number }
}

export type ResponseEvidencePlan = {
  action: 'append' | 'duplicate'
  late_evidence: boolean
  dispatch: false
  evidence: {
    binding: AttemptBinding
    received_at: number
    response_hash: string
    response_bytes: number
    category: 'result' | 'error'
  }
  content: {
    status: ResponseAnchor['content_status']
    expires_at: number
    delivery: 'payload' | 'metadata_only'
    native_response?: JsonObject
  }
}

// 当前可信分类与保存权限，不能取自持久化旧 ACL、response 内容或 caller 自报。
export type ResponseContentPolicy = {
  classification_status: RequestGate['classification_status']
  retain_content_authorized: boolean
}

// 返回待提交意图；可靠持久化、历史保留、当前读取授权和最终发布由 #5 负责。
export function planResponseEvidence(
  frame: Extract<AuthenticatedEnvelope, { type: 'response' }>,
  context: CodecContext,
  anchor: ResponseAnchor | undefined,
  now: number,
  policy?: ResponseContentPolicy
): ResponseEvidencePlan {
  if (!anchor) {
    fail('attempt_anchor_unavailable')
  }
  uint(now)
  uint(anchor.content_expires_at, true)
  uint(anchor.dedup_expires_at, true)
  if (context.phase !== 'authenticated' || context.direction !== 'connector_to_gateway') {
    fail('authentication_required')
  }
  if (anchor.state === 'outcome_unknown' && !context.connection.negotiated.capabilities.includes('late_evidence')) {
    fail('unsupported_capability')
  }
  // 大响应只能走同样受限的逻辑对象检查，不能通过 typed 参数绕过 codec。
  const checked = decodeWireObject(Buffer.from(boundedJson(frame, LIMITS.object_bytes)), context)
  if (checked.type !== 'response') {
    fail('invalid_evidence')
  }
  const binding = {
    machine_id: checked.machine_id,
    recovery_generation: checked.recovery_generation,
    connection_epoch: checked.connection_epoch,
    ...checked.payload.attempt
  }
  assertBinding(binding, anchor.binding)
  const resolved = context.resolveAttempt?.(checked.payload.attempt)
  if (!resolved || resolved.method !== anchor.method || resolved.mode !== anchor.mode) {
    fail('attempt_binding_mismatch')
  }
  if (now >= anchor.dedup_expires_at || anchor.state === 'not_dispatched') {
    fail('evidence_not_applicable')
  }
  if (!['dispatching', 'connector_accepted', 'outcome_unknown', 'responded'].includes(anchor.state)) {
    fail('evidence_not_applicable')
  }
  const raw = boundedJson(checked.payload.native_response, LIMITS.object_bytes)
  const response_hash = hash(raw)
  const response_bytes = Buffer.byteLength(raw)

  if (anchor.evidence) {
    sha(anchor.evidence.response_hash)
    uint(anchor.evidence.response_bytes, true)
    if (anchor.evidence.response_hash !== response_hash || anchor.evidence.response_bytes !== response_bytes) {
      fail('response_evidence_conflict')
    }
  } else if (anchor.state === 'responded') {
    fail('evidence_anchor_unavailable')
  }
  // 证据能否追加与原文能否保存分别判断；晚到结果不会恢复过期或 discarded 内容。
  const status =
    anchor.content_status === 'available' && now >= anchor.content_expires_at ? 'expired' : anchor.content_status
  if (!['available', 'expired', 'discarded', 'unavailable'].includes(status)) {
    fail('invalid_content_status')
  }
  const duplicate = anchor.evidence !== undefined
  const retain =
    status === 'available' &&
    !duplicate &&
    policy?.classification_status === 'trusted_complete' &&
    policy.retain_content_authorized === true &&
    providerScopeAllowed(binding, anchor.method, 'read', context.policies)
  return {
    action: duplicate ? 'duplicate' : 'append',
    late_evidence: anchor.state === 'outcome_unknown',
    dispatch: false,
    evidence: {
      binding,
      received_at: now,
      response_hash,
      response_bytes,
      category: Object.hasOwn(checked.payload.native_response, 'error') ? 'error' : 'result'
    },
    // 重复消息不生成任何原文写入/句柄意图，也不刷新期限。
    content: {
      status,
      expires_at: anchor.content_expires_at,
      delivery: retain ? 'payload' : 'metadata_only',
      ...(retain ? { native_response: checked.payload.native_response } : {})
    }
  }
}
