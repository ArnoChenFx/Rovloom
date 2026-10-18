import { authorize, canonical, GatewayError, validateRequest, validateTarget } from './contracts.js';
import type { NativeRequest, Policy, Target } from './contracts.js';
import { Store } from './store.js';

// Authenticated transports supply this identity; never deserialize it from tool arguments.
export type Principal = { id: string; policy: Policy };
export type LocalPolicies = (machineId: string) => Policy;

export class Router {
  constructor(private readonly store: Store, private readonly localPolicies: LocalPolicies) {}

  private check(principal: Principal, target: Target, method: string): void {
    if (!principal.id.trim()) throw new GatewayError('unauthenticated');
    authorize(target, method, principal.policy, this.localPolicies(target.machine_id));
  }

  create(principal: Principal, target: Target, request: NativeRequest, key?: string, timeoutMs?: number) {
    // Snapshot bounded JSON before inspecting it; subsequent mutations cannot change routing.
    const snapshot = JSON.parse(canonical({ target, request })) as { target: Target; request: NativeRequest };
    validateTarget(snapshot.target);
    validateRequest(snapshot.request);
    this.check(principal, snapshot.target, snapshot.request.method);
    return this.store.createCall(principal.id, snapshot.target, snapshot.request, key, timeoutMs);
  }

  get(principal: Principal, callId: string) {
    const call = this.store.call(principal.id, callId);
    if (!call.target_json || !call.method) throw new GatewayError('legacy_call_context_unavailable');
    this.check(principal, JSON.parse(call.target_json) as Target, call.method);
    return call;
  }

  dispatch(principal: Principal, callId: string, epoch: string): string {
    this.get(principal, callId);
    return this.store.dispatch(principal.id, callId, epoch);
  }

  cancel(principal: Principal, callId: string) {
    this.get(principal, callId);
    // Stops bridging only; outcome_unknown never claims the native action rolled back.
    return this.store.stop(principal.id, callId);
  }
}
