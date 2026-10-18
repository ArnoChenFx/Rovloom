import { createHash } from 'node:crypto';
import { GatewayError } from '../contracts.js';
import {
  ContractFault,
  DEFAULT_LIMITS as JSON_LIMITS,
  parse as parseNativeJson,
} from '../native-contract/json.js';
import type { JsonObject } from './types.js';

export const LIMITS = Object.freeze({
  frame_bytes: 1_048_576,
  depth: 64,
  nodes: 100_000,
  object_bytes: 8_388_608,
  schema_bundle_bytes: 16_777_216,
  chunk_bytes: 65_536,
  transfers: 4,
  buffered_bytes: 20_971_520,
  transfer_timeout_ms: 30_000,
  dedup_entries: 4096,
});

export class WireError extends GatewayError {
  readonly source: 'gateway' | 'transport';
  constructor(code: string, source: 'gateway' | 'transport' = 'gateway') {
    super(code);
    this.name = 'WireError';
    this.source = source;
  }
}

export function fail(code: string, source?: 'gateway' | 'transport'): never {
  throw new WireError(code, source);
}

export function object(v: unknown): JsonObject {
  if (
    v === null ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.getPrototypeOf(v) !== Object.prototype
  )
    fail('invalid_frame');
  return v as JsonObject;
}

export function fields(
  v: JsonObject,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  if (
    required.some((k) => !Object.hasOwn(v, k)) ||
    Object.keys(v).some((k) => !required.includes(k) && !optional.includes(k))
  )
    fail('invalid_frame_fields');
}

export function id(v: unknown): asserts v is string {
  if (typeof v !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(v)) fail('invalid_frame_id');
}

export function uint(v: unknown, positive = false): asserts v is number {
  if (!Number.isSafeInteger(v) || (v as number) < (positive ? 1 : 0)) fail('invalid_integer');
}

export function sha(v: unknown): asserts v is string {
  if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) fail('invalid_digest');
}

export function text(v: unknown, max = 4096): asserts v is string {
  // Wire 文本标识在边界拒绝 ASCII 控制字符，不能让它们混入日志或路由上下文。
  // oxlint-disable no-control-regex
  if (
    typeof v !== 'string' ||
    v.length === 0 ||
    Buffer.byteLength(v) > max ||
    /[\u0000-\u001f]/.test(v)
  )
    fail('invalid_text');
  // oxlint-enable no-control-regex
}

export function oneOf<T extends string>(v: unknown, values: readonly T[]): asserts v is T {
  if (!values.includes(v as T)) fail('invalid_enum');
}

function wellFormed(v: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(v);
}

// 规范化不调用 getter/toJSON，计量完整 JSON；对象/大 bundle 独立于 frame 上限。
export function boundedJson(value: unknown, maxBytes: number = LIMITS.frame_bytes): string {
  let nodes = 0;
  let bytes = 0;
  const seen = new Set<object>();
  const emit = (s: string) => {
    bytes += Buffer.byteLength(s);
    if (bytes > maxBytes) fail('json_size_limit', 'transport');
    return s;
  };

  const visit = (v: unknown, depth: number): string => {
    if (++nodes > LIMITS.nodes || depth > LIMITS.depth) fail('json_depth_limit', 'transport');
    if (v === null || typeof v === 'boolean') return emit(JSON.stringify(v));
    if (typeof v === 'string') {
      if (!wellFormed(v)) fail('invalid_unicode', 'transport');
      return emit(JSON.stringify(v));
    }
    if (typeof v === 'number' && Number.isFinite(v)) return emit(JSON.stringify(v));
    if (v === null || typeof v !== 'object' || seen.has(v)) fail('invalid_json', 'transport');
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype)
      fail('invalid_json', 'transport');
    const ds = Object.getOwnPropertyDescriptors(v);
    if (Object.getOwnPropertySymbols(v).length || Object.values(ds).some((d) => !('value' in d)))
      fail('invalid_json', 'transport');
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        if (v.length > LIMITS.nodes || Object.keys(v).length !== v.length)
          fail('invalid_json', 'transport');
        const entries: string[] = [];
        for (let i = 0; i < v.length; i++) {
          if (!Object.hasOwn(v, i)) fail('invalid_json', 'transport');
          entries.push(visit(ds[String(i)]!.value, depth + 1));
        }
        emit('[' + ','.repeat(Math.max(0, entries.length - 1)) + ']');
        return '[' + entries.join(',') + ']';
      }
      const entries = Object.keys(v)
        .sort()
        .map((k) => {
          if (!wellFormed(k)) fail('invalid_unicode', 'transport');
          return emit(JSON.stringify(k) + ':') + visit(ds[k]!.value, depth + 1);
        });
      emit('{' + ','.repeat(Math.max(0, entries.length - 1)) + '}');
      return '{' + entries.join(',') + '}';
    } finally {
      seen.delete(v);
    }
  };
  return visit(value, 0);
}

export function parseJson(
  input: string | Uint8Array,
  maxBytes: number = LIMITS.frame_bytes,
): unknown {
  if (!(typeof input === 'string' || input instanceof Uint8Array))
    fail('invalid_frame', 'transport');
  if ((typeof input === 'string' ? Buffer.byteLength(input) : input.byteLength) > maxBytes)
    fail('frame_limit', 'transport');
  let raw: string;
  try {
    raw =
      typeof input === 'string'
        ? input
        : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input);
  } catch {
    fail('invalid_utf8', 'transport');
  }
  if (!wellFormed(raw)) fail('invalid_unicode', 'transport');
  let value: unknown;
  try {
    value = parseNativeJson(raw, {
      ...JSON_LIMITS,
      object_bytes: maxBytes,
      object_depth: LIMITS.depth,
      object_nodes: LIMITS.nodes,
    });
  } catch (error) {
    if (error instanceof ContractFault) {
      const { code, reason } = error.failure;
      if (code === 'object_limit') fail('json_depth_limit', 'transport');
      if (reason === 'unpaired_surrogate') fail('invalid_unicode', 'transport');
      if (code === 'duplicate_json_key') fail(code, 'transport');
      // 在解析阶段提前拒绝精度损失，保留已有 Wire 整数错误接口。
      if (code === 'json_number_precision') fail('invalid_integer', 'transport');
    }
    fail('invalid_frame_json', 'transport');
  }
  boundedJson(value, maxBytes);
  return value;
}

export function hash(text: string | Uint8Array): string {
  return createHash('sha256').update(text).digest('hex');
}
