// 只读固定LocalService SID的系统profile记录；不读取管理员HOME、不展开调用者环境或创建登录token。
import { win32 } from 'node:path'
import { windowsLibrary, windowsWide } from '../update/windows/native.js'
import { ServiceError } from './types.js'

type ProfileRecord = { path: string; expanded: boolean; windows: string }
type Registry = {
  RegGetValueW(
    key: bigint,
    subkey: Buffer,
    value: Buffer,
    flags: number,
    type: Buffer,
    data: Buffer,
    size: Buffer
  ): number
}
type Kernel = { GetWindowsDirectoryW(path: Buffer, size: number): number }
let registry: Registry | undefined
let kernel: Kernel | undefined

// RegGetValue限制64位系统键及字符串类型且禁止环境展开；使用固定缓冲预算，不回退当前用户profile。
function profileRecord(): ProfileRecord {
  registry ??= windowsLibrary<Registry>('advapi32', {
    RegGetValueW: { args: ['u64', 'buffer', 'buffer', 'u32', 'buffer', 'buffer', 'buffer'], returns: 'i32' }
  })
  kernel ??= windowsLibrary<Kernel>('kernel32', { GetWindowsDirectoryW: { args: ['buffer', 'u32'], returns: 'u32' } })
  const system = Buffer.alloc(520)
  const units = kernel.GetWindowsDirectoryW(system, 260)
  if (units < 3 || units >= 260) {
    throw new ServiceError('config_path_required')
  }
  const bytes = Buffer.alloc(8194)
  const size = Buffer.alloc(4)
  size.writeUInt32LE(bytes.length)
  const type = Buffer.alloc(4)
  const code = registry.RegGetValueW(
    0xffffffff80000002n,
    windowsWide('SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\S-1-5-19'),
    windowsWide('ProfileImagePath'),
    0x10010006,
    type,
    bytes,
    size
  )
  const count = size.readUInt32LE()
  if (
    code !== 0 ||
    ![1, 2].includes(type.readUInt32LE()) ||
    count < 4 ||
    count > bytes.length ||
    count % 2 !== 0 ||
    bytes.readUInt16LE(count - 2) !== 0
  ) {
    throw new ServiceError('config_path_required')
  }
  return {
    path: bytes.toString('utf16le', 0, count - 2),
    expanded: type.readUInt32LE() === 2,
    windows: system.toString('utf16le', 0, units * 2)
  }
}

// 仅将系统根占位符替换为系统API事实；这里只解析账户home，实际owner/私有ACL/祖先由安装器租约再核验。
export function windowsServiceHome(read: () => ProfileRecord = profileRecord): string {
  let record: ProfileRecord
  try {
    record = read()
  } catch {
    throw new ServiceError('config_path_required')
  }
  const path = record.expanded ? record.path.replace(/^%systemroot%(?=\\)/iu, record.windows) : record.path
  if (
    !/^[A-Za-z]:\\/u.test(path) ||
    win32.normalize(path) !== path ||
    path.includes('%') ||
    path.slice(3).includes(':') ||
    Array.from(path).some(
      /* NUL及不可见系统分隔符不能成为home。 */ (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127
    )
  ) {
    throw new ServiceError('config_path_required')
  }
  return path
}
