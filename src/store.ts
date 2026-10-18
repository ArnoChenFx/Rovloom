import { DatabaseSync } from 'node:sqlite';
import { closeSync, openSync, unlinkSync, chmodSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { canonical, digest, GatewayError, validateRequest, validateTarget } from './contracts.js';
import type { CallState, NativeRequest, Target } from './contracts.js';

type Machine = { machine_id: string; name: string; status: string };

export type Call = {
  call_id: string;
  principal: string;
  machine_id: string;
  state: CallState;
  epoch: string | null;
  attempt_id: string | null;
  response: string | null;
  target_json: string | null;
  method: string | null;
  deadline: number | null;
};
const id = (prefix: string) => `${prefix}_${randomUUID()}`;
const secret = () => randomBytes(32).toString('base64url');

export class Store {
  private db!: DatabaseSync;
  private lock: number | undefined;
  private closed = false;

  constructor(
    private readonly path: string,
    private readonly now = Date.now,
  ) {
    // 崩溃遗留的锁必须由管理员确认后恢复，不能自动接管。
    if (path !== ':memory:') this.lock = openSync(path + '.lock', 'wx', 0o600);
    try {
      this.db = new DatabaseSync(path);
      if (path !== ':memory:') chmodSync(path, 0o600);
      const hasMetadata = this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='metadata'")
        .get();
      if (hasMetadata) {
        const versions = this.db.prepare('SELECT version FROM metadata').all() as {
          version: number;
        }[];
        if (versions.length !== 1 || ![1, 2, 3].includes(versions[0]!.version)) {
          throw new GatewayError('unsupported_database_version');
        }
      }
      this.db.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = DELETE;
        CREATE TABLE IF NOT EXISTS metadata (version INTEGER NOT NULL);
        INSERT INTO metadata SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM metadata);
        CREATE TABLE IF NOT EXISTS machines (
          machine_id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL, credential_hash TEXT, epoch TEXT
        );
        CREATE TABLE IF NOT EXISTS enrollments (
          token_hash TEXT PRIMARY KEY, machine_id TEXT NOT NULL REFERENCES machines,
          expires INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS calls (
          call_id TEXT PRIMARY KEY, principal TEXT NOT NULL,
          machine_id TEXT NOT NULL REFERENCES machines, request_hash TEXT NOT NULL,
          request_key TEXT, state TEXT NOT NULL, epoch TEXT, attempt_id TEXT, response TEXT,
          UNIQUE(principal, request_key)
        );
      `);
      const version = this.db.prepare('SELECT version FROM metadata').get() as { version: number };
      if (version.version === 1) {
        this.db.exec(`BEGIN IMMEDIATE;
          ALTER TABLE calls ADD COLUMN target_json TEXT;
          ALTER TABLE calls ADD COLUMN method TEXT;
          ALTER TABLE calls ADD COLUMN deadline INTEGER;
          UPDATE metadata SET version=2;
          COMMIT;`);
      }
      if (version.version < 3) {
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE results (
            result_id TEXT PRIMARY KEY, call_id TEXT NOT NULL REFERENCES calls,
            payload BLOB NOT NULL, bytes INTEGER NOT NULL,
            hash TEXT NOT NULL, expires INTEGER NOT NULL
          );
          CREATE INDEX results_expiry ON results(expires);
          UPDATE metadata SET version=3;
          COMMIT;`);
      }
      // 重启只收敛本地状态；可能已经送达的调用保持 unknown，不能据此重派。
      this.db.exec(`BEGIN IMMEDIATE;
        UPDATE machines SET status='offline', epoch=NULL WHERE status='online';
        UPDATE calls SET state='not_dispatched' WHERE state='created';
        UPDATE calls SET state='outcome_unknown'
          WHERE state IN ('dispatching','connector_accepted');
        COMMIT;`);
    } catch (error) {
      this.db?.close();
      this.releaseLock();
      throw error;
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
    if (this.closed) return;
    this.db.close();
    this.releaseLock();
    this.closed = true;
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private name(value: string): string {
    const normalized = value.normalize('NFKC').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(normalized)) throw new GatewayError('invalid_name');
    return normalized;
  }

  register(name: string): Machine {
    const machine_id = id('m');
    const normalized = this.name(name);
    this.db
      .prepare("INSERT INTO machines(machine_id,name,status) VALUES (?,?,'pending')")
      .run(machine_id, normalized);
    return this.machine(machine_id);
  }

  machine(machine_id: string): Machine {
    const row = this.db
      .prepare('SELECT machine_id,name,status FROM machines WHERE machine_id=?')
      .get(machine_id);
    if (!row) throw new GatewayError('machine_not_found');
    return row as Machine;
  }

  rename(machine_id: string, name: string): Machine {
    this.machine(machine_id);
    this.db
      .prepare('UPDATE machines SET name=? WHERE machine_id=?')
      .run(this.name(name), machine_id);
    return this.machine(machine_id);
  }

  // 仅供受保护的管理通道使用：这些凭据绝不能出现在 MCP 工具输出中。
  issueEnrollment(machine_id: string, ttlMs = 600_000): string {
    if (this.machine(machine_id).status !== 'pending')
      throw new GatewayError('invalid_machine_state');
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 600_000)
      throw new GatewayError('invalid_ttl');
    const token = secret();
    this.db
      .prepare('INSERT INTO enrollments(token_hash,machine_id,expires) VALUES (?,?,?)')
      .run(digest(token), machine_id, this.now() + ttlMs);
    return token;
  }

  redeem(token: string): { machine_id: string; credential: string } {
    return this.transaction(() => {
      const row = this.db
        .prepare(`SELECT e.machine_id FROM enrollments e JOIN machines m USING(machine_id)
        WHERE token_hash=? AND expires>? AND consumed=0 AND m.status='pending'`)
        .get(digest(token), this.now()) as { machine_id: string } | undefined;
      if (!row) throw new GatewayError('invalid_enrollment');
      const credential = secret();
      // 同一事务消费该机器的全部配对码并设置凭据，避免其它未消费码再次换取身份。
      this.db.prepare('UPDATE enrollments SET consumed=1 WHERE machine_id=?').run(row.machine_id);
      this.db
        .prepare("UPDATE machines SET credential_hash=?, status='offline' WHERE machine_id=?")
        .run(digest(credential), row.machine_id);
      return { machine_id: row.machine_id, credential };
    });
  }

  connect(machine_id: string, credential: string): string {
    return this.transaction(() => {
      const row = this.db
        .prepare('SELECT status,credential_hash FROM machines WHERE machine_id=?')
        .get(machine_id) as { status: string; credential_hash: string } | undefined;
      if (!row || row.status === 'revoked' || row.credential_hash !== digest(credential)) {
        throw new GatewayError('invalid_device_credential');
      }
      if (row.status === 'online') throw new GatewayError('duplicate_device_connection');
      const epoch = id('epoch');
      this.db
        .prepare("UPDATE machines SET status='online',epoch=? WHERE machine_id=?")
        .run(epoch, machine_id);
      return epoch;
    });
  }

  disconnect(machine_id: string, epoch: string): void {
    this.transaction(() => {
      const changed = this.db
        .prepare("UPDATE machines SET status='offline',epoch=NULL WHERE machine_id=? AND epoch=?")
        .run(machine_id, epoch);
      if (changed.changes !== 1) return;
      // 旧 epoch 的断线通知不能覆盖新连接，也不能把已送达的调用标成未派发。
      this.db
        .prepare("UPDATE calls SET state='not_dispatched' WHERE machine_id=? AND state='created'")
        .run(machine_id);
      this.db
        .prepare(`UPDATE calls SET state='outcome_unknown' WHERE machine_id=? AND epoch=?
        AND state IN ('dispatching','connector_accepted')`)
        .run(machine_id, epoch);
    });
  }

  revoke(machine_id: string): void {
    this.transaction(() => {
      this.machine(machine_id);
      this.db
        .prepare(
          'DELETE FROM results WHERE call_id IN (SELECT call_id FROM calls WHERE machine_id=?)',
        )
        .run(machine_id);
      this.db
        .prepare(
          "UPDATE machines SET status='revoked',credential_hash=NULL,epoch=NULL WHERE machine_id=?",
        )
        .run(machine_id);
      this.db
        .prepare(`UPDATE calls
          SET state=CASE WHEN state='created' THEN 'not_dispatched' ELSE 'outcome_unknown' END
          WHERE machine_id=? AND state IN ('created','dispatching','connector_accepted')`)
        .run(machine_id);
    });
  }

  createCall(
    principal: string,
    target: Target,
    request: NativeRequest,
    key?: string,
    timeoutMs = 30_000,
  ): Call {
    validateTarget(target);
    validateRequest(request);
    if (!principal.trim() || (key !== undefined && (!key || key.length > 256)))
      throw new GatewayError('invalid_caller_key');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600_000)
      throw new GatewayError('invalid_timeout');
    const hash = digest(canonical({ target, request, timeoutMs }));

    return this.transaction(() => {
      // 同 key 先比对原意图，再返回原调用；机器当前离线也不应让旧请求重新登记。
      if (key !== undefined) {
        const existing = this.db
          .prepare('SELECT call_id,request_hash FROM calls WHERE principal=? AND request_key=?')
          .get(principal, key) as { call_id: string; request_hash: string } | undefined;
        if (existing) {
          if (existing.request_hash !== hash) throw new GatewayError('request_key_conflict');
          return this.call(principal, existing.call_id);
        }
      }
      if (this.machine(target.machine_id).status !== 'online')
        throw new GatewayError('machine_offline');
      const call_id = id('call');
      this.db
        .prepare(`INSERT INTO calls(
          call_id,principal,machine_id,request_hash,request_key,state,target_json,method,deadline
        ) VALUES (?,?,?,?,?,'created',?,?,?)`)
        .run(
          call_id,
          principal,
          target.machine_id,
          hash,
          key ?? null,
          canonical(target),
          request.method,
          this.now() + timeoutMs,
        );
      return this.call(principal, call_id);
    });
  }

  call(principal: string, call_id: string): Call {
    const row = this.db
      .prepare(`SELECT c.call_id,c.principal,c.machine_id,c.state,c.epoch,c.attempt_id,
        c.response,c.target_json,c.method,c.deadline
        FROM calls c JOIN machines m USING(machine_id)
        WHERE call_id=? AND principal=? AND m.status!='revoked'`)
      .get(call_id, principal);
    if (!row) throw new GatewayError('call_not_found');
    return row as Call;
  }

  dispatch(principal: string, call_id: string, epoch: string): string {
    return this.transaction(() => {
      const call = this.call(principal, call_id);
      const attempt = id('attempt');
      // 状态、deadline 与当前连接 epoch 在同一次更新中判定；事务提交后才返回 attempt。
      const changed = this.db
        .prepare(`UPDATE calls SET state='dispatching',epoch=?,attempt_id=?
        WHERE call_id=? AND state='created' AND deadline>? AND EXISTS
        (SELECT 1 FROM machines WHERE machine_id=? AND status='online' AND epoch=?)`)
        .run(epoch, attempt, call_id, this.now(), call.machine_id, epoch);
      if (changed.changes !== 1) throw new GatewayError('dispatch_rejected');
      return attempt;
    });
  }

  saveResult(
    principal: string,
    callId: string,
    ttlMs = 3_600_000,
    quotaBytes = 16_777_216,
  ): { result_id: string; bytes: number; hash: string; expires: number } {
    if (
      !Number.isSafeInteger(ttlMs) ||
      ttlMs <= 0 ||
      ttlMs > 3_600_000 ||
      !Number.isSafeInteger(quotaBytes) ||
      quotaBytes <= 0 ||
      quotaBytes > 16_777_216
    ) {
      throw new GatewayError('invalid_result_limits');
    }
    return this.transaction(() => {
      const call = this.call(principal, callId);
      if (call.state !== 'responded' || call.response === null)
        throw new GatewayError('result_not_ready');
      const payload = Buffer.from(call.response);
      this.db.prepare('DELETE FROM results WHERE expires<=?').run(this.now());
      const existing = this.db
        .prepare(`SELECT result_id,bytes,hash,expires FROM results
        WHERE call_id=? ORDER BY expires LIMIT 1`)
        .get(callId) as
        | { result_id: string; bytes: number; hash: string; expires: number }
        | undefined;
      // 重复保存复用现有句柄，避免重复占用配额或悄悄延长有效期。
      if (existing) return existing;
      const used = this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM results').get() as {
        bytes: number;
      };
      if (used.bytes + payload.length > quotaBytes) throw new GatewayError('result_quota');
      const result = {
        result_id: id('result'),
        bytes: payload.length,
        hash: digest(payload.toString('utf8')),
        expires: this.now() + ttlMs,
      };
      this.db
        .prepare('INSERT INTO results VALUES (?,?,?,?,?,?)')
        .run(result.result_id, callId, payload, result.bytes, result.hash, result.expires);
      return result;
    });
  }

  discardResponse(principal: string, callId: string): void {
    this.transaction(() => {
      const call = this.call(principal, callId);
      if (call.state !== 'responded') throw new GatewayError('result_not_ready');
      this.db.prepare('DELETE FROM results WHERE call_id=?').run(callId);
      this.db.prepare('UPDATE calls SET response=NULL WHERE call_id=?').run(callId);
    });
  }

  resultCall(principal: string, resultId: string): Call {
    const row = this.db
      .prepare('SELECT call_id FROM results WHERE result_id=? AND expires>?')
      .get(resultId, this.now()) as { call_id: string } | undefined;
    if (!row) throw new GatewayError('result_not_found');
    return this.call(principal, row.call_id);
  }

  readResult(principal: string, resultId: string, cursor = 0, maxBytes = 65_536) {
    this.resultCall(principal, resultId);
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
    // 使用字节游标和 base64，保证分页切开 UTF-8 字符时仍可无损重组。
    const chunk = this.db
      .prepare('SELECT substr(payload,?,?) AS chunk FROM results WHERE result_id=?')
      .get(cursor + 1, maxBytes, resultId) as { chunk: Uint8Array };
    const data = Buffer.from(chunk.chunk);
    return {
      result_id: resultId,
      encoding: 'base64' as const,
      data: data.toString('base64'),
      next_cursor: cursor + data.length,
      eof: cursor + data.length === row.bytes,
      ...row,
    };
  }

  accepted(machine_id: string, call_id: string, attempt: string, epoch: string): void {
    const changed = this.db
      .prepare(`UPDATE calls SET state='connector_accepted'
      WHERE machine_id=? AND call_id=? AND attempt_id=? AND epoch=? AND state='dispatching'
      AND EXISTS (SELECT 1 FROM machines WHERE machine_id=? AND status='online' AND epoch=?)`)
      .run(machine_id, call_id, attempt, epoch, machine_id, epoch);
    if (changed.changes !== 1) throw new GatewayError('stale_acceptance');
  }

  stop(principal: string, call_id: string): Call {
    this.call(principal, call_id);
    this.db
      .prepare(`UPDATE calls
        SET state=CASE WHEN state='created' THEN 'not_dispatched' ELSE 'outcome_unknown' END
        WHERE call_id=? AND state IN ('created','dispatching','connector_accepted')`)
      .run(call_id);
    return this.call(principal, call_id);
  }

  expire(): void {
    this.db.prepare('DELETE FROM results WHERE expires<=?').run(this.now());
    this.db
      .prepare(`UPDATE calls
        SET state=CASE WHEN state='created' THEN 'not_dispatched' ELSE 'outcome_unknown' END
        WHERE deadline<=? AND state IN ('created','dispatching','connector_accepted')`)
      .run(this.now());
  }

  receive(
    machine_id: string,
    call_id: string,
    attempt: string,
    epoch: string,
    response: unknown,
  ): void {
    const json = canonical(response);
    const changed = this.db
      .prepare(`UPDATE calls SET state='responded',response=?
      WHERE machine_id=? AND call_id=? AND attempt_id=? AND epoch=?
        AND state IN ('dispatching','connector_accepted')
      AND EXISTS (SELECT 1 FROM machines WHERE machine_id=? AND status='online' AND epoch=?)`)
      .run(json, machine_id, call_id, attempt, epoch, machine_id, epoch);
    if (changed.changes !== 1) throw new GatewayError('stale_response');
  }
}
