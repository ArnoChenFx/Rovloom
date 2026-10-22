/**
 * Windows 本机身份原语（bun:ffi 调用 Win32），对应 Linux 上的 uid/mode、SO_PEERCRED 与 /proc：
 * 路径信任（属主 + DACL）、命名管道服务端 pid、进程镜像路径与创建时间。
 * 只在 win32 上有效；其它平台调用即抛 `windows_platform_required`，不提供伪造的等价物。
 */
import { lstatSync } from 'node:fs'
import { parse, win32 } from 'node:path'
import { createRequire } from 'node:module'

export class WindowsPlatformError extends Error {
  /** 只保留固定错误码，不携带路径、SID 或系统错误文本。 */
  constructor(readonly code: string) {
    super(code)
    this.name = 'WindowsPlatformError'
  }
}

/** 可信属主：当前用户、SYSTEM、Administrators、TrustedInstaller。 */
const SYSTEM_SID = 'S-1-5-18'
const ADMINISTRATORS_SID = 'S-1-5-32-544'
const TRUSTED_INSTALLER_SID = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
/** 范围过宽的主体：它们对路径拥有写类权限时，该路径不再是私有的。 */
const BROAD_SIDS = new Set([
  'S-1-1-0', // Everyone
  'S-1-5-11', // Authenticated Users
  'S-1-5-32-545', // Users
  'S-1-5-7', // Anonymous
  'S-1-5-4', // Interactive
  'S-1-5-2', // Network
  'S-1-2-1' // Console Logon
])
/** 写数据/追加（建子项）/写扩展属性/删除子项/写属性/DELETE/WRITE_DAC/WRITE_OWNER/GENERIC_WRITE/GENERIC_ALL。 */
const WRITE_MASK = 0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x10000 | 0x40000 | 0x80000 | 0x40000000 | 0x10000000
const INHERIT_ONLY_ACE = 0x08
const INVALID_HANDLE = 0xffffffffffffffffn

type Pointer = Uint8Array | null
type Kernel = {
  CreateFileW(
    path: Pointer,
    access: number,
    share: number,
    security: Pointer,
    creation: number,
    flags: number,
    template: bigint
  ): bigint
  CloseHandle(handle: bigint): number
  GetNamedPipeServerProcessId(handle: bigint, out: Pointer): number
  OpenProcess(access: number, inherit: number, pid: number): bigint
  QueryFullProcessImageNameW(handle: bigint, flags: number, path: Pointer, size: Pointer): number
  GetProcessTimes(handle: bigint, creation: Pointer, exit: Pointer, kernel: Pointer, user: Pointer): number
  GetExitCodeProcess(handle: bigint, out: Pointer): number
  GetCurrentProcess(): bigint
  LocalFree(handle: bigint): bigint
}
type Advanced = {
  GetNamedSecurityInfoW(
    name: Pointer,
    type: number,
    information: number,
    owner: Pointer,
    group: Pointer,
    dacl: Pointer,
    sacl: Pointer,
    descriptor: Pointer
  ): number
  ConvertSidToStringSidW(sid: bigint, out: Pointer): number
  OpenProcessToken(process: bigint, access: number, out: Pointer): number
  GetTokenInformation(token: bigint, kind: number, buffer: Pointer, length: number, returned: Pointer): number
}
type Ffi = {
  dlopen(path: string, symbols: Record<string, { args: string[]; returns: string }>): { symbols: unknown }
  read: {
    u8(pointer: number, offset: number): number
    u16(pointer: number, offset: number): number
    u32(pointer: number, offset: number): number
  }
}
type Api = Readonly<{ kernel: Kernel; advanced: Advanced; read: Ffi['read'] }>

