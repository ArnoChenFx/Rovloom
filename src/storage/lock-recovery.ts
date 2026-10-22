/** 写锁文件的崩溃恢复：锁内容带持有者进程身份，只有证明持有者已死才删除，其余一律保持 fail-closed。 */
import { lstatSync, readFileSync, unlinkSync } from 'node:fs'
import { syncParentDirectory } from './files.js'
import { currentProcessIdentity, ownerIsDead } from './process-identity.js'
import type { ProcessIdentity } from './process-identity.js'

/** 带本进程身份的锁内容；没有死亡证据的平台写空内容，保持不自动接管的语义。 */
export function lockContent(format: string): string {
  const identity = currentProcessIdentity()
  return identity ? JSON.stringify({ format, process: identity }) : ''
}

/** 带本进程身份的锁字段（用于 JSON 记录）；没有死亡证据的平台返回 undefined。 */
export function lockOwnerFields(): Readonly<{ process: ProcessIdentity }> | undefined {
  const identity = currentProcessIdentity()
  return identity ? Object.freeze({ process: identity }) : undefined
}

/** 解析 owner 身份；格式、字段或类型任何不符都视为无证据。 */
export function recordedProcess(value: unknown, format: string): ProcessIdentity | undefined {
  const record = value as { format?: unknown; process?: { pid?: unknown; start?: unknown } } | null
  if (
    record?.format !== format ||
    !Number.isSafeInteger(record.process?.pid) ||
    (record.process!.pid as number) <= 0 ||
    typeof record.process?.start !== 'string'
  ) {
    return undefined
  }
  return Object.freeze({ pid: record.process.pid as number, start: record.process.start })
}

/** 本用户的普通文件才可能是我们留下的锁；其它类型或归属一律放弃恢复。 */
export function ownedFile(path: string): boolean | undefined {
  try {
    const info = lstatSync(path)
    // Windows 没有 uid：锁所在目录的属主/ACL 已由各账本自己的 protectedPath 核验。
    return info.isFile() && (process.platform === 'win32' || info.uid === process.geteuid!()) ? true : undefined
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : undefined
  }
}

/**
 * 互斥锁：内容带持有者进程身份且该进程已死，才删除锁（SQLite 回滚日志在下次打开时自行恢复）。
 * 空锁、旧格式、持有者仍存活或无法判断时返回 false，沿用原 fail-closed。
 */
export function recoverStaleLock(lockPath: string, format: string): boolean {
  if (ownedFile(lockPath) !== true) {
    return false
  }
  let recorded: ProcessIdentity | undefined
  try {
    const bytes = readFileSync(lockPath)
    if (bytes.length === 0 || bytes.length > 1024) {
      return false
    }
    recorded = recordedProcess(JSON.parse(bytes.toString('utf8')), format)
  } catch {
    return false
  }
  if (!recorded || !ownerIsDead(recorded)) {
    return false
  }
  try {
    unlinkSync(lockPath)
    syncParentDirectory(lockPath)
  } catch {
    return false
  }
  return true
}
