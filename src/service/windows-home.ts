// 普通只读查询LocalService的系统profile路径，供服务配置复用唯一角色路径规则。
import { win32 } from 'node:path'
import { windowsLibrary, windowsWide } from '../update/windows/native.js'
import { ServiceError } from './types.js'

type Registry = {
  RegGetValueW(root: bigint, key: Buffer, name: Buffer, flags: number, type: Buffer, data: Buffer, size: Buffer): number
}
type Kernel = { GetWindowsDirectoryW(path: Buffer, length: number): number }
let registry: Registry | undefined
let kernel: Kernel | undefined

// 读取固定LocalService记录的字符串；不创建profile、登录token或展开安装管理员的环境。
function readLocalServiceHome(): string {
  registry ??= windowsLibrary<Registry>('advapi32', {
    RegGetValueW: { args: ['u64', 'buffer', 'buffer', 'u32', 'buffer', 'buffer', 'buffer'], returns: 'i32' }
  })
  const bytes = Buffer.alloc(8194)
  const length = Buffer.alloc(4)
  length.writeUInt32LE(bytes.length)
  const type = Buffer.alloc(4)
  const result = registry.RegGetValueW(
    0xffffffff80000002n,
    windowsWide('SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\S-1-5-19'),
    windowsWide('ProfileImagePath'),
    0x10010006,
    type,
    bytes,
    length
  )
  const count = length.readUInt32LE()
  if (
    result !== 0 ||
    ![1, 2].includes(type.readUInt32LE()) ||
    count < 4 ||
    count > bytes.length ||
    count % 2 !== 0 ||
    bytes.readUInt16LE(count - 2) !== 0
  ) {
    throw new ServiceError('config_path_required')
  }
  let home = bytes.toString('utf16le', 0, count - 2)
  if (type.readUInt32LE() === 2 && /^%SystemRoot%(?=\\)/iu.test(home)) {
    kernel ??= windowsLibrary<Kernel>('kernel32', {
      GetWindowsDirectoryW: { args: ['buffer', 'u32'], returns: 'u32' }
    })
    const system = Buffer.alloc(520)
    const units = kernel.GetWindowsDirectoryW(system, 260)
    if (units < 3 || units >= 260) {
      throw new ServiceError('config_path_required')
    }
    home = system.toString('utf16le', 0, units * 2) + home.slice(12)
  }
  return home
}

// 只接受系统账户的单个规范绝对home；失败要求显式配置，不回退安装管理员的用户目录。
export function windowsServiceHome(read: () => string = readLocalServiceHome): string {
  let home: string
  try {
    home = read()
  } catch {
    throw new ServiceError('config_path_required')
  }
  if (
    !/^[A-Za-z]:\\/u.test(home) ||
    home.length > 4096 ||
    win32.normalize(home) !== home ||
    win32.parse(home).root === home ||
    home.includes('%') ||
    home.slice(3).includes(':') ||
    Array.from(home).some(
      /* 控制字符不能拼入角色配置文件名。 */ (value) => value.charCodeAt(0) < 32 || value.charCodeAt(0) === 127
    )
  ) {
    throw new ServiceError('config_path_required')
  }
  return home
}