/** 懒加载 DLL：Linux/macOS 上不会触碰 kernel32。 */
function load(): Api {
  const { dlopen, read } = createRequire(import.meta.url)('bun:ffi') as Ffi
  const kernel = dlopen('kernel32.dll', {
    CreateFileW: { args: ['ptr', 'u32', 'u32', 'ptr', 'u32', 'u32', 'u64'], returns: 'u64' },
    CloseHandle: { args: ['u64'], returns: 'i32' },
    GetNamedPipeServerProcessId: { args: ['u64', 'ptr'], returns: 'i32' },
    OpenProcess: { args: ['u32', 'i32', 'u32'], returns: 'u64' },
    QueryFullProcessImageNameW: { args: ['u64', 'u32', 'ptr', 'ptr'], returns: 'i32' },
    GetProcessTimes: { args: ['u64', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'i32' },
    GetExitCodeProcess: { args: ['u64', 'ptr'], returns: 'i32' },
    GetCurrentProcess: { args: [], returns: 'u64' },
    LocalFree: { args: ['u64'], returns: 'u64' }
  })
  const advanced = dlopen('advapi32.dll', {
    GetNamedSecurityInfoW: { args: ['ptr', 'u32', 'u32', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'u32' },
    ConvertSidToStringSidW: { args: ['u64', 'ptr'], returns: 'i32' },
    OpenProcessToken: { args: ['u64', 'u32', 'ptr'], returns: 'i32' },
    GetTokenInformation: { args: ['u64', 'u32', 'ptr', 'u32', 'ptr'], returns: 'i32' }
  })
  return { kernel: kernel.symbols as Kernel, advanced: advanced.symbols as Advanced, read }
}
let api: Api | undefined
/** 只在 Windows 上返回 API；其它平台拒绝，调用方不应走到这里。 */
function win(): Api {
  if (process.platform !== 'win32' || !process.versions.bun) {
    throw new WindowsPlatformError('windows_platform_required')
  }
  api ??= load()
  return api
}

/** UTF-16LE、NUL 结尾的缓冲区，供 *W 系列 API 使用。 */
function wide(text: string): Buffer {
  return Buffer.from(text + '\0', 'utf16le')
}

/** 读 NUL 结尾的 UTF-16 字符串（SID 文本不超过几百字符）。 */
function readWide(pointer: number): string {
  const { read } = win()
  const units: number[] = []
  for (let offset = 0; offset < 1024; offset += 2) {
    const unit = read.u16(pointer, offset)
    if (unit === 0) {
      break
    }
    units.push(unit)
  }
  return String.fromCharCode(...units)
}

/** 把 SID 指针转成字符串；转换失败是固定错误。 */
function sidText(sid: bigint): string {
  const { advanced, kernel } = win()
  const out = Buffer.alloc(8)
  if (!advanced.ConvertSidToStringSidW(sid, out)) {
    throw new WindowsPlatformError('windows_sid_unavailable')
  }
  const text = out.readBigUInt64LE(0)
  try {
    return readWide(Number(text))
  } finally {
    kernel.LocalFree(text)
  }
}

/** 当前进程令牌的用户 SID。 */
export function windowsCurrentUserSid(): string {
  const { advanced, kernel } = win()
  const token = Buffer.alloc(8)
  if (!advanced.OpenProcessToken(kernel.GetCurrentProcess(), 8, token)) {
    throw new WindowsPlatformError('windows_token_unavailable')
  }
  const handle = token.readBigUInt64LE(0)
  try {
    const buffer = Buffer.alloc(512)
    const length = Buffer.alloc(4)
    if (!advanced.GetTokenInformation(handle, 1, buffer, 512, length)) {
      throw new WindowsPlatformError('windows_token_unavailable')
    }
    return sidText(buffer.readBigUInt64LE(0))
  } finally {
    kernel.CloseHandle(handle)
  }
}

export type WindowsPathFacts = Readonly<{ owner: string; broad_write: boolean }>

/** 路径的属主 SID，以及是否有范围过宽的主体拥有写类权限（排除仅继承给子项的 ACE）。 */
export function windowsPathFacts(path: string): WindowsPathFacts {
  const { advanced, kernel, read } = win()
  const owner = Buffer.alloc(8)
  const dacl = Buffer.alloc(8)
  const descriptor = Buffer.alloc(8)
  // SE_FILE_OBJECT，OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION。
  const status = advanced.GetNamedSecurityInfoW(wide(path), 1, 1 | 4, owner, null, dacl, null, descriptor)
  if (status !== 0) {
    throw new WindowsPlatformError('windows_security_unavailable')
  }
  const block = descriptor.readBigUInt64LE(0)
  try {
    const ownerSid = sidText(owner.readBigUInt64LE(0))
    const aclPointer = Number(dacl.readBigUInt64LE(0))
    // 没有 DACL 即任何人完全访问。
    if (aclPointer === 0) {
      return Object.freeze({ owner: ownerSid, broad_write: true })
    }
    const count = read.u16(aclPointer, 4)
    let offset = 8
    let broad = false
    for (let index = 0; index < count && !broad; index++) {
      const type = read.u8(aclPointer, offset)
      const flags = read.u8(aclPointer, offset + 1)
      const size = read.u16(aclPointer, offset + 2)
      // 0 = ACCESS_ALLOWED，9 = ACCESS_ALLOWED_CALLBACK；两者的头、掩码、SID 布局一致。拒绝 ACE 忽略（保守地多报）。
      if ((type === 0 || type === 9) && (flags & INHERIT_ONLY_ACE) === 0) {
        const mask = read.u32(aclPointer, offset + 4)
        if ((mask & WRITE_MASK) !== 0 && BROAD_SIDS.has(sidText(BigInt(aclPointer + offset + 8)))) {
          broad = true
        }
      }
      offset += size
    }
    return Object.freeze({ owner: ownerSid, broad_write: broad })
  } finally {
    kernel.LocalFree(block)
  }
}

export type WindowsPathKind = 'directory' | 'file' | 'binary'

/**
 * 逐级核验路径：不是符号链接/联接点，属主可信，且没有范围过宽的主体可写（卷根只核验类型，不核验 ACL）。
 * 最后一项须满足类型；返回包含文件身份的戳，之后可复核同一对象未被替换。
 */
export function windowsInspectPath(path: string, kind: WindowsPathKind): string {
  if (!win32.isAbsolute(path) || win32.normalize(path) !== path || path.includes('\0') || path.startsWith('\\\\')) {
    throw new WindowsPlatformError('windows_path_invalid')
  }
  const user = windowsCurrentUserSid()
  const trusted = new Set([user, SYSTEM_SID, ADMINISTRATORS_SID, TRUSTED_INSTALLER_SID])
  const root = parse(path).root
  const names = path
    .slice(root.length)
    .split('\\')
    .filter((part) => part.length > 0)
  const stamps: string[] = []
  let current = root
  for (let index = -1; index < names.length; index++) {
    if (index >= 0) {
      current = win32.join(current, names[index]!)
    }
    const entry = lstatSync(current, { bigint: true })
    const last = index === names.length - 1
    if (entry.isSymbolicLink() || (!last && !entry.isDirectory())) {
      throw new WindowsPlatformError('windows_path_untrusted')
    }
    if (index >= 0) {
      const facts = windowsPathFacts(current)
      if (!trusted.has(facts.owner) || facts.broad_write) {
        throw new WindowsPlatformError('windows_path_untrusted')
      }
    }
    if (last) {
      if (
        (kind === 'directory' && !entry.isDirectory()) ||
        ((kind === 'file' || kind === 'binary') && !entry.isFile()) ||
        (kind === 'binary' && entry.size > 64n * 1024n * 1024n)
      ) {
        throw new WindowsPlatformError('windows_path_untrusted')
      }
    }
    stamps.push(
      [
        current,
        entry.dev,
        entry.ino,
        entry.mode,
        last && kind !== 'directory' ? entry.ctimeNs : '',
        last && kind !== 'directory' ? entry.size : ''
      ].join(':')
    )
  }
  return stamps.join('\n')
}

/** 命名管道服务端 pid：打开客户端句柄后由内核回答，不依赖任何文件内容。管道不存在或无法打开即抛错。 */
export function windowsPipeServerPid(pipePath: string): number {
  const { kernel } = win()
  // GENERIC_READ | GENERIC_WRITE，OPEN_EXISTING。
  const handle = kernel.CreateFileW(wide(pipePath), 0xc0000000, 0, null, 3, 0, 0n)
  if (handle === INVALID_HANDLE) {
    throw new WindowsPlatformError('windows_pipe_unavailable')
  }
  try {
    const out = Buffer.alloc(4)
    if (!kernel.GetNamedPipeServerProcessId(handle, out)) {
      throw new WindowsPlatformError('windows_pipe_unavailable')
    }
    return out.readUInt32LE(0)
  } finally {
    kernel.CloseHandle(handle)
  }
}

export type WindowsProcessFacts = Readonly<{ image: string; created: bigint }>

/** 进程镜像完整路径与创建时间（FILETIME，100ns，自 1601）；进程不存在或已退出返回 undefined。 */
export function windowsProcessFacts(pid: number): WindowsProcessFacts | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return undefined
  }
  const { kernel } = win()
  // PROCESS_QUERY_LIMITED_INFORMATION。
  const handle = kernel.OpenProcess(0x1000, 0, pid)
  if (!handle) {
    return undefined
  }
  try {
    // STILL_ACTIVE = 259：已退出但句柄仍可开的进程不算存活。
    const code = Buffer.alloc(4)
    if (!kernel.GetExitCodeProcess(handle, code) || code.readUInt32LE(0) !== 259) {
      return undefined
    }
    const path = Buffer.alloc(2 * 1024)
    const size = Buffer.alloc(4)
    size.writeUInt32LE(1024, 0)
    const times = Buffer.alloc(32)
    if (
      !kernel.QueryFullProcessImageNameW(handle, 0, path, size) ||
      !kernel.GetProcessTimes(
        handle,
        times.subarray(0, 8),
        times.subarray(8, 16),
        times.subarray(16, 24),
        times.subarray(24, 32)
      )
    ) {
      return undefined
    }
    return Object.freeze({
      image: path.toString('utf16le', 0, size.readUInt32LE(0) * 2),
      created: times.readBigUInt64LE(0)
    })
  } finally {
    kernel.CloseHandle(handle)
  }
}

