import { authorize, canonical, GatewayError, validateRequest, validateTarget } from './contracts.js'
import type { NativeRequest, Policy, Target } from './contracts.js'
import { Store } from './store.js'

// 身份必须由已认证的传输层提供，不能从工具参数中反序列化。
export type Principal = {
  id: string
  policy: Policy
  permissions?: { discard_response?: boolean }
}

export type LocalPolicies = (machineId: string) => Policy

export class Router {
  constructor(
    private readonly store: Store,
    private readonly localPolicies: LocalPolicies
  ) {}

  private check(principal: Principal, target: Target, method: string): void {
    if (!principal.id.trim()) throw new GatewayError('unauthenticated')
    authorize(target, method, principal.policy, this.localPolicies(target.machine_id))
  }

  create(principal: Principal, target: Target, request: NativeRequest, key?: string, timeoutMs?: number) {
    // 先生成有大小限制的 JSON 快照，防止后续对象变更影响路由目标。
    const snapshot = JSON.parse(canonical({ target, request })) as {
      target: Target
      request: NativeRequest
    }
    validateTarget(snapshot.target)
    validateRequest(snapshot.request)
    this.check(principal, snapshot.target, snapshot.request.method)
    return this.store.createCall(principal.id, snapshot.target, snapshot.request, key, timeoutMs)
  }

  get(principal: Principal, callId: string) {
    const call = this.store.call(principal.id, callId)
    if (!call.target_json || !call.method) throw new GatewayError('legacy_call_context_unavailable')
    // 归属检查之后仍须按当前双端策略授权；创建时获准不代表之后始终可读或操作。
    this.check(principal, JSON.parse(call.target_json) as Target, call.method)
    return call
  }

  dispatch(principal: Principal, callId: string, epoch: string): string {
    this.get(principal, callId)
    return this.store.dispatch(principal.id, callId, epoch)
  }

  saveResult(principal: Principal, callId: string) {
    this.get(principal, callId)
    return this.store.saveResult(principal.id, callId)
  }

  discardResponse(principal: Principal, callId: string): void {
    this.get(principal, callId)
    // 原生方法的读取许可不代表拥有网关保存数据的删除许可。
    if (principal.permissions?.discard_response !== true) throw new GatewayError('discard_forbidden')
    this.store.discardResponse(principal.id, callId)
  }

  readResult(principal: Principal, resultId: string, cursor = 0, maxBytes = 65_536) {
    const call = this.store.resultCall(principal.id, resultId)
    this.get(principal, call.call_id)
    return this.store.readResult(principal.id, resultId, cursor, maxBytes)
  }

  cancel(principal: Principal, callId: string) {
    this.get(principal, callId)
    // 只停止桥接；outcome_unknown 不表示远端原生动作已回滚。
    return this.store.stop(principal.id, callId)
  }
}
