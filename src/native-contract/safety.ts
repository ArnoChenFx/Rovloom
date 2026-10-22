// 独立执行调用与结果读取门禁：按静态方法表、双端策略和 raw 授权校验后登记内存派发许可。
import { authorize } from '../contracts.js'
import { candidates, views } from './internal.js'
import { luvusMethod } from './methods.js'
import { attempt, equal, fail, object, snapshot } from './json.js'
import { verifySource } from './validator.js'
import type { Check, DispatchAuthorization, DispatchCandidate, DispatchPermit, ResultAuthorization } from './types.js'

// 抛出来源与阶段均为授权的失败信息。
function reject(code: string, reason?: string): never {
  return fail(code, 'authorization', reason, 'authorization')
}

// 核验候选句柄、来源和主体时间字段，并冻结授权输入以防后续变更。
function checkedAuthorization(candidate: DispatchCandidate, input: DispatchAuthorization): DispatchAuthorization {
  const stored = candidates.get(candidate)
  if (!stored || !views.has(stored.view)) {
    reject('invalid_request_handle')
  }
  const context = snapshot(input) as unknown as DispatchAuthorization
  if (!context.source?.authenticated) {
    reject('unauthenticated')
  }
  const current = verifySource(context.source)
  if (!equal(current, candidate.binding)) {
    reject('capability_stale')
  }
  if (
    typeof context.principal_id !== 'string' ||
    !context.principal_id.trim() ||
    !Number.isSafeInteger(context.now) ||
    context.now < 0
  ) {
    reject('invalid_authorization_context')
  }
  return context
}

// 许可必须是 checkDispatch 签发的形状，且其候选仍是本校验器登记过的请求。
export function checkedPermit(permit: DispatchPermit): void {
  if (!permit || permit.kind !== 'permit' || !candidates.has(permit.candidate)) {
    reject('invalid_permit_handle')
  }
}

// 方法必须在静态表中，且实际安装契约广告的原生提示与表逐字段一致；表外方法一律拒绝。
function checkListed(candidate: DispatchCandidate): void {
  const stored = candidates.get(candidate)!
  const listed = luvusMethod(candidate.method)
  if (!listed) {
    reject('method_not_listed')
  }
  if (!equal(listed, stored.descriptor.native_contract)) {
    reject('method_contract_mismatch')
  }
  if (
    candidate.binding.target.profile !== 'session' ||
    (stored.descriptor.transport !== 'unclassified' && stored.descriptor.transport !== 'single_request_rpc')
  ) {
    reject('unsupported_transport')
  }
}

// 检查原生访问列表与双方策略；调用方与本机都必须授权该方法。
function checkPolicies(candidate: DispatchCandidate, context: DispatchAuthorization): void {
  const stored = candidates.get(candidate)!
  const capabilities = views.get(stored.view)!.capabilities
  if (capabilities.access !== undefined) {
    const access = object(capabilities.access)
    if (!Array.isArray(access.allowed_methods) || !access.allowed_methods.includes(candidate.method)) {
      reject('forbidden', 'native_access')
    }
  }
  for (const policy of [context.caller_policy, context.local_policy]) {
    if (
      !policy ||
      typeof policy.host !== 'boolean' ||
      ['machines', 'sessions', 'methods'].some(
        /* 检查每个策略列表的类型、非空条目和重复值。 */ (key) => {
          const items = (policy as unknown as Record<string, unknown>)[key]
          return (
            !Array.isArray(items) ||
            !items.every(
              /* 要求策略列表中的每项都是非空字符串。 */ (item) => typeof item === 'string' && item.length > 0
            ) ||
            new Set(items).size !== items.length
          )
        }
      )
    ) {
      reject('invalid_authorization_context')
    }
  }
  try {
    authorize(candidate.binding.target, candidate.method, context.caller_policy, context.local_policy)
  } catch {
    reject('forbidden', 'policy')
  }
}

// 核验 raw 的显式选择、Owner 身份和授权范围、有效期及完整绑定。
function checkRaw(candidate: DispatchCandidate, context: DispatchAuthorization): void {
  const grant = context.raw_grant
  if (
    context.owner !== true ||
    context.raw_requested !== true ||
    !grant ||
    grant.source_verified !== true ||
    typeof grant.id !== 'string' ||
    !grant.id.length ||
    Object.keys(grant).some(
      // 拒绝 raw grant 中未受支持的额外字段。
      (key) => !['id', 'source_verified', 'principal_id', 'binding', 'methods', 'expires_at'].includes(key)
    )
  ) {
    reject('raw_contract_not_authorized')
  }
  if (
    grant.principal_id !== context.principal_id ||
    !Array.isArray(grant.methods) ||
    !grant.methods.includes(candidate.method) ||
    !equal(grant.binding?.target, candidate.binding.target)
  ) {
    reject('raw_contract_scope_mismatch')
  }
  if (!Number.isSafeInteger(grant.expires_at) || grant.expires_at <= context.now) {
    reject('raw_contract_grant_expired')
  }
  if (!equal(grant.binding, candidate.binding)) {
    reject('raw_contract_grant_stale')
  }
}

// 全部安全门禁通过后签发内存许可；raw 仅豁免参数 schema 完整性要求。
export function checkDispatch(candidate: DispatchCandidate, input: DispatchAuthorization): Check<DispatchPermit> {
  return attempt(
    'authorization',
    /* 验证当前授权上下文并执行各项门禁，最后登记许可及其主体。 */ () => {
      const context = checkedAuthorization(candidate, input)
      checkListed(candidate)
      checkPolicies(candidate, context)
      // raw 只放宽参数 schema 覆盖要求；方法表、策略和传输门禁仍须全部通过。
      if (context.mode === 'strict') {
        if (candidate.validation === 'generic') {
          reject('parameter_schema_incomplete')
        }
        if (candidate.validation === 'unavailable') {
          reject('schema_unavailable')
        }
      } else if (context.mode === 'raw_contract') {
        checkRaw(candidate, context)
      } else {
        reject('invalid_execution_mode')
      }
      return Object.freeze({
        kind: 'permit' as const,
        candidate,
        principal_id: context.principal_id,
        binding: candidate.binding,
        method: candidate.method,
        mode: context.mode,
        validation: candidate.validation,
        ...(context.mode === 'raw_contract' ? { raw_grant_id: context.raw_grant!.id } : {})
      })
    }
  )
}

// 在结果读取时重新核验许可主体、当前双端策略与内容状态。
export function checkResultBoundary(permit: DispatchPermit, input: ResultAuthorization): Check<void> {
  return attempt(
    'result',
    /* 读取真实许可并检查结果仍可用，拒绝其它主体或已撤权的读取。 */ () => {
      checkedPermit(permit)
      const context = snapshot(input) as unknown as ResultAuthorization
      if (
        permit.principal_id !== context.principal_id ||
        context.caller_policy_allowed !== true ||
        context.local_policy_allowed !== true
      ) {
        reject('forbidden')
      }
      if (context.content_status !== 'available') {
        reject('content_unavailable')
      }
    }
  )
}

// 保存门禁独立于读取：只有派发时的同一主体、同一当前来源才能保留原文。
export function checkResultRetention(permit: DispatchPermit, input: DispatchAuthorization): Check<void> {
  return attempt(
    'result',
    /* 重新验证当前授权来源，并要求仍是派发时的主体。 */ () => {
      checkedPermit(permit)
      const context = checkedAuthorization(permit.candidate, input)
      if (permit.principal_id !== context.principal_id) {
        reject('forbidden')
      }
    }
  )
}
