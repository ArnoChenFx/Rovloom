import type { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import { dirname } from 'node:path';
import { GatewayError } from '../contracts.js';
import type { Retention } from './config.js';
import { managedBytes } from './files.js';
const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
export function assertBudget(
  db: DatabaseSync,
  path: string,
  limits: Retention,
  backupDirectory: string | undefined,
  admission: boolean,
  extraBackupBytes = 0,
): void {
  const sum = (sql: string) => Number(db.prepare(sql).get()!.n);
  const content = sum(
    'SELECT COALESCE(SUM(COALESCE(length(CAST(request_json AS BLOB)),0)+COALESCE(length(CAST(response AS BLOB)),0)),0) n FROM calls',
  );
  if (content > limits.content_bytes) throw new GatewayError('content_quota');
  if (sum('SELECT COALESCE(SUM(bytes),0) n FROM results') > limits.handle_payload_bytes)
    throw new GatewayError('result_quota');
  const audit = db
    .prepare('SELECT * FROM audit')
    .all()
    .reduce((n, row) => n + size(row), 0);
  if (audit > limits.audit_bytes) throw new GatewayError('audit_quota');
  const calls = db
    .prepare(
      'SELECT call_id,principal,target_json,identity_json,binding_json,request_hash,key_digest,history_epoch,state,response_hash,response_bytes,created,deadline,content_expires,metadata_expires,dedup_expires,content_status FROM calls',
    )
    .all();
  const histories = db.prepare('SELECT * FROM history').all();
  if (size(calls) + size(histories) > limits.call_metadata_bytes)
    throw new GatewayError('metadata_quota');
  const security = ['machines', 'enrollments', 'providers', 'management'].reduce(
    (n, table) => n + size(db.prepare(`SELECT * FROM ${table}`).all()),
    0,
  );
  if (security > limits.security_metadata_bytes) throw new GatewayError('security_quota');
  const pages =
    Number(db.prepare('PRAGMA page_count').get()!.page_count) *
    Number(db.prepare('PRAGMA page_size').get()!.page_size);
  const backupBytes = backupDirectory ? managedBytes(backupDirectory) : 0;
  if (backupBytes + extraBackupBytes > limits.backup_bytes) throw new GatewayError('backup_quota');
  const bytes =
    (path === ':memory:'
      ? pages
      : managedBytes(dirname(path)) + Math.max(0, pages - statSync(path).size)) + backupBytes;
  const reserved = sum('SELECT COALESCE(SUM(reserved),0) n FROM calls');
  if (
    reserved > limits.storage_reserve_bytes ||
    bytes + reserved + extraBackupBytes >
      limits.storage_total_bytes - (admission ? limits.storage_reserve_bytes : 0)
  )
    throw new GatewayError('storage_exhausted');
}
