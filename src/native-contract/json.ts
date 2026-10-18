import { createHash } from 'node:crypto'
import type { Check, Json, JsonObject, Limits, NativeContractFailure } from './types.js'

export const DEFAULT_LIMITS: Limits = Object.freeze({
  object_bytes: 1_048_576,
  object_depth: 64,
  object_nodes: 100_000,
  bundle_bytes: 2_097_152,
  bundle_nodes: 150_000,
  documents: 64,
  document_bytes: 524_288,
  references: 2_048,
  reference_depth: 32,
  terminal_frame_bytes: 65_536
})

export class ContractFault extends Error {
  constructor(readonly failure: NativeContractFailure) {
    super(failure.code)
  }
}

export function fail(
  code: string,
  stage = 'validation',
  reason?: string,
  origin: 'contract' | 'authorization' = 'contract'
): never {
  throw new ContractFault(Object.freeze({ origin, code, stage, ...(reason ? { reason } : {}) }))
}

export function attempt<T>(stage: string, fn: () => T): Check<T> {
  try {
    return { ok: true, value: fn() }
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof ContractFault
          ? error.failure
          : Object.freeze({ origin: 'contract', code: 'invalid_context', stage })
    }
  }
}

export function limits(overrides: Partial<Limits> = {}): Limits {
  const result = { ...DEFAULT_LIMITS }
  for (const [key, value] of Object.entries(overrides)) {
    if (
      !Object.hasOwn(result, key) ||
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      value > result[key as keyof Limits]
    ) {
      fail('invalid_limits', 'limits')
    }
    result[key as keyof Limits] = value
  }
  return Object.freeze(result)
}

export function hash(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function object(value: unknown, code = 'invalid_context'): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(code)
  }
  return value as JsonObject
}

export function text(value: unknown, code = 'invalid_context'): string {
  if (typeof value !== 'string' || !value.length) {
    fail(code)
  }
  return value
}

export function equal(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true
  }
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) {
    return false
  }
  const left = Object.keys(a).sort()
  const right = Object.keys(b).sort()
  return (
    left.length === right.length &&
    left.every(
      (key, i) => key === right[i] && equal((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
    )
  )
}

function unicode(value: string): void {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail('invalid_json', 'parse', 'unpaired_surrogate')
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail('invalid_json', 'parse', 'unpaired_surrogate')
    }
  }
}

export function snapshot(value: unknown, budget: Limits = DEFAULT_LIMITS): Json {
  const active = new Set<object>()
  let nodes = 0
  let bytes = 0
  const spend = (count: number): void => {
    bytes += count
    if (bytes > budget.object_bytes) {
      fail('object_limit', 'parse')
    }
  }

  const stringBytes = (value: string): void => {
    // 逐项计入 JSON 编码预算，不能先 stringify 整个对象再判断，避免超额分配。
    if (value.length + 2 > budget.object_bytes - bytes) {
      fail('object_limit', 'parse')
    }
    spend(2)
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i)
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(++i)
        if (!(next >= 0xdc00 && next <= 0xdfff)) {
          fail('invalid_json', 'parse', 'unpaired_surrogate')
        }
        spend(4)
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        fail('invalid_json', 'parse', 'unpaired_surrogate')
      } else if (code === 34 || code === 92) {
        spend(2)
      } else if (code < 32) {
        spend([8, 9, 10, 12, 13].includes(code) ? 2 : 6)
      } else {
        spend(code < 128 ? 1 : code < 2048 ? 2 : 3)
      }
    }
  }

  const visit = (item: unknown, depth: number): Json => {
    if (++nodes > budget.object_nodes || depth > budget.object_depth) {
      fail('object_limit', 'parse')
    }
    if (item === null || typeof item === 'boolean') {
      spend(item === false ? 5 : 4)
      return item
    }
    if (typeof item === 'string') {
      stringBytes(item)
      return item
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) {
        fail('invalid_json', 'parse')
      }
      if (Number.isInteger(item) && !Number.isSafeInteger(item)) {
        fail('json_number_precision', 'parse')
      }
      spend(JSON.stringify(item).length)
      return item
    }
    if (!item || typeof item !== 'object' || active.has(item)) {
      fail('invalid_json', 'parse')
    }
    if (
      Object.getOwnPropertySymbols(item).length ||
      Object.getPrototypeOf(item) !== (Array.isArray(item) ? Array.prototype : Object.prototype)
    ) {
      fail('invalid_json', 'parse')
    }
    if (Array.isArray(item) && item.length > budget.object_nodes) {
      fail('object_limit', 'parse')
    }
    const descriptors = Object.getOwnPropertyDescriptors(item)
    if (Object.values(descriptors).some((d) => !('value' in d))) {
      fail('invalid_json', 'parse')
    }
    active.add(item)
    try {
      if (Array.isArray(item)) {
        if (Object.keys(item).length !== item.length || Object.keys(descriptors).length !== item.length + 1) {
          fail('invalid_json', 'parse')
        }
        spend(2 + Math.max(0, item.length - 1))
        const values: Json[] = []
        for (let i = 0; i < item.length; i++) {
          if (!Object.hasOwn(descriptors, i)) {
            fail('invalid_json', 'parse')
          }
          values.push(visit(descriptors[i]!.value, depth + 1))
        }
        return Object.freeze(values)
      }
      const result: Record<string, Json> = {}
      spend(2)
      let first = true
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable) {
          fail('invalid_json', 'parse')
        }
        spend(first ? 1 : 2)
        first = false
        stringBytes(key)
        Object.defineProperty(result, key, {
          value: visit(descriptor.value, depth + 1),
          enumerable: true
        })
      }
      return Object.freeze(result)
    } finally {
      active.delete(item)
    }
  }
  return visit(value, 0)
}

