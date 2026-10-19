// 维护 hash-only 身份 SQLite、单 writer、一次性管理确认、固定期限及持久拒绝状态。
import { DatabaseSync } from 'node:sqlite'
import { existsSync, statSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createPrivate, privateFile, privatePath } from '../storage/files.js'
import { fail, id, WireError } from '../wire/index.js'

export type IdentityAction = 'install' | 'rotate' | 'finish_rotation' | 'revoke' | 're_pair' | 'takeover'
export type IdentityIntent = {
  action: IdentityAction
  machine_id: string
  recovery_generation: string
  revision: number
  connection_epoch: string | null
}
export type IdentityApproval = { actor: string; confirmation_id: string; expires_at: number }
/** 基于独立管理员上下文核对完整 intent，返回一次性短期确认；JSON 自报不能成为授权。 */
export type IdentityAuthorizer = (intent: IdentityIntent) => IdentityApproval
export type IdentityRecord = {
  machine_id: string
  revision: number
  status: 'active' | 'blocked' | 'pending' | 'revoked'
  current_hash: string | null
  current_expires: number
  previous_hash: string | null
  previous_expires: number
}
export type IdentityUsage = { security_bytes: number; audit_bytes: number; reserved_bytes: number }
export type CommittedIdentity = {
  row: IdentityRecord
  now: number
  blocked?: { generation: string; connection_epoch: string | null; revision: number }
}
export type IdentityStoreOptions = {
  generation: string
  /** 当前业务存储不处于 active 或已隔离时拒绝身份操作，不提供默认放行。 */
  guard(): void
  /** 按宿主显式分配的安全/审计份额及总存储预算审核身份库用量，缺来源时拒绝。 */
  checkBudget(usage: IdentityUsage): void
  /** 提供独立可信时间，调用方仍须检查单调性和固定到期边界。 */
  now?: () => number
  limits?: Partial<{ bytes: number; devices: number; audit: number; confirmations: number; audit_ttl: number }>
  /** 在提交前执行受信故障钩子，异常必须保持持久拒绝；业务输入不得选择此钩子。 */
  fault?: (point: 'before_commit') => void
}

