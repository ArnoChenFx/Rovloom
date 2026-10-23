/** 快照只由固定同级目录托管；运行中的 Gateway 与离线命令复用同一清理和预算边界。 */
import { lstatSync, realpathSync, unlinkSync } from 'node:fs'
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

/** 只清理本次导出所在的普通目录；目录消失、替换或清理失败时保留产物，不能覆盖原失败。 */
export function snapshotCleanup(directory: string): (path: string) => void {
  const original = lstatSync(directory)
  if (!original.isDirectory() || original.isSymbolicLink()) {
    throw new GatewayError('invalid_backup_directory')
  }
  return (path) => {
    if (dirname(path) !== directory) {
      return
    }
    try {
      const current = lstatSync(directory)
      if (
        current.isDirectory() &&
        !current.isSymbolicLink() &&
        current.dev === original.dev &&
        current.ino === original.ino
      ) {
        unlinkSync(path)
      }
    } catch {
      // 路径已不再属于本次产物或无法安全清理：保留现场，不沿链接查找，也不掩盖主错误。
    }
  }
}