export function parse(bytes: Uint8Array | string, budget: Limits): Json {
  let input: string
  if (typeof bytes === 'string') {
    if (bytes.length > budget.object_bytes) {
      fail('object_limit', 'parse')
    }
    unicode(bytes)
    input = bytes
  } else if (bytes instanceof Uint8Array) {
    if (bytes.byteLength > budget.object_bytes) {
      fail('object_limit', 'parse')
    }
    try {
      // 保留 BOM 交给 JSON 语法拒绝，不能让字节入口静默接受字符串入口拒绝的内容。
      input = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch {
      fail('invalid_utf8', 'parse')
    }
  } else {
    fail('invalid_json', 'parse')
  }
  if (Buffer.byteLength(input) > budget.object_bytes) {
    fail('object_limit', 'parse')
  }
  let position = 0
  let nodes = 0
  const whitespace = () => {
    while (/[\x20\t\r\n]/.test(input[position] ?? '\u0000')) {
      position++
    }
  }

  const string = (): string => {
    const start = position++
    while (position < input.length) {
      const c = input[position++]
      if (c === '\\') {
        position++
        continue
      }
      if (c === '"') {
        try {
          const value: string = JSON.parse(input.slice(start, position))
          unicode(value)
          return value
        } catch (error) {
          if (error instanceof ContractFault) {
            throw error
          }
          fail('invalid_json', 'parse')
        }
      }
    }
    fail('invalid_json', 'parse')
  }

  const value = (depth: number): Json => {
    if (++nodes > budget.object_nodes || depth > budget.object_depth) {
      fail('object_limit', 'parse')
    }
    whitespace()
    const c = input[position]
    if (c === '"') {
      return string()
    }
    if (c === '{') {
      position++
      whitespace()
      const result: Record<string, Json> = {}
      const keys = new Set<string>()
      if (input[position] === '}') {
        position++
        return Object.freeze(result)
      }
      while (true) {
        whitespace()
        if (input[position] !== '"') {
          fail('invalid_json', 'parse')
        }
        const key = string()
        // 必须在写入对象前拒绝重复键；JSON.parse 会覆盖旧值，无法保留这一边界。
        if (keys.has(key)) {
          fail('duplicate_json_key', 'parse')
        }
        keys.add(key)
        whitespace()
        if (input[position++] !== ':') {
          fail('invalid_json', 'parse')
        }
        Object.defineProperty(result, key, { value: value(depth + 1), enumerable: true })
        whitespace()
        const end = input[position++]
        if (end === '}') {
          return Object.freeze(result)
        }
        if (end !== ',') {
          fail('invalid_json', 'parse')
        }
      }
    }
    if (c === '[') {
      position++
      whitespace()
      const result: Json[] = []
      if (input[position] === ']') {
        position++
        return Object.freeze(result)
      }
      while (true) {
        result.push(value(depth + 1))
        whitespace()
        const end = input[position++]
        if (end === ']') {
          return Object.freeze(result)
        }
        if (end !== ',') {
          fail('invalid_json', 'parse')
        }
      }
    }
    for (const [literal, decoded] of [
      ['true', true],
      ['false', false],
      ['null', null]
    ] as const) {
      if (input.startsWith(literal, position)) {
        position += literal.length
        return decoded
      }
    }
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(input.slice(position))
    if (!match) {
      fail('invalid_json', 'parse')
    }
    position += match[0].length
    const decoded = Number(match[0])
    if (!Number.isFinite(decoded)) {
      fail('invalid_json', 'parse')
    }
    if (Number.isInteger(decoded) && !Number.isSafeInteger(decoded)) {
      fail('json_number_precision', 'parse')
    }
    return decoded
  }

  const result = value(0)
  whitespace()
  if (position !== input.length) {
    fail('invalid_json', 'parse')
  }
  return result
}

export function parseNativeJson(bytes: Uint8Array | string, overrides: Partial<Limits> = {}): Check<Json> {
  return attempt('parse', () => parse(bytes, limits(overrides)))
}

export function pointer(value: unknown, path: string): unknown {
  if (path === '') {
    return value
  }
  if (!path.startsWith('/') || /~(?![01])/.test(path)) {
    fail('schema_unavailable', 'compile', 'missing_fragment')
  }
  for (const token of path.slice(1).split('/')) {
    const key = token.replace(/~1/g, '/').replace(/~0/g, '~')
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) {
      fail('schema_unavailable', 'compile', 'missing_fragment')
    }
    value = (value as Record<string, unknown>)[key]
  }
  return value
}
