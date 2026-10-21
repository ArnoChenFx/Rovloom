// 独立执行调用、结果读取与结果保留的安全门禁，校验可信分类及策略后登记内存派发许可。
import { authorize } from '../contracts.js'
import { candidates, permits, SCOPES, views } from './internal.js'
import { attempt, ContractFault, equal, fail, object, pointer, snapshot } from './json.js'
import { verifySource } from './validator.js'
import type {
  Check,
  DispatchAuthorization,
  DispatchCandidate,
  DispatchPermit,
  JsonObject,
  NativeRequestGate,
  ResultAuthorization,
  SafetyClassification
} from './types.js'

// 抛出来源与阶段均为授权的失败信息。
function reject(code: string, reason?: string): never {
  return fail(code, 'authorization', reason, 'authorization')
}
const TOKENS = new Set(['uhp.token.create', 'uhp.token.list', 'uhp.token.revoke'])

// 从可信分类快照中选出唯一匹配当前方法、控制动作与子动作的记录。
function selectClassification(candidate: DispatchCandidate, context: DispatchAuthorization): JsonObject {
  if (context.classification_source_verified !== true) {
    reject('safety_classification_untrusted')
  }
  if (!Array.isArray(context.classifications)) {
    reject('safety_classification_missing')
  }
  const rows = snapshot(context.classifications) as readonly JsonObject[]
  const selected = rows.filter(
    // 筛选方法匹配的分类。
    (row) => row && typeof row === 'object' && row.method === candidate.method
  )
  if (!selected.length) {
    reject('safety_classification_missing')
  }
  // 同一请求只能命中一条分类；缺少匹配或多条同时命中都拒绝。
  const matching = selected.filter(
    /* 匹配分类的可选子动作指针；缺失路径或非法选择器均视为不匹配。 */ (row) => {
      if (row.sub_action === undefined) {
        return true
      }
      try {
        const selector = object(row.sub_action)
        return (
          typeof selector.pointer === 'string' && equal(pointer(candidate.request, selector.pointer), selector.value)
        )
      } catch {
        return false
      }
    }
  )
  if (!matching.length) {
    reject('safety_classification_missing', 'sub_action')
  }
  if (matching.length !== 1) {
    reject('safety_classification_invalid', 'conflict')
  }
  return matching[0]!
}

