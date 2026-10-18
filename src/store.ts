import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, fsyncSync, openSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { canonical, digest, GatewayError, validateRequest } from './contracts.js';
import type { CallState, NativeRequest } from './contracts.js';
import {
  assertBinding,
  boundedJson,
  planHistoryAdmission,
  registeredRequestDigest,
  validateAttempt,
  validateProvider,
  validateTarget,
  id as validateId,
} from './wire/index.js';
import type { HistoryScope, HistoryRecord } from './wire/history.js';
import type { ResponseAnchor, ResponseEvidencePlan } from './wire/evidence.js';
import type {
  AttemptBinding,
  AttemptIdentity,
  HistoryReference,
  ProviderBinding,
  V2Target,
  ValidationMode,
} from './wire/types.js';
import type { TrustedAttempt } from './integration/luvus-wire.js';
import { DEFAULT_RETENTION, retention } from './storage/config.js';
import type { Retention } from './storage/config.js';
import { SCHEMA, SCHEMA_VERSION } from './storage/schema.js';
import { createPrivate, managedBytes, privateFile, privatePath } from './storage/files.js';

export { DEFAULT_RETENTION };
type Machine = { machine_id: string; name: string; status: string };
type Metadata = { generation: string; mode: string; clock: number };
export type ManagementRequest = { action: string; target: string; fence: string };
export type StoreOptions = {
  retention?: Partial<Retention>;
  backupDirectory?: string;
  // 只由受保护宿主注入，须核实独立权限、真实确认及准确 fence；普通工具参数不能传入。
  management?: (request: ManagementRequest) => { actor: string; confirmation_id: string };
  fault?: (point: 'before_commit' | 'after_anchor' | 'evidence_commit') => void;
};
export type CallOptions = {
  binding_revision: number;
  contract_ref: string;
  caller_policy_revision: string;
  local_policy_revision: string;
  validation?: ValidationMode;
  timeoutMs?: number;
  history?: HistoryReference;
};
export type Call = {
  call_id: string;
  principal: string;
  machine_id: string;
  provider_id: string;
  binding_revision: number;
  provider_kind: 'luvus' | 'herdr';
  state: CallState;
  epoch: string | null;
  attempt_id: string | null;
  response: string | null;
  target_json: string;
  method: string;
  deadline: number;
  content_expires: number;
  metadata_expires: number;
  dedup_expires: number;
  content_status: ResponseAnchor['content_status'];
};
type Row = Call & {
  identity_json: string;
  binding_json: string | null;
  request_json: string | null;
  request_hash: string;
  history_epoch: string | null;
  key_digest: string | null;
  created: number;
  response_hash: string | null;
  response_bytes: number | null;
  reserved: number;
  mode: ValidationMode;
};
const id = (prefix: string) => `${prefix}_${randomUUID()}`;
const secret = () => randomBytes(32).toString('base64url');
const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
const publicCall = (r: Row, now: number): Call => {
  const {
    call_id,
    principal,
    machine_id,
    provider_id,
    binding_revision,
    provider_kind,
    state,
    epoch,
    attempt_id,
    response,
    target_json,
    method,
    deadline,
    content_expires,
    metadata_expires,
    dedup_expires,
    content_status,
  } = r;
  return {
    call_id,
    principal,
    machine_id,
    provider_id,
    binding_revision,
    provider_kind,
    state,
    epoch,
    attempt_id,
    response: content_status === 'available' && now < content_expires ? response : null,
    target_json,
    method,
    deadline,
    content_expires,
    metadata_expires,
    dedup_expires,
    content_status:
      content_status === 'available' && now >= content_expires ? 'expired' : content_status,
  };
};

