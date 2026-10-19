// 在 Connector 受保护路由与原 Wire 校验之间保存有界准入锚点，不打开 Gateway Store 或生成执行许可。
import type { NativeWireBackend, TrustedAttempt } from '../integration/luvus-wire.js'
import type { Adapter, Connection } from '../transport/index.js'
import type { AttemptBinding, Direction, V2Target, WireEnvelope } from '../wire/types.js'
import {
  assertBinding,
  boundedJson,
  fail,
  hash,
  id,
  LIMITS,
  object,
  parseJson,
  uint,
  validateAttempt,
  validateTarget
} from '../wire/index.js'

type Entry = Readonly<{ binding: AttemptBinding; digest: string; expires: number }>
export type ConnectorAttemptBookOptions = Readonly<{
  retention_ms?: number
  // 独立可信元数据可保留 Gateway 原截止；不能从 Wire 请求字段推导。
  dedupExpires?(binding: AttemptBinding): number
  limits?: Readonly<{ entries: number; bytes: number }>
  now(): number
}>

/** 只保留发送身份、请求摘要和首次固定期限；同一进程重连共用本对象，正文由 epoch 后端分别释放。 */
export class ConnectorAttemptBook {
  readonly #options: ConnectorAttemptBookOptions
  readonly #entries = new Map<string, Entry>()
  #clock = -1
  #bytes = 0

  /** 固定受保护的 retention 和资源预算；调用消息无权调整这些值。 */
  constructor(options: ConnectorAttemptBookOptions) {
    if ((options.retention_ms === undefined) === (options.dedupExpires === undefined)) {
      fail('connector_retention_source_required')
    }
    if (options.retention_ms !== undefined) {
      uint(options.retention_ms, true)
    }
    const limits = { entries: 4096, bytes: 4_194_304, ...options.limits }
    uint(limits.entries, true)
    uint(limits.bytes, true)
    if (limits.entries > 4096 || limits.bytes > LIMITS.buffered_bytes || typeof options.now !== 'function') {
      fail('connector_attempt_config_invalid')
    }
    this.#options = { ...options, limits }
  }

  /** 检查可信时钟高水位，并仅在原固定期限后回收元数据。 */
  #time(): number {
    const now = this.#options.now()
    uint(now)
    if (now < this.#clock || !Number.isSafeInteger(now + (this.#options.retention_ms ?? 0))) {
      fail('clock_untrusted')
    }
    this.#clock = now
    for (const [name, entry] of this.#entries) {
      if (now >= entry.expires) {
        this.#bytes -= Buffer.byteLength(boundedJson(entry))
        this.#entries.delete(name)
      }
    }
    return now
  }

  /** 预查同一意图和固定预算；仅真实 Wire 校验成功之后才由 commit 建立记录。 */
  #prepare(attempt: TrustedAttempt): Entry {
    const now = this.#time()
    if (now >= attempt.binding.registration.deadline) {
      fail('deadline_exceeded')
    }
    const name = attempt.binding.call_id + ':' + attempt.binding.attempt_id
    const digest = hash(boundedJson(attempt))
    const originalExpiry = this.#options.dedupExpires?.(attempt.binding)
    if (originalExpiry !== undefined) {
      uint(originalExpiry, true)
    }
    const previous = this.#entries.get(name)
    if (previous) {
      assertBinding(attempt.binding, previous.binding)
      if (previous.digest !== digest || (originalExpiry !== undefined && originalExpiry !== previous.expires)) {
        fail('attempt_request_mismatch')
      }
      return previous
    }
    const entry = {
      binding: JSON.parse(boundedJson(attempt.binding)) as AttemptBinding,
      digest,
      expires: originalExpiry ?? now + this.#options.retention_ms!
    }
    // Connector 自有固定保留期必须覆盖执行期限；不能暗中延长配置或采信消息中的 TTL。
    if (entry.expires < attempt.binding.registration.deadline) {
      fail('connector_retention_insufficient')
    }
    if (
      this.#entries.size >= this.#options.limits!.entries ||
      this.#bytes + Buffer.byteLength(boundedJson(entry)) > this.#options.limits!.bytes
    ) {
      fail('connector_attempt_capacity')
    }
    return entry
  }

  /** 先预留不可改写的私有期限，仅验证回调成功后提交；调用方不能构造或延长 entry。 */
  admit<T>(attempt: TrustedAttempt, verify: () => T): T {
    const entry = this.#prepare(attempt)
    const result = verify()
    const current = this.#prepare(attempt)
    if (current.digest !== entry.digest || boundedJson(current.binding) !== boundedJson(entry.binding)) {
      fail('attempt_request_mismatch')
    }
    const name = attempt.binding.call_id + ':' + attempt.binding.attempt_id
    if (!this.#entries.has(name)) {
      this.#entries.set(name, entry)
      this.#bytes += Buffer.byteLength(boundedJson(entry))
    }
    return result
  }

  /** 只向完全匹配的已提交锚点提供首次登记截止，不从重连时间创建新期限。 */
  dedupExpires(binding: AttemptBinding): number {
    this.#time()
    const entry = this.#entries.get(binding.call_id + ':' + binding.attempt_id)
    if (!entry) {
      fail('attempt_anchor_unavailable')
    }
    assertBinding(binding, entry.binding)
    return entry.expires
  }
}

