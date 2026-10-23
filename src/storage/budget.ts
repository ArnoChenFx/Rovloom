// 汇总内容、结果句柄、备份和磁盘占用；未完成调用只按固定的收尾预约计入，不再逐表统计 JSON 字节。
import type { DatabaseSync } from 'node:sqlite'
import { existsSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { GatewayError } from '../contracts.js'
import type { Retention } from './config.js'
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
  // 执行返回单行 n 字段的聚合查询，并将 SQLite 结果转换为数值。
  const sum = (sql: string) => Number(db.prepare(sql).get()!.n)
  const content = sum(
    'SELECT COALESCE(SUM(COALESCE(length(CAST(request_json AS BLOB)),0)+COALESCE(length(CAST(response AS BLOB)),0)),0) n FROM calls'
  )
  if (content > limits.content_bytes) {
    throw new GatewayError('content_quota')
  }
  if (sum('SELECT COALESCE(SUM(bytes),0) n FROM results') > limits.content_bytes) {
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
  const reserved = sum('SELECT COALESCE(SUM(reserved),0) n FROM calls')
  if (
    reserved > limits.storage_reserve_bytes ||
    bytes + reserved + extraBackupBytes > limits.storage_total_bytes - (admission ? limits.storage_reserve_bytes : 0)
  ) {
    throw new GatewayError('storage_exhausted')
  }
}
