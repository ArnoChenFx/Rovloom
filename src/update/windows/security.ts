// 通过持有的文件句柄读取 owner/DACL；只检查安全边界，不修改已有 ACL、账户或权限。
import { createHash } from 'node:crypto'
import { UpdateError } from '../contract.js'
import { WindowsNativeError, windowsFfi, windowsLibrary, windowsPointer, windowsWide } from './native.js'

export type WindowsAce = Readonly<{ kind: 'allow' | 'deny'; sid: string; mask: number; inheritOnly: boolean }>
export type WindowsSecuritySnapshot = Readonly<{
  owner: string
  group: string
  entries: readonly WindowsAce[]
  canonical: string
  digest: string
}>
type Security = {
  ConvertStringSecurityDescriptorToSecurityDescriptorW(
    text: Buffer,
    revision: number,
    descriptor: Buffer,
    size: number
  ): number
  OpenProcessToken(process: bigint, access: number, token: Buffer): number
  GetTokenInformation(token: bigint, information: number, bytes: Buffer, size: number, needed: Buffer): number
  GetSecurityInfo(
    handle: bigint,
    object: number,
    information: number,
    owner: Buffer,
    group: Buffer,
    acl: Buffer,
    sacl: number,
    descriptor: Buffer
  ): number
  GetAclInformation(acl: number, bytes: Buffer, size: number, information: number): number
  GetAce(acl: number, index: number, entry: Buffer): number
  GetLengthSid(sid: number): number
  IsValidSid(sid: number): number
  ConvertSidToStringSidW(sid: number, text: Buffer): number
  ConvertSecurityDescriptorToStringSecurityDescriptorW(
    descriptor: number,
    revision: number,
    information: number,
    text: Buffer,
    length: Buffer
  ): number
  LookupAccountNameW(
    system: number,
    account: Buffer,
    sid: Buffer,
    sidLength: Buffer,
    domain: Buffer,
    domainLength: Buffer,
    use: Buffer
  ): number
}
type Kernel = {
  GetCurrentProcess(): bigint
  GetLastError(): number
  CloseHandle(handle: bigint): number
  LocalFree(memory: bigint): bigint
  lstrlenW(text: number): number
}
let security: Security | undefined
let kernel: Kernel | undefined
let user: string | undefined
let installer: string | undefined

// 两个固定系统库只包含读取安全描述符和回收自有内存/句柄所需的符号。
function api(): { security: Security; kernel: Kernel } {
  security ??= windowsLibrary<Security>('advapi32', {
    ConvertStringSecurityDescriptorToSecurityDescriptorW: { args: ['buffer', 'u32', 'buffer', 'ptr'], returns: 'i32' },
    OpenProcessToken: { args: ['u64', 'u32', 'buffer'], returns: 'i32' },
    GetTokenInformation: { args: ['u64', 'u32', 'buffer', 'u32', 'buffer'], returns: 'i32' },
    GetSecurityInfo: { args: ['u64', 'u32', 'u32', 'buffer', 'buffer', 'buffer', 'ptr', 'buffer'], returns: 'u32' },
    GetAclInformation: { args: ['ptr', 'buffer', 'u32', 'u32'], returns: 'i32' },
    GetAce: { args: ['ptr', 'u32', 'buffer'], returns: 'i32' },
    GetLengthSid: { args: ['ptr'], returns: 'u32' },
    IsValidSid: { args: ['ptr'], returns: 'i32' },
    ConvertSidToStringSidW: { args: ['ptr', 'buffer'], returns: 'i32' },
    ConvertSecurityDescriptorToStringSecurityDescriptorW: {
      args: ['ptr', 'u32', 'u32', 'buffer', 'buffer'],
      returns: 'i32'
    },
    LookupAccountNameW: { args: ['ptr', 'buffer', 'buffer', 'buffer', 'buffer', 'buffer', 'buffer'], returns: 'i32' }
  })
  kernel ??= windowsLibrary<Kernel>('kernel32', {
    GetCurrentProcess: { args: [], returns: 'u64' },
    GetLastError: { args: [], returns: 'u32' },
    CloseHandle: { args: ['u64'], returns: 'i32' },
    LocalFree: { args: ['u64'], returns: 'u64' },
    lstrlenW: { args: ['ptr'], returns: 'i32' }
  })
  return { security, kernel }
}

