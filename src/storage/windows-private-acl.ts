// Windows Gateway 私有数据的 ACL 判定；原生句柄读取及数据库 lease 尚未接线，不授予平台支持。
import { GatewayError } from '../contracts.js'
import type { WindowsAce } from '../update/windows/security.js'

export type WindowsPrivateAce = WindowsAce & Readonly<{ fileInherit: boolean; directoryInherit: boolean }>

// 更新器只阻断外部写入；私有数据还必须拒绝外部读取，并保证 SQLite 新 journal 的继承边界。
export function checkWindowsPrivateAcl(
  owner: string,
  entries: readonly WindowsPrivateAce[],
  current: string,
  protectedDacl: boolean,
  directory: boolean
): void {
  if (!/^S-1-(?:\d+-)*\d+$/u.test(current) || owner !== current || !protectedDacl || entries.length > 1024) {
    throw new GatewayError('unsafe_storage_acl')
  }
  const trusted = new Set([current, 'S-1-5-18', 'S-1-5-32-544'])
  let inheritable = !directory
  for (const entry of entries) {
    if (
      !['allow', 'deny'].includes(entry.kind) ||
      !Number.isInteger(entry.mask) ||
      entry.mask < 0 ||
      entry.mask > 0xffffffff ||
      typeof entry.fileInherit !== 'boolean' ||
      typeof entry.directoryInherit !== 'boolean' ||
      typeof entry.inheritOnly !== 'boolean' ||
      (entry.kind === 'allow' && entry.mask !== 0 && !trusted.has(entry.sid))
    ) {
      throw new GatewayError('unsafe_storage_acl')
    }
    if (
      entry.kind === 'allow' &&
      entry.sid === current &&
      !entry.inheritOnly &&
      entry.fileInherit &&
      entry.directoryInherit &&
      (entry.mask & 0x1f01ff) === 0x1f01ff
    ) {
      inheritable = true
    }
  }
  if (!inheritable) {
    throw new GatewayError('unsafe_storage_acl')
  }
}
