// 依据宿主可信身份及双方当前 provider 策略路由持久调用、派发和结果操作，逐次授权并保留登记版本边界。
import { canonical, GatewayError, validateRequest } from './contracts.js'
import type { NativeRequest } from './contracts.js'
import { boundedJson, providerScopeAllowed, validateTarget } from './wire/index.js'
import type { ProviderAction, ProviderPolicy, V2Target } from './wire/types.js'
import { Store } from './store.js'
import type { CallOptions } from './store.js'

// 身份与策略来自认证宿主，不能由 runtime_call 的 JSON 参数构造。
export type Principal = {
  id: string
  policy: ProviderPolicy
  permissions?: { discard_response?: boolean }
}
export type LocalPolicies = (target: V2Target) => ProviderPolicy
export class Router {
  // 绑定持久 Store 与宿主本地策略解析器，供每次操作重新执行双方策略检查。
  constructor(
    private readonly store: Store,
    private readonly localPolicies: LocalPolicies
  ) {}
  // 要求有效主体，并按完整 provider 目标及操作类型同时核对调用方和宿主当前策略。
  private check(principal: Principal, target: V2Target, method: string, action: ProviderAction): void {
    if (!principal.id.trim()) {
      throw new GatewayError('unauthenticated')
    }
    // 只使用完整 tuple；revision 由 Store 和真实 native gate 另行核对。
    const binding = { target } as Parameters<typeof providerScopeAllowed>[0]
    if (
      !providerScopeAllowed(binding, method, action, {
        caller: principal.policy,
        local: this.localPolicies(target)
      })
    ) {
      throw new GatewayError('forbidden')
    }
  }
  // 快照并校验目标与请求，授权后将双方策略版本一并登记为新的持久调用意图。
  create(
    principal: Principal,
    target: V2Target,
    request: NativeRequest,
    options: Omit<CallOptions, 'caller_policy_revision' | 'local_policy_revision'>
  ) {
    const snapshot = JSON.parse(canonical({ target, request })) as {
      target: V2Target
      request: NativeRequest
    }
    validateTarget(snapshot.target)
    validateRequest(snapshot.request)
    this.check(principal, snapshot.target, snapshot.request.method, 'dispatch')
    return this.store.createCall(principal.id, snapshot.target, snapshot.request, {
      ...options,
      caller_policy_revision: principal.policy.revision,
      local_policy_revision: this.localPolicies(snapshot.target).revision
    })
  }
  // 读取主体所属调用，并按其已登记目标重新核对指定操作的当前双方策略。
  private authorized(principal: Principal, callId: string, action: ProviderAction) {
    const call = this.store.call(principal.id, callId)
    this.check(principal, JSON.parse(call.target_json), call.method, action)
    return call
  }
  // 在持久归属、期限和 provider 校验通过后，重新执行读取策略并返回调用视图。
  get(principal: Principal, callId: string) {
    return this.authorized(principal, callId, 'read')
  }
  // 重验派发策略并核对登记时双方版本，提交持久派发锚点后返回有界 JSON 绑定快照。
  dispatch(principal: Principal, callId: string, epoch: string) {
    const call = this.authorized(principal, callId, 'dispatch')
    // 策略 revision 变更必须作为新意图登记，不能悄悄刷新已登记 attempt。
    const target = JSON.parse(call.target_json) as V2Target
    const binding = this.store.dispatch(principal.id, callId, epoch, {
      caller: principal.policy.revision,
      local: this.localPolicies(target).revision
    })
    return JSON.parse(boundedJson(binding)) as typeof binding
  }
  // 重新确认调用可读后创建或复用受固定内容期限约束的结果句柄。
  saveResult(principal: Principal, callId: string) {
    this.get(principal, callId)
    return this.store.saveResult(principal.id, callId)
  }
  // 同时要求当前读取授权与独立丢弃权限，再删除结果句柄和调用原文。
  discardResponse(principal: Principal, callId: string): void {
    this.get(principal, callId)
    if (principal.permissions?.discard_response !== true) {
      throw new GatewayError('discard_forbidden')
    }
    this.store.discardResponse(principal.id, callId)
  }
  // 先按句柄解析所属调用并重验读取策略，再返回受字节上限约束的响应分块。
  readResult(principal: Principal, resultId: string, cursor = 0, maxBytes = 65_536) {
    const call = this.store.resultCall(principal.id, resultId)
    this.get(principal, call.call_id)
    return this.store.readResult(principal.id, resultId, cursor, maxBytes)
  }
  // 重新核对取消权限后持久停止调用，返回未派发或结果未知等实际状态。
  cancel(principal: Principal, callId: string) {
    this.authorized(principal, callId, 'cancel')
    return this.store.stop(principal.id, callId)
  }
  // 在限定时长内轮询调用，每轮重新授权；终态或单调等待期限到达时返回当前视图。
  async wait(principal: Principal, callId: string, waitMs = 1000) {
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 25_000) {
      throw new GatewayError('invalid_wait')
    }
    const until = performance.now() + waitMs
    while (true) {
      const call = this.get(principal, callId)
      if (!['created', 'dispatching', 'connector_accepted'].includes(call.state) || performance.now() >= until) {
        return call
      }
      await new Promise(
        /* 按剩余等待时间安排 1 至 50 毫秒的下一次轮询唤醒。 */ (resolve) =>
          setTimeout(resolve, Math.min(50, Math.max(1, until - performance.now())))
      )
    }
  }
}