// 验证分类的完整字段、绑定身份和安全语义，拒绝未知或互相冲突的要求。
function classification(candidate: DispatchCandidate, context: DispatchAuthorization): SafetyClassification {
  const row = selectClassification(candidate, context)
  const required = [
    'method',
    'revision',
    'contract',
    'native',
    'transport',
    'effect',
    'requires_owner',
    'management_permission',
    'confirmation_required',
    'result'
  ]
  if (
    required.some(/* 检测分类缺少的必填字段。 */ (key) => !Object.hasOwn(row, key)) ||
    Object.keys(row).some(/* 检测分类声明了未受支持的额外字段。 */ (key) => ![...required, 'sub_action'].includes(key))
  ) {
    reject('safety_classification_invalid', 'incomplete_or_unknown_field')
  }
  const native = object(row.native, 'safety_classification_invalid')
  const result = object(row.result, 'safety_classification_invalid')
  if (!equal(Object.keys(result).sort(), ['boundary', 'delivery', 'read_authorization', 'retention', 'sensitivity'])) {
    reject('safety_classification_invalid', 'incomplete_or_unknown_result_field')
  }
  if (
    !['read', 'write', 'execute', 'external'].includes(row.effect as string) ||
    !['single_request_rpc', 'host_stdio_proxy', 'persistent_local_stream'].includes(row.transport as string) ||
    !SCOPES.has(native.scope as string) ||
    !['read', 'write'].includes(native.access as string) ||
    !['ordinary', 'protected_secret'].includes(result.boundary as string) ||
    !['public', 'potentially_sensitive', 'credential'].includes(result.sensitivity as string) ||
    !['caller_policy', 'none'].includes(result.retention as string) ||
    !['ordinary', 'custody'].includes(result.delivery as string)
  ) {
    reject('safety_classification_unknown')
  }
  // 分类绑定当前契约、原生广告和 revision；原生 read/write 提示不能自行授予安全许可。
  const stored = candidates.get(candidate)!
  if (
    row.revision !== candidate.binding.classification_revision ||
    !equal(row.contract, candidate.binding.contract) ||
    !equal(native, stored.descriptor.native_contract) ||
    (stored.descriptor.transport !== 'unclassified' && row.transport !== stored.descriptor.transport) ||
    typeof row.requires_owner !== 'boolean' ||
    typeof row.confirmation_required !== 'boolean' ||
    !(
      row.management_permission === null ||
      (typeof row.management_permission === 'string' && row.management_permission.length > 0)
    ) ||
    result.read_authorization !== 'required' ||
    typeof native.idempotent !== 'boolean' ||
    (native.access === 'write' && row.effect === 'read') ||
    (native.access === 'read' && row.effect !== 'read') ||
    (native.scope === 'admin' && row.management_permission === null) ||
    (candidate.method === 'module.action.invoke' && row.sub_action === undefined)
  ) {
    reject('safety_classification_invalid', 'incomplete_or_conflicting')
  }
  if (
    (result.boundary === 'protected_secret') !== (result.delivery === 'custody') ||
    (result.sensitivity === 'credential' && result.boundary !== 'protected_secret') ||
    (TOKENS.has(candidate.method) && (result.boundary !== 'protected_secret' || row.management_permission === null))
  ) {
    reject('safety_classification_invalid', 'secret_boundary')
  }
  return row as unknown as SafetyClassification
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

// 要求当前适配器支持描述中的传输，并独立检查控制帧动作支持情况。
function checkTransport(
  candidate: DispatchCandidate,
  context: DispatchAuthorization,
  row?: SafetyClassification
): void {
  const stored = candidates.get(candidate)!
  const transport = stored.descriptor.transport === 'unclassified' ? row?.transport : stored.descriptor.transport
  if (
    !transport ||
    !Array.isArray(context.supported_transports) ||
    !context.supported_transports.includes(transport) ||
    (stored.descriptor.transport === 'unclassified' &&
      transport !== (candidate.binding.target.profile === 'host' ? 'host_stdio_proxy' : 'single_request_rpc'))
  ) {
    reject('unsupported_transport')
  }
}

// 同时检查原生访问列表、双方策略及分类要求的 Owner、管理权限和确认。
function checkPolicies(candidate: DispatchCandidate, context: DispatchAuthorization, row: SafetyClassification): void {
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
  if (row.requires_owner && context.owner !== true) {
    reject('forbidden', 'owner_required')
  }
  if (!Array.isArray(context.permissions)) {
    reject('invalid_authorization_context')
  }
  if (row.management_permission && !context.permissions.includes(row.management_permission)) {
    reject('management_forbidden')
  }
  if (row.confirmation_required && context.confirmation_verified !== true) {
    reject('confirmation_required')
  }
}

// 要求秘密结果走 custody，并验证选用的 custody 通道当前可用。
function checkSecret(context: DispatchAuthorization, row: SafetyClassification): void {
  if (
    (row.result.boundary === 'protected_secret' && context.result_channel !== 'custody') ||
    (context.result_channel === 'custody' && context.custody_available !== true)
  ) {
    reject('secret_boundary_required')
  }
  if (!['ordinary', 'custody'].includes(context.result_channel)) {
    reject('invalid_authorization_context')
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
    /* 验证当前授权上下文并执行各项门禁，最后登记许可及其主体和分类。 */ () => {
      const context = checkedAuthorization(candidate, input)
      const row = classification(candidate, context)
      checkTransport(candidate, context, row)
      checkPolicies(candidate, context, row)
      checkSecret(context, row)
      // raw 只放宽参数 schema 覆盖要求；前面的分类、传输、策略和秘密边界仍须全部通过。
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
      const permit: DispatchPermit = Object.freeze({
        kind: 'permit',
        binding: candidate.binding,
        method: candidate.method,
        mode: context.mode,
        validation: candidate.validation,
        classification_revision: row.revision,
        ...(context.mode === 'raw_contract' ? { raw_grant_id: context.raw_grant!.id } : {})
      })
      permits.set(permit, {
        candidate,
        principal: context.principal_id,
        classification: row,
        supportedActions: Object.freeze([])
      })
      return permit
    }
  )
}

// 分别报告分类、参数、传输和授权门禁状态，供调用方解释拒绝原因。
export function inspectRequestGate(
  candidate: DispatchCandidate,
  input: DispatchAuthorization
): Check<NativeRequestGate> {
  return attempt(
    'request_gate',
    /* 在保留可诊断分类状态的同时，独立评估每项门禁而不签发许可。 */ () => {
      const context = checkedAuthorization(candidate, input)
      let row: SafetyClassification | undefined
      let classification_status: NativeRequestGate['classification_status'] = 'trusted_complete'
      try {
        row = classification(candidate, context)
      } catch (error) {
        if (!(error instanceof ContractFault)) {
          throw error
        }
        const status = error.failure.code.replace('safety_classification_', '')
        if (!['missing', 'unknown', 'invalid', 'untrusted'].includes(status)) {
          throw error
        }
        classification_status = status as NativeRequestGate['classification_status']
      }
      return Object.freeze({
        classification_status,
        schema_status:
          candidate.validation === 'schema'
            ? 'complete'
            : candidate.validation === 'generic'
              ? 'incomplete'
              : 'unavailable',
        transport_status: attempt(
          'transport_gate',
          /* 独立检查当前传输能否用于此候选。 */ () => checkTransport(candidate, context, row)
        ).ok
          ? 'supported'
          : 'unsupported',
        authorized:
          !!row &&
          attempt(
            'policy_gate',
            /* 独立检查双方策略及分类要求的附加权限。 */ () => checkPolicies(candidate, context, row!)
          ).ok,
        secret_result_authorized:
          !!row && attempt('secret_gate', /* 独立检查结果通道是否满足秘密边界。 */ () => checkSecret(context, row!)).ok,
        raw_contract_authorized:
          context.mode === 'raw_contract' &&
          attempt('raw_gate', /* 独立检查 raw grant 是否授权当前候选。 */ () => checkRaw(candidate, context)).ok
      })
    }
  )
}

// 在结果读取时重新核验许可主体、当前策略、分类版本与交付通道。
export function checkResultBoundary(permit: DispatchPermit, input: ResultAuthorization): Check<void> {
  return attempt(
    'result',
    /* 读取真实许可并检查结果仍可用，拒绝过时分类或不合适的交付通道。 */ () => {
      const stored = permits.get(permit)
      if (!stored) {
        reject('invalid_permit_handle')
      }
      const context = snapshot(input) as unknown as ResultAuthorization
      if (context.classification_source_verified !== true) {
        reject('safety_classification_untrusted')
      }
      if (context.classification_revision !== stored.classification.revision) {
        reject('capability_stale')
      }
      if (
        stored.principal !== context.principal_id ||
        context.caller_policy_allowed !== true ||
        context.local_policy_allowed !== true
      ) {
        reject('forbidden')
      }
      if (stored.classification.result.boundary === 'protected_secret' && context.channel !== 'custody') {
        reject('secret_boundary_required')
      }
      if (!['ordinary', 'custody'].includes(context.channel)) {
        reject('invalid_authorization_context')
      }
      if (context.content_status !== 'available') {
        reject('content_unavailable')
      }
    }
  )
}

// 保留门禁独立于读取；同时服从派发时和当前可信分类，不能用新分类复活禁存原文。
export function checkResultRetention(permit: DispatchPermit, input: DispatchAuthorization): Check<void> {
  return attempt(
    'result',
    /* 重新验证当前授权及分类，并要求派发时与当前分类都允许保留结果。 */ () => {
      const stored = permits.get(permit)
      if (!stored) {
        reject('invalid_permit_handle')
      }
      const context = checkedAuthorization(stored.candidate, input)
      const current = classification(stored.candidate, context)
      if (stored.principal !== context.principal_id) {
        reject('forbidden')
      }
      if (stored.classification.result.retention !== 'caller_policy' || current.result.retention !== 'caller_policy') {
        reject('content_retention_forbidden')
      }
    }
  )
}
