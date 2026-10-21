/** Luvus Connector 崩溃（kill -9 / 掉电）后的锁恢复：只有证明持有者进程已死才接管，其余一律保持 fail-closed。 */
import { lstatSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { syncParentDirectory } from '../storage/files.js'
import { currentProcessIdentity, listening, ownerIsDead } from '../storage/process-identity.js'
import type { ProcessIdentity } from '../storage/process-identity.js'
import { nativeRecordStamp, readNativeRecord, removeNativeRecord } from './native-record-files.js'
import { LUVUS_CLAIMS_LOCK_FORMAT } from '../connector/luvus/claims.js'
import type { LuvusLocalConfig } from '../connector/luvus/types.js'

export const LUVUS_OWNER_FORMAT = 'rovloom-luvus-owner-v1'

/** 带本进程身份的锁内容；没有死亡证据的平台写空内容，保持旧的 fail-closed 语义。 */
export function lockOwnerFields(): Readonly<{ process: ProcessIdentity }> | undefined {
  const identity = currentProcessIdentity()
  return identity ? Object.freeze({ process: identity }) : undefined
}

/** 解析 owner 身份；格式、字段或类型任何不符都视为无证据。 */
function recordedProcess(value: unknown, format: string): ProcessIdentity | undefined {
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
function ownedFile(path: string): boolean | undefined {
  try {
    const info = lstatSync(path)
    // Windows 没有 uid：锁所在目录的属主/ACL 已由账本的 protectedPath 核验。
    return info.isFile() && (process.platform === 'win32' || info.uid === process.geteuid!()) ? true : undefined
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : undefined
  }
}

/**
 * claim 账本互斥锁：内容带持有者进程身份且该进程已死，才删除锁（SQLite 回滚日志在下次打开时自行恢复，
 * 账本里的派发墓碑原样保留）。空锁、旧格式或无法判断时返回 false，沿用原 fail-closed。
 */
export function recoverLuvusClaimsLock(lockPath: string): boolean {
  if (ownedFile(lockPath) !== true) {
    return false
  }
  let recorded: ProcessIdentity | undefined
  try {
    const bytes = readFileSync(lockPath)
    if (bytes.length === 0 || bytes.length > 1024) {
      return false
    }
    recorded = recordedProcess(JSON.parse(bytes.toString('utf8')), LUVUS_CLAIMS_LOCK_FORMAT)
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

/**
 * root 拥有锁：记录的 Connector 已死，且该会话的 Luvus 端点都无人监听（没有孤儿 server）时才移除。
 * 孤儿 server 仍在监听、锁无身份或证据不确定时返回 false，调用方沿用原 fail-closed。
 */
export async function recoverLuvusOwnerLock(
  ownerLockPath: string,
  config: Pick<LuvusLocalConfig, 'state_root' | 'target'>
): Promise<boolean> {
  if (ownedFile(ownerLockPath) !== true) {
    return false
  }
  let stamp: string
  let recorded: ProcessIdentity | undefined
  try {
    const read = readNativeRecord(ownerLockPath)
    stamp = read.stamp
    recorded = recordedProcess(read.value, LUVUS_OWNER_FORMAT)
  } catch {
    return false
  }
  if (!recorded || !ownerIsDead(recorded)) {
    return false
  }
  const directory = join(config.state_root, 'sessions', config.target.session)
  for (const name of ['luvus.sock', 'luvus-client.sock']) {
    const path = join(directory, name)
    try {
      const info = lstatSync(path)
      if (!info.isSocket() || info.uid !== process.geteuid!() || (await listening(path))) {
        return false
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return false
      }
    }
  }
  try {
    if (nativeRecordStamp(ownerLockPath) !== stamp) {
      return false
    }
    removeNativeRecord(ownerLockPath, stamp)
  } catch {
    return false
  }
  return true
}