// 安全描述符仅用于新建自有私有目录；绝不应用到既有安装、目录或用户数据。
export function windowsPrivateAttributes(): Readonly<{ bytes: Buffer; dispose(): void }> {
  const { security: a, kernel: k } = api()
  const sid = windowsCurrentSid()
  const text = `O:${sid}D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${sid})`
  const output = Buffer.alloc(8)
  if (!a.ConvertStringSecurityDescriptorToSecurityDescriptorW(windowsWide(text), 1, output, 0)) {
    throw new WindowsNativeError(k.GetLastError())
  }
  const pointer = output.readBigUInt64LE()
  const bytes = Buffer.alloc(24)
  bytes.writeUInt32LE(24)
  bytes.writeBigUInt64LE(pointer, 8)
  let disposed = false
  return Object.freeze({
    bytes,
    dispose: /* 显式释放本次构造的描述符，不把失败交给 GC。 */ () => {
      if (!disposed) {
        if (k.LocalFree(pointer) !== 0n) {
          throw new UpdateError('staging_failed')
        }
        disposed = true
      }
    }
  })
}

// 原生字符串由系统分配并 NUL 终止，先查询长度再复制，不能越过分配大小扫描缓冲区。
function sidText(pointer: number): string {
  const { security: a, kernel: k } = api()
  if (!a.IsValidSid(pointer) || a.GetLengthSid(pointer) > 68) {
    throw new UpdateError('unsafe_installation')
  }
  const output = Buffer.alloc(8)
  if (!a.ConvertSidToStringSidW(pointer, output)) {
    throw new WindowsNativeError(k.GetLastError())
  }
  const allocation = output.readBigUInt64LE()
  let result: string | undefined
  let failure: unknown
  try {
    const text = windowsPointer(allocation)
    const count = k.lstrlenW(text)
    if (count < 3 || count > 184) {
      throw new UpdateError('unsafe_installation')
    }
    result = Buffer.from(windowsFfi().toArrayBuffer(text, 0, count * 2)).toString('utf16le')
    if (!/^S-1-(?:\d+-)*\d+$/u.test(result)) {
      throw new UpdateError('unsafe_installation')
    }
  } catch (error) {
    failure = error
  }
  const freed = k.LocalFree(allocation) === 0n
  if (failure) {
    throw failure
  }
  if (!freed) {
    throw new UpdateError('staging_failed')
  }
  return result!
}

// 只读取当前进程 token 的 SID，不提升权限，不接受 caller 选择账户或 token。
export function windowsCurrentSid(): string {
  if (user) {
    return user
  }
  const { security: a, kernel: k } = api()
  const output = Buffer.alloc(8)
  if (!a.OpenProcessToken(k.GetCurrentProcess(), 8, output)) {
    throw new WindowsNativeError(k.GetLastError())
  }
  const handle = output.readBigUInt64LE()
  let result: string | undefined
  let failure: unknown
  try {
    const bytes = Buffer.alloc(256)
    if (!a.GetTokenInformation(handle, 1, bytes, bytes.length, Buffer.alloc(4))) {
      throw new WindowsNativeError(k.GetLastError())
    }
    const sid = windowsPointer(bytes.readBigUInt64LE())
    const base = windowsFfi().ptr(bytes)
    if (sid < base || sid + 68 > base + bytes.length) {
      throw new UpdateError('unsafe_installation')
    }
    result = sidText(sid)
  } catch (error) {
    failure = error
  }
  const closed = k.CloseHandle(handle) !== 0
  if (failure) {
    throw failure
  }
  if (!closed) {
    throw new WindowsNativeError(k.GetLastError())
  }
  user = result!
  return user
}

// TrustedInstaller 仅通过固定系统服务账户解析；未知/不存在时不能扩大为任意服务 SID。
function trustedInstaller(): string {
  if (installer) {
    return installer
  }
  const { security: a, kernel: k } = api()
  const sid = Buffer.alloc(256)
  const size = Buffer.alloc(4)
  size.writeUInt32LE(sid.length)
  const domain = Buffer.alloc(512)
  const count = Buffer.alloc(4)
  count.writeUInt32LE(domain.length / 2)
  if (
    !a.LookupAccountNameW(0, windowsWide('NT SERVICE\\TrustedInstaller'), sid, size, domain, count, Buffer.alloc(4))
  ) {
    throw new WindowsNativeError(k.GetLastError())
  }
  installer = sidText(windowsFfi().ptr(sid))
  return installer
}

// 保守检查 owner 的隐式 WRITE_DAC 及不可信 allow ACE；不把 deny 当成可安全忽略的授权覆盖。
export function checkWindowsAcl(
  owner: string,
  entries: readonly WindowsAce[],
  current: string,
  systemInstaller: string,
  ancestor: boolean
): void {
  const trusted = new Set([current, 'S-1-5-18', 'S-1-5-32-544', systemInstaller])
  if (!trusted.has(owner) || entries.length > 1024) {
    throw new UpdateError('unsafe_installation')
  }
  // 祖先允许创建其它子目录，但不允许替换/删除既有组件、修改属性或写安全描述符。
  const forbidden = ancestor ? 0x500d0152 : 0x500d0116
  for (const entry of entries) {
    if (
      !['allow', 'deny'].includes(entry.kind) ||
      !Number.isInteger(entry.mask) ||
      entry.mask < 0 ||
      entry.mask > 0xffffffff
    ) {
      throw new UpdateError('unsafe_installation')
    }
    if (!entry.inheritOnly && entry.kind === 'allow' && !trusted.has(entry.sid) && (entry.mask & forbidden) !== 0) {
      throw new UpdateError('unsafe_installation')
    }
  }
}