// 单 writer 的 hash-only 身份库；与业务 Store 的跨库管理操作采取先持久拒绝、后完成的顺序。
export class IdentityStore {
  private db!: DatabaseSync
  private closed = false
  private busy = false
  private degraded = false
  private locked = false
  private observed = 0
  readonly limits: { bytes: number; devices: number; audit: number; confirmations: number; audit_ttl: number }
  /** 打开受限单 writer 身份库，核对 schema/代次/完整性与预算；拒绝崩溃锁及未经验证的宿主。 */
  constructor(
    private readonly path: string,
    private readonly options: IdentityStoreOptions
  ) {
    id(options.generation)
    if (
      typeof options.guard !== 'function' ||
      typeof options.checkBudget !== 'function' ||
      options.guard() !== undefined
    ) {
      fail('identity_host_required')
    }
    this.limits = {
      bytes: 8_388_608,
      devices: 1024,
      audit: 8192,
      confirmations: 4096,
      audit_ttl: 90 * 86_400_000,
      ...options.limits
    }
    for (const value of Object.values(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1) {
        fail('identity_limit')
      }
    }
    if (
      this.limits.bytes < 65_536 ||
      this.limits.bytes > 67_108_864 ||
      this.limits.devices > 4096 ||
      this.limits.audit > 65_536 ||
      this.limits.confirmations > 65_536
    ) {
      fail('identity_limit')
    }
    privatePath(path)
    if (existsSync(path)) {
      privateFile(path)
    }
    createPrivate(path + '.lock')
    this.locked = true
    try {
      if (!existsSync(path)) {
        createPrivate(path)
      }
      this.db = new DatabaseSync(path)
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
      if (tables.length === 0) {
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE identity_meta(version INTEGER NOT NULL, generation TEXT NOT NULL, clock INTEGER NOT NULL, mode TEXT NOT NULL);
          CREATE TABLE device_credentials(machine_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, status TEXT NOT NULL,
            current_hash TEXT, current_expires INTEGER NOT NULL, previous_hash TEXT, previous_expires INTEGER NOT NULL);
          CREATE TABLE identity_confirmations(id TEXT PRIMARY KEY, expires INTEGER NOT NULL);
          CREATE TABLE identity_blocks(machine_id TEXT PRIMARY KEY, generation TEXT NOT NULL,
            connection_epoch TEXT, revision INTEGER NOT NULL);
          CREATE TABLE identity_audit(id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, revision INTEGER NOT NULL,
            action TEXT NOT NULL, actor TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL);`)
        this.db.prepare("INSERT INTO identity_meta VALUES(2,?,0,'active')").run(options.generation)
        this.db.exec('COMMIT')
      }
      const meta = this.meta()
      if (meta.version !== 2 || meta.generation !== options.generation) {
        fail('identity_recovery_required')
      }
      if (this.db.prepare('PRAGMA quick_check').get()!.quick_check !== 'ok') {
        fail('identity_integrity_failed')
      }
      this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;')
      const pages = Math.floor(this.limits.bytes / 3 / 4096)
      this.db.exec(`PRAGMA max_page_count=${pages}`)
      this.degraded = meta.mode !== 'active' || existsSync(path + '.degraded')
      if (this.options.checkBudget(this.usage()) !== undefined) {
        fail('identity_host_required')
      }
    } catch {
      try {
        this.db?.close()
      } catch {
        /* 构造失败不能复用不完整句柄。 */
      }
      this.unlock()
      fail('identity_open_failed')
    }
  }
  /** 读取且要求唯一的身份元数据行，防止损坏或重复元数据被当作有效配置。 */
  private meta() {
    const rows = this.db.prepare('SELECT * FROM identity_meta').all()
    if (rows.length !== 1) {
      fail('identity_integrity_failed')
    }
    return rows[0] as { version: number; generation: string; clock: number; mode: string }
  }
  /** 保持进程拒绝状态并尽力持久化降级标记；写失败时不会自动恢复身份权限。 */
  private block(): void {
    this.degraded = true
    try {
      this.db.prepare("UPDATE identity_meta SET mode='degraded'").run()
    } catch {
      /* 磁盘故障时依赖拒绝标记。 */
    }
    try {
      if (!existsSync(this.path + '.degraded')) {
        createPrivate(this.path + '.degraded')
      }
    } catch {
      /* 不承诺整机回滚检测。 */
    }
  }
  /** 计量身份/确认/审计、SQLite 页和 journal 预算，超限时阻断安全状态变更。 */
  private usage(): IdentityUsage {
    const devices = this.db.prepare('SELECT * FROM device_credentials').all()
    const confirmations = this.db.prepare('SELECT * FROM identity_confirmations').all()
    const audit = this.db.prepare('SELECT * FROM identity_audit').all()
    const blocks = this.db.prepare('SELECT * FROM identity_blocks').all()
    if (
      devices.length > this.limits.devices ||
      blocks.length > this.limits.devices ||
      confirmations.length > this.limits.confirmations ||
      audit.length > this.limits.audit
    ) {
      fail('identity_quota')
    }
    const security_bytes = Buffer.byteLength(JSON.stringify({ devices, confirmations, blocks }))
    const audit_bytes = Buffer.byteLength(JSON.stringify(audit))
    const pages =
      Number(this.db.prepare('PRAGMA page_count').get()!.page_count) *
      Number(this.db.prepare('PRAGMA page_size').get()!.page_size)
    const journal = existsSync(this.path + '-journal') ? statSync(this.path + '-journal').size : 0
    if (Math.max(pages, statSync(this.path).size) + journal + 16_384 > this.limits.bytes) {
      fail('identity_quota')
    }
    return { security_bytes, audit_bytes, reserved_bytes: 16_384 }
  }
  /** 串行提交身份事务并维持拒绝时也持久化的时间高水位；异常回滚且存储故障保持封锁。 */
  private transaction<T>(fn: (now: number) => T): T {
    if (this.closed || this.degraded) {
      fail('identity_unavailable')
    }
    if (this.busy) {
      fail('identity_reentrancy')
    }
    if (this.options.guard() !== undefined) {
      fail('identity_host_required')
    }
    this.busy = true
    try {
      const now = (this.options.now ?? Date.now)()
      if (
        !Number.isSafeInteger(now) ||
        now < Math.max(this.meta().clock, this.observed) ||
        !Number.isSafeInteger(now + this.limits.audit_ttl)
      ) {
        this.block()
        fail('clock_untrusted')
      }
      this.observed = now
      if (this.options.checkBudget(this.usage()) !== undefined) {
        fail('identity_host_required')
      }
      // 认证拒绝也要保存时间高水位，不能因回滚让到期凭据在重启后复活。
      this.db.prepare('UPDATE identity_meta SET clock=?').run(now)
      this.db.exec('BEGIN IMMEDIATE')
      this.db.prepare('DELETE FROM identity_confirmations WHERE expires<=?').run(now)
      this.db.prepare('DELETE FROM identity_audit WHERE expires<=?').run(now)
      const result = fn(now)
      if (this.options.checkBudget(this.usage()) !== undefined) {
        fail('identity_host_required')
      }
      this.options.fault?.('before_commit')
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* 事务尚未开始时无回滚内容。 */
      }
      if (!(error instanceof WireError) || error.code === 'identity_quota') {
        this.block()
        fail('identity_unavailable')
      }
      throw error
    } finally {
      this.busy = false
    }
  }
  /** 返回该身份库固定的恢复代次，供宿主与业务账本核对。 */
  generation(): string {
    return this.options.generation
  }
  /** 校验稳定设备 ID 后查询其凭据元数据；未登记返回 undefined。 */
  private row(machine: string): IdentityRecord | undefined {
    id(machine)
    return this.db.prepare('SELECT * FROM device_credentials WHERE machine_id=?').get(machine) as
      | IdentityRecord
      | undefined
  }
  /** 在受信门禁与单 writer 事务内取得设备快照，不绕过降级或时间检查。 */
  read(machine: string): IdentityRecord | undefined {
    return this.transaction(
      /** 读取当前设备行，确保快照受本次事务约束。 */
      () => this.row(machine)
    )
  }
  /** 验证代次、active 状态及当前/过渡凭据的固定到期时间，成功才返回元数据。 */
  verify(machine: string, generation: string, digest: string): IdentityRecord {
    return this.transaction(
      /** 在同一事务快照中判断当前或过渡 hash 是否仍有效，到期边界一律拒绝。 */
      (now) => {
        const row = this.row(machine)
        if (
          generation !== this.generation() ||
          row?.status !== 'active' ||
          !(
            (row.current_hash === digest && row.current_expires > now) ||
            (row.previous_hash === digest && row.previous_expires > now)
          )
        ) {
          fail('invalid_device_credential')
        }
        return row
      }
    )
  }
  /** 用独立只读连接和独立快照读取已提交身份及精确 blocked fence；写事务的暂存行不能成为许可。 */
  committed(machine: string, generation: string): CommittedIdentity | undefined {
    id(machine)
    if (this.closed || this.degraded || existsSync(this.path + '.degraded')) {
      return undefined
    }
    if (this.options.guard() !== undefined) {
      fail('identity_host_required')
    }
    let reader: DatabaseSync | undefined
    try {
      if (!this.busy) {
        this.transaction(
          /** 独立观察也先持久推进时间高水位，防止重启回拨使已过期凭据复活。 */
          () => undefined
        )
      }
      reader = new DatabaseSync(this.path, { readOnly: true })
      reader.exec('BEGIN')
      const rows = reader.prepare('SELECT * FROM identity_meta').all()
      const meta = rows[0] as { version: number; generation: string; clock: number; mode: string } | undefined
      // 使用刚刚持久 checkpoint 的固定时间；重复读墙钟会把正常毫秒推进误当作未提交时间。
      const now = meta?.clock ?? -1
      if (
        rows.length !== 1 ||
        meta?.version !== 2 ||
        meta.mode !== 'active' ||
        meta.generation !== generation ||
        generation !== this.options.generation ||
        !Number.isSafeInteger(now) ||
        now < Math.max(meta.clock, this.observed) ||
        now > this.observed
      ) {
        return undefined
      }
      const row = reader.prepare('SELECT * FROM device_credentials WHERE machine_id=?').get(machine) as
        | IdentityRecord
        | undefined
      if (!row) {
        return undefined
      }
      const blocked = reader
        .prepare('SELECT generation,connection_epoch,revision FROM identity_blocks WHERE machine_id=?')
        .get(machine) as CommittedIdentity['blocked']
      return { row, now, blocked }
    } catch {
      return undefined
    } finally {
      try {
        reader?.exec('ROLLBACK')
      } catch {
        /* BEGIN 失败时没有快照；读失败仍只能拒绝。 */
      }
      reader?.close()
    }
  }
  /** 消费独立当前管理确认，推进单调 revision，并将身份变更及必要审计一起提交。 */
  change<T>(
    machine: string,
    action: IdentityAction,
    authorize: IdentityAuthorizer,
    epoch: string | null,
    fn: (row: IdentityRecord | undefined, now: number) => { row: IdentityRecord; result: T }
  ): T {
    return this.transaction(
      /** 核对确认期限和一次性 ID，再验证新行 revision 并原子保存安全记录与审计。 */
      (now) => {
        const previous = this.row(machine)
        const approval = authorize({
          action,
          machine_id: machine,
          recovery_generation: this.generation(),
          revision: previous?.revision ?? 0,
          connection_epoch: epoch
        })
        id(approval.actor)
        id(approval.confirmation_id)
        if (
          !Number.isSafeInteger(approval.expires_at) ||
          approval.expires_at <= now ||
          approval.expires_at > now + 300_000
        ) {
          fail('invalid_identity_confirmation')
        }
        if (this.db.prepare('SELECT id FROM identity_confirmations WHERE id=?').get(approval.confirmation_id)) {
          fail('identity_confirmation_replayed')
        }
        const { row, result } = fn(previous, now)
        if (row.machine_id !== machine || row.revision !== (previous?.revision ?? 0) + 1) {
          fail('identity_revision_mismatch')
        }
        this.db
          .prepare('INSERT INTO identity_confirmations VALUES(?,?)')
          .run(approval.confirmation_id, approval.expires_at)
        this.db
          .prepare('INSERT OR REPLACE INTO device_credentials VALUES(?,?,?,?,?,?,?)')
          .run(
            row.machine_id,
            row.revision,
            row.status,
            row.current_hash,
            row.current_expires,
            row.previous_hash,
            row.previous_expires
          )
        this.db.prepare('DELETE FROM identity_blocks WHERE machine_id=?').run(machine)
        if (action === 're_pair' && row.status === 'blocked') {
          this.db
            .prepare('INSERT INTO identity_blocks VALUES(?,?,?,?)')
            .run(machine, this.generation(), epoch, row.revision)
        }
        this.db
          .prepare('INSERT INTO identity_audit VALUES(?,?,?,?,?,?,?)')
          .run(randomUUID(), machine, row.revision, action, approval.actor, now, now + this.limits.audit_ttl)
        return result
      }
    )
  }
  /** 只收敛指定 revision 的 blocked 状态，不创建或重建任何凭据。 */
  settle(machine: string, revision: number, status: 'pending' | 'revoked' | 'active'): void {
    this.transaction(
      /** 精确匹配 blocked 行及其 revision，防止旧跨库完成事件覆盖新的管理状态。 */
      () => {
        const row = this.row(machine)
        if (row?.status !== 'blocked' || row.revision !== revision) {
          fail('identity_revision_mismatch')
        }
        this.db
          .prepare('UPDATE device_credentials SET status=? WHERE machine_id=? AND revision=?')
          .run(status, machine, revision)
        this.db.prepare('DELETE FROM identity_blocks WHERE machine_id=?').run(machine)
      }
    )
  }
  /** 持久拒绝仍持有失败交付 hash 的设备；revision 推进不能绕过，写入失败封锁整个身份库。 */
  denyDelivery(machine: string, digest: string): void {
    try {
      this.transaction(
        /** 精确匹配 current 或 previous hash；已完全替换的旧交付不能误封新凭据或其它设备。 */
        (now) => {
          const row = this.row(machine)
          if (!row || row.status !== 'active' || (row.current_hash !== digest && row.previous_hash !== digest)) {
            return
          }
          this.db
            .prepare(
              "UPDATE device_credentials SET status='blocked',current_hash=NULL,previous_hash=NULL WHERE machine_id=? AND revision=?"
            )
            .run(machine, row.revision)
          this.db
            .prepare('INSERT INTO identity_audit VALUES(?,?,?,?,?,?,?)')
            .run(randomUUID(), machine, row.revision, 'delivery_unknown', 'custody', now, now + this.limits.audit_ttl)
        }
      )
    } catch {
      this.block()
      fail('identity_unavailable')
    }
  }
  /** 经独立审计读取授权返回有界管理元数据，不返回凭据 hash 或原文。 */
  audit(authorize: () => void) {
    if (authorize() !== undefined) {
      fail('identity_forbidden')
    }
    return this.transaction(
      /** 在事务中按稳定次序读取已授权的管理审计快照。 */
      () =>
        this.db.prepare('SELECT machine_id,revision,action,actor,created FROM identity_audit ORDER BY created,id').all()
    )
  }
  /** 只释放本实例持有的独占锁，正常关闭前不会清理他人或崩溃遗留锁。 */
  private unlock(): void {
    if (this.locked) {
      unlinkSync(this.path + '.lock')
      this.locked = false
    }
  }
  /** 幂等关闭 SQLite 并释放自己的 writer 锁，降级标记保留供下次启动拒绝。 */
  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.db.close()
    this.unlock()
  }
}
