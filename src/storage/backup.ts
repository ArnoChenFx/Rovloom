import { DatabaseSync } from 'node:sqlite';
import { closeSync, fsyncSync, openSync, unlinkSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { GatewayError } from '../contracts.js';
import type { Retention } from './config.js';
import { createPrivate } from './files.js';
import { SCHEMA, SCHEMA_VERSION } from './schema.js';
const id = (prefix: string) => `${prefix}_${randomUUID()}`;

export function exportSnapshot(
  sourceDb: DatabaseSync,
  destination: string,
  now: number,
  limits: Retention,
): void {
  let created = false;
  try {
    createPrivate(destination);
    created = true;
    const backup = new DatabaseSync(destination);
    try {
      backup.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');
      backup.exec(SCHEMA);
      backup
        .prepare("INSERT INTO metadata VALUES(1,?,?,'recovery_quarantined',?)")
        .run(SCHEMA_VERSION, id('recovery'), now);
      for (const table of ['machines', 'providers', 'history', 'calls', 'audit', 'management']) {
        for (const source of sourceDb.prepare(`SELECT * FROM ${table}`).all()) {
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
      if (bytes > limits.backup_bytes || bytes > limits.storage_total_bytes)
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
    }
    const fd = openSync(destination, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (created && existsSync(destination)) unlinkSync(destination);
    throw error;
  }
}
