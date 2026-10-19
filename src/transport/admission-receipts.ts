// 独立持久保存实际认证通道交付的原截止和请求摘要，不保存请求正文或生成派发许可。
import { constants, closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, sep } from 'node:path'
import { createPrivate, privateFile, privatePath } from '../storage/files.js'
import { consumeAuthenticatedAdmissionReceipt } from './admission-proof.js'
import type { AuthenticatedAdmissionReceipt, AdmissionReceiptSink } from './admission-proof.js'
import {
  admissionRequestDigest,
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
import type { AdmissionRequest, AdmissionReceiptRecord, AttemptBinding } from '../wire/index.js'

export type ConnectorAdmissionReceiptsOptions = Readonly<{
  path: string
  mode: 'create' | 'open'
  ledger_id: string
  limits: Readonly<{ entries: number; bytes: number }>
  now(): number
}>
type State = { version: 1; ledger_id: string; clock: number; entries: AdmissionReceiptRecord[] }

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
export class ConnectorAdmissionReceipts implements AdmissionReceiptSink {
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
      fields(state, ['version', 'ledger_id', 'clock', 'entries'])
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
        const name = entry.binding.call_id + ':' + entry.binding.attempt_id
        if (names.has(name)) {
          throw new WireError('receipt_ledger_invalid')
        }
        names.add(name)
      }
      this.#state = state as State
      this.#digest = hash(raw)
      this.#time()
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

  /** 可信时钟高水位也持久保存；回拨不能在重启后复活已过期 receipt。 */
  #time(): number {
    this.#guard()
    const now = this.#options.now()
    this.#guard()
    uint(now)
    if (now < this.#state.clock) {
      throw new WireError('clock_untrusted')
    }
    if (now > this.#state.clock) {
      this.#persist({
        ...this.#state,
        clock: now,
        entries: this.#state.entries.filter(
          /** 到原固定截止后仅清除元数据，不产生新期限或执行意图。 */ (entry) => now < entry.dedup_expires_at
        )
      })
    }
    return now
  }

  /** 只消费 transport 私有一次性证明；记录完整绑定、规范请求摘要及 Gateway 原固定截止。 */
  accept(proof: AuthenticatedAdmissionReceipt): void {
    try {
      const record = consumeAuthenticatedAdmissionReceipt(proof)
      const now = this.#time()
      if (now >= record.binding.registration.deadline || now >= record.dedup_expires_at) {
        throw new WireError('admission_receipt_expired')
      }
      const previous = this.#state.entries.find(
        /** call/attempt 全局唯一，换 epoch、目标、请求或截止都不能覆盖原记录。 */ (entry) =>
          entry.binding.call_id === record.binding.call_id && entry.binding.attempt_id === record.binding.attempt_id
      )
      if (previous) {
        if (boundedJson(previous) !== boundedJson(record)) {
          throw new WireError('admission_receipt_conflict')
        }
        return
      }
      this.#persist({ ...this.#state, entries: [...this.#state.entries, record] })
    } catch (error) {
      safe(error)
    }
  }

  /** 正文只有与已认证且持久的原摘要完全相同才可进入原生派发；此门禁自身不授予许可。 */
  assertRequest(request: AdmissionRequest): void {
    try {
      const expected = admissionRequestDigest(request)
      this.dedupExpires(request.binding)
      const entry = this.#state.entries.find(
        /** 完整绑定已由 dedupExpires 核对，再查固定元数据比较原始请求摘要。 */ (record) =>
          record.binding.call_id === request.binding.call_id && record.binding.attempt_id === request.binding.attempt_id
      )!
      if (entry.request_sha256 !== expected) {
        throw new WireError('admission_request_mismatch')
      }
    } catch (error) {
      safe(error)
    }
  }

  /** 缺已认证交付、过期或换连接的查询全部拒绝，永远不按当前时间补算 TTL。 */
  dedupExpires(binding: AttemptBinding): number {
    try {
      const now = this.#time()
      const entry = this.#state.entries.find(
        /** 独立持久查询只按精确 call/attempt 查找，不取回任何请求正文。 */ (record) =>
          record.binding.call_id === binding.call_id && record.binding.attempt_id === binding.attempt_id
      )
      if (!entry || now >= entry.dedup_expires_at) {
        throw new WireError('admission_receipt_unavailable')
      }
      assertBinding(binding, entry.binding)
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
    this.#unlock()
  }
}
