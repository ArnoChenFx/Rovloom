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
export type CallState =
  | 'created'
  | 'dispatching'
  | 'connector_accepted'
  | 'responded'
  | 'not_dispatched'
  | 'outcome_unknown';
export type Policy = { machines: string[]; sessions: string[]; methods: string[]; host: boolean };

export function validateTarget(value: Target): void {
  if (!value || typeof value.machine_id !== 'string' || !value.machine_id.trim()) {
    throw new GatewayError('invalid_target');
  }
  if (value.profile === 'session') {
    if (typeof value.session !== 'string' || !value.session.trim())
      throw new GatewayError('session_required');
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

// 方法采用精确白名单，未知方法默认拒绝；调用方与本地策略必须同时允许。
export function authorize(target: Target, method: string, caller: Policy, local: Policy): void {
  validateTarget(target);
  for (const policy of [caller, local]) {
    if (
      !policy.machines.includes(target.machine_id) ||
      !policy.methods.includes(method) ||
      (target.profile === 'host' ? !policy.host : !policy.sessions.includes(target.session))
    ) {
      throw new GatewayError('forbidden');
    }
  }
}

export function canonical(value: unknown): string {
  const ancestors = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  const emit = (text: string): string => {
    bytes += Buffer.byteLength(text);
    if (bytes > 1_048_576) throw new GatewayError('json_limit');
    return text;
  };
  const visit = (item: unknown, depth: number): string => {
    if (++nodes > 100_000 || depth > 64) throw new GatewayError('json_limit');
    if (item === null || typeof item === 'string' || typeof item === 'boolean')
      return emit(JSON.stringify(item));
    if (typeof item === 'number' && Number.isFinite(item)) return emit(JSON.stringify(item));
    if (typeof item !== 'object' || item === null || ancestors.has(item))
      throw new GatewayError('invalid_json');
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype)
      throw new GatewayError('invalid_json');
    if (Object.getOwnPropertySymbols(item).length) throw new GatewayError('invalid_json');
    ancestors.add(item);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (Object.values(descriptors).some((d) => !('value' in d)))
        throw new GatewayError('invalid_json');
      if (Array.isArray(item)) {
        if (item.length > 100_000 || Object.keys(item).length !== item.length)
          throw new GatewayError('invalid_json');
        const values: string[] = [];
        for (let i = 0; i < item.length; i++) {
          if (!Object.hasOwn(item, i)) throw new GatewayError('invalid_json');
          values.push(visit(item[i], depth + 1));
        }
        emit('[' + ','.repeat(Math.max(0, values.length - 1)) + ']');
        return '[' + values.join(',') + ']';
      }
      const entries = Object.keys(item)
        .sort()
        .map((key) => emit(JSON.stringify(key) + ':') + visit(descriptors[key]!.value, depth + 1));
      emit('{' + ','.repeat(Math.max(0, entries.length - 1)) + '}');
      return '{' + entries.join(',') + '}';
    } finally {
      ancestors.delete(item);
    }
  };
  return visit(value, 0);
}

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
