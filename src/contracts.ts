import { createHash } from 'node:crypto';

export class GatewayError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'GatewayError';
  }
}

export type Target =
  | { machine_id: string; profile: 'session'; session: string }
  | { machine_id: string; profile: 'host'; session?: never };
export type NativeRequest = { method: string; params?: unknown; [key: string]: unknown };
export type CallState = 'created' | 'dispatching' | 'connector_accepted' |
  'responded' | 'not_dispatched' | 'outcome_unknown';
export type Policy = { machines: string[]; sessions: string[]; methods: string[]; host: boolean };

export function validateTarget(value: Target): void {
  if (!value || typeof value.machine_id !== 'string' || !value.machine_id.trim()) {
    throw new GatewayError('invalid_target');
  }
  if (value.profile === 'session') {
    if (typeof value.session !== 'string' || !value.session.trim()) throw new GatewayError('session_required');
  } else if (value.profile !== 'host' || value.session !== undefined) {
    throw new GatewayError('invalid_profile');
  }
}

export function validateRequest(request: NativeRequest): void {
  if (!request || typeof request.method !== 'string' || !request.method.trim()) {
    throw new GatewayError('invalid_request');
  }
  if ('auth' in request || 'id' in request) throw new GatewayError('reserved_request_field');
  canonical(request);
}

// Exact method allowlists fail closed for future methods. Both layers must allow.
export function authorize(target: Target, method: string, caller: Policy, local: Policy): void {
  validateTarget(target);
  for (const policy of [caller, local]) {
    if (!policy.machines.includes(target.machine_id) || !policy.methods.includes(method) ||
      (target.profile === 'host' ? !policy.host : !policy.sessions.includes(target.session))) {
      throw new GatewayError('forbidden');
    }
  }
}

export function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' +
      canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  }
  throw new GatewayError('invalid_json');
}

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
