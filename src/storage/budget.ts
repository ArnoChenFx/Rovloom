// 汇总内容、结果句柄、备份和磁盘占用；未完成调用只按固定的收尾预约计入，不再逐表统计 JSON 字节。
import type { DatabaseSync } from 'node:sqlite'
import { existsSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { GatewayError } from '../contracts.js'
import type { Retention } from './config.js'
import { SCHEMA } from './schema.js'
import { managedBytes } from './files.js'
import { assertSnapshotDirectoryBoundary } from './snapshot-directory.js'

// 检查当前占用与待收尾预约；准入时额外保留应急空间，任一项超限即拒绝。
export function assertBudget(
  db: DatabaseSync,
  path: string,
  limits: Retention,
  backupDirectory: string | undefined,
  admission: boolean,
  extraBackupBytes = 0
): void {
  // SQLite 触发器与内容/预约/结果变化同事务提交或回滚；热路径不再扫描历史。
  const usage = db
    .prepare('SELECT content_bytes,result_bytes,reserved_bytes FROM storage_usage WHERE singleton=1')
    .get()
  if (!usage) {
    throw new GatewayError('database_integrity_failed')
  }
  if (Number(usage.content_bytes) > limits.content_bytes) {
    throw new GatewayError('content_quota')
  }
  if (Number(usage.result_bytes) > limits.content_bytes) {
    throw new GatewayError('result_quota')
  }
  const pages =
    Number(db.prepare('PRAGMA page_count').get()!.page_count) * Number(db.prepare('PRAGMA page_size').get()!.page_size)
  // 扫描前复核目录边界：被换成软链接时按无效目录拒绝，不能把目录外占用计入或掩盖真实占用。
  if (backupDirectory) {
    assertSnapshotDirectoryBoundary(backupDirectory)
  }
  const backupBytes = backupDirectory && existsSync(backupDirectory) ? managedBytes(backupDirectory) : 0
  if (backupBytes + extraBackupBytes > limits.backup_bytes) {
    throw new GatewayError('backup_quota')
  }
  const bytes =
    (path === ':memory:' ? pages : managedBytes(dirname(path)) + Math.max(0, pages - statSync(path).size)) + backupBytes
  const reserved = Number(usage.reserved_bytes)
  if (
    reserved > limits.storage_reserve_bytes ||
    bytes + reserved + extraBackupBytes > limits.storage_total_bytes - (admission ? limits.storage_reserve_bytes : 0)
  ) {
    throw new GatewayError('storage_exhausted')
  }
}

/** 只在启动与离线检查重算用量，防止损坏的计数进入准入；不会修正或写库。 */
export function assertUsage(db: DatabaseSync): void {
  // 零用量也不能掩盖丢失/被修改的触发器，否则首次写入就可能绕过计数。
  const triggers = new Set(
    db
      .prepare("SELECT sql FROM sqlite_schema WHERE type='trigger'")
      .all()
      .map((row) => String(row.sql))
  )
  const expected = SCHEMA.match(/CREATE TRIGGER (?:calls|results)_usage_[a-z]+ [\s\S]*?END;/gu) ?? []
  if (expected.length !== 6 || expected.some((sql) => !triggers.has(sql.slice(0, -1)))) {
    throw new GatewayError('database_integrity_failed')
  }
  const actual = db
    .prepare(`SELECT
    (SELECT COALESCE(SUM(COALESCE(length(CAST(request_json AS BLOB)),0)+COALESCE(length(CAST(response AS BLOB)),0)),0) FROM calls) content_bytes,
    (SELECT COALESCE(SUM(bytes),0) FROM results) result_bytes,
    (SELECT COALESCE(SUM(reserved),0) FROM calls) reserved_bytes`)
    .get()!
  const stored = db
    .prepare('SELECT content_bytes,result_bytes,reserved_bytes FROM storage_usage WHERE singleton=1')
    .get()
  if (!stored || Object.keys(actual).some((key) => actual[key] !== stored[key])) {
    throw new GatewayError('database_integrity_failed')
  }
}