export class Store {
  private db!: DatabaseSync;
  private lock: number | undefined;
  private closed = false;
  private degraded = false;
  private observed = 0;
  readonly limits: Retention;
  constructor(
    private readonly path: string,
    private readonly now = Date.now,
    private readonly options: StoreOptions = {},
  ) {
    this.limits = retention(options.retention);
    if (path !== ':memory:') {
      privatePath(path);
      if (existsSync(path)) privateFile(path);
      createPrivate(path + '.lock');
      this.lock = openSync(path + '.lock', 'r');
    }
    try {
      if (path !== ':memory:' && !existsSync(path)) createPrivate(path);
      this.db = new DatabaseSync(path);

      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      if (tables.length) {
        const version = this.db.prepare('SELECT version FROM metadata').all() as {
          version: number;
        }[];
        if (version.length !== 1 || version[0]!.version !== SCHEMA_VERSION)
          throw new GatewayError('unsupported_database_version');
      } else {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          this.db.exec(SCHEMA);
          this.db
            .prepare("INSERT INTO metadata VALUES(1,?,?, 'active',?)")
            .run(SCHEMA_VERSION, id('recovery'), this.rawTime());
          this.db.exec('COMMIT');
        } catch (error) {
          this.db.exec('ROLLBACK');
          throw error;
        }
      }
      this.db.exec(
        'PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;',
      );
      if (this.options.backupDirectory) privatePath(join(this.options.backupDirectory, 'boundary'));
      if (this.db.prepare('PRAGMA quick_check').get()!.quick_check !== 'ok')
        throw new GatewayError('database_integrity_failed');
      this.degraded =
        this.meta().mode === 'storage_degraded' ||
        (path !== ':memory:' && existsSync(path + '.degraded'));
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec(`UPDATE machines SET status='offline',epoch=NULL WHERE status='online';
          UPDATE calls SET state='not_dispatched' WHERE state='created';
          UPDATE calls SET state='outcome_unknown' WHERE state IN ('dispatching','connector_accepted');`);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    } catch (error) {
      this.db?.close();
      this.releaseLock();
      if (error instanceof GatewayError) throw error;
      throw new GatewayError('database_open_failed');
    }
  }
  private rawTime(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new GatewayError('clock_untrusted');
    return value;
  }
  private meta(): Metadata {
    return this.db.prepare('SELECT generation,mode,clock FROM metadata').get() as Metadata;
  }
  generation(): string {
    return this.meta().generation;
  }
  health() {
    return {
      mode:
        this.meta().mode === 'recovery_quarantined'
          ? 'recovery_quarantined'
          : this.degraded
            ? 'storage_degraded'
            : 'active',
      generation: this.generation(),
    };
  }
  private time(): number {
    const value = this.rawTime();
    if (value < Math.max(this.observed, this.meta().clock)) {
      this.markDegraded();
      throw new GatewayError('clock_untrusted');
    }
    this.observed = value;
    try {
      this.db.prepare('UPDATE metadata SET clock=?').run(value);
    } catch {
      this.markDegraded();
      throw new GatewayError('storage_degraded');
    }
    return value;
  }
  private active(): void {
    if (this.meta().mode === 'recovery_quarantined') throw new GatewayError('recovery_quarantined');
    if (this.degraded) throw new GatewayError('storage_degraded');
  }
  private markDegraded(): void {
    this.degraded = true;
    try {
      this.db
        .prepare("UPDATE metadata SET mode='storage_degraded' WHERE mode!='recovery_quarantined'")
        .run();
    } catch {
      /* 原锚点保持原样。 */
    }
    if (this.path !== ':memory:') {
      try {
        createPrivate(this.path + '.degraded');
      } catch {
        /* 磁盘满时内存仍拒绝新副作用。 */
      }
    }
  }
  private releaseLock(): void {
    if (this.lock !== undefined) {
      closeSync(this.lock);
      unlinkSync(this.path + '.lock');
      this.lock = undefined;
    }
  }
  close(): void {
    if (!this.closed) {
      this.db.close();
      this.releaseLock();
      this.closed = true;
    }
  }
  private transaction<T>(fn: (now: number) => T, admission = true): T {
    if (admission) this.active();
    const now = this.time();
    if (
      Object.entries(this.limits).some(
        ([key, value]) =>
          (key.endsWith('_ttl') || key === 'history_epoch_max_age') &&
          !Number.isSafeInteger(now + value),
      )
    )
      throw new GatewayError('invalid_storage_limits');
    try {
      this.db.exec('BEGIN IMMEDIATE');
    } catch {
      this.markDegraded();
      throw new GatewayError('storage_degraded');
    }
    try {
      const value = fn(now);
      this.db.prepare('UPDATE metadata SET clock=?').run(now);
      this.budget(admission);
      this.options.fault?.('before_commit');
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* 不在错误中暴露 SQL/内容。 */
      }
      if (
        error instanceof GatewayError &&
        !['storage_exhausted', 'audit_quota', 'metadata_quota', 'security_quota'].includes(
          error.code,
        )
      )
        throw error;
      if (
        error instanceof Error &&
        /UNIQUE constraint|CHECK constraint|FOREIGN KEY constraint/.test(error.message)
      )
        throw new GatewayError('constraint_conflict');
      this.markDegraded();
      throw new GatewayError('storage_degraded');
    }
  }
  private budget(admission: boolean): void {
    const sum = (sql: string) => Number(this.db.prepare(sql).get()!.n);
    const content = sum(
      'SELECT COALESCE(SUM(COALESCE(length(CAST(request_json AS BLOB)),0)+COALESCE(length(CAST(response AS BLOB)),0)),0) n FROM calls',
    );
    if (content > this.limits.content_bytes) throw new GatewayError('content_quota');
    if (sum('SELECT COALESCE(SUM(bytes),0) n FROM results') > this.limits.handle_payload_bytes)
      throw new GatewayError('result_quota');
    const audit = this.db
      .prepare('SELECT * FROM audit')
      .all()
      .reduce((n, row) => n + size(row), 0);
    if (audit > this.limits.audit_bytes) throw new GatewayError('audit_quota');
    const calls = this.db
      .prepare(
        'SELECT call_id,principal,target_json,identity_json,binding_json,request_hash,key_digest,history_epoch,state,response_hash,response_bytes,created,deadline,content_expires,metadata_expires,dedup_expires,content_status FROM calls',
      )
      .all();
    const histories = this.db.prepare('SELECT * FROM history').all();
    if (size(calls) + size(histories) > this.limits.call_metadata_bytes)
      throw new GatewayError('metadata_quota');
    const security = ['machines', 'enrollments', 'providers', 'management'].reduce(
      (n, table) => n + size(this.db.prepare(`SELECT * FROM ${table}`).all()),
      0,
    );
    if (security > this.limits.security_metadata_bytes) throw new GatewayError('security_quota');
    const pages =
      Number(this.db.prepare('PRAGMA page_count').get()!.page_count) *
      Number(this.db.prepare('PRAGMA page_size').get()!.page_size);
    const backupBytes = this.options.backupDirectory
      ? managedBytes(this.options.backupDirectory)
      : 0;
    if (backupBytes > this.limits.backup_bytes) throw new GatewayError('backup_quota');
    const bytes =
      (this.path === ':memory:'
        ? pages
        : managedBytes(dirname(this.path)) + Math.max(0, pages - statSync(this.path).size)) +
      backupBytes;
    const reserved = sum('SELECT COALESCE(SUM(reserved),0) n FROM calls');
    if (
      reserved > this.limits.storage_reserve_bytes ||
      bytes + reserved >
        this.limits.storage_total_bytes - (admission ? this.limits.storage_reserve_bytes : 0)
    )
      throw new GatewayError('storage_exhausted');
  }
  private audit(
    action: string,
    actor: string,
    now: number,
    row?: Row,
    extra: Record<string, unknown> = {},
  ): void {
    const details = row
      ? {
          machine_id: row.machine_id,
          provider_id: row.provider_id,
          binding_revision: row.binding_revision,
          provider_kind: row.provider_kind,
          target: JSON.parse(row.target_json),
          method: row.method,
          state: row.state,
          attempt: (() => {
            const b = JSON.parse(row.binding_json ?? row.identity_json);
            return {
              ...b,
              registration: {
                ...b.registration,
                history: b.registration.history
                  ? { history_epoch: b.registration.history.history_epoch }
                  : null,
              },
            };
          })(),
          bytes: row.response_bytes,
          ...extra,
        }
      : extra;
    // 不写 request、response、key 或它们的原文；target/摘要仍是受保护元数据。
    this.db
      .prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?)')
      .run(
        id('event'),
        action,
        actor,
        row?.call_id ?? null,
        now,
        now + this.limits.audit_ttl,
        boundedJson(details),
      );
  }
  private manage(action: string, target: string, fence: string, now: number): void {
    const proof = this.options.management?.({ action, target, fence });
    if (!proof?.actor || !proof.confirmation_id)
      throw new GatewayError('management_authorization_required');
    if (
      this.db.prepare('SELECT 1 FROM management WHERE confirmation_id=?').get(proof.confirmation_id)
    )
      throw new GatewayError('confirmation_replayed');
    this.db
      .prepare('INSERT INTO management VALUES(?,?,?,?,?)')
      .run(proof.confirmation_id, proof.actor, action, target, fence);
    this.audit(action, proof.actor, now, undefined, {
      target,
      fence,
      confirmation_id: proof.confirmation_id,
    });
  }
  private name(value: string): string {
    const normalized = value.normalize('NFKC').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(normalized)) throw new GatewayError('invalid_name');
    return normalized;
  }
  register(name: string): Machine {
    return this.transaction((now) => {
      const machine = id('m');
      this.db
        .prepare("INSERT INTO machines(machine_id,name,status) VALUES(?,?,'pending')")
        .run(machine, this.name(name));
      this.audit('machine_registered', 'local', now, undefined, { machine_id: machine });
      return this.machine(machine);
    });
  }
  machine(machine_id: string): Machine {
    const row = this.db
      .prepare('SELECT machine_id,name,status FROM machines WHERE machine_id=?')
      .get(machine_id);
    if (!row) throw new GatewayError('machine_not_found');
    return row as Machine;
  }
  rename(machine: string, name: string): Machine {
    return this.transaction((now) => {
      this.machine(machine);
      this.db
        .prepare('UPDATE machines SET name=? WHERE machine_id=?')
        .run(this.name(name), machine);
      this.audit('machine_renamed', 'local', now, undefined, { machine_id: machine });
      return this.machine(machine);
    });
  }
  issueEnrollment(machine: string, ttlMs = 600_000): string {
    return this.transaction((now) => {
      if (this.machine(machine).status !== 'pending')
        throw new GatewayError('invalid_machine_state');
      if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 600_000)
        throw new GatewayError('invalid_ttl');
      if (
        this.db.prepare('SELECT needs_confirmation FROM machines WHERE machine_id=?').get(machine)!
          .needs_confirmation === 1
      ) {
        this.manage('device_reenroll', machine, this.generation(), now);
        this.db.prepare('UPDATE machines SET needs_confirmation=0 WHERE machine_id=?').run(machine);
      }
      const token = secret();
      this.db
        .prepare('INSERT INTO enrollments(token_hash,machine_id,expires) VALUES(?,?,?)')
        .run(digest(token), machine, now + ttlMs);
      this.audit('enrollment_issued', 'local', now, undefined, { machine_id: machine });
      return token;
    });
  }
  redeem(token: string): { machine_id: string; credential: string } {
    return this.transaction((now) => {
      const row = this.db
        .prepare(`SELECT e.machine_id FROM enrollments e JOIN machines m USING(machine_id)
        WHERE token_hash=? AND expires>? AND consumed=0 AND m.status='pending'`)
        .get(digest(token), now) as { machine_id: string } | undefined;
      if (!row) throw new GatewayError('invalid_enrollment');
      const credential = secret();
      this.db.prepare('UPDATE enrollments SET consumed=1 WHERE machine_id=?').run(row.machine_id);
      this.db
        .prepare("UPDATE machines SET credential_hash=?,status='offline' WHERE machine_id=?")
        .run(digest(credential), row.machine_id);
      this.audit('enrollment_consumed', 'local', now, undefined, { machine_id: row.machine_id });
      return { ...row, credential };
    });
  }
  connect(machine: string, credential: string): string {
    return this.transaction((now) => {
      const row = this.db
        .prepare('SELECT status,credential_hash FROM machines WHERE machine_id=?')
        .get(machine);
      if (!row || row.status === 'revoked' || row.credential_hash !== digest(credential))
        throw new GatewayError('invalid_device_credential');
      if (row.status === 'online') throw new GatewayError('duplicate_device_connection');
      const epoch = id('epoch');
      this.db
        .prepare("UPDATE machines SET status='online',epoch=? WHERE machine_id=?")
        .run(epoch, machine);
      this.audit('connected', machine, now, undefined, {
        machine_id: machine,
        epoch,
        generation: this.generation(),
      });
      return epoch;
    });
  }
  defineProvider(binding: ProviderBinding): ProviderBinding {
    validateProvider(binding);
    return this.transaction((now) => {
      this.machine(binding.machine_id);
      if (this.provider(binding.machine_id, binding.provider_id))
        throw new GatewayError('provider_exists');
      if (binding.binding_revision !== 1) throw new GatewayError('invalid_initial_revision');
      this.manage('providers_manage', binding.machine_id + '/' + binding.provider_id, 'new', now);
      this.db
        .prepare('INSERT INTO providers VALUES(?,?,?,?,?,?)')
        .run(
          binding.machine_id,
          binding.provider_id,
          binding.kind,
          binding.config_ref,
          1,
          Number(binding.enabled),
        );
      return { ...binding };
    });
  }
  provider(machine: string, provider: string): ProviderBinding | undefined {
    const row = this.db
      .prepare('SELECT * FROM providers WHERE machine_id=? AND provider_id=?')
      .get(machine, provider);
    return row ? ({ ...row, enabled: row.enabled === 1 } as ProviderBinding) : undefined;
  }
  private current(
    row: Pick<Row, 'machine_id' | 'provider_id' | 'binding_revision' | 'provider_kind'>,
  ): void {
    if (this.machine(row.machine_id).status === 'revoked') throw new GatewayError('call_not_found');
    const provider = this.provider(row.machine_id, row.provider_id);
    if (!provider?.enabled) throw new GatewayError('provider_disabled');
    if (provider.binding_revision !== row.binding_revision || provider.kind !== row.provider_kind)
      throw new GatewayError('provider_binding_mismatch');
  }
  setProviderEnabled(
    machine: string,
    providerId: string,
    revision: number,
    enabled: boolean,
  ): ProviderBinding {
    return this.transaction((now) => {
      const provider = this.provider(machine, providerId);
      if (!provider || provider.binding_revision !== revision)
        throw new GatewayError('provider_binding_mismatch');
      this.manage('providers_manage', machine + '/' + providerId, String(revision), now);
      this.db
        .prepare(
          'UPDATE providers SET enabled=?,binding_revision=binding_revision+1 WHERE machine_id=? AND provider_id=?',
        )
        .run(Number(enabled), machine, providerId);
      this.stopWhere(
        'machine_id=? AND provider_id=?',
        [machine, providerId],
        'provider_changed',
        now,
      );
      return this.provider(machine, providerId)!;
    });
  }
  private stopWhere(where: string, values: string[], reason: string, now: number): void {
    const rows = this.db
      .prepare(
        `SELECT * FROM calls WHERE ${where} AND state IN ('created','dispatching','connector_accepted')`,
      )
      .all(...values) as Row[];
    for (const row of rows) {
      this.db
        .prepare('UPDATE calls SET state=? WHERE call_id=?')
        .run(row.state === 'created' ? 'not_dispatched' : 'outcome_unknown', row.call_id);
      this.audit(reason, 'system', now, this.row(row.call_id));
    }
  }
  disconnect(machine: string, epoch: string): void {
    this.transaction((now) => {
      const changed = this.db
        .prepare("UPDATE machines SET status='offline',epoch=NULL WHERE machine_id=? AND epoch=?")
        .run(machine, epoch);
      if (changed.changes === 1)
        this.stopWhere(
          'machine_id=? AND (epoch=? OR epoch IS NULL)',
          [machine, epoch],
          'disconnect',
          now,
        );
    }, false);
  }
  revoke(machine: string): void {
    this.transaction((now) => {
      this.machine(machine);
      this.manage('devices_revoke', machine, this.generation(), now);
      this.stopWhere('machine_id=?', [machine], 'device_revoked', now);
      this.db
        .prepare(
          "UPDATE machines SET status='revoked',credential_hash=NULL,epoch=NULL WHERE machine_id=?",
        )
        .run(machine);
      this.db.prepare('DELETE FROM enrollments WHERE machine_id=?').run(machine);
      this.db
        .prepare(
          'DELETE FROM results WHERE call_id IN (SELECT call_id FROM calls WHERE machine_id=?)',
        )
        .run(machine);
      this.db
        .prepare(
          "UPDATE calls SET response=NULL,request_json=NULL,content_status='unavailable' WHERE machine_id=?",
        )
        .run(machine);
    }, false);
  }
  openHistory(
    principal: string,
    target: V2Target,
    revision: number,
    retire?: string,
  ): HistoryScope {
    validateTarget(target);
    validateId(principal);
    return this.transaction((now) => {
      const provider = this.provider(target.machine_id, target.provider_id);
      if (!provider?.enabled || provider.binding_revision !== revision)
        throw new GatewayError('provider_binding_mismatch');
      if (retire) {
        const changed = this.db
          .prepare(
            "UPDATE history SET status='retired' WHERE history_epoch=? AND principal=? AND machine_id=? AND provider_id=? AND binding_revision=? AND recovery_generation=?",
          )
          .run(
            retire,
            principal,
            target.machine_id,
            target.provider_id,
            revision,
            this.generation(),
          );
        if (changed.changes !== 1) throw new GatewayError('dedup_history_unavailable');
      }
      const scope: HistoryScope = {
        history_epoch: id('history'),
        recovery_generation: this.generation(),
        status: 'active',
        scope_created_at: now,
        accept_new_until: now + this.limits.history_epoch_max_age,
        frozen_dedup_ttl: this.limits.dedup_ttl,
      };
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
          scope.frozen_dedup_ttl,
        );
      this.audit('history_opened', principal, now, undefined, {
        machine_id: target.machine_id,
        provider_id: target.provider_id,
        binding_revision: revision,
        history_epoch: scope.history_epoch,
        retired: retire ?? null,
      });
      return scope;
    });
  }
  private row(callId: string): Row {
    const row = this.db.prepare('SELECT * FROM calls WHERE call_id=?').get(callId) as
      | Row
      | undefined;
    if (!row) throw new GatewayError('call_not_found');
    return row;
  }
  private owned(principal: string, callId: string, now = this.time()): Row {
    if (this.meta().mode === 'recovery_quarantined') throw new GatewayError('recovery_quarantined');
    const row = this.row(callId);
    if (row.principal !== principal || row.metadata_expires <= now)
      throw new GatewayError('call_not_found');
    this.current(row);
    return row;
  }
  call(principal: string, callId: string): Call {
    const now = this.time();
    const result = publicCall(this.owned(principal, callId, now), now);
    if (this.degraded && ['dispatching', 'connector_accepted'].includes(result.state))
      result.state = 'outcome_unknown';
    return result;
  }
  createCall(
    principal: string,
    target: V2Target,
    request: NativeRequest,
    options: CallOptions,
  ): Call {
    validateTarget(target);
    validateRequest(request);
    return this.transaction((now) => {
      const provider = this.provider(target.machine_id, target.provider_id);
      if (!provider || !provider.enabled || provider.binding_revision !== options.binding_revision)
        throw new GatewayError('provider_binding_mismatch');
      if (provider.kind === 'herdr') throw new GatewayError('provider_support_candidate');
      const timeout = options.timeoutMs ?? 30_000;
      if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 600_000)
        throw new GatewayError('invalid_timeout');
      const identity: AttemptIdentity = {
        call_id: id('call'),
        attempt_id: id('attempt'),
        native_request_id: id('native'),
        target,
        provider_kind: provider.kind,
        binding_revision: provider.binding_revision,
        contract_ref: options.contract_ref,
        registration: {
          deadline: now + timeout,
          history: options.history ?? null,
          caller_policy_revision: options.caller_policy_revision,
          local_policy_revision: options.local_policy_revision,
        },
      };
      validateAttempt(identity);
      let hash = registeredRequestDigest(
        {
          attempt: identity,
          expected_binding_revision: provider.binding_revision,
          native_request: request,
          validation: options.validation ?? 'strict',
        },
        principal,
      );
      let dedupExpires = now + this.limits.dedup_ttl;
      if (options.history) {
        const scope = this.db
          .prepare(
            'SELECT * FROM history WHERE history_epoch=? AND principal=? AND machine_id=? AND provider_id=? AND binding_revision=?',
          )
          .get(
            options.history.history_epoch,
            principal,
            target.machine_id,
            target.provider_id,
            provider.binding_revision,
          ) as HistoryScope | undefined;
        const old = this.db
          .prepare('SELECT * FROM calls WHERE history_epoch=? AND key_digest=?')
          .get(options.history.history_epoch, digest(options.history.client_request_key)) as
          | Row
          | undefined;
        if (old) {
          // deadline 是初次登记的绝对值，重送不能以当前时刻刷新；其余条件仍逐项摘要核对。
          const prior = JSON.parse(old.identity_json) as AttemptIdentity;
          identity.registration.deadline = prior.registration.deadline;
          hash = registeredRequestDigest(
            {
              attempt: identity,
              expected_binding_revision: provider.binding_revision,
              native_request: request,
              validation: options.validation ?? 'strict',
            },
            principal,
          );
          if (prior.registration.deadline - old.created !== timeout)
            throw new GatewayError('request_key_conflict');
        }
        const record: HistoryRecord | undefined = old
          ? {
              history_epoch: old.history_epoch!,
              recovery_generation:
                JSON.parse(old.binding_json ?? '{}').recovery_generation ??
                scope?.recovery_generation,
              key_digest: old.key_digest!,
              request_digest: old.request_hash,
              call_id: old.call_id,
              call_created_at: old.created,
              dedup_expires_at: old.dedup_expires,
            }
          : undefined;
        const decision = planHistoryAdmission(
          options.history,
          this.generation(),
          hash,
          scope,
          record,
          now,
        );
        if (decision.action === 'return_existing')
          return publicCall(this.owned(principal, decision.call_id, now), now);
        dedupExpires = decision.dedup_expires_at;
      }
      if (this.machine(target.machine_id).status !== 'online')
        throw new GatewayError('machine_offline');
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
          now + this.limits.content_ttl,
          now + this.limits.call_metadata_ttl,
          dedupExpires,
        );
      const row = this.row(identity.call_id);
      this.audit('created', principal, now, row);
      return publicCall(row, now);
    });
  }
  dispatch(
    principal: string,
    callId: string,
    epoch: string,
    policies?: { caller: string; local: string },
  ): AttemptBinding {
    const binding = this.transaction((now) => {
      const row = this.owned(principal, callId, now);
      const machine = this.db
        .prepare('SELECT status,epoch FROM machines WHERE machine_id=?')
        .get(row.machine_id)!;
      if (
        row.state !== 'created' ||
        row.deadline <= now ||
        row.content_expires <= now ||
        machine.status !== 'online' ||
        machine.epoch !== epoch
      )
        throw new GatewayError('dispatch_rejected');
      const registered = JSON.parse(row.identity_json) as AttemptIdentity;
      if (
        policies &&
        (registered.registration.caller_policy_revision !== policies.caller ||
          registered.registration.local_policy_revision !== policies.local)
      )
        throw new GatewayError('policy_revision_mismatch');
      const binding: AttemptBinding = {
        ...registered,
        machine_id: row.machine_id,
        recovery_generation: this.generation(),
        connection_epoch: epoch,
      };
      this.db
        .prepare(
          "UPDATE calls SET state='dispatching',epoch=?,attempt_id=?,binding_json=?,reserved=? WHERE call_id=?",
        )
        .run(
          epoch,
          binding.attempt_id,
          boundedJson(binding),
          this.limits.attempt_reserve_bytes,
          callId,
        );
      this.audit('dispatching', principal, now, this.row(callId));
      return binding;
    });
    try {
      this.options.fault?.('after_anchor');
    } catch {
      this.markDegraded();
      throw new GatewayError('storage_degraded');
    }
    return binding;
  }
  attempt(callId: string, attemptId: string): TrustedAttempt | undefined {
    this.active();
    const now = this.time();
    const row = this.row(callId);
    if (
      row.attempt_id !== attemptId ||
      !row.binding_json ||
      !row.request_json ||
      now >= row.content_expires ||
      now >= row.metadata_expires
    )
      return undefined;
    this.current(row);
    return {
      binding: JSON.parse(row.binding_json),
      principal_id: row.principal,
      method: row.method,
      mode: row.mode,
      transport: 'rpc',
      native_request: JSON.parse(row.request_json),
    };
  }
  responseAnchor(binding: AttemptBinding): ResponseAnchor {
    this.active();
    const row = this.row(binding.call_id);
    this.current(row);
    if (!row.binding_json) throw new GatewayError('attempt_anchor_unavailable');
    assertBinding(binding, JSON.parse(row.binding_json));
    if (binding.recovery_generation !== this.generation())
      throw new GatewayError('attempt_binding_mismatch');
    const machine = this.db
      .prepare('SELECT status,epoch FROM machines WHERE machine_id=?')
      .get(row.machine_id)!;
    if (machine.status !== 'online' || machine.epoch !== binding.connection_epoch)
      throw new GatewayError('stale_response');
    const call = publicCall(row, this.time());
    return {
      binding: JSON.parse(row.binding_json),
      method: row.method,
      mode: row.mode,
      state: call.state === 'created' ? 'not_dispatched' : call.state,
      content_status: call.content_status,
      content_expires_at: row.content_expires,
      dedup_expires_at: row.dedup_expires,
      ...(row.response_hash
        ? { evidence: { response_hash: row.response_hash, response_bytes: row.response_bytes! } }
        : {}),
    };
  }
  accepted(binding: AttemptBinding): void {
    this.transaction((now) => {
      const anchor = this.responseAnchor(binding);
      if (anchor.state !== 'dispatching' || now >= binding.registration.deadline)
        throw new GatewayError('stale_acceptance');
      this.db
        .prepare("UPDATE calls SET state='connector_accepted' WHERE call_id=?")
        .run(binding.call_id);
      this.audit('connector_accepted', 'connector', now, this.row(binding.call_id));
    }, false);
  }
  // planner 必须是宿主闭包，调用真实 adapter.planEvidence；不接收可序列化 EvidencePlan 作为证明。
  commitEvidence(binding: AttemptBinding, planner: () => ResponseEvidencePlan): Call {
    return this.transaction((now) => {
      this.stopWhere(
        'call_id=? AND deadline<=?',
        [binding.call_id, String(now)],
        'deadline_exceeded',
        now,
      );
      const anchor = this.responseAnchor(binding);
      const plan = planner();
      assertBinding(plan.evidence.binding, anchor.binding);
      if (
        plan.evidence.received_at !== now ||
        plan.content.expires_at !== anchor.content_expires_at ||
        plan.dispatch !== false
      )
        throw new GatewayError('invalid_evidence_plan');
      const row = this.row(binding.call_id);
      if (plan.action === 'duplicate') {
        if (
          !anchor.evidence ||
          anchor.evidence.response_hash !== plan.evidence.response_hash ||
          anchor.evidence.response_bytes !== plan.evidence.response_bytes
        )
          throw new GatewayError('response_evidence_conflict');
        return publicCall(row, now);
      }
      if (
        row.response_hash ||
        !['dispatching', 'connector_accepted', 'outcome_unknown'].includes(row.state)
      )
        throw new GatewayError('response_evidence_conflict');
      let response: string | null = null;
      let contentStatus = publicCall(row, now).content_status;
      if (
        plan.content.delivery === 'payload' &&
        contentStatus === 'available' &&
        now < row.content_expires &&
        plan.content.native_response
      ) {
        const text = boundedJson(plan.content.native_response, 33_554_432);
        if (
          digest(text) !== plan.evidence.response_hash ||
          Buffer.byteLength(text) !== plan.evidence.response_bytes
        )
          throw new GatewayError('invalid_evidence_plan');
        const used = Number(
          this.db
            .prepare(
              'SELECT COALESCE(SUM(COALESCE(length(CAST(request_json AS BLOB)),0)+COALESCE(length(CAST(response AS BLOB)),0)),0) n FROM calls',
            )
            .get()!.n,
        );
        if (used + Buffer.byteLength(text) <= this.limits.content_bytes) response = text;
      }
      if (!response && contentStatus === 'available') contentStatus = 'unavailable';
      this.db
        .prepare(
          "UPDATE calls SET state='responded',response=?,response_hash=?,response_bytes=?,response_category=?,content_status=?,reserved=0 WHERE call_id=?",
        )
        .run(
          response,
          plan.evidence.response_hash,
          plan.evidence.response_bytes,
          plan.evidence.category,
          contentStatus,
          binding.call_id,
        );
      this.audit(
        plan.late_evidence ? 'late_evidence' : 'responded',
        'connector',
        now,
        this.row(binding.call_id),
        { response_hash: plan.evidence.response_hash, category: plan.evidence.category },
      );
      this.options.fault?.('evidence_commit');
      return publicCall(this.row(binding.call_id), now);
    }, false);
  }
  stop(principal: string, callId: string): Call {
    return this.transaction((now) => {
      this.owned(principal, callId, now);
      this.stopWhere('call_id=?', [callId], 'cancelled', now);
      return publicCall(this.row(callId), now);
    }, false);
  }
  expire(): void {
    this.transaction((now) => {
      this.stopWhere('deadline<=?', [String(now)], 'deadline_exceeded', now);
      this.db
        .prepare(
          "DELETE FROM results WHERE expires<=? OR call_id IN (SELECT call_id FROM calls WHERE content_expires<=? OR content_status!='available')",
        )
        .run(now, now);
      this.db
        .prepare(
          "UPDATE calls SET response=NULL,request_json=NULL,content_status=CASE WHEN content_status='available' THEN 'expired' ELSE content_status END WHERE content_expires<=?",
        )
        .run(now);
      this.db
        .prepare('DELETE FROM calls WHERE metadata_expires<=? AND dedup_expires<=?')
        .run(now, now);
      this.db.prepare("UPDATE history SET status='retired' WHERE accept_new_until<=?").run(now);
      this.db
        .prepare(
          'DELETE FROM history WHERE accept_new_until+frozen_dedup_ttl<=? AND NOT EXISTS(SELECT 1 FROM calls WHERE calls.history_epoch=history.history_epoch)',
        )
        .run(now);
      this.db.prepare('DELETE FROM audit WHERE expires<=?').run(now);
      this.db.prepare('DELETE FROM enrollments WHERE expires<=?').run(now);
      for (const row of this.db.prepare('SELECT path FROM backups WHERE expires<=?').all(now)) {
        const path = String(row.path);
        if (dirname(path) !== this.options.backupDirectory)
          throw new GatewayError('unsafe_backup_path');
        if (existsSync(path)) {
          privateFile(path);
          unlinkSync(path);
        }
        this.db.prepare('DELETE FROM backups WHERE path=?').run(path);
      }
    }, false);
  }
  saveResult(
    principal: string,
    callId: string,
    ttlMs = this.limits.handle_ttl,
    quotaBytes = this.limits.handle_payload_bytes,
  ) {
    if (
      !Number.isSafeInteger(ttlMs) ||
      ttlMs <= 0 ||
      ttlMs > this.limits.handle_ttl ||
      !Number.isSafeInteger(quotaBytes) ||
      quotaBytes <= 0 ||
      quotaBytes > this.limits.handle_payload_bytes
    )
      throw new GatewayError('invalid_result_limits');
    return this.transaction((now) => {
      const row = this.owned(principal, callId, now);
      if (
        row.state !== 'responded' ||
        !row.response ||
        row.content_status !== 'available' ||
        row.content_expires <= now
      )
        throw new GatewayError('result_not_ready');
      this.db.prepare('DELETE FROM results WHERE expires<=?').run(now);
      const existing = this.db.prepare('SELECT * FROM results WHERE call_id=?').get(callId);
      if (existing) {
        const { call_id: _call, ...result } = existing;
        return result as { result_id: string; bytes: number; hash: string; expires: number };
      }
      const used = Number(this.db.prepare('SELECT COALESCE(SUM(bytes),0) n FROM results').get()!.n);
      const bytes = Buffer.byteLength(row.response);
      if (used + bytes > quotaBytes) throw new GatewayError('result_quota');
      const result = {
        result_id: id('result'),
        bytes,
        hash: row.response_hash!,
        expires: Math.min(now + ttlMs, row.content_expires),
      };
      this.db
        .prepare('INSERT INTO results VALUES(?,?,?,?,?)')
        .run(result.result_id, callId, result.bytes, result.hash, result.expires);
      this.audit('result_handle', principal, now, row);
      return result;
    });
  }
  discardResponse(principal: string, callId: string): void {
    this.transaction((now) => {
      const row = this.owned(principal, callId, now);
      this.db.prepare('DELETE FROM results WHERE call_id=?').run(callId);
      this.db
        .prepare(
          "UPDATE calls SET response=NULL,request_json=NULL,content_status='discarded' WHERE call_id=?",
        )
        .run(callId);
      this.audit('discard_response', principal, now, row);
    }, false);
  }
  resultCall(principal: string, resultId: string): Call {
    const now = this.time();
    const row = this.db
      .prepare('SELECT call_id FROM results WHERE result_id=? AND expires>?')
      .get(resultId, now) as { call_id: string } | undefined;
    if (!row) throw new GatewayError('result_not_found');
    const call = this.call(principal, row.call_id);
    if (call.content_status !== 'available' || !call.response)
      throw new GatewayError('result_not_found');
    return call;
  }
  readResult(principal: string, resultId: string, cursor = 0, maxBytes = 65_536) {
    const call = this.resultCall(principal, resultId);
    if (
      !Number.isSafeInteger(cursor) ||
      cursor < 0 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes <= 0 ||
      maxBytes > 65_536
    )
      throw new GatewayError('invalid_result_cursor');
    const row = this.db
      .prepare('SELECT bytes,hash FROM results WHERE result_id=?')
      .get(resultId) as { bytes: number; hash: string };
    if (cursor > row.bytes) throw new GatewayError('invalid_result_cursor');
    const data = Buffer.from(call.response!).subarray(cursor, cursor + maxBytes);
    return {
      result_id: resultId,
      encoding: 'base64' as const,
      data: data.toString('base64'),
      next_cursor: cursor + data.length,
      eof: cursor + data.length === row.bytes,
      ...row,
    };
  }
  // 审计/恢复只供独立受保护管理面；普通 Principal 不持有此入口。
  auditRecords() {
    return this.transaction((now) => {
      this.manage('audit_read', 'database', this.generation(), now);
      return this.db.prepare('SELECT * FROM audit ORDER BY at,event_id').all();
    }, false);
  }
  resumeStorage(): void {
    this.transaction((now) => {
      if (this.meta().mode === 'recovery_quarantined')
        throw new GatewayError('recovery_quarantined');
      if (this.db.prepare('PRAGMA quick_check').get()!.quick_check !== 'ok')
        throw new GatewayError('database_integrity_failed');
      this.manage('storage_resume', 'database', this.generation(), now);
      this.budget(true);
      this.db.prepare("UPDATE metadata SET mode='active'").run();
    }, false);
    if (this.path !== ':memory:' && existsSync(this.path + '.degraded'))
      unlinkSync(this.path + '.degraded');
    this.degraded = false;
  }
  completeRecovery(): void {
    this.transaction((now) => {
      if (this.meta().mode !== 'recovery_quarantined')
        throw new GatewayError('invalid_recovery_state');
      this.manage('recovery_complete', 'database', this.generation(), now);
      this.db.prepare("UPDATE metadata SET mode='active'").run();
    }, false);
  }
  backup(destination: string): void {
    privatePath(destination);
    if (
      !this.options.backupDirectory ||
      dirname(destination) !== this.options.backupDirectory ||
      dirname(destination) === dirname(this.path) ||
      dirname(destination).startsWith(dirname(this.path) + '/') ||
      dirname(this.path).startsWith(dirname(destination) + '/')
    )
      throw new GatewayError('separate_backup_directory_required');
    this.transaction((now) => {
      this.manage('backup_create', 'database', this.generation(), now);
      if (
        Number(this.db.prepare('SELECT COUNT(*) n FROM backups').get()!.n) >=
        this.limits.backup_max_count
      )
        throw new GatewayError('backup_count_quota');
      if (existsSync(destination)) throw new GatewayError('backup_exists');
      createPrivate(destination + '.lock');
      createPrivate(destination);
      const backup = new DatabaseSync(destination);
      try {
        backup.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');
        backup.exec(SCHEMA);
        backup
          .prepare("INSERT INTO metadata VALUES(1,?,?,'recovery_quarantined',?)")
          .run(SCHEMA_VERSION, id('recovery'), now);
        for (const table of ['machines', 'providers', 'history', 'calls', 'audit', 'management']) {
          for (const source of this.db.prepare(`SELECT * FROM ${table}`).all()) {
            const row = { ...source };
            if (table === 'machines') {
              row.needs_confirmation = 1;
              row.credential_hash = null;
              row.epoch = null;
              if (row.status !== 'revoked') row.status = 'pending';
            }
            if (table === 'providers') {
              row.enabled = 0;
              row.binding_revision = Number(row.binding_revision) + 1;
            }
            if (table === 'history') row.status = 'retired';
            if (table === 'calls') {
              row.request_json = null;
              row.response = null;
              row.content_status = 'unavailable';
              if (row.state !== 'responded')
                row.state = row.binding_json ? 'outcome_unknown' : 'not_dispatched';
              row.reserved = 0;
            }
            const keys = Object.keys(row);
            backup
              .prepare(
                `INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`,
              )
              .run(...keys.map((k) => row[k]!));
          }
        }
        const bytes =
          Number(backup.prepare('PRAGMA page_count').get()!.page_count) *
          Number(backup.prepare('PRAGMA page_size').get()!.page_size);
        if (bytes > this.limits.backup_bytes || bytes > this.limits.storage_total_bytes)
          throw new GatewayError('backup_quota');
        backup.exec('COMMIT');
      } catch (error) {
        try {
          backup.exec('ROLLBACK');
        } catch {
          /* 输出为不完整备份，不能使用。 */
        }
        throw error;
      } finally {
        backup.close();
        unlinkSync(destination + '.lock');
      }
      const fd = openSync(destination, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      this.db
        .prepare('INSERT INTO backups VALUES(?,?,?)')
        .run(destination, now, now + this.limits.backup_ttl);
    }, false);
  }
}
