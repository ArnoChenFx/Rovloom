// 独立持久保存实际认证通道交付的原截止和请求摘要，不保存请求正文或生成派发许可。
import { constants, closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, sep } from 'node:path'
import { createPrivate, privateFile, privatePath } from '../storage/files.js'
import { consumeAuthenticatedAdmissionReceipt } from './admission-proof.js'
import type { AuthenticatedAdmissionReceipt, AdmissionReceiptSink } from './admission-proof.js'
import {
  admissionRequestDigest,
  admissionRegisteredRequestDigest,
  validateTarget,
  assertBinding,
  boundedJson,
  fields,
  hash,
  id,
  object,
  parseJson,
  uint,
  validateAdmissionReceipt,
  WireError
} from '../wire/index.js'
import type { LedgerInvalidation } from '../storage/model.js'
import type { ResponseAnchor } from '../wire/evidence.js'
import type {
  AdmissionContextReader,
  TrustedAdmissionSnapshot,
  AdmissionRequest,
  AdmissionReceiptRecord,
  AttemptBinding,
  ConnectionIdentity,
  V2Target
} from '../wire/index.js'

export type ConnectorAdmissionReceiptsOptions = Readonly<{
  path: string
  mode: 'create' | 'open'
  ledger_id: string
  limits: Readonly<{ entries: number; bytes: number }>
  now(): number
  // 只有含完整上下文的记录需要受保护路由；旧 cutoff-only 接口保持兼容。
  routes?: readonly Readonly<{ target: V2Target; principal_id: string }>[]
}>
type Floor = { call_id: string; attempt_id: string; content_expired: boolean; epoch_closed: boolean }
type State = {
  version: 1
  ledger_id: string
  clock: number
  entries: AdmissionReceiptRecord[]
  context_floors?: Floor[]
}

/** lstat 将断链也视为已有目录项，不能自动跟随或覆盖。 */
function present(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }
}

/** 受保护父目录不能被其它用户改写；不把 /tmp 的 sticky 位当作独立配置来源。 */
function protectedPath(path: string): void {
  privatePath(path)
  const uid = process.geteuid!()
  const rootOwner = lstatSync(sep).uid
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const entry = lstatSync(parent)
    if ((entry.mode & 0o022) !== 0 || (entry.uid !== uid && entry.uid !== rootOwner)) {
      throw new WireError('receipt_path_untrusted')
    }
    if (parent === sep) {
      break
    }
  }
}

/** 固定普通私有文件的 inode、属主及权限；内容另以提交摘要逐次核对。 */
function identity(path: string): string {
  privateFile(path)
  const entry = lstatSync(path, { bigint: true })
  return [entry.dev, entry.ino, entry.uid, entry.mode, entry.nlink].join(':')
}