// 对同一持有文件对象读取 owner/DACL 与规范 SDDL；未知 ACE 类型、NULL DACL 和超预算均拒绝。
export function inspectWindowsFileSecurity(handle: bigint, ancestor: boolean): WindowsSecuritySnapshot {
  const { security: a, kernel: k } = api()
  const owner = Buffer.alloc(8)
  const group = Buffer.alloc(8)
  const acl = Buffer.alloc(8)
  const descriptor = Buffer.alloc(8)
  const code = a.GetSecurityInfo(handle, 1, 7, owner, group, acl, 0, descriptor)
  if (code !== 0) {
    throw new WindowsNativeError(code)
  }
  const allocation = descriptor.readBigUInt64LE()
  const text = Buffer.alloc(8)
  let result: WindowsSecuritySnapshot | undefined
  let failure: unknown
  try {
    const pAcl = windowsPointer(acl.readBigUInt64LE())
    const info = Buffer.alloc(12)
    if (!a.GetAclInformation(pAcl, info, info.length, 2)) {
      throw new WindowsNativeError(k.GetLastError())
    }
    const count = info.readUInt32LE()
    if (count > 1024 || info.readUInt32LE(4) > 131072) {
      throw new UpdateError('unsafe_installation')
    }
    const entries: WindowsAce[] = []
    for (let index = 0; index < count; index++) {
      const output = Buffer.alloc(8)
      if (!a.GetAce(pAcl, index, output)) {
        throw new WindowsNativeError(k.GetLastError())
      }
      const pointer = windowsPointer(output.readBigUInt64LE())
      const header = Buffer.from(windowsFfi().toArrayBuffer(pointer, 0, 8))
      const type = header[0]!
      const flags = header[1]!
      const length = header.readUInt16LE(2)
      if (![0, 1].includes(type) || length < 16 || length > 76 || a.GetLengthSid(pointer + 8) > length - 8) {
        throw new UpdateError('unsafe_installation')
      }
      entries.push({
        kind: type === 0 ? 'allow' : 'deny',
        sid: sidText(pointer + 8),
        mask: header.readUInt32LE(4),
        inheritOnly: (flags & 8) !== 0
      })
    }
    const ownerSid = sidText(windowsPointer(owner.readBigUInt64LE()))
    const groupSid = group.readBigUInt64LE() === 0n ? '' : sidText(windowsPointer(group.readBigUInt64LE()))
    checkWindowsAcl(ownerSid, entries, windowsCurrentSid(), trustedInstaller(), ancestor)
    const length = Buffer.alloc(4)
    if (!a.ConvertSecurityDescriptorToStringSecurityDescriptorW(windowsPointer(allocation), 1, 7, text, length)) {
      throw new WindowsNativeError(k.GetLastError())
    }
    const units = length.readUInt32LE()
    if (units < 1 || units > 65536) {
      throw new UpdateError('unsafe_installation')
    }
    const pointer = windowsPointer(text.readBigUInt64LE())
    // API 返回分配容量而非实际字符数；只散列 NUL 前的文本，不把分配尾部填充误当权限变化。
    const characters = k.lstrlenW(pointer)
    if (characters < 1 || characters >= units) {
      throw new UpdateError('unsafe_installation')
    }
    const sddl = Buffer.from(windowsFfi().toArrayBuffer(pointer, 0, characters * 2))
    result = Object.freeze({
      owner: ownerSid,
      group: groupSid,
      entries: Object.freeze(entries.map(/* 固定只读权限事实，不返回原生指针。 */ (entry) => Object.freeze(entry))),
      canonical: sddl.toString('utf16le'),
      digest: createHash('sha256').update(sddl).digest('hex')
    })
  } catch (error) {
    failure = error
  }
  const textAllocation = text.readBigUInt64LE()
  const textFreed = !textAllocation || k.LocalFree(textAllocation) === 0n
  const descriptorFreed = k.LocalFree(allocation) === 0n
  if (failure) {
    throw failure
  }
  if (!textFreed || !descriptorFreed) {
    throw new UpdateError('staging_failed')
  }
  return result!
}

// 普通更新身份仅携带摘要，完整权限事实只供受信内部核验，不写公共 CLI 诊断或回执。
export function verifyWindowsFileSecurity(handle: bigint, ancestor: boolean): string {
  return inspectWindowsFileSecurity(handle, ancestor).digest
}
