/** 从认证原派发快照和受保护路由建立通用 Connector 准入锚点，不解释原生协议或打开 Gateway writer。 */
import type { TrustedAttempt } from '../integration/luvus-wire.js'
import type { AdmissionContextReader, Connection, TrustedAdmissionSnapshot } from '../transport/index.js'
import type { LedgerInvalidation } from '../storage/model.js'
import type { ResponseAnchor } from '../wire/evidence.js'
import type { AttemptBinding, Direction, ProviderPolicies, V2Target, WireEnvelope } from '../wire/types.js'
import {
  admissionRequestDigest,
  admissionRegisteredRequestDigest,
  assertBinding,
  boundedJson,
  fail,
  fields,
  id,
  LIMITS,
  object,
  parseJson,
  uint,
  validateAdmissionReceipt,
  validateAttempt,
  validateTarget,
  WireError
} from '../wire/index.js'
import type { ConnectorAttemptBook } from './connector-attempts.js'

export type ConnectorAdmissionLedgerOptions = Readonly<{
  connection: Connection
  routes: readonly Readonly<{ target: V2Target; principal_id: string }>[]
  policies(principal: string): ProviderPolicies
  receipts: AdmissionContextReader
  book: ConnectorAttemptBook
  now(): number
  limits?: Readonly<{ attempts: number; bytes: number }>
}>
type Entry = {
  snapshot: TrustedAdmissionSnapshot
  attempt: Omit<TrustedAttempt, 'native_request'>
  body?: TrustedAttempt
  fenced: boolean
  bytes: number
  committed: boolean
}
type Pending = { entry: Entry; visible: boolean }

/** 克隆有界数据快照，宿主随后修改输入对象不能改写已准入的身份和原期限。 */
function copy<T>(value: T): T {
  return JSON.parse(boundedJson(value)) as T
}

/** 不把 reader、策略或时钟端口的任意底层异常原文暴露给业务调用。 */
function unavailable(error: unknown): never {
  if (error instanceof WireError) {
    throw error
  }
  fail('admission_context_unavailable')
}

/** 校验原快照的最小完整形状；认证归属仍只能来自独立 reader 的受保护记录。 */
function checkedSnapshot(input: TrustedAdmissionSnapshot, binding: AttemptBinding): TrustedAdmissionSnapshot {
  const value = object(copy(input))
  fields(value, [
    'binding',
    'principal_id',
    'request_sha256',
    'registered_request_sha256',
    'anchor',
    'sequence',
    'fenced'
  ])
  validateAdmissionReceipt({
    binding: value.binding,
    request_sha256: value.request_sha256,
    dedup_expires_at: object(value.anchor).dedup_expires_at,
    context: {
      principal_id: value.principal_id,
      registered_request_sha256: value.registered_request_sha256,
      anchor: value.anchor,
      sequence: value.sequence,
      fenced: value.fenced
    }
  })
  assertBinding(binding, value.binding as AttemptBinding)
  return value as TrustedAdmissionSnapshot
}