/** 在创建、原子替换和移除锁后同步目录项，提交失败始终拒绝继续派发。 */
function syncParent(path: string): void {
  const fd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** 统一为无路径、无载荷的安全错误；已知 Wire 错误仍保留其固定边界码。 */
function safe(error: unknown): never {
  if (error instanceof WireError) {
    throw error
  }
  throw new WireError('receipt_storage_unavailable')
}

/** 一个独占 writer 原子替换有界元数据文件；崩溃锁和暂存文件必须显式恢复，绝不自动接管。 */
export class ConnectorAdmissionReceipts implements AdmissionReceiptSink, AdmissionContextReader {
  readonly #routes = new Map<string, string>()
  readonly #listeners = new Set<(event: LedgerInvalidation) => void>()
  readonly #options: ConnectorAdmissionReceiptsOptions
  #state!: State
  #fileIdentity = ''
  #lockIdentity = ''
  #digest = ''
  #closed = false
  #degraded = false
  #busy = false

  /** 首次创建必须显式选择 create；正常打开缺文件、旧 schema、坏身份和超额均失败。 */
  constructor(input: ConnectorAdmissionReceiptsOptions) {
    const options = { ...input, limits: { ...input.limits } }
    id(options.ledger_id)
    uint(options.limits.entries, true)
    uint(options.limits.bytes, true)
    if (
      typeof options.path !== 'string' ||
      !['create', 'open'].includes(options.mode) ||
      typeof options.now !== 'function' ||
      options.limits.entries > 1024 ||
      options.limits.bytes < 262_144 ||
      options.limits.bytes > 16_777_216
    ) {
      throw new WireError('receipt_config_invalid')
    }
    this.#options = options
    for (const route of options.routes ?? []) {
      validateTarget(route.target)
      id(route.principal_id)
      const key = boundedJson(route.target)
      if (this.#routes.has(key) || this.#routes.size >= 64) {
        throw new WireError('receipt_route_invalid')
      }
      this.#routes.set(key, route.principal_id)
    }
    try {
      protectedPath(options.path)
      if (present(options.path + '.pending')) {
        throw new WireError('receipt_recovery_required')
      }
      if (present(options.path) !== (options.mode === 'open')) {
        throw new WireError(options.mode === 'open' ? 'receipt_ledger_missing' : 'receipt_ledger_exists')
      }
      createPrivate(options.path + '.lock')
      this.#lockIdentity = identity(options.path + '.lock')
      syncParent(options.path)
      if (options.mode === 'create') {
        createPrivate(options.path, boundedJson({ version: 1, ledger_id: options.ledger_id, clock: 0, entries: [] }))
        syncParent(options.path)
      }
      this.#fileIdentity = identity(options.path)
      const raw = this.#read()
      const state = object(parseJson(raw, options.limits.bytes))
      fields(state, ['version', 'ledger_id', 'clock', 'entries'], ['context_floors'])
      uint(state.clock)
      if (
        state.version !== 1 ||
        state.ledger_id !== options.ledger_id ||
        !Array.isArray(state.entries) ||
        state.entries.length > options.limits.entries
      ) {
        throw new WireError('receipt_ledger_invalid')
      }
      const names = new Set<string>()
      for (const entry of state.entries) {
        validateAdmissionReceipt(entry)
        this.#assertRoute(entry)
        const name = entry.binding.call_id + ':' + entry.binding.attempt_id
        if (names.has(name)) {
          throw new WireError('receipt_ledger_invalid')
        }
        names.add(name)
      }
      if (state.context_floors !== undefined) {
        if (!Array.isArray(state.context_floors) || state.context_floors.length > options.limits.entries) {
          throw new WireError('receipt_ledger_invalid')
        }
        const floors = new Set<string>()
        for (const floor of state.context_floors) {
          fields(object(floor), ['call_id', 'attempt_id', 'content_expired', 'epoch_closed'])
          id(floor.call_id)
          id(floor.attempt_id)
          const key = floor.call_id + ':' + floor.attempt_id
          if (
            typeof floor.content_expired !== 'boolean' ||
            typeof floor.epoch_closed !== 'boolean' ||
            !names.has(key) ||
            floors.has(key) ||
            !state.entries.some(
              /** 本机单调标记只能关联已有完整上下文，不能为缺交付的调用制造锚点。 */ (entry) =>
                entry.binding.call_id === floor.call_id &&
                entry.binding.attempt_id === floor.attempt_id &&
                entry.context !== undefined
            )
          ) {
            throw new WireError('receipt_ledger_invalid')
          }
          floors.add(key)
        }
      }
      this.#state = state as State
      this.#digest = hash(raw)
      this.#time()
      if (options.mode === 'open') {
        const floors = this.#state.entries
          .filter(/** 重启不恢复任何旧 epoch 的 online 或执行能力。 */ (entry) => entry.context !== undefined)
          .map(
            /** 固定原截止，仅把旧本机 epoch 持久收紧为不可执行。 */ (entry) => ({
              ...this.#floor(entry),
              epoch_closed: true
            })
          )
        if (
          floors.some(
            /** 已封锁项不重复写文件。 */ (floor) =>
              !this.#state.context_floors?.find(
                /** 同一 call/attempt 标记只有不可逆 false 到 true。 */ (prior) =>
                  prior.call_id === floor.call_id && prior.attempt_id === floor.attempt_id
              )?.epoch_closed
          )
        ) {
          this.#persist({ ...this.#state, context_floors: floors })
        }
      }
    } catch (error) {
      this.#unlock()
      safe(error)
    }
  }

  /** 读取前限制实际文件尺寸，不让超额文件先占满解析或复制预算。 */
  #read(): Buffer {
    if (lstatSync(this.#options.path).size > this.#options.limits.bytes) {
      throw new WireError('receipt_capacity')
    }
    return readFileSync(this.#options.path)
  }

  /** 每次访问都核对保护路径、独占锁、实际文件身份和最近提交摘要。 */
  #guard(): void {
    if (this.#closed || this.#degraded || this.#busy) {
      throw new WireError('receipt_ledger_unavailable')
    }
    protectedPath(this.#options.path)
    if (
      identity(this.#options.path) !== this.#fileIdentity ||
      identity(this.#options.path + '.lock') !== this.#lockIdentity ||
      hash(this.#read()) !== this.#digest ||
      present(this.#options.path + '.pending')
    ) {
      throw new WireError('receipt_ledger_identity_changed')
    }
  }

  /** 先写私有暂存并 fsync，再原子替换和独立读取确认；任一步失败都会永久降级本对象。 */
  #persist(state: State): void {
    this.#guard()
    const raw = boundedJson(state, this.#options.limits.bytes)
    if (state.entries.length > this.#options.limits.entries) {
      throw new WireError('receipt_capacity')
    }
    this.#busy = true
    try {
      createPrivate(this.#options.path + '.pending', raw)
      renameSync(this.#options.path + '.pending', this.#options.path)
      syncParent(this.#options.path)
      this.#fileIdentity = identity(this.#options.path)
      if (this.#read().toString('utf8') !== raw) {
        throw new WireError('receipt_commit_unverified')
      }
      this.#state = state
      this.#digest = hash(raw)
    } catch (error) {
      this.#degraded = true
      safe(error)
    } finally {
      this.#busy = false
    }
  }

  /** 完整上下文中的 principal 必须同时命中受保护完整 Target 路由。 */
  #assertRoute(record: AdmissionReceiptRecord): void {
    if (record.context && this.#routes.get(boundedJson(record.binding.target)) !== record.context.principal_id) {
      throw new WireError('admission_principal_mismatch')
    }
  }

  /** 本机失效标记与认证 source 分开保存，旧消息精确重复不能清除 TTL 或 epoch fence。 */
  #floor(record: AdmissionReceiptRecord): Floor {
    return (
      this.#state.context_floors?.find(
        /** call/attempt 唯一关联原本机单调标记。 */ (floor) =>
          floor.call_id === record.binding.call_id && floor.attempt_id === record.binding.attempt_id
      ) ?? {
        call_id: record.binding.call_id,
        attempt_id: record.binding.attempt_id,
        content_expired: false,
        epoch_closed: false
      }
    )
  }

  /** 只有持久变更提交后才通知既有 H1 上下文，通知不包含正文或执行许可。 */
  #publish(events: LedgerInvalidation[]): void {
    for (const event of events) {
      for (const listener of this.#listeners) {
        try {
          listener(event)
        } catch {
          /* 通知失败不回滚已提交的收紧。 */
        }
      }
    }
  }

  /** 固定原 TTL 和可信高水位持久收紧；不会改写认证 source 或刷新任一截止。 */
  #time(): number {
    this.#guard()
    const now = this.#options.now()
    this.#guard()
    uint(now)
    if (now < this.#state.clock) {
      throw new WireError('clock_untrusted')
    }
    const events: LedgerInvalidation[] = []
    const entries = this.#state.entries.filter(
      /** 原 dedup 截止后只回收元数据，不允许凭空重建旧意图。 */ (entry) => {
        if (now >= entry.dedup_expires_at) {
          if (entry.context) {
            events.push({ kind: 'fence', machine_id: entry.binding.machine_id, call_id: entry.binding.call_id })
          }
          return false
        }
        return true
      }
    )
    const floors = entries
      .filter(/** 旧 cutoff-only 记录不生成完整上下文。 */ (entry) => entry.context !== undefined)
      .map(
        /** 本机 TTL 收紧独立于 source sequence，避免旧 source 快照复活内容。 */ (entry) => {
          const floor = this.#floor(entry)
          if (
            !floor.content_expired &&
            entry.context!.anchor.content_status === 'available' &&
            now >= entry.context!.anchor.content_expires_at
          ) {
            events.push({ kind: 'content', machine_id: entry.binding.machine_id, call_id: entry.binding.call_id })
            return { ...floor, content_expired: true }
          }
          return floor
        }
      )
    if (
      now > this.#state.clock ||
      entries.length !== this.#state.entries.length ||
      boundedJson(floors) !== boundedJson(this.#state.context_floors ?? [])
    ) {
      this.#persist({
        ...this.#state,
        clock: now,
        entries,
        ...(floors.length || this.#state.context_floors ? { context_floors: floors } : {})
      })
      this.#publish(events)
      this.#guard()
    }
    return now
  }

  /** 认证更新只能推进原状态，不改变 principal、方法、摘要和三类固定期限。 */
  #advance(previous: AdmissionReceiptRecord, record: AdmissionReceiptRecord): void {
    assertBinding(record.binding, previous.binding)
    if (
      previous.request_sha256 !== record.request_sha256 ||
      previous.dedup_expires_at !== record.dedup_expires_at ||
      (previous.context === undefined) !== (record.context === undefined)
    ) {
      throw new WireError('admission_receipt_conflict')
    }
    if (!previous.context || !record.context) {
      if (boundedJson(previous) !== boundedJson(record)) {
        throw new WireError('admission_receipt_conflict')
      }
      return
    }
    const before = previous.context
    const after = record.context
    if (after.sequence === before.sequence && boundedJson(record) === boundedJson(previous)) {
      return
    }
    if (
      after.sequence !== before.sequence + 1 ||
      before.principal_id !== after.principal_id ||
      before.registered_request_sha256 !== after.registered_request_sha256 ||
      before.anchor.method !== after.anchor.method ||
      before.anchor.mode !== after.anchor.mode ||
      before.anchor.content_expires_at !== after.anchor.content_expires_at ||
      (before.fenced && !after.fenced)
    ) {
      throw new WireError('admission_context_conflict')
    }
    const states: Record<string, readonly string[]> = {
      dispatching: ['dispatching', 'connector_accepted', 'outcome_unknown', 'responded'],
      connector_accepted: ['connector_accepted', 'outcome_unknown', 'responded'],
      outcome_unknown: ['outcome_unknown', 'responded'],
      responded: ['responded'],
      not_dispatched: ['not_dispatched']
    }
    const contents: Record<string, readonly string[]> = {
      available: ['available', 'expired', 'discarded', 'unavailable'],
      expired: ['expired', 'discarded', 'unavailable'],
      discarded: ['discarded', 'unavailable'],
      unavailable: ['unavailable']
    }
    if (
      !states[before.anchor.state]!.includes(after.anchor.state) ||
      !contents[before.anchor.content_status]!.includes(after.anchor.content_status) ||
      (before.anchor.evidence !== undefined &&
        (after.anchor.evidence === undefined ||
          boundedJson(before.anchor.evidence) !== boundedJson(after.anchor.evidence)))
    ) {
      throw new WireError('admission_context_conflict')
    }
  }

  /** 只消费认证通道的 opaque 证明；精确重复幂等，更新先持久后通知，不凭空建立 fence。 */
  accept(proof: AuthenticatedAdmissionReceipt): void {
    try {
      const record = consumeAuthenticatedAdmissionReceipt(proof)
      this.#assertRoute(record)
      const now = this.#time()
      if (now >= record.dedup_expires_at) {
        throw new WireError('admission_receipt_expired')
      }
      const previous = this.#state.entries.find(
        /** 新 epoch 不能覆盖原 call/attempt 的完整绑定。 */ (entry) =>
          entry.binding.call_id === record.binding.call_id && entry.binding.attempt_id === record.binding.attempt_id
      )
      if (previous) {
        this.#advance(previous, record)
        if (boundedJson(previous) === boundedJson(record)) {
          return
        }
      } else if (
        now >= record.binding.registration.deadline ||
        (record.context &&
          (record.context.sequence !== 1 || record.context.fenced || record.context.anchor.state !== 'dispatching'))
      ) {
        throw new WireError('admission_receipt_expired')
      }
      const entries = previous
        ? this.#state.entries.map(
            /** 只替换已经核对的唯一记录，不改变其它 provider 的状态。 */ (entry) =>
              entry === previous ? record : entry
          )
        : [...this.#state.entries, record]
      const floors =
        record.context && !previous
          ? [
              ...(this.#state.context_floors ?? []),
              {
                call_id: record.binding.call_id,
                attempt_id: record.binding.attempt_id,
                content_expired: now >= record.context.anchor.content_expires_at,
                epoch_closed: false
              }
            ]
          : this.#state.context_floors
      this.#persist({ ...this.#state, entries, ...(floors ? { context_floors: floors } : {}) })
      if (previous?.context && record.context) {
        const kind =
          !previous.context.fenced && record.context.fenced
            ? 'fence'
            : previous.context.anchor.content_status !== record.context.anchor.content_status
              ? 'content'
              : undefined
        if (kind) {
          this.#publish([{ kind, machine_id: record.binding.machine_id, call_id: record.binding.call_id }])
        }
      }
    } catch (error) {
      safe(error)
    }
  }

  /** 旧 receipt 不具有完整 H1 语义；快照独立复制并合入不可逆本机 TTL/epoch fence。 */
  snapshot(binding: AttemptBinding): TrustedAdmissionSnapshot {
    try {
      this.dedupExpires(binding)
      const record = this.#state.entries.find(
        /** 完整绑定已在墓碑查询中核对。 */ (entry) =>
          entry.binding.call_id === binding.call_id && entry.binding.attempt_id === binding.attempt_id
      )!
      this.#assertRoute(record)
      if (!record.context) {
        throw new WireError('admission_context_required')
      }
      const copy = JSON.parse(boundedJson(record)) as AdmissionReceiptRecord
      const context = copy.context!
      const floor = this.#floor(record)
      if (floor.content_expired && context.anchor.content_status === 'available') {
        context.anchor.content_status = 'expired'
      }
      return {
        binding: copy.binding,
        principal_id: context.principal_id,
        request_sha256: copy.request_sha256,
        registered_request_sha256: context.registered_request_sha256,
        anchor: context.anchor,
        sequence: context.sequence,
        fenced: context.fenced || floor.epoch_closed
      }
    } catch (error) {
      safe(error)
    }
  }

  /** 只投影原锚点；已 fence 的历史元数据不能恢复响应或执行能力。 */
  responseAnchor(binding: AttemptBinding): ResponseAnchor {
    const snapshot = this.snapshot(binding)
    if (snapshot.fenced) {
      throw new WireError('admission_context_fenced')
    }
    return snapshot.anchor
  }

  /** 内容可见状态独立于 permit；旧 epoch 永远不可读，TTL 与 discard 都不复活。 */
  contentStatus(binding: AttemptBinding): ResponseAnchor['content_status'] {
    const snapshot = this.snapshot(binding)
    return snapshot.fenced ? 'unavailable' : snapshot.anchor.content_status
  }

  /** 只订阅已持久收紧；通知本身不生成 native handle 或执行许可。 */
  subscribeInvalidation(listener: (event: LedgerInvalidation) => void): () => void {
    this.#guard()
    if (typeof listener !== 'function' || this.#listeners.size >= 128) {
      throw new WireError('listener_limit')
    }
    this.#listeners.add(listener)
    return /** 退订当前消费者，不影响其它 provider 的监听。 */ () => {
      this.#listeners.delete(listener)
    }
  }

  /** transport 失去 epoch 后先持久本机 fence；失败永久降级，调用者仍须清理会话资源。 */
  closeEpoch(connection: ConnectionIdentity): void {
    try {
      this.#time()
      const events: LedgerInvalidation[] = []
      const floors = this.#state.entries
        .filter(/** 仅完整上下文受本机 epoch 生命周期治理。 */ (entry) => entry.context !== undefined)
        .map(
          /** 精确旧 epoch 的标记不能封锁同设备其它新连接。 */ (entry) => {
            const floor = this.#floor(entry)
            if (
              !floor.epoch_closed &&
              entry.binding.machine_id === connection.machine_id &&
              entry.binding.recovery_generation === connection.recovery_generation &&
              entry.binding.connection_epoch === connection.connection_epoch
            ) {
              events.push({ kind: 'fence', machine_id: entry.binding.machine_id, call_id: entry.binding.call_id })
              return { ...floor, epoch_closed: true }
            }
            return floor
          }
        )
      if (events.length) {
        this.#persist({ ...this.#state, context_floors: floors })
        this.#publish(events)
      }
    } catch (error) {
      this.#degraded = true
      safe(error)
    }
  }

  /** 认证原正文、固定路由主体与 Store 同式登记摘要都匹配，才允许继续原 Wire 派发。 */
  assertRequest(request: AdmissionRequest): void {
    try {
      const expected = admissionRequestDigest(request)
      this.dedupExpires(request.binding)
      const entry = this.#state.entries.find(
        /** 只从已认证的原 call/attempt 读取摘要。 */ (record) =>
          record.binding.call_id === request.binding.call_id && record.binding.attempt_id === request.binding.attempt_id
      )!
      if (entry.request_sha256 !== expected) {
        throw new WireError('admission_request_mismatch')
      }
      if (entry.context) {
        const snapshot = this.snapshot(request.binding)
        if (
          snapshot.fenced ||
          snapshot.anchor.content_status !== 'available' ||
          !['dispatching', 'connector_accepted'].includes(snapshot.anchor.state) ||
          snapshot.anchor.method !== request.native_request.method ||
          snapshot.anchor.mode !== request.validation ||
          snapshot.registered_request_sha256 !== admissionRegisteredRequestDigest(request, snapshot.principal_id)
        ) {
          throw new WireError('admission_request_mismatch')
        }
      }
    } catch (error) {
      safe(error)
    }
  }

  /** 原墓碑可供去重核对；fence 不删除或延长原截止，也不授予执行能力。 */
  dedupExpires(binding: AttemptBinding): number {
    try {
      const now = this.#time()
      const entry = this.#state.entries.find(
        /** 精确定位最小持久墓碑，不取请求或响应正文。 */ (record) =>
          record.binding.call_id === binding.call_id && record.binding.attempt_id === binding.attempt_id
      )
      if (!entry || now >= entry.dedup_expires_at) {
        throw new WireError('admission_receipt_unavailable')
      }
      assertBinding(binding, entry.binding)
      this.#assertRoute(entry)
      return entry.dedup_expires_at
    } catch (error) {
      safe(error)
    }
  }

  /** 仅移除仍属本实例的独占锁；崩溃遗留和被替换的文件都不自动接管。 */
  #unlock(): void {
    try {
      if (this.#lockIdentity && identity(this.#options.path + '.lock') === this.#lockIdentity) {
        unlinkSync(this.#options.path + '.lock')
        syncParent(this.#options.path)
      }
    } catch {
      // 无法确认锁身份或持久性时保持恢复缺项，不删除其它文件。
    }
    this.#lockIdentity = ''
  }

  /** 幂等释放独占 writer；持久元数据和原固定截止跨正常重启保留。 */
  close(): void {
    if (this.#closed) {
      return
    }
    this.#closed = true
    this.#publish([{ kind: 'closed' }])
    this.#listeners.clear()
    this.#unlock()
  }
}
