/** 快照只由固定同级目录托管；运行中的 Gateway 与离线命令复用同一清理和预算边界。 */
import { lstatSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { GatewayError } from '../contracts.js'
import { databasePath } from './files.js'

/** 从真实数据库位置选择固定目录，不信任备份登记中的任意路径或目录软链接。 */
export function snapshotDirectory(database: string): string {
  return realpathSync(dirname(databasePath(database))) + '.backups'
}

/** 复核固定目录的当前状态：缺失仍保留清理边界且不创建；已有位置必须是普通目录，不能重定向。 */
export function assertSnapshotDirectoryBoundary(directory: string): void {
  let entry
  try {
    entry = lstatSync(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw error
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new GatewayError('invalid_backup_directory')
  }
}

/** 打开时按数据库位置选定固定目录，并复核其边界。 */
export function configuredSnapshotDirectory(database: string): string {
  const directory = snapshotDirectory(database)
  assertSnapshotDirectoryBoundary(directory)
  return directory
}