export type ConnectorAdmissionOptions = Readonly<{
  // 必须直接使用 transport.session 实际认证后交付的连接，不能从请求 JSON 建立身份。
  connection: Connection
  // 本机受保护路由为完整目标固定 principal；原 Wire 未携带 caller 身份，不能自报或补猜。
  routes: readonly Readonly<{ target: V2Target; principal_id: string }>[]
  source: Pick<
    NativeWireBackend,
    'provider' | 'localProvider' | 'contract' | 'nativeSource' | 'policies' | 'authority' | 'now'
  >
  book: ConnectorAttemptBook
  limits?: Readonly<{ attempts: number; bytes: number }>
}>

type Admission = {
  decode(input: string | Uint8Array, direction: Direction, original: Adapter['decode']): WireEnvelope
  close(): void
  release(binding: AttemptBinding): void
}
const admissions = new WeakMap<NativeWireBackend, Admission>()

/** 装配独立于 Gateway writer 的准入后端；候选只在原 Wire decode 的同步验证范围可见。 */
export function createConnectorAdmissionBackend(options: ConnectorAdmissionOptions) {
  const connection = JSON.parse(boundedJson(options.connection)) as Connection
  if (connection.authenticated !== true || connection.active !== true) {
    fail('authentication_required')
  }
  for (const value of [connection.machine_id, connection.recovery_generation, connection.connection_epoch]) {
    id(value)
  }
  const routes = new Map<string, string>()
  for (const route of options.routes) {
    validateTarget(route.target)
    id(route.principal_id)
    const name = boundedJson(route.target)
    if (route.target.machine_id !== connection.machine_id || routes.has(name) || routes.size >= 64) {
      fail('connector_route_invalid')
    }
    if (routes.size && ![...routes.values()].includes(route.principal_id)) {
      fail('connector_principal_ambiguous')
    }
    routes.set(name, route.principal_id)
  }
  const limits = { attempts: 128, bytes: 16_777_216, ...options.limits }
  uint(limits.attempts, true)
  uint(limits.bytes, true)
  if (limits.attempts > 4096 || limits.bytes > LIMITS.buffered_bytes || routes.size === 0) {
    fail('connector_attempt_config_invalid')
  }
  const attempts = new Map<string, TrustedAttempt>()
  let bytes = 0
  let pending: TrustedAttempt | undefined
  let closed = false
  const principal = routes.values().next().value

  /** 每次返回独立快照，关闭后的旧 epoch 不可继续通过认证检查。 */
  function currentConnection(): Connection {
    return { ...structuredClone(connection), active: !closed as true }
  }

  /** 私有候选只能在原 decode 内作为独立锚点，失败后不会进入已提交表。 */
  function attempt(call: string, attemptId: string): TrustedAttempt | undefined {
    if (closed) {
      return undefined
    }
    const candidate =
      pending?.binding.call_id === call && pending.binding.attempt_id === attemptId
        ? pending
        : attempts.get(call + ':' + attemptId)
    return candidate ? (JSON.parse(boundedJson(candidate)) as TrustedAttempt) : undefined
  }

  const backend: NativeWireBackend & { dedupExpires(binding: AttemptBinding): number; close(): void } = {
    ...options.source,
    connection: currentConnection,
    attempt,
    // 原生响应读取只沿用本 epoch 当前请求的受保护路由身份；其它独立读取入口须另行装配。
    currentPrincipal: /* 返回单一受保护路由 principal，不记录最近 caller。 */ () => (closed ? undefined : principal),
    contentStatus: /* 仅保留本机在途正文，deadline 后不再提供正文。 */ (binding) => {
      const stored = attempt(binding.call_id, binding.attempt_id)
      if (!stored) {
        return 'unavailable'
      }
      assertBinding(binding, stored.binding)
      return options.source.now() < binding.registration.deadline ? 'available' : 'expired'
    },
    dedupExpires: /* 只查询共享记录中的固定本机期限。 */ (binding) => options.book.dedupExpires(binding),
    close: /* 关闭 epoch 仅释放正文；共享 book 和持久 claims 不随连接断开清除。 */ () => {
      closed = true
      attempts.clear()
      bytes = 0
      pending = undefined
    }
  }

  admissions.set(backend, {
    close: backend.close,
    /** 释放在途原文，但共享摘要及固定期限继续阻止重新登记旧意图。 */
    release(binding) {
      const name = binding.call_id + ':' + binding.attempt_id
      const found = attempts.get(name)
      if (found) {
        assertBinding(binding, found.binding)
        bytes -= Buffer.byteLength(boundedJson(found))
        attempts.delete(name)
      }
    },
    /** 原入口先有界解析并核对固定路由，再让真实 Wire 执行全部 envelope、契约、策略和原生门禁。 */
    decode(input, direction, original) {
      if (closed || pending) {
        fail(closed ? 'adapter_closed' : 'native_adapter_unavailable')
      }
      const frame = object(parseJson(input, LIMITS.frame_bytes))
      if (frame.type !== 'request' || direction !== 'gateway_to_connector') {
        return original(input, direction)
      }
      const payload = object(frame.payload)
      validateAttempt(payload.attempt)
      const binding: AttemptBinding = {
        ...payload.attempt,
        machine_id: frame.machine_id as string,
        connection_epoch: frame.connection_epoch as string,
        recovery_generation: frame.recovery_generation as string
      }
      assertBinding(binding, { ...binding, ...connection })
      if (binding.target.machine_id !== connection.machine_id) {
        fail('target_machine_mismatch')
      }
      const selected = routes.get(boundedJson(binding.target))
      if (!selected) {
        fail('connector_route_unavailable')
      }
      const policies = options.source.policies(selected)
      if (
        payload.expected_binding_revision !== binding.binding_revision ||
        policies.caller.revision !== binding.registration.caller_policy_revision ||
        policies.local.revision !== binding.registration.local_policy_revision
      ) {
        fail('policy_revision_stale')
      }
      const native = object(payload.native_request)
      const candidate: TrustedAttempt = {
        binding,
        principal_id: selected,
        method: native.method as string,
        mode: payload.validation as 'strict' | 'raw-contract',
        transport: 'rpc',
        native_request: native
      }
      const name = binding.call_id + ':' + binding.attempt_id
      const previous = attempts.get(name)
      if (previous && boundedJson(previous) !== boundedJson(candidate)) {
        fail('attempt_request_mismatch')
      }
      const size = Buffer.byteLength(boundedJson(candidate))
      if (!previous && (attempts.size >= limits.attempts || bytes + size > limits.bytes)) {
        fail('connector_attempt_capacity')
      }
      const result = options.book.admit(
        candidate,
        /** 只有原 decode 的同步验证范围能够读取本次候选；外部 metadata 回调看不到候选。 */ () => {
          pending = candidate
          try {
            const checked = original(input, direction)
            if (closed) {
              fail('adapter_closed')
            }
            return checked
          } finally {
            pending = undefined
          }
        }
      )
      if (closed) {
        fail('adapter_closed')
      }
      if (!previous) {
        attempts.set(name, candidate)
        bytes += size
      }
      return result
    }
  })
  return backend
}

/** 仅给本模块建立的准入后端包装真实 adapter.decode；其它独立可信后端保持原接口。 */
export function connectorAdmissionAdapter(backend: NativeWireBackend, adapter: Adapter): Adapter {
  const admission = admissions.get(backend)
  if (!admission) {
    return adapter
  }
  return Object.freeze({
    ...adapter,
    decode: /* 将候选安装严格限制在原 decode 的同步校验范围。 */ (input, direction) =>
      admission.decode(input, direction, adapter.decode),
    release: /* 原 Wire 完成释放之后回收该 attempt 的本机请求正文。 */ (binding) => {
      try {
        adapter.release(binding)
      } finally {
        admission.release(binding)
      }
    },
    close: /* 先停原 Wire，再销毁本 epoch 的请求锚点。 */ () => {
      try {
        adapter.close()
      } finally {
        admission.close()
      }
    }
  })
}