export type WindowsProcessState = Readonly<{ kind: 'dead' } | { kind: 'unknown' } | { kind: 'alive'; start: string }>

/**
 * 进程是否存活：只有内核明确回答“没有该 PID”或进程已退出才算已死；拒绝访问等一切不确定情形为 unknown。
 * alive 带创建时间（FILETIME 十进制），用来区分同一 PID 被复用的无关进程。
 */
export function windowsProcessState(pid: number): WindowsProcessState {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return Object.freeze({ kind: 'unknown' })
  }
  const { kernel } = win()
  // PROCESS_QUERY_LIMITED_INFORMATION。
  const handle = kernel.OpenProcess(0x1000, 0, pid)
  if (!handle) {
    // libuv 把 ERROR_INVALID_PARAMETER 映射为 ESRCH（没有该进程），拒绝访问为 EPERM（存在但无权）。
    try {
      process.kill(pid, 0)
      return Object.freeze({ kind: 'unknown' })
    } catch (error) {
      return Object.freeze({ kind: (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown' })
    }
  }
  try {
    const code = Buffer.alloc(4)
    if (!kernel.GetExitCodeProcess(handle, code)) {
      return Object.freeze({ kind: 'unknown' })
    }
    // STILL_ACTIVE = 259：已退出但句柄仍可开的进程不再持有任何资源。
    if (code.readUInt32LE(0) !== 259) {
      return Object.freeze({ kind: 'dead' })
    }
    const times = Buffer.alloc(32)
    if (
      !kernel.GetProcessTimes(
        handle,
        times.subarray(0, 8),
        times.subarray(8, 16),
        times.subarray(16, 24),
        times.subarray(24, 32)
      )
    ) {
      return Object.freeze({ kind: 'unknown' })
    }
    return Object.freeze({ kind: 'alive', start: times.readBigUInt64LE(0).toString() })
  } finally {
    kernel.CloseHandle(handle)
  }
}
