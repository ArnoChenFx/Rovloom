/** 快照只由固定同级目录托管；运行中的 Gateway 与离线命令复用同一清理和预算边界。 */
import { lstatSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { GatewayError } from '../contracts.js'
import { databasePath } from './files.js'

/** 从真实数据库位置选择固定目录，不信任备份登记中的任意路径或目录软链接。 */
export function snapshotDirectory(database: string): string {
  return realpathSync(dirname(databasePath(database))) + '.backups'
}

/** 缺失目录仍保留固定清理边界且不创建；已有位置必须是普通目录，不能重定向。 */
export function configuredSnapshotDirectory(database: string): string {
  const directory = snapshotDirectory(database)
  let entry
  try {
    entry = lstatSync(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return directory
    }
    throw error
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new GatewayError('invalid_backup_directory')
  }
  return directory
}
