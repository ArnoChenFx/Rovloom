// 持久化 SQLite 调用账本与设备生命周期，按固定期限治理内容、预算，并在提交后通知宿主回收上下文。
import { DatabaseSync } from 'node:sqlite'
import { closeSync, existsSync, openSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { canonical, digest, GatewayError, validateRequest } from './contracts.js'
import type { NativeRequest } from './contracts.js'
import {
  assertBinding,
  boundedJson,
  contractRef,
  LIMITS,
  planHistoryAdmission,
  registeredRequestDigest,
  validateAttempt,
  validateProvider,
  validateTarget,
  id as validateId
} from './wire/index.js'
import type { HistoryScope, HistoryRecord } from './wire/history.js'
import type { ResponseAnchor, ResponseEvidencePlan } from './wire/evidence.js'
import type {
  AttemptBinding,
  AttemptIdentity,
  DispatchRefusalCode,
  JsonObject,
  ProviderBinding,
  V2Target
} from './wire/types.js'
import type { TrustedAttempt } from './integration/luvus-wire.js'
import { DEFAULT_RETENTION, retention } from './storage/config.js'
import type { Retention } from './storage/config.js'
import { exportSnapshot } from './storage/backup.js'
import { assertBudget } from './storage/budget.js'
import { auditRecord } from './storage/audit.js'
import { SCHEMA, SCHEMA_VERSION } from './storage/schema.js'
import { createPrivate, databasePath, privateFile, privatePath } from './storage/files.js'
import { fixedHerdrSource } from './connector/herdr/review.js'
import { reviewedHerdrRequest } from './connector/herdr/methods.js'

export { DEFAULT_RETENTION }
export type {
  Call,
  CallOptions,
  CallAdmissionOptions,
  CallAdmission,
  ManagementRequest,
  StoreOptions,
  ResultPage
} from './storage/model.js'
import type {
  Call,
  CallOptions,
  CallAdmissionOptions,
  CallAdmission,
  Machine,
  Metadata,
  Row,
  StoreOptions,
  LedgerInvalidation,
  ResultPage
} from './storage/model.js'
import { publicCall } from './storage/model.js'
import { ManagementLedger } from './storage/management.js'
import { DeviceLedger } from './storage/devices.js'
// 为本地账本实体生成带类别前缀的随机标识，避免顺序 ID 产生关联。
const id = (prefix: string) => `${prefix}_${randomUUID()}`

/** 批观察只交付同一可信时刻的最小锚点；单项失效不包含正文或广播、执行许可。 */
export type ResponseAnchorObservation = Readonly<{
  now: number
  entries: readonly (Readonly<{ available: true; anchor: ResponseAnchor }> | Readonly<{ available: false }>)[]
}>

export class Store {
  private db!: DatabaseSync
  private lock: number | undefined
  private closed = false
  private degraded = false
  private observed = 0
  private transactionTime?: number
  private invalidationListeners = new Set<(event: LedgerInvalidation) => void>()
  private pendingInvalidations: LedgerInvalidation[] = []
  // 注册有界的本进程回收监听器，关闭后的账本拒绝新增监听。
  subscribeInvalidation(listener: (event: LedgerInvalidation) => void): () => void {
    if (this.closed) {
      throw new GatewayError('storage_closed')
    }
    if (this.invalidationListeners.size >= 128) {
      throw new GatewayError('listener_limit')
    }
    this.invalidationListeners.add(listener)
    return /* 删除当前监听器，重复取消也不会触及其它宿主订阅。 */ () => {
      this.invalidationListeners.delete(listener)
    }
  }
  // 在成功提交后逐项通知宿主回收，监听器的同步异常不改变已持久化的事务结论。
  private publishInvalidations(events: LedgerInvalidation[]): void {
    for (const event of events) {
      for (const listener of this.invalidationListeners) {
        try {
          listener(event)
        } catch {
          /* 宿主回收失败不能把已提交账本改报失败。 */
        }
      }
    }
  }
  // 收集受影响调用的最小失效通知，延迟到本事务 COMMIT 后发布。
  private invalidateWhere(where: string, values: (string | number)[], kind: 'content' | 'fence'): void {
    if (!this.invalidationListeners.size) {
      return
    }
    const rows = this.db.prepare(`SELECT call_id,machine_id FROM calls WHERE ${where}`).all(...values)
    for (const row of rows) {
      this.pendingInvalidations.push({ kind, machine_id: String(row.machine_id), call_id: String(row.call_id) })
    }
  }
  private maintenance?: ReturnType<typeof setInterval>
  readonly administration: ManagementLedger
  private devices!: DeviceLedger
  readonly limits: Retention
  // 打开独占的私有 SQLite 账本，检查规范 schema、完整性与恢复状态并启动期限清理。
  // 重开时使原连接离线，未派发调用收敛为未派发、在途调用收敛为结果未知，不自动重放。
  constructor(
    private readonly path: string,
    private readonly now = Date.now,
    private readonly options: StoreOptions = {}
  ) {
    this.limits = retention(options.retention)
    const interval = options.maintenanceIntervalMs ?? 1000
    if (!Number.isSafeInteger(interval) || interval < 1 || interval > 60_000) {
      throw new GatewayError('invalid_maintenance_interval')
    }
    if (path !== ':memory:') {
      path = databasePath(path)
      this.path = path
      createPrivate(path + '.lock')
      this.lock = openSync(path + '.lock', 'r')
    }
    try {
      if (path !== ':memory:' && !existsSync(path)) {
        createPrivate(path)
      }
      this.db = new DatabaseSync(path)

      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
      if (tables.length) {
        const version = this.db.prepare('SELECT version FROM metadata').all() as {
          version: number
        }[]
        if (version.length !== 1 || version[0]!.version !== SCHEMA_VERSION) {
          throw new GatewayError('unsupported_database_version')
        }
      } else {
        this.db.exec('BEGIN IMMEDIATE')
        try {
          this.db.exec(SCHEMA)
          this.db
            .prepare("INSERT INTO metadata VALUES(1,?,?, 'active',?)")
            .run(SCHEMA_VERSION, id('recovery'), this.rawTime())
          this.db.exec('COMMIT')
        } catch (error) {
          this.db.exec('ROLLBACK')
          throw error
        }
      }
      this.db.exec(
        'PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;'
      )
      if (this.options.backupDirectory) {
        privatePath(join(this.options.backupDirectory, 'boundary'))
      }
      if (this.db.prepare('PRAGMA quick_check').get()!.quick_check !== 'ok') {
        throw new GatewayError('database_integrity_failed')
      }
      this.observed = this.meta().clock
      this.degraded = this.meta().mode === 'storage_degraded' || (path !== ':memory:' && existsSync(path + '.degraded'))
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db
          .exec(`UPDATE machines SET resource_revision=resource_revision+1,status='offline',epoch=NULL WHERE status='online';
          UPDATE calls SET state='not_dispatched' WHERE state='created';
          UPDATE calls SET state='outcome_unknown' WHERE state IN ('dispatching','connector_accepted');`)
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
      this.devices = new DeviceLedger({
        db: this.db,
        transaction: (fn, admission) => this.transaction(fn, admission),
        manage: (action, target, fence, now) => this.manage(action, target, fence, now),
        audit: (action, actor, now, row, extra) => this.audit(action, actor, now, row, extra),
        generation: () => this.generation(),
        stopWhere: (where, values, reason, now) => this.stopWhere(where, values, reason, now),
        invalidateWhere: (where, values, kind) => this.invalidateWhere(where, values, kind),
        invalidate: (event) => {
          this.pendingInvalidations.push(event)
        }
      })
      this.administration = new ManagementLedger(
        this.db,
        {
          // 所有管理元数据与业务写入复用同一 writer、时钟、预算和提交后通知。
          transaction: (run) => this.transaction(run),
          // 管理读取同样核对当前存储模式，隔离和降级不签发范围。
          guard: () => this.active(),
          // 代次来自同一业务元数据，不从管理员输入构造。
          generation: () => this.generation(),
          // 管理期限和保留使用可信 Store 高水位时钟。
          clock: () => this.clock(),
          // 复用既有设备注册原语，不生成第二套设备身份。
          register: (name, now) => this.devices.applyRegister(name, now),
          // 复用名称规范化和唯一约束，审计由管理事务归因到真实管理员。
          rename: (machine, name, now) => this.devices.applyRename(machine, name, now),
          // 精确 epoch 失效仍由既有账本收敛在途工作，不暗中重放。
          disconnect: (machine, epoch, now) => this.devices.applyDisconnect(machine, epoch, now),
          // 持久撤销清理沿用同一设备与调用账本。
          revoke: (machine, now) => this.devices.applyRevoke(machine, now),
          // 实例 fence 与原调用失效使用既有 provider 原语。
          provider: (machine, provider, revision, enabled, now) =>
            this.applyProvider(machine, provider, revision, enabled, now),
          // 管理回执关联的审计事件在同一事务落盘。
          audit: (action, actor, now, details, event) => this.audit(action, actor, now, undefined, details, event)
        },
        this.limits.metadata_ttl
      )
      this.maintenance = setInterval(
        /* 周期推进 deadline 与分层 TTL 清理；降级由具体错误路径处理，后台不输出业务原文。 */ () => {
          try {
            this.expire()
          } catch {
            /* 本轮维护失败后等待下次调度，不在后台打印内容或原始异常。 */
          }
        },
        interval
      )
      this.maintenance.unref()
    } catch (error) {
      this.db?.close()
      this.releaseLock()
      if (error instanceof GatewayError) {
        throw error
      }
      throw new GatewayError('database_open_failed')
    }
  }
  // 验证宿主时钟为非负安全整数，拒绝无效时间进入账本期限计算。
  private rawTime(): number {
    const value = this.now()
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new GatewayError('clock_untrusted')
    }
    return value
  }
  // 读取单例元数据中的恢复 generation、运行模式和已持久化时钟。
  private meta(): Metadata {
    return this.db.prepare('SELECT generation,mode,clock FROM metadata').get() as Metadata
  }
  // 取得当前账本恢复 generation，供连接及管理操作的 fence 核对。
  generation(): string {
    return this.meta().generation
  }
  // 要求账本可运行，并逐项核对设备在线状态、epoch 和恢复 generation。
  assertConnection(
    connection: { machine_id: string; recovery_generation: string; connection_epoch: string },
    lease?: string
  ): void {
    this.active()
    this.time()
    const row = this.db
      .prepare('SELECT status,epoch,credential_hash FROM machines WHERE machine_id=?')
      .get(connection.machine_id)
    if (
      connection.recovery_generation !== this.generation() ||
      row?.status !== 'online' ||
      row.epoch !== connection.connection_epoch ||
      (lease !== undefined && row.credential_hash !== lease)
    ) {
      throw new GatewayError('connection_unavailable')
    }
  }

  // 返回不含业务内容的运行模式与恢复 generation，供宿主判断隔离或降级状态。
  health() {
    return {
      mode:
        this.meta().mode === 'recovery_quarantined'
          ? 'recovery_quarantined'
          : this.degraded
            ? 'storage_degraded'
            : 'active',
      generation: this.generation()
    }
  }
  // 提供经过单调性核验的账本时钟，事务内保持同一时间锚点。
  clock(): number {
    return this.time()
  }
  // 固定事务时钟；事务外只与内存高水位比较（高水位随每次写事务持久化，启动时载入），读路径不写库。
  private time(): number {
    if (this.transactionTime !== undefined) {
      return this.transactionTime
    }
    const value = this.rawTime()
    if (value < this.observed) {
      this.markDegraded()
      throw new GatewayError('clock_untrusted')
    }
    this.observed = value
    return value
  }
  // 阻止关闭、恢复隔离或存储降级中的新业务准入。
  private active(): void {
    if (this.closed) {
      throw new GatewayError('storage_closed')
    }
    if (this.meta().mode === 'recovery_quarantined') {
      throw new GatewayError('recovery_quarantined')
    }
    if (this.degraded) {
      throw new GatewayError('storage_degraded')
    }
  }
  // 立即锁存内存降级，尽力写入持久化模式和文件哨兵；磁盘失败也不能重新准入副作用。
  private markDegraded(): void {
    this.degraded = true
    try {
      this.db.prepare("UPDATE metadata SET mode='storage_degraded' WHERE mode!='recovery_quarantined'").run()
    } catch {
      /* 原锚点保持原样。 */
    }
    if (this.path !== ':memory:') {
      try {
        createPrivate(this.path + '.degraded')
      } catch {
        /* 磁盘满时内存仍拒绝新副作用。 */
      }
    }
  }
  // 关闭并删除本实例持有的 writer 锁，允许正常退出后的新实例打开。
  private releaseLock(): void {
    if (this.lock !== undefined) {
      closeSync(this.lock)
      unlinkSync(this.path + '.lock')
      this.lock = undefined
    }
  }
  // 停止维护定时器，通知宿主销毁上下文，再关闭数据库并释放 writer 锁。
  close(): void {
    if (!this.closed) {
      if (this.maintenance) {
        clearInterval(this.maintenance)
      }
      this.closed = true
      this.publishInvalidations([{ kind: 'closed' }])
      this.invalidationListeners.clear()
      try {
        // 读路径只推进内存高水位；关闭时补写一次，使重开后的时钟回退仍可发现。
        this.db.prepare('UPDATE metadata SET clock=? WHERE clock<?').run(this.observed, this.observed)
      } catch {
        /* 降级或只读时跳过，下次写事务仍会持久高水位。 */
      }
      this.db.close()
      this.releaseLock()
    }
  }
  // 在单一 writer 事务内固定时钟和预算，成功提交才发布回收通知，存储失败锁存降级。
  private transaction<T>(fn: (now: number) => T, admission = true): T {
    if (this.transactionTime !== undefined) {
      throw new GatewayError('transaction_in_progress')
    }
    if (admission) {
      this.active()
    }
    const now = this.time()
    if (
      Object.entries(this.limits).some(
        // 检查各层期限相加仍在安全整数范围，防止时间溢出造成永久保留。
        ([key, value]) =>
          (key.endsWith('_ttl') || key === 'history_epoch_max_age') && !Number.isSafeInteger(now + value)
      )
    ) {
      throw new GatewayError('invalid_storage_limits')
    }
    try {
      this.db.exec('BEGIN IMMEDIATE')
    } catch {
      this.markDegraded()
      throw new GatewayError('storage_degraded')
    }
    this.transactionTime = now
    this.pendingInvalidations = []
    let committed = false
    try {
      const value = fn(now)
      this.db.prepare('UPDATE metadata SET clock=?').run(now)
      this.budget(admission)
      this.options.fault?.('before_commit')
      this.db.exec('COMMIT')
      committed = true
      return value
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* 不在错误中暴露 SQL/内容。 */
      }
      if (
        error instanceof GatewayError &&
        !['storage_exhausted', 'audit_quota', 'metadata_quota', 'security_quota'].includes(error.code)
      ) {
        throw error
      }
      if (error instanceof Error && /UNIQUE constraint|CHECK constraint|FOREIGN KEY constraint/.test(error.message)) {
        throw new GatewayError('constraint_conflict')
      }
      this.markDegraded()
      throw new GatewayError('storage_degraded')
    } finally {
      this.transactionTime = undefined
      const events = this.pendingInvalidations
      this.pendingInvalidations = []
      if (committed) {
        this.publishInvalidations(events)
      }
    }
  }
  // 结合逻辑子额、物理文件与备份检查预算，为准入保留在途完成空间。
  private budget(admission: boolean): void {
    assertBudget(this.db, this.path, this.limits, this.options.backupDirectory, admission)
  }
  // 按固定白名单构造脱敏审计记录，并与对应业务变化在同一事务写入。
  private audit(
    action: string,
    actor: string,
    now: number,
    row?: Row,
    extra: Record<string, unknown> = {},
    eventId = id('event')
  ): void {
    const record = auditRecord(eventId, action, actor, now, this.limits.metadata_ttl, this.generation(), row, extra)
    this.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?)').run(...Object.values(record))
  }
  // 核验受保护宿主的独立授权与一次性确认，绑定精确 fence 并写入审计。
  private manage(action: string, target: string, fence: string, now: number): void {
    const proof = this.options.management?.({ action, target, fence })
    if (!proof?.actor || !proof.confirmation_id) {
      throw new GatewayError('management_authorization_required')
    }
    if (this.db.prepare('SELECT 1 FROM management WHERE confirmation_id=?').get(proof.confirmation_id)) {
      throw new GatewayError('confirmation_replayed')
    }
    this.db
      .prepare('INSERT INTO management VALUES(?,?,?,?,?)')
      .run(proof.confirmation_id, proof.actor, action, target, fence)
    this.audit(action, proof.actor, now, undefined, {
      target,
      fence,
      confirmation_id: proof.confirmation_id
    })
  }
  // 以下设备生命周期入口委托给 DeviceLedger，保持 Store 的公开接口不变。
  register(name: string): Machine {
    return this.devices.register(name)
  }
  machine(machine_id: string): Machine {
    return this.devices.machine(machine_id)
  }
  credentialRevision(machine: string): number {
    return this.devices.credentialRevision(machine)
  }
  rename(machine: string, name: string): Machine {
    return this.devices.rename(machine, name)
  }
  issueEnrollment(machine: string, ttlMs = 600_000): string {
    return this.devices.issueEnrollment(machine, ttlMs)
  }
  issuePairingEnrollment(machine: string, pairingId: string, policyRef: string, ttlMs = 600_000): string {
    return this.devices.issuePairingEnrollment(machine, pairingId, policyRef, ttlMs)
  }
  redeem(token: string): { machine_id: string; credential: string } {
    return this.devices.redeem(token)
  }
  connect(machine: string, credential: string): string {
    return this.devices.connect(machine, credential)
  }
  resetDeviceEnrollment(machineId: string, recoveryGeneration: string, expectedEpoch: string | null): void {
    this.devices.resetDeviceEnrollment(machineId, recoveryGeneration, expectedEpoch)
  }
  denyDelivery(machine: string, credentialDigest: string): void {
    this.devices.denyDelivery(machine, credentialDigest)
  }
  disconnect(machine: string, epoch: string): void {
    this.devices.disconnect(machine, epoch)
  }
  revoke(machine: string): void {
    this.devices.revoke(machine)
  }
  // 为设备登记唯一且完整的 provider 绑定，拒绝覆盖既有身份。
  defineProvider(binding: ProviderBinding): ProviderBinding {
    validateProvider(binding)
    return this.transaction(
      /* 核对独立 provider 管理确认后插入唯一绑定，管理审计在同一事务提交。 */ (now) => {
        this.machine(binding.machine_id)
        if (this.provider(binding.machine_id, binding.provider_id)) {
          throw new GatewayError('provider_exists')
        }
        if (binding.binding_revision !== 1) {
          throw new GatewayError('invalid_initial_revision')
        }
        this.manage('providers_manage', binding.machine_id + '/' + binding.provider_id, 'new', now)
        this.db
          .prepare('INSERT INTO providers VALUES(?,?,?,?,?,?)')
          .run(binding.machine_id, binding.provider_id, binding.kind, binding.config_ref, 1, Number(binding.enabled))
        return { ...binding }
      }
    )
  }
  // 按设备和 provider 双重作用域查询绑定，避免同设备方法同名发生串用。
  provider(machine: string, provider: string): ProviderBinding | undefined {
    return this.storedProvider(machine, provider)
  }
  /** 复用原 provider SQL 与启用投影，私有批观察不调用宿主公开覆写。 */
  private storedProvider(machine: string, provider: string): ProviderBinding | undefined {
    const row = this.db.prepare('SELECT * FROM providers WHERE machine_id=? AND provider_id=?').get(machine, provider)
    return row ? ({ ...row, enabled: row.enabled === 1 } as ProviderBinding) : undefined
  }
  // 要求调用所属设备未撤销且 provider 仍启用，并保持原 binding revision。
  private current(
    row: Pick<Row, 'machine_id' | 'provider_id' | 'binding_revision' | 'provider_kind'>,
    stored = false
  ): void {
    if ((stored ? this.devices.storedMachine(row.machine_id) : this.machine(row.machine_id)).status === 'revoked') {
      throw new GatewayError('call_not_found')
    }
    const provider = stored
      ? this.storedProvider(row.machine_id, row.provider_id)
      : this.provider(row.machine_id, row.provider_id)
    if (!provider?.enabled) {
      throw new GatewayError('provider_disabled')
    }
    if (provider.binding_revision !== row.binding_revision || provider.kind !== row.provider_kind) {
      throw new GatewayError('provider_binding_mismatch')
    }
  }
  // 以预期 revision 修改 provider 状态并推进 fence，使旧尝试不可继续使用。
  setProviderEnabled(machine: string, providerId: string, revision: number, enabled: boolean): ProviderBinding {
    return this.transaction(
      // 原入口保留其受保护宿主确认；共享管理服务另在同一 writer 事务消费持久确认。
      (now) => {
        const current = this.provider(machine, providerId)
        if (!current || current.binding_revision !== revision) {
          throw new GatewayError('provider_binding_mismatch')
        }
        this.manage('providers_manage', machine + '/' + providerId, String(revision), now)
        const result = this.applyProvider(machine, providerId, revision, enabled, now)
        return result
      }
    )
  }
  // 同一事务内使用的生命周期原语，调用者必须先完成独立管理授权与 fence 核对。
  private applyProvider(
    machine: string,
    providerId: string,
    revision: number,
    enabled: boolean,
    now: number
  ): ProviderBinding {
    const provider = this.provider(machine, providerId)
    if (!provider || provider.binding_revision !== revision) {
      throw new GatewayError('provider_binding_mismatch')
    }
    this.db
      .prepare(
        'UPDATE providers SET enabled=?,binding_revision=binding_revision+1 WHERE machine_id=? AND provider_id=?'
      )
      .run(Number(enabled), machine, providerId)
    this.stopWhere('machine_id=? AND provider_id=?', [machine, providerId], 'provider_changed', now)
    this.invalidateWhere('machine_id=? AND provider_id=?', [machine, providerId], 'fence')
    return this.provider(machine, providerId)!
  }
  // 将匹配的未完成调用改为未派发或结果未知，保留最小锚点用于可靠对账。
  private stopWhere(where: string, values: string[], reason: string, now: number): void {
    const rows = this.db
      .prepare(`SELECT * FROM calls WHERE ${where} AND state IN ('created','dispatching','connector_accepted')`)
      .all(...values) as Row[]
    for (const row of rows) {
      this.db
        .prepare('UPDATE calls SET state=? WHERE call_id=?')
        .run(row.state === 'created' ? 'not_dispatched' : 'outcome_unknown', row.call_id)
      this.audit(reason, 'system', now, this.row(row.call_id))
    }
  }
  // 在 principal、provider、revision 和恢复 generation 范围内建立固定期限的去重历史。
  openHistory(principal: string, target: V2Target, revision: number, retire?: string): HistoryScope {
    validateTarget(target)
    validateId(principal)
    return this.transaction(
      /* 退休指定旧 scope 后建立新的有界 history epoch，冻结其去重期限。 */ (now) => {
        const provider = this.provider(target.machine_id, target.provider_id)
        if (!provider?.enabled || provider.binding_revision !== revision) {
          throw new GatewayError('provider_binding_mismatch')
        }
        if (retire) {
          const changed = this.db
            .prepare(
              "UPDATE history SET status='retired' WHERE history_epoch=? AND principal=? AND machine_id=? AND provider_id=? AND binding_revision=? AND recovery_generation=?"
            )
            .run(retire, principal, target.machine_id, target.provider_id, revision, this.generation())
          if (changed.changes !== 1) {
            throw new GatewayError('dedup_history_unavailable')
          }
        }
        const scope: HistoryScope = {
          history_epoch: id('history'),
          recovery_generation: this.generation(),
          status: 'active',
          scope_created_at: now,
          accept_new_until: now + this.limits.history_epoch_max_age,
          frozen_dedup_ttl: this.limits.metadata_ttl
        }
        this.db
          .prepare('INSERT INTO history VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(
            scope.history_epoch,
            scope.recovery_generation,
            principal,
            target.machine_id,
            target.provider_id,
            revision,
            scope.status,
            now,
            scope.accept_new_until,
            scope.frozen_dedup_ttl
          )
        this.audit('history_opened', principal, now, undefined, {
          machine_id: target.machine_id,
          provider_id: target.provider_id,
          binding_revision: revision,
          history_epoch: scope.history_epoch,
          retired: retire ?? null
        })
        return scope
      }
    )
  }
  // 查询调用内部账本行，缺失时返回固定错误而不暴露 SQL 细节。
  private row(callId: string): Row {
    const row = this.db.prepare('SELECT * FROM calls WHERE call_id=?').get(callId) as Row | undefined
    if (!row) {
      throw new GatewayError('call_not_found')
    }
    return row
  }
  // 核对调用归属、元数据期限及恢复隔离状态，再允许访问内部账本。
  private owned(principal: string, callId: string, now = this.time()): Row {
    if (this.meta().mode === 'recovery_quarantined') {
      throw new GatewayError('recovery_quarantined')
    }
    const row = this.row(callId)
    if (row.principal !== principal || row.metadata_expires <= now) {
      throw new GatewayError('call_not_found')
    }
    this.current(row)
    return row
  }
  // 返回当前 principal 的公开调用投影，降级时保守呈现尚未确定的执行结论。
  call(principal: string, callId: string): Call {
    const now = this.time()
    const result = publicCall(this.owned(principal, callId, now), now)
    if (this.degraded && ['dispatching', 'connector_accepted'].includes(result.state)) {
      result.state = 'outcome_unknown'
    }
    return result
  }
  // 保留内部相对 timeout 调用路径；与绝对准入共用同一 writer 登记，返回原有 Call 视图。
  createCall(
    principal: string,
    target: V2Target,
    request: NativeRequest,
    options: CallOptions,
    authorize?: () => void
  ): Call {
    return this.registerCall(principal, target, request, options, { timeoutMs: options.timeoutMs ?? 30_000 }, authorize)
      .call
  }
  // 原子登记绝对 deadline 并返回首次登记标志；同步 authorize 只供可信 Router 复验，不能来自请求参数。
  admitCall(
    principal: string,
    target: V2Target,
    request: NativeRequest,
    options: CallAdmissionOptions,
    authorize?: () => void,
    preflight?: (request: JsonObject) => void
  ): CallAdmission {
    if (options.timeoutMs !== undefined) {
      throw new GatewayError('invalid_deadline')
    }
    return this.registerCall(principal, target, request, options, { deadline: options.deadline }, authorize, preflight)
  }
  // 快照完整意图，在唯一 writer 事务中决定新旧；不提供查询后创建、派发或通用 SQL 回调入口。
  private registerCall(
    principal: string,
    targetValue: V2Target,
    requestValue: NativeRequest,
    supplied: CallOptions,
    timing: { timeoutMs: number } | { deadline: number },
    authorize?: () => void,
    preflight?: (request: JsonObject) => void
  ): CallAdmission {
    validateTarget(targetValue)
    validateRequest(requestValue)
    if ('timeoutMs' in timing) {
      if (!Number.isSafeInteger(timing.timeoutMs) || timing.timeoutMs <= 0 || timing.timeoutMs > 600_000) {
        throw new GatewayError('invalid_timeout')
      }
    } else if (!Number.isSafeInteger(timing.deadline) || timing.deadline <= 0) {
      throw new GatewayError('invalid_deadline')
    }
    if (authorize !== undefined && typeof authorize !== 'function') {
      throw new GatewayError('synchronous_authorization_required')
    }
    if (preflight !== undefined && typeof preflight !== 'function') {
      throw new GatewayError('synchronous_native_preflight_required')
    }
    const { target, request } = JSON.parse(canonical({ target: targetValue, request: requestValue })) as {
      target: V2Target
      request: NativeRequest
    }
    const options: CallOptions = {
      binding_revision: supplied.binding_revision,
      contract_ref: supplied.contract_ref,
      caller_policy_revision: supplied.caller_policy_revision,
      local_policy_revision: supplied.local_policy_revision,
      ...(supplied.validation === undefined ? {} : { validation: supplied.validation }),
      ...(supplied.history === undefined ? {} : { history: JSON.parse(canonical(supplied.history)) })
    }
    return this.transaction(
      /* 在同一 writer 事务复验授权、查询去重并登记；预算和审计提交后才返回 created 判定。 */ (now) => {
        const authorized: unknown = authorize?.()
        if (authorized !== undefined) {
          if (authorized instanceof Promise) {
            void authorized.catch(/* 观察违规异步授权的拒绝；准入仍同步失败，不把后续结果当作许可。 */ () => {})
          }
          throw new GatewayError('synchronous_authorization_required')
        }
        const provider = this.provider(target.machine_id, target.provider_id)
        if (!provider || !provider.enabled || provider.binding_revision !== options.binding_revision) {
          throw new GatewayError('provider_binding_mismatch')
        }
        // Herdr 在此只登记已评审 RPC 意图；实际发送前仍须完整安装 schema 和当前权限检查。
        if (
          provider.kind === 'herdr' &&
          (target.profile !== 'session' ||
            (options.validation ?? 'strict') !== 'strict' ||
            options.contract_ref !== contractRef(fixedHerdrSource()) ||
            !reviewedHerdrRequest(request))
        ) {
          throw new GatewayError('provider_support_candidate')
        }
        const identity: AttemptIdentity = {
          call_id: id('call'),
          attempt_id: id('attempt'),
          native_request_id: id('native'),
          target,
          provider_kind: provider.kind,
          binding_revision: provider.binding_revision,
          contract_ref: options.contract_ref,
          registration: {
            deadline: 'deadline' in timing ? timing.deadline : now + timing.timeoutMs,
            history: options.history ?? null,
            caller_policy_revision: options.caller_policy_revision,
            local_policy_revision: options.local_policy_revision
          }
        }
        validateAttempt(identity)
        let hash = registeredRequestDigest(
          {
            attempt: identity,
            expected_binding_revision: provider.binding_revision,
            native_request: request,
            validation: options.validation ?? 'strict'
          },
          principal
        )
        let dedupExpires = now + this.limits.metadata_ttl
        if (options.history) {
          const scope = this.db
            .prepare(
              'SELECT * FROM history WHERE history_epoch=? AND principal=? AND machine_id=? AND provider_id=? AND binding_revision=?'
            )
            .get(
              options.history.history_epoch,
              principal,
              target.machine_id,
              target.provider_id,
              provider.binding_revision
            ) as HistoryScope | undefined
          const old = this.db
            .prepare('SELECT * FROM calls WHERE history_epoch=? AND key_digest=?')
            .get(options.history.history_epoch, digest(options.history.client_request_key)) as Row | undefined
          if (old) {
            // deadline 是初次登记的绝对值，重送不能以当前时刻刷新；其余条件仍逐项摘要核对。
            const prior = JSON.parse(old.identity_json) as AttemptIdentity
            if ('timeoutMs' in timing) {
              identity.registration.deadline = prior.registration.deadline
            }
            hash = registeredRequestDigest(
              {
                attempt: identity,
                expected_binding_revision: provider.binding_revision,
                native_request: request,
                validation: options.validation ?? 'strict'
              },
              principal
            )
            if ('timeoutMs' in timing && prior.registration.deadline - old.created !== timing.timeoutMs) {
              throw new GatewayError('request_key_conflict')
            }
          }
          const record: HistoryRecord | undefined = old
            ? {
                history_epoch: old.history_epoch!,
                recovery_generation:
                  JSON.parse(old.binding_json ?? '{}').recovery_generation ?? scope?.recovery_generation,
                key_digest: old.key_digest!,
                request_digest: old.request_hash,
                call_id: old.call_id,
                call_created_at: old.created,
                dedup_expires_at: old.dedup_expires
              }
            : undefined
          const decision = planHistoryAdmission(options.history, this.generation(), hash, scope, record, now)
          if (decision.action === 'return_existing') {
            return { call: publicCall(this.owned(principal, decision.call_id, now), now), created: false }
          }
          dedupExpires = decision.dedup_expires_at
        }
        // 有效墓碑命中只返回旧意图；只有首次登记才要求绝对截止时间仍在未来且不超过十分钟。
        if ('deadline' in timing) {
          if (timing.deadline <= now) {
            throw new GatewayError('deadline_exceeded')
          }
          if (timing.deadline - now > 600_000) {
            throw new GatewayError('invalid_deadline')
          }
        }
        if (this.machine(target.machine_id).status !== 'online') {
          throw new GatewayError('machine_offline')
        }
        // 首次登记在唯一 writer 中使用实际原生 ID 验证完整根；失败回滚，不生成 call 或派发锚点。
        const checked: unknown = preflight?.(JSON.parse(canonical({ ...request, id: identity.native_request_id })))
        if (checked !== undefined) {
          if (checked instanceof Promise) {
            void checked.catch(/* 消费违反同步契约的晚到拒绝，不能在回调完成前登记。 */ () => {})
          }
          throw new GatewayError('synchronous_native_preflight_required')
        }
        this.db
          .prepare(`INSERT INTO calls(call_id,principal,machine_id,provider_id,binding_revision,provider_kind,
        request_hash,key_digest,history_epoch,state,identity_json,target_json,method,mode,request_json,
        created,deadline,content_expires,metadata_expires,dedup_expires,content_status)
        VALUES(?,?,?,?,?,?,?,?,?,'created',?,?,?,?,?,?,?,?,?,?,'available')`)
          .run(
            identity.call_id,
            principal,
            target.machine_id,
            target.provider_id,
            provider.binding_revision,
            provider.kind,
            hash,
            options.history ? digest(options.history.client_request_key) : null,
            options.history?.history_epoch ?? null,
            boundedJson(identity),
            boundedJson(target),
            request.method,
            options.validation ?? 'strict',
            canonical(request),
            now,
            identity.registration.deadline,
            now + this.limits.result_ttl,
            Math.max(now + this.limits.metadata_ttl, dedupExpires),
            dedupExpires
          )
        const row = this.row(identity.call_id)
        this.audit('created', principal, now, row)
        return { call: publicCall(row, now), created: true }
      }
    )
  }
  // 核对当前连接、期限及可选的宿主策略 revision，提交完整 attempt 锚点与完成预留后才允许发送。
  // 返回绑定只证明账本派发锚点已持久化，真实原生执行许可仍由适配器独立校验。
  dispatch(
    principal: string,
    callId: string,
    epoch: string,
    policies?: { caller: string; local: string }
  ): AttemptBinding {
    const binding = this.transaction(
      /* 核对调用状态、连接与可选策略 revision，写入一次性完整 attempt 绑定及完成空间预留。 */ (now) => {
        const row = this.owned(principal, callId, now)
        const machine = this.db.prepare('SELECT status,epoch FROM machines WHERE machine_id=?').get(row.machine_id)!
        if (
          row.state !== 'created' ||
          row.deadline <= now ||
          row.content_expires <= now ||
          machine.status !== 'online' ||
          machine.epoch !== epoch
        ) {
          throw new GatewayError('dispatch_rejected')
        }
        const registered = JSON.parse(row.identity_json) as AttemptIdentity
        if (
          policies &&
          (registered.registration.caller_policy_revision !== policies.caller ||
            registered.registration.local_policy_revision !== policies.local)
        ) {
          throw new GatewayError('policy_revision_mismatch')
        }
        const binding: AttemptBinding = {
          ...registered,
          machine_id: row.machine_id,
          recovery_generation: this.generation(),
          connection_epoch: epoch
        }
        this.db
          .prepare(
            "UPDATE calls SET state='dispatching',epoch=?,attempt_id=?,binding_json=?,reserved=? WHERE call_id=?"
          )
          .run(epoch, binding.attempt_id, boundedJson(binding), this.limits.attempt_reserve_bytes, callId)
        this.audit('dispatching', principal, now, this.row(callId))
        return binding
      }
    )
    try {
      this.options.fault?.('after_anchor')
    } catch {
      this.markDegraded()
      throw new GatewayError('storage_degraded')
    }
    return binding
  }
  // 从仍有原文且未过期的账本行投影 RPC 请求记录；缺少原文返回 undefined，失效绑定或连接拒绝。
  // 该记录不含密封响应句柄，不能从持久化摘要恢复已回收的原生上下文。
  attempt(callId: string, attemptId: string): TrustedAttempt | undefined {
    this.active()
    const now = this.time()
    const row = this.row(callId)
    if (
      row.attempt_id !== attemptId ||
      !row.binding_json ||
      !row.request_json ||
      now >= row.content_expires ||
      now >= row.metadata_expires
    ) {
      return undefined
    }
    this.current(row)
    this.assertConnection(JSON.parse(row.binding_json))
    return {
      binding: JSON.parse(row.binding_json),
      principal_id: row.principal,
      method: row.method,
      mode: row.mode,
      native_request: JSON.parse(row.request_json)
    }
  }
  /** 共用原单项锚点的完整绑定、当前 provider、generation 和在线 epoch 校验，不采样新时间。 */
  private responseAnchorRow(binding: AttemptBinding, stored = false): Row {
    this.active()
    const row = this.row(binding.call_id)
    this.current(row, stored)
    if (!row.binding_json) {
      throw new GatewayError('attempt_anchor_unavailable')
    }
    assertBinding(binding, JSON.parse(row.binding_json))
    if (binding.recovery_generation !== (stored ? this.meta().generation : this.generation())) {
      throw new GatewayError('attempt_binding_mismatch')
    }
    const machine = this.db.prepare('SELECT status,epoch FROM machines WHERE machine_id=?').get(row.machine_id)!
    if (machine.status !== 'online' || machine.epoch !== binding.connection_epoch) {
      throw new GatewayError('stale_response')
    }
    return row
  }
  /** 仅投影最小锚点与原固定期限，绝不把请求、响应正文或内部行引用交给调用方。 */
  private responseAnchorAt(row: Row, now: number): ResponseAnchor {
    const call = publicCall(row, now)
    return {
      binding: JSON.parse(row.binding_json!),
      method: row.method,
      mode: row.mode,
      state: call.state === 'created' ? 'not_dispatched' : call.state,
      content_status: call.content_status,
      content_expires_at: row.content_expires,
      dedup_expires_at: row.dedup_expires,
      ...(row.response_hash
        ? { evidence: { response_hash: row.response_hash, response_bytes: row.response_bytes! } }
        : {})
    }
  }
  // 核对完整绑定、当前 provider 和在线连接后读取最小响应锚点，保留原 deadline、内容及去重期限。
  // 内容清理后仍可返回摘要与状态，但不返回请求正文，也不从这些元数据恢复密封响应能力。
  responseAnchor(binding: AttemptBinding): ResponseAnchor {
    const row = this.responseAnchorRow(binding)
    return this.responseAnchorAt(row, this.time())
  }
  /** 有界纯数据批观察：核对并按需持久可信时钟，再于私有只读事务读取；不运行宿主闭包、预算或写入通知。 */
  responseAnchors(bindings: readonly AttemptBinding[]): ResponseAnchorObservation {
    if (this.transactionTime !== undefined) {
      throw new GatewayError('transaction_in_progress')
    }
    if (!Array.isArray(bindings) || bindings.length > LIMITS.dedup_entries) {
      throw new GatewayError('invalid_response_anchor_batch')
    }
    const snapshot: AttemptBinding[] = []
    const descriptors = Object.getOwnPropertyDescriptors(bindings)
    let bytes = 0
    for (let index = 0; index < bindings.length; index++) {
      const descriptor = descriptors[String(index)]
      if (!descriptor || !('value' in descriptor)) {
        throw new GatewayError('invalid_response_anchor_batch')
      }
      const raw = boundedJson(descriptor.value)
      bytes += Buffer.byteLength(raw)
      // 每项仍受原 JSON 预算限制；整批只复用受保护进程缓冲上限，不放宽 Wire 单帧或对象限制。
      if (bytes > LIMITS.buffered_bytes) {
        throw new GatewayError('invalid_response_anchor_batch')
      }
      const binding = JSON.parse(raw) as AttemptBinding
      assertBinding(binding, binding)
      snapshot.push(binding)
    }
    let begun = false
    try {
      this.active()
      const now = this.time()
      this.db.exec('BEGIN')
      begun = true
      const entries: ResponseAnchorObservation['entries'][number][] = []
      for (const binding of snapshot) {
        try {
          entries.push({ available: true, anchor: this.responseAnchorAt(this.responseAnchorRow(binding, true), now) })
        } catch (error) {
          if (
            error instanceof GatewayError &&
            [
              'call_not_found',
              'machine_not_found',
              'provider_disabled',
              'provider_binding_mismatch',
              'attempt_anchor_unavailable',
              'attempt_binding_mismatch',
              'stale_response'
            ].includes(error.code)
          ) {
            entries.push({ available: false })
          } else {
            throw error
          }
        }
      }
      this.db.exec('COMMIT')
      begun = false
      return { now, entries }
    } catch (error) {
      if (begun) {
        try {
          this.db.exec('ROLLBACK')
        } catch {
          /* 回滚失败不交付部分观察，整个 Store 继续按降级拒绝。 */
        }
      }
      if (
        error instanceof GatewayError &&
        ['storage_closed', 'recovery_quarantined', 'storage_degraded'].includes(error.code)
      ) {
        throw error
      }
      this.markDegraded()
      throw new GatewayError(
        error instanceof GatewayError && error.code === 'clock_untrusted' ? error.code : 'storage_degraded'
      )
    }
  }
  // 仅在原 attempt 尚未过期且处于派发中时记录连接器接受，不把接受视为执行成功。
  accepted(binding: AttemptBinding): void {
    this.transaction(
      /* 核对尚未过期的 dispatching 锚点后写入接受状态及审计。 */ (now) => {
        const anchor = this.responseAnchor(binding)
        if (anchor.state !== 'dispatching' || now >= binding.registration.deadline) {
          throw new GatewayError('stale_acceptance')
        }
        this.db.prepare("UPDATE calls SET state='connector_accepted' WHERE call_id=?").run(binding.call_id)
        this.audit('connector_accepted', 'connector', now, this.row(binding.call_id))
      },
      false
    )
  }
  /** 仅由已认证 Wire 拒绝路径调用；原子提交确定未写出，未知或既有终态绝不倒退。 */
  commitDispatchRefusal(binding: AttemptBinding, code: DispatchRefusalCode): boolean {
    if (code !== 'terminal_execution_disabled') {
      throw new GatewayError('invalid_dispatch_refusal')
    }
    return this.transaction(
      /** 先落实原固定 deadline，再核对当前完整锚点；审计提交前不发布拒绝。 */ (now) => {
        this.stopWhere('call_id=? AND deadline<=?', [binding.call_id, String(now)], 'deadline_exceeded', now)
        const row = this.responseAnchorRow(binding)
        if (!['dispatching', 'connector_accepted'].includes(row.state)) {
          return false
        }
        this.db.prepare("UPDATE calls SET state='not_dispatched',reserved=0 WHERE call_id=?").run(binding.call_id)
        this.audit('dispatch_refused', 'connector', now, this.row(binding.call_id), { code })
        return true
      },
      false
    )
  }
  // 在同一 writer 事务内调用宿主闭包中的真实 adapter.planEvidence，再原子提交响应证据与审计。
  // 持久化锚点不能替代适配器仍有效的原生上下文，不接收序列化 EvidencePlan 作为校验证明。
  commitEvidence(binding: AttemptBinding, planner: () => ResponseEvidencePlan): Call {
    const outcome = this.transaction(
      /* 先落实截止期限，再执行真实证据规划；可信冲突仅追加有界脱敏审计。 */ (now) => {
        this.stopWhere('call_id=? AND deadline<=?', [binding.call_id, String(now)], 'deadline_exceeded', now)
        const anchor = this.responseAnchor(binding)
        try {
          return this.applyEvidence(binding, anchor, planner(), now)
        } catch (error) {
          // Wire planner 仅在原生 schema/来源/完整锚点已验证后报告可信内容冲突。
          if (!(error instanceof GatewayError) || error.code !== 'response_evidence_conflict' || !anchor.evidence) {
            throw error
          }
          const eventId = 'response_conflict_' + binding.call_id
          if (!this.db.prepare('SELECT 1 FROM audit WHERE event_id=?').get(eventId)) {
            this.audit(
              'response_conflict',
              'connector',
              now,
              this.row(binding.call_id),
              {
                code: 'response_evidence_conflict',
                expected_response_hash: anchor.evidence.response_hash
              },
              eventId
            )
          }
          // 每个调用在审计保留窗内最多一条；不保存冲突 payload，也不改写原结果。
          return { conflict: true } as const
        }
      },
      false
    )
    if ('conflict' in outcome) {
      // 只有审计事务已提交，才返回通常的冲突拒绝；失败由 transaction 返回降级错误。
      throw new GatewayError('response_evidence_conflict')
    }
    return outcome
  }
  // 核对证据绑定、固定期限和原文摘要；重复证据幂等，冲突拒绝，新证据完成后释放完成预留。
  // 内容已过期、删除或预算不足时只持久化摘要与结果状态，不复活原文或延长保留期限。
  private applyEvidence(
    binding: AttemptBinding,
    anchor: ResponseAnchor,
    plan: ResponseEvidencePlan,
    now: number
  ): Call {
    assertBinding(plan.evidence.binding, anchor.binding)
    if (
      plan.evidence.received_at !== now ||
      plan.content.expires_at !== anchor.content_expires_at ||
      plan.dispatch !== false
    ) {
      throw new GatewayError('invalid_evidence_plan')
    }
    const row = this.row(binding.call_id)
    if (plan.action === 'duplicate') {
      if (
        !anchor.evidence ||
        anchor.evidence.response_hash !== plan.evidence.response_hash ||
        anchor.evidence.response_bytes !== plan.evidence.response_bytes
      ) {
        throw new GatewayError('response_evidence_conflict')
      }
      return publicCall(row, now)
    }
    if (row.response_hash || !['dispatching', 'connector_accepted', 'outcome_unknown'].includes(row.state)) {
      throw new GatewayError('response_evidence_conflict')
    }
    let response: string | null = null
    let contentStatus = publicCall(row, now).content_status
    if (
      plan.content.delivery === 'payload' &&
      contentStatus === 'available' &&
      now < row.content_expires &&
      plan.content.native_response
    ) {
      const text = boundedJson(plan.content.native_response, 33_554_432)
      if (digest(text) !== plan.evidence.response_hash || Buffer.byteLength(text) !== plan.evidence.response_bytes) {
        throw new GatewayError('invalid_evidence_plan')
      }
      const used = Number(
        this.db
          .prepare(
            'SELECT COALESCE(SUM(COALESCE(length(CAST(request_json AS BLOB)),0)+COALESCE(length(CAST(response AS BLOB)),0)),0) n FROM calls'
          )
          .get()!.n
      )
      if (used + Buffer.byteLength(text) <= this.limits.content_bytes) {
        response = text
      }
    }
    if (!response && contentStatus === 'available') {
      contentStatus = 'unavailable'
    }
    this.db
      .prepare(
        "UPDATE calls SET state='responded',response=?,response_hash=?,response_bytes=?,response_category=?,content_status=?,reserved=0 WHERE call_id=?"
      )
      .run(
        response,
        plan.evidence.response_hash,
        plan.evidence.response_bytes,
        plan.evidence.category,
        contentStatus,
        binding.call_id
      )
    this.audit(plan.late_evidence ? 'late_evidence' : 'responded', 'connector', now, this.row(binding.call_id), {
      response_hash: plan.evidence.response_hash,
      category: plan.evidence.category
    })
    this.options.fault?.('evidence_commit')
    return publicCall(this.row(binding.call_id), now)
  }
  // 停止本 principal 的调用并保留未知结果锚点，不能据此声称远端副作用已取消。
  stop(principal: string, callId: string): Call {
    return this.transaction(
      /* 核验调用归属后停止未完成调用，返回保留原期限的公开状态。 */ (now) => {
        this.owned(principal, callId, now)
        this.stopWhere('call_id=?', [callId], 'cancelled', now)
        return publicCall(this.row(callId), now)
      },
      false
    )
  }
  // 按分层期限清除内容、结果句柄、历史与审计，提交后发布内容压缩或 fence 回收通知。
  // 原生仅响应上下文由宿主从存活许可封存；SQLite 只保留摘要锚点，不能在重启后重建该能力。
  expire(): void {
    this.transaction(
      /* 删除各层过期对象并排队发布内容或 fence 通知，回滚时不通知宿主。 */ (now) => {
        this.stopWhere('deadline<=?', [String(now)], 'deadline_exceeded', now)
        this.invalidateWhere(
          "content_expires<=? AND (content_status='available' OR request_json IS NOT NULL OR response IS NOT NULL)",
          [now],
          'content'
        )
        this.invalidateWhere('dedup_expires<=?', [now], 'fence')
        this.db
          .prepare(
            "DELETE FROM results WHERE expires<=? OR call_id IN (SELECT call_id FROM calls WHERE content_expires<=? OR content_status!='available')"
          )
          .run(now, now)
        this.db
          .prepare(
            "UPDATE calls SET response=NULL,request_json=NULL,content_status=CASE WHEN content_status='available' THEN 'expired' ELSE content_status END WHERE content_expires<=?"
          )
          .run(now)
        this.db.prepare('DELETE FROM calls WHERE metadata_expires<=? AND dedup_expires<=?').run(now, now)
        this.db.prepare("UPDATE history SET status='retired' WHERE accept_new_until<=?").run(now)
        this.db
          .prepare(
            'DELETE FROM history WHERE accept_new_until+frozen_dedup_ttl<=? AND NOT EXISTS(SELECT 1 FROM calls WHERE calls.history_epoch=history.history_epoch)'
          )
          .run(now)
        this.administration.expire(now)
        this.db.prepare('DELETE FROM audit WHERE expires<=?').run(now)
        this.db.prepare('DELETE FROM enrollments WHERE expires<=?').run(now)
        for (const row of this.db.prepare('SELECT path FROM backups WHERE expires<=?').all(now)) {
          const path = String(row.path)
          if (dirname(path) !== this.options.backupDirectory) {
            throw new GatewayError('unsafe_backup_path')
          }
          if (existsSync(path + '.lock')) {
            continue
          }
          if (existsSync(path)) {
            privateFile(path)
            unlinkSync(path)
          }
          this.db.prepare('DELETE FROM backups WHERE path=?').run(path)
        }
      },
      false
    )
  }
  // 按当前归属、内容和期限读取已有句柄元数据，不进入签发事务，不续期或创建句柄。
  findResult(
    principal: string,
    callId: string
  ): Pick<ResultPage, 'result_id' | 'bytes' | 'hash' | 'expires'> | undefined {
    if (this.transactionTime !== undefined) {
      throw new GatewayError('transaction_in_progress')
    }
    this.active()
    const call = this.call(principal, callId)
    if (call.state !== 'responded' || call.content_status !== 'available' || !call.response) {
      throw new GatewayError('result_not_ready')
    }
    return this.db
      .prepare('SELECT result_id,bytes,hash,expires FROM results WHERE call_id=? AND expires>?')
      .get(callId, this.time()) as Pick<ResultPage, 'result_id' | 'bytes' | 'hash' | 'expires'> | undefined
  }
  // 只为已提交且当前可见的响应创建有界结果句柄，拒绝过期、删除或超配额内容。
  saveResult(principal: string, callId: string, quotaBytes = this.limits.content_bytes) {
    if (!Number.isSafeInteger(quotaBytes) || quotaBytes <= 0 || quotaBytes > this.limits.content_bytes) {
      throw new GatewayError('invalid_result_limits')
    }
    return this.transaction(
      /* 核对响应可见性及句柄子额，写入与原内容同期限的结果句柄。 */ (now) => {
        const row = this.owned(principal, callId, now)
        if (
          row.state !== 'responded' ||
          !row.response ||
          row.content_status !== 'available' ||
          row.content_expires <= now
        ) {
          throw new GatewayError('result_not_ready')
        }
        this.db.prepare('DELETE FROM results WHERE expires<=?').run(now)
        const existing = this.db.prepare('SELECT * FROM results WHERE call_id=?').get(callId)
        if (existing) {
          const { call_id: _call, ...result } = existing
          return result as { result_id: string; bytes: number; hash: string; expires: number }
        }
        const used = Number(this.db.prepare('SELECT COALESCE(SUM(bytes),0) n FROM results').get()!.n)
        const bytes = Buffer.byteLength(row.response)
        if (used + bytes > quotaBytes) {
          throw new GatewayError('result_quota')
        }
        const result = {
          result_id: id('result'),
          bytes,
          hash: row.response_hash!,
          expires: row.content_expires
        }
        this.db
          .prepare('INSERT INTO results VALUES(?,?,?,?,?)')
          .run(result.result_id, callId, result.bytes, result.hash, result.expires)
        this.audit('result_handle', principal, now, row)
        return result
      }
    )
  }
  // 原子删除调用的请求、响应与结果句柄，提交后通知宿主释放执行上下文或封存仅响应上下文。
  // 账本保留既有状态和摘要供后续证据核对，不保存封存句柄，也不恢复内容读取权。
  discardResponse(principal: string, callId: string): void {
    this.transaction(
      /* 删除结果句柄并清空请求响应正文，排队发布不可回滚的提交后回收通知。 */ (now) => {
        const row = this.owned(principal, callId, now)
        this.db.prepare('DELETE FROM results WHERE call_id=?').run(callId)
        this.db
          .prepare("UPDATE calls SET response=NULL,request_json=NULL,content_status='discarded' WHERE call_id=?")
          .run(callId)
        this.audit('discard_response', principal, now, row)
        this.pendingInvalidations.push({ kind: 'content', machine_id: row.machine_id, call_id: callId })
      },
      false
    )
  }
  // 核对结果句柄归属及期限，并要求调用内容仍可见。
  resultCall(principal: string, resultId: string): Call {
    const now = this.time()
    const row = this.db.prepare('SELECT call_id FROM results WHERE result_id=? AND expires>?').get(resultId, now) as
      | { call_id: string }
      | undefined
    if (!row) {
      throw new GatewayError('result_not_found')
    }
    const call = this.call(principal, row.call_id)
    if (call.content_status !== 'available' || !call.response) {
      throw new GatewayError('result_not_found')
    }
    return call
  }
  // 共用原归属、参数及末次句柄查询，返回仅供本次同步操作使用的读取事实，不构造正文页。
  private resultRead(principal: string, resultId: string, cursor: number, maxBytes: number) {
    const call = this.resultCall(principal, resultId)
    if (
      !Number.isSafeInteger(cursor) ||
      cursor < 0 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes <= 0 ||
      maxBytes > 65_536
    ) {
      throw new GatewayError('invalid_result_cursor')
    }
    const row = this.db
      .prepare('SELECT bytes,hash,expires FROM results WHERE result_id=? AND expires>?')
      .get(resultId, this.time()) as { bytes: number; hash: string; expires: number } | undefined
    // 授权读取与此处查询之间可能已提交清理；按实际句柄是否仍存在及未到期拒绝，不以原内容期限替代。
    if (!row) {
      throw new GatewayError('result_not_found')
    }
    if (cursor > row.bytes) {
      throw new GatewayError('invalid_result_cursor')
    }
    return { call, row }
  }
  // 执行与实际分页相同的归属、期限和参数检查；成功只表示本次预检通过，不授予后续交付权。
  checkResultRead(principal: string, resultId: string, cursor = 0, maxBytes = 65_536): void {
    this.resultRead(principal, resultId, cursor, maxBytes)
  }
  // 以 UTF-8 字节偏移截取有界响应片段，返回 base64、下一游标、原内容摘要及实际句柄截止时间，不创建或续期句柄。
  readResult(principal: string, resultId: string, cursor = 0, maxBytes = 65_536): ResultPage {
    const { call, row } = this.resultRead(principal, resultId, cursor, maxBytes)
    const data = Buffer.from(call.response!).subarray(cursor, cursor + maxBytes)
    return {
      result_id: resultId,
      encoding: 'base64' as const,
      data: data.toString('base64'),
      next_cursor: cursor + data.length,
      eof: cursor + data.length === row.bytes,
      ...row
    }
  }
  // 审计/恢复只供独立受保护管理面；普通 Principal 不持有此入口。
  auditRecords() {
    return this.transaction(
      /* 先登记一次性审计读取确认，再按稳定顺序返回脱敏记录。 */ (now) => {
        this.manage('audit_read', 'database', this.generation(), now)
        return this.db.prepare('SELECT * FROM audit ORDER BY at,event_id').all()
      },
      false
    )
  }
  // 经受保护确认及完整性、预算检查后解除降级，并删除独立降级哨兵。
  resumeStorage(): void {
    this.transaction(
      /* 检查数据库完整性并消费恢复确认，只有预算恢复正常才切回 active。 */ (now) => {
        if (this.meta().mode === 'recovery_quarantined') {
          throw new GatewayError('recovery_quarantined')
        }
        if (this.db.prepare('PRAGMA quick_check').get()!.quick_check !== 'ok') {
          throw new GatewayError('database_integrity_failed')
        }
        this.manage('storage_resume', 'database', this.generation(), now)
        this.budget(true)
        this.db.prepare("UPDATE metadata SET mode='active'").run()
      },
      false
    )
    if (this.path !== ':memory:' && existsSync(this.path + '.degraded')) {
      unlinkSync(this.path + '.degraded')
    }
    this.degraded = false
  }
  // 经精确恢复 generation 的受保护确认解除恢复隔离，旧连接和旧调用不会重放。
  completeRecovery(): void {
    this.transaction(
      /* 要求当前处于恢复隔离，消费独立确认后切回 active。 */ (now) => {
        if (this.meta().mode !== 'recovery_quarantined') {
          throw new GatewayError('invalid_recovery_state')
        }
        this.manage('recovery_complete', 'database', this.generation(), now)
        this.db.prepare("UPDATE metadata SET mode='active'").run()
      },
      false
    )
  }
  // 在独立私有目录中导出有期限的内容脱敏备份，并将受保护确认与备份登记原子提交。
  backup(destination: string): void {
    privatePath(destination)
    if (
      !this.options.backupDirectory ||
      dirname(destination) !== this.options.backupDirectory ||
      dirname(destination) === dirname(this.path) ||
      dirname(destination).startsWith(dirname(this.path) + '/') ||
      dirname(this.path).startsWith(dirname(destination) + '/')
    ) {
      throw new GatewayError('separate_backup_directory_required')
    }
    let exported = false
    let locked = false
    try {
      this.transaction(
        /* 消费备份确认并检查数量与物理预算，锁住目的文件后导出并登记到期时间。 */ (now) => {
          this.manage('backup_create', 'database', this.generation(), now)
          if (Number(this.db.prepare('SELECT COUNT(*) n FROM backups').get()!.n) >= this.limits.backup_max_count) {
            throw new GatewayError('backup_count_quota')
          }
          if (existsSync(destination)) {
            throw new GatewayError('backup_exists')
          }
          const estimate =
            Number(this.db.prepare('PRAGMA page_count').get()!.page_count) *
              Number(this.db.prepare('PRAGMA page_size').get()!.page_size) +
            65_536
          assertBudget(this.db, this.path, this.limits, this.options.backupDirectory, false, estimate)
          createPrivate(destination + '.lock')
          locked = true
          exportSnapshot(this.db, destination, now, this.limits)
          exported = true
          this.db.prepare('INSERT INTO backups VALUES(?,?,?)').run(destination, now, now + this.limits.backup_ttl)
        },
        false
      )
    } catch (error) {
      if (exported && existsSync(destination)) {
        unlinkSync(destination)
      }
      throw error
    } finally {
      if (locked) {
        unlinkSync(destination + '.lock')
      }
    }
  }
}
