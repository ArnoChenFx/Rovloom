import { canonical, GatewayError, validateRequest } from './contracts.js';
import type { NativeRequest } from './contracts.js';
import { boundedJson, providerScopeAllowed, validateTarget } from './wire/index.js';
import type { ProviderAction, ProviderPolicy, V2Target } from './wire/types.js';
import { Store } from './store.js';
import type { CallOptions } from './store.js';

// 身份与策略来自认证宿主，不能由 runtime_call 的 JSON 参数构造。
export type Principal = {
  id: string;
  policy: ProviderPolicy;
  permissions?: { discard_response?: boolean };
};
export type LocalPolicies = (target: V2Target) => ProviderPolicy;
export class Router {
  constructor(
    private readonly store: Store,
    private readonly localPolicies: LocalPolicies,
  ) {}
  private check(
    principal: Principal,
    target: V2Target,
    method: string,
    action: ProviderAction,
  ): void {
    if (!principal.id.trim()) throw new GatewayError('unauthenticated');
    // 只使用完整 tuple；revision 由 Store 和真实 native gate 另行核对。
    const binding = { target } as Parameters<typeof providerScopeAllowed>[0];
    if (
      !providerScopeAllowed(binding, method, action, {
        caller: principal.policy,
        local: this.localPolicies(target),
      })
    )
      throw new GatewayError('forbidden');
  }
  create(
    principal: Principal,
    target: V2Target,
    request: NativeRequest,
    options: Omit<CallOptions, 'caller_policy_revision' | 'local_policy_revision'>,
  ) {
    const snapshot = JSON.parse(canonical({ target, request })) as {
      target: V2Target;
      request: NativeRequest;
    };
    validateTarget(snapshot.target);
    validateRequest(snapshot.request);
    this.check(principal, snapshot.target, snapshot.request.method, 'dispatch');
    return this.store.createCall(principal.id, snapshot.target, snapshot.request, {
      ...options,
      caller_policy_revision: principal.policy.revision,
      local_policy_revision: this.localPolicies(snapshot.target).revision,
    });
  }
  private authorized(principal: Principal, callId: string, action: ProviderAction) {
    const call = this.store.call(principal.id, callId);
    this.check(principal, JSON.parse(call.target_json), call.method, action);
    return call;
  }
  get(principal: Principal, callId: string) {
    return this.authorized(principal, callId, 'read');
  }
  dispatch(principal: Principal, callId: string, epoch: string) {
    const call = this.authorized(principal, callId, 'dispatch');
    // 策略 revision 变更必须作为新意图登记，不能悄悄刷新已登记 attempt。
    const target = JSON.parse(call.target_json) as V2Target;
    const binding = this.store.dispatch(principal.id, callId, epoch, {
      caller: principal.policy.revision,
      local: this.localPolicies(target).revision,
    });
    return JSON.parse(boundedJson(binding)) as typeof binding;
  }
  saveResult(principal: Principal, callId: string) {
    this.get(principal, callId);
    return this.store.saveResult(principal.id, callId);
  }
  discardResponse(principal: Principal, callId: string): void {
    this.get(principal, callId);
    if (principal.permissions?.discard_response !== true)
      throw new GatewayError('discard_forbidden');
    this.store.discardResponse(principal.id, callId);
  }
  readResult(principal: Principal, resultId: string, cursor = 0, maxBytes = 65_536) {
    const call = this.store.resultCall(principal.id, resultId);
    this.get(principal, call.call_id);
    return this.store.readResult(principal.id, resultId, cursor, maxBytes);
  }
  cancel(principal: Principal, callId: string) {
    this.authorized(principal, callId, 'cancel');
    return this.store.stop(principal.id, callId);
  }
}