/** 完整快照是必需来源；legacy receipt 或相对本机 TTL 都不能补造原 principal、正文期限和派发状态。 */
export function createConnectorAdmissionLedger(options: ConnectorAdmissionLedgerOptions) {
  const connection = copy(options.connection)
  if (connection.authenticated !== true || connection.active !== true) {
    fail('authentication_required')
  }
  for (const value of [connection.machine_id, connection.connection_epoch, connection.recovery_generation]) {
    id(value)
  }
  if (
    !(['rpc', 'admission_receipt', 'admission_context'] as const).every(
      /* 每个依赖都必须来自当前真实协商连接，不能用 reader 存在替代新能力协商。 */ (capability) =>
        connection.negotiated.capabilities.includes(capability)
    ) ||
    typeof options.receipts?.snapshot !== 'function' ||
    typeof options.receipts?.subscribeInvalidation !== 'function' ||
    typeof options.policies !== 'function' ||
    typeof options.now !== 'function'
  ) {
    fail('admission_context_source_required')
  }
  const routes = new Map<string, string>()
  for (const route of copy(options.routes)) {
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
  if (!routes.size || limits.attempts > 4096 || limits.bytes > LIMITS.buffered_bytes) {
    fail('connector_attempt_config_invalid')
  }
  const entries = new Map<string, Entry>()
  const listeners = new Set<(event: LedgerInvalidation) => void>()
  const principal = routes.values().next().value!
  let bytes = 0
  let clock = -1
  let revision = 0
  let closed = false
  let decoding = false
  let admittingBinding: AttemptBinding | undefined
  let reading = false
  let pending: Pending | undefined
  let unsubscribe: (() => void) | undefined

  /** 宿主元数据回调看不到尚未提交的候选；只有原 Wire 自身调用账本端口时短暂可见。 */
  function external<T>(operation: () => T): T {
    const candidate = pending
    const visible = candidate?.visible
    if (candidate) {
      candidate.visible = false
    }
    try {
      return operation()
    } catch (error) {
      return unavailable(error)
    } finally {
      if (!closed && pending === candidate && candidate) {
        candidate.visible = visible === true
      }
    }
  }

  /** 快照随原状态更新时同样计入总预算，候选尚未提交不能从已提交预算中扣除。 */
  function account(entry: Entry): void {
    const size = Buffer.byteLength(
      boundedJson({ attempt: entry.attempt, snapshot: entry.snapshot, ...(entry.body ? { body: entry.body } : {}) })
    )
    if (
      entry.committed &&
      entries.get(entry.attempt.binding.call_id + ':' + entry.attempt.binding.attempt_id) === entry
    ) {
      if (bytes + size - entry.bytes > limits.bytes) {
        close()
        fail('connector_attempt_capacity')
      }
      bytes += size - entry.bytes
    }
    entry.bytes = size
  }

  /** 提交本地回收后才通知真实后端，单个监听器异常不妨碍其余所有者收到 fence。 */
  function publish(event: LedgerInvalidation): void {
    for (const listener of Array.from(listeners)) {
      try {
        listener(copy(event))
      } catch {
        // 通知不授予权限，读取端仍须每次重验；不能因监听器抛错回滚已提交状态。
      }
    }
  }

  /** 仅释放原文并修正预算，原快照和共享去重簿继续保留不可延长的固定身份。 */
  function dropBody(entry: Entry): void {
    if (entry.body) {
      entry.body = undefined
      account(entry)
    }
  }

  /** 关闭只销毁本 epoch 的正文和订阅，不清除 receipt、book 或 provider 的持久 claims。 */
  function close(): void {
    if (closed) {
      return
    }
    closed = true
    revision++
    entries.clear()
    bytes = 0
    pending = undefined
    const stop = unsubscribe
    unsubscribe = undefined
    try {
      stop?.()
    } catch {
      fail('admission_context_unavailable')
    } finally {
      publish({ kind: 'closed' })
      listeners.clear()
    }
  }

  /** 单调时钟和关闭 fence 在宿主回调前后重验，回拨不能恢复正文或私有许可。 */
  function now(): number {
    if (closed) {
      fail('adapter_closed')
    }
    if (reading) {
      close()
      fail('admission_context_reentrant')
    }
    reading = true
    try {
      const value = external(/** 时钟端口不能借准入候选建立请求来源。 */ () => options.now())
      if (closed) {
        fail('adapter_closed')
      }
      uint(value)
      if (value < clock) {
        fail('clock_untrusted')
      }
      clock = value
      return value
    } catch (error) {
      close()
      unavailable(error)
    } finally {
      reading = false
    }
  }

  /** 每次确认当前政策来源，只有新准入核原登记修订；晚到证据由真实 Wire 另查当前权限。 */
  function checkPolicies(binding: AttemptBinding, selected: string, dispatch: boolean): void {
    const policies = object(external(/** 双端政策始终按原受保护 principal 查询。 */ () => options.policies(selected)))
    const caller = object(policies.caller)
    const local = object(policies.local)
    id(caller.revision)
    id(local.revision)
    if (closed) {
      fail('adapter_closed')
    }
    if (
      dispatch &&
      (caller.revision !== binding.registration.caller_policy_revision ||
        local.revision !== binding.registration.local_policy_revision)
    ) {
      fail('policy_revision_stale')
    }
  }

  /** 每次从认证账本取得当前快照，拒绝固定字段漂移、序列回退及同序列内容变化。 */
  function snapshot(
    binding: AttemptBinding,
    previous?: TrustedAdmissionSnapshot,
    dispatch = false
  ): TrustedAdmissionSnapshot {
    if (closed) {
      fail('adapter_closed')
    }
    const result = checkedSnapshot(
      external(
        /** 原快照只从独立认证 reader 获取，不把候选交给 receipt 回调。 */ () =>
          options.receipts.snapshot(copy(binding))
      ),
      binding
    )
    if (closed) {
      fail('adapter_closed')
    }
    assertBinding(binding, { ...binding, ...connection })
    if (routes.get(boundedJson(binding.target)) !== result.principal_id) {
      fail('admission_principal_mismatch')
    }
    checkPolicies(binding, result.principal_id, dispatch)
    if (previous) {
      const sameSequence = { ...copy(result), anchor: copy(result.anchor) }
      if (result.sequence === previous.sequence) {
        // reader 的持久本机 floor 可在同一原序列收紧，不能改变原派发事实或延长期限。
        if (!previous.fenced && sameSequence.fenced) {
          sameSequence.fenced = false
        }
        if (
          previous.anchor.content_status === 'available' &&
          sameSequence.anchor.content_status === 'expired' &&
          clock >= previous.anchor.content_expires_at
        ) {
          sameSequence.anchor.content_status = 'available'
        }
      }
      if (
        result.principal_id !== previous.principal_id ||
        result.request_sha256 !== previous.request_sha256 ||
        result.registered_request_sha256 !== previous.registered_request_sha256 ||
        result.anchor.method !== previous.anchor.method ||
        result.anchor.mode !== previous.anchor.mode ||
        result.anchor.content_expires_at !== previous.anchor.content_expires_at ||
        result.anchor.dedup_expires_at !== previous.anchor.dedup_expires_at ||
        result.sequence < previous.sequence ||
        (result.sequence === previous.sequence && boundedJson(sameSequence) !== boundedJson(previous)) ||
        (previous.fenced && !result.fenced) ||
        (previous.anchor.content_status !== 'available' && result.anchor.content_status === 'available')
      ) {
        fail('admission_context_conflict')
      }
    }
    return result
  }

  /** 读取正文前应用原内容截止、持久 fence 和去重截止，回收完成后再发布最小通知。 */
  function refresh(entry: Entry): TrustedAdmissionSnapshot {
    const at = now()
    let current: TrustedAdmissionSnapshot
    try {
      current = snapshot(entry.attempt.binding, entry.snapshot)
    } catch (error) {
      const notify = !entry.fenced
      entry.fenced = true
      dropBody(entry)
      if (notify) {
        publish({ kind: 'fence', machine_id: entry.attempt.binding.machine_id, call_id: entry.attempt.binding.call_id })
      }
      return unavailable(error)
    }
    if (entry.fenced || current.fenced || at >= current.anchor.dedup_expires_at) {
      const notify = !entry.fenced
      entry.fenced = true
      dropBody(entry)
      if (notify) {
        publish({ kind: 'fence', machine_id: current.binding.machine_id, call_id: current.binding.call_id })
      }
      fail('attempt_anchor_unavailable')
    }
    entry.snapshot = current
    account(entry)
    if (current.anchor.content_status !== 'available' || at >= current.anchor.content_expires_at) {
      const hadBody = entry.body !== undefined
      dropBody(entry)
      if (hadBody) {
        publish({ kind: 'content', machine_id: current.binding.machine_id, call_id: current.binding.call_id })
      }
    }
    if (closed || entry.fenced) {
      fail(closed ? 'adapter_closed' : 'attempt_anchor_unavailable')
    }
    return current
  }

  /** 只把已提交正文或原 Wire 同步校验范围内的候选投影成可信 attempt。 */
  function attempt(callId: string, attemptId: string): TrustedAttempt | undefined {
    if (closed) {
      return undefined
    }
    const candidate = pending?.visible ? pending.entry : undefined
    const entry =
      candidate?.attempt.binding.call_id === callId && candidate.attempt.binding.attempt_id === attemptId
        ? candidate
        : entries.get(callId + ':' + attemptId)
    if (!entry) {
      return undefined
    }
    refresh(entry)
    return entry.body ? copy(entry.body) : undefined
  }

  /** 原锚点仅查询已准入或原验证范围候选，返回的内容状态采用 Gateway 原期限和当前可信时间。 */
  function responseAnchor(binding: AttemptBinding): ResponseAnchor | undefined {
    if (closed) {
      return undefined
    }
    const candidate = pending?.visible ? pending.entry : undefined
    const entry =
      candidate?.attempt.binding.call_id === binding.call_id &&
      candidate.attempt.binding.attempt_id === binding.attempt_id
        ? candidate
        : entries.get(binding.call_id + ':' + binding.attempt_id)
    if (!entry) {
      return undefined
    }
    assertBinding(binding, entry.attempt.binding)
    const current = refresh(entry)
    return {
      ...copy(current.anchor),
      content_status:
        current.anchor.content_status === 'available' && clock >= current.anchor.content_expires_at
          ? 'expired'
          : current.anchor.content_status
    }
  }

  /** receipt 仅在持久提交后发事件；先回收本地原文，再转交真实 backend 的订阅者。 */
  function invalidate(event: LedgerInvalidation): void {
    if (closed) {
      return
    }
    if (event.kind === 'closed') {
      close()
      return
    }
    // 独立 reader 的时钟推进可同时回收其它调用，只有本候选的身份/内容变化才中断本次准入。
    if (
      admittingBinding?.machine_id === event.machine_id &&
      (event.kind === 'device_fence' || admittingBinding.call_id === event.call_id)
    ) {
      revision++
    }
    for (const entry of entries.values()) {
      if (
        entry.attempt.binding.machine_id === event.machine_id &&
        (event.kind === 'device_fence' || entry.attempt.binding.call_id === event.call_id)
      ) {
        dropBody(entry)
        if (event.kind !== 'content') {
          entry.fenced = true
        }
      }
    }
    publish(event)
  }

  const ledger = Object.freeze({
    /** 完整认证身份固定于本 epoch；关闭后保持身份但 active 为 false。 */
    connection(): Connection {
      return { ...copy(connection), active: !closed as true }
    },
    attempt,
    responseAnchor,
    /** 当前读取主体只来自单一完整受保护路由，不能记住最近请求的自报身份。 */
    currentPrincipal(): string | undefined {
      return closed ? undefined : principal
    },
    /** 内容状态与执行 deadline 分开，只沿用认证原锚点的绝对内容截止。 */
    contentStatus(binding: AttemptBinding): ResponseAnchor['content_status'] {
      return responseAnchor(binding)?.content_status ?? 'unavailable'
    },
    now,
    /** 返回相同原记录的固定去重期限，正文释放和断线不会生成新期限。 */
    dedupExpires(binding: AttemptBinding): number {
      const anchor = responseAnchor(binding)
      if (!anchor) {
        fail('attempt_anchor_unavailable')
      }
      const observed = revision
      const expiry = external(
        /** 原 book 的时间端口也可能同步收紧或关闭，返回前必须重验 epoch。 */ () => options.book.dedupExpires(binding)
      )
      if (closed || observed !== revision) {
        fail(closed ? 'adapter_closed' : 'attempt_context_invalidated')
      }
      if (entries.get(binding.call_id + ':' + binding.attempt_id)?.fenced) {
        fail('attempt_anchor_unavailable')
      }
      if (expiry !== anchor.dedup_expires_at) {
        fail('attempt_anchor_unavailable')
      }
      return anchor.dedup_expires_at
    },
    /** 注册后端回收通知，关闭后同步交付 closed，返回幂等取消订阅。 */
    subscribeInvalidation(listener: (event: LedgerInvalidation) => void): () => void {
      if (typeof listener !== 'function' || listeners.size >= 128) {
        fail('listener_limit')
      }
      if (closed) {
        listener({ kind: 'closed' })
      } else {
        listeners.add(listener)
      }
      return /** 解除订阅只影响本监听器，不改变任何已提交锚点或 claims。 */ () => {
        listeners.delete(listener)
      }
    },
    /** 外部只交原始 Wire，候选仅在真实同步 decode 内可见，完整复核成功后才提交。 */
    decode(
      input: string | Uint8Array,
      direction: Direction,
      original: (input: string | Uint8Array, direction: Direction) => WireEnvelope
    ): WireEnvelope {
      if (closed || decoding) {
        fail(closed ? 'adapter_closed' : 'admission_context_reentrant')
      }
      decoding = true
      const observed = revision
      try {
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
        admittingBinding = binding
        const selected = routes.get(boundedJson(binding.target))
        if (!selected || binding.target.machine_id !== connection.machine_id) {
          fail('connector_route_unavailable')
        }
        const originalSnapshot = snapshot(binding, undefined, true)
        const at = now()
        for (const [name, retained] of entries) {
          if (at >= retained.snapshot.anchor.dedup_expires_at) {
            entries.delete(name)
            bytes -= retained.bytes
            publish({
              kind: 'fence',
              machine_id: retained.attempt.binding.machine_id,
              call_id: retained.attempt.binding.call_id
            })
          }
        }
        if (
          originalSnapshot.fenced ||
          !['dispatching', 'connector_accepted'].includes(originalSnapshot.anchor.state) ||
          originalSnapshot.anchor.content_status !== 'available' ||
          at >= binding.registration.deadline ||
          at >= originalSnapshot.anchor.content_expires_at ||
          at >= originalSnapshot.anchor.dedup_expires_at
        ) {
          fail('attempt_anchor_unavailable')
        }
        const native = object(payload.native_request)
        const mode = payload.validation as TrustedAttempt['mode']
        if (payload.expected_binding_revision !== binding.binding_revision) {
          fail('provider_binding_mismatch')
        }
        if (
          originalSnapshot.request_sha256 !==
            admissionRequestDigest({ binding, native_request: native, validation: mode }) ||
          originalSnapshot.registered_request_sha256 !==
            admissionRegisteredRequestDigest({ binding, native_request: native, validation: mode }, selected) ||
          originalSnapshot.anchor.method !== native.method ||
          originalSnapshot.anchor.mode !== mode
        ) {
          fail('admission_request_mismatch')
        }
        const body: TrustedAttempt = {
          binding,
          principal_id: selected,
          method: native.method as string,
          mode,
          transport: 'rpc',
          native_request: native
        }
        const { native_request: _body, ...metadata } = body
        const entry: Entry = {
          snapshot: originalSnapshot,
          attempt: metadata,
          body,
          fenced: false,
          committed: false,
          bytes: Buffer.byteLength(boundedJson({ attempt: metadata, body, snapshot: originalSnapshot }))
        }
        const name = binding.call_id + ':' + binding.attempt_id
        const previous = entries.get(name)
        if (previous) {
          refresh(previous)
          if (!previous.body || boundedJson(previous.body) !== boundedJson(body)) {
            fail('attempt_request_mismatch')
          }
        }
        if (!previous && (entries.size >= limits.attempts || bytes + entry.bytes > limits.bytes)) {
          fail('connector_attempt_capacity')
        }
        const result = options.book.admit(
          body,
          /** 独立源回调看不到候选；只在原 Wire 验证回调内开放必要的账本只读端口。 */ () => {
            pending = { entry, visible: true }
            try {
              const checked = original(input, direction)
              if (!checked || typeof checked !== 'object' || Object.getPrototypeOf(checked) !== Object.prototype) {
                void Promise.resolve(checked).catch(/** 消费非法异步返回的晚到拒绝，不承认准入已经完成。 */ () => {})
                fail('synchronous_connector_admission_required')
              }
              if (closed || observed !== revision) {
                fail(closed ? 'adapter_closed' : 'attempt_context_invalidated')
              }
              if (boundedJson(snapshot(binding, originalSnapshot, true)) !== boundedJson(originalSnapshot)) {
                fail('admission_context_conflict')
              }
              refresh(entry)
              if (!entry.body) {
                fail('content_unavailable')
              }
              return checked
            } finally {
              pending = undefined
            }
          },
          originalSnapshot.anchor.dedup_expires_at,
          /** book 第二次独立来源查询后再核最终 fence，关闭不能留下已提交摘要。 */ () => {
            const current = snapshot(binding, originalSnapshot, true)
            const at = now()
            if (closed || observed !== revision) {
              fail(closed ? 'adapter_closed' : 'attempt_context_invalidated')
            }
            if (
              boundedJson(current) !== boundedJson(originalSnapshot) ||
              at >= current.anchor.content_expires_at ||
              at >= current.anchor.dedup_expires_at ||
              at >= binding.registration.deadline
            ) {
              fail('admission_context_conflict')
            }
          }
        )
        if (closed || observed !== revision) {
          fail(closed ? 'adapter_closed' : 'attempt_context_invalidated')
        }
        if (!previous) {
          entry.committed = true
          entries.set(name, entry)
          bytes += entry.bytes
        }
        return result
      } finally {
        pending = undefined
        admittingBinding = undefined
        decoding = false
      }
    },
    /** 完成释放只丢本 epoch 请求原文，响应锚点、共享去重簿和持久 claims 均保留。 */
    release(binding: AttemptBinding): void {
      if (admittingBinding?.call_id === binding.call_id && admittingBinding.attempt_id === binding.attempt_id) {
        assertBinding(binding, admittingBinding)
        revision++
      }
      if (
        pending?.entry.attempt.binding.call_id === binding.call_id &&
        pending.entry.attempt.binding.attempt_id === binding.attempt_id
      ) {
        assertBinding(binding, pending.entry.attempt.binding)
        dropBody(pending.entry)
      }
      const found = entries.get(binding.call_id + ':' + binding.attempt_id)
      if (found) {
        assertBinding(binding, found.attempt.binding)
        dropBody(found)
      }
    },
    close
  })
  unsubscribe = external(
    /** 订阅实际持久 reader，不以任意 JSON 或测试事件作为生产状态来源。 */ () =>
      options.receipts.subscribeInvalidation(invalidate)
  )
  if (typeof unsubscribe !== 'function') {
    close()
    fail('admission_context_source_required')
  }
  if (closed) {
    external(/** 同步关闭的 reader 仍必须解除刚交付的真实订阅。 */ () => unsubscribe!())
    unsubscribe = undefined
  }
  return ledger
}

export type ConnectorAdmissionLedger = ReturnType<typeof createConnectorAdmissionLedger>
