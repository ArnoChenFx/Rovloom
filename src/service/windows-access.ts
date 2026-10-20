// 使用系统Authz评估固定服务SID对已核验安全描述符的访问；不登录、不改ACL，不把SID模拟称为实际服务执行。
import { ServiceError } from './types.js'
import { windowsFfi, windowsLibrary, windowsPointer, windowsWide } from '../update/windows/native.js'

export const WINDOWS_SERVICE_ACCESS = Object.freeze({ read: 0x120089, execute: 0x1200a9, dataDirectory: 0x1301ff })
type Kernel = { GetLastError(): number; LocalFree(pointer: bigint): bigint }
type Security = {
  ConvertStringSidToSidW(text: Buffer, output: Buffer): number
  ConvertStringSecurityDescriptorToSecurityDescriptorW(
    text: Buffer,
    revision: number,
    output: Buffer,
    size: number
  ): number
  GetSecurityDescriptorDacl(descriptor: number, present: Buffer, acl: Buffer, defaults: Buffer): number
  GetAclInformation(acl: number, info: Buffer, size: number, kind: number): number
  GetAce(acl: number, index: number, output: Buffer): number
}
type Authz = {
  AuthzInitializeResourceManager(
    flags: number,
    access: number,
    groups: number,
    free: number,
    name: number,
    output: Buffer
  ): number
  AuthzInitializeContextFromSid(
    flags: number,
    sid: number,
    manager: bigint,
    expiration: number,
    id: bigint,
    groups: number,
    output: Buffer
  ): number
  AuthzAccessCheck(
    flags: number,
    context: bigint,
    request: Buffer,
    audit: bigint,
    descriptor: number,
    optional: number,
    count: number,
    reply: Buffer,
    results: number
  ): number
  AuthzFreeContext(context: bigint): number
  AuthzFreeResourceManager(manager: bigint): number
}
let kernel: Kernel | undefined
let security: Security | undefined
let authz: Authz | undefined

// DLL路径和ABI均固定在源码；64位结构布局适用现有锁定Bun的Windows x64/arm64。
function api() {
  kernel ??= windowsLibrary<Kernel>('kernel32', {
    GetLastError: { args: [], returns: 'u32' },
    LocalFree: { args: ['u64'], returns: 'u64' }
  })
  security ??= windowsLibrary<Security>('advapi32', {
    ConvertStringSidToSidW: { args: ['buffer', 'buffer'], returns: 'i32' },
    ConvertStringSecurityDescriptorToSecurityDescriptorW: { args: ['buffer', 'u32', 'buffer', 'ptr'], returns: 'i32' },
    GetSecurityDescriptorDacl: { args: ['ptr', 'buffer', 'buffer', 'buffer'], returns: 'i32' },
    GetAclInformation: { args: ['ptr', 'buffer', 'u32', 'u32'], returns: 'i32' },
    GetAce: { args: ['ptr', 'u32', 'buffer'], returns: 'i32' }
  })
  authz ??= windowsLibrary<Authz>('authz', {
    AuthzInitializeResourceManager: { args: ['u32', 'ptr', 'ptr', 'ptr', 'ptr', 'buffer'], returns: 'i32' },
    AuthzInitializeContextFromSid: { args: ['u32', 'ptr', 'u64', 'ptr', 'u64', 'ptr', 'buffer'], returns: 'i32' },
    AuthzAccessCheck: { args: ['u32', 'u64', 'buffer', 'u64', 'ptr', 'ptr', 'u32', 'buffer', 'ptr'], returns: 'i32' },
    AuthzFreeContext: { args: ['u64'], returns: 'i32' },
    AuthzFreeResourceManager: { args: ['u64'], returns: 'i32' }
  })
  return { k: kernel, s: security, a: authz }
}

// SID上下文不含全部服务登录特征；先拒绝deny/条件或对象ACE，避免遗漏登录组的deny被当作允许。
function simpleAllowAcl(descriptor: number): void {
  const { s, k } = api()
  const present = Buffer.alloc(4)
  const pointer = Buffer.alloc(8)
  if (!s.GetSecurityDescriptorDacl(descriptor, present, pointer, Buffer.alloc(4))) {
    throw new ServiceError('unsafe_installation', k.GetLastError())
  }
  if (present.readUInt32LE() !== 1 || pointer.readBigUInt64LE() === 0n) {
    throw new ServiceError('unsafe_installation')
  }
  const acl = windowsPointer(pointer.readBigUInt64LE())
  const info = Buffer.alloc(12)
  if (!s.GetAclInformation(acl, info, info.length, 2) || info.readUInt32LE() > 1024) {
    throw new ServiceError('unsafe_installation')
  }
  for (let index = 0; index < info.readUInt32LE(); index++) {
    const entry = Buffer.alloc(8)
    if (!s.GetAce(acl, index, entry)) {
      throw new ServiceError('unsafe_installation', k.GetLastError())
    }
    const header = new Uint8Array(windowsFfi().toArrayBuffer(windowsPointer(entry.readBigUInt64LE()), 0, 4))
    if (header[0] !== 0) {
      throw new ServiceError('unsafe_installation')
    }
  }
}

// 评估前提是调用者已持有同一对象并证明owner/DACL/祖先可信；本函数不代替路径租约或保密策略。
export function windowsAccountHasAccess(sddl: string, sid: string, desired: number): boolean {
  if (
    typeof sddl !== 'string' ||
    sddl.length > 65536 ||
    sid !== 'S-1-5-19' ||
    !Number.isSafeInteger(desired) ||
    desired < 1 ||
    desired > 0x1fffff
  ) {
    throw new ServiceError('invalid_arguments')
  }
  const { k, s, a } = api()
  const subject = Buffer.alloc(8)
  const descriptor = Buffer.alloc(8)
  const manager = Buffer.alloc(8)
  const context = Buffer.alloc(8)
  let granted = false
  let failure: unknown
  try {
    if (
      !s.ConvertStringSidToSidW(windowsWide(sid), subject) ||
      !s.ConvertStringSecurityDescriptorToSecurityDescriptorW(windowsWide(sddl), 1, descriptor, 0)
    ) {
      throw new ServiceError('unsafe_installation', k.GetLastError())
    }
    const sd = windowsPointer(descriptor.readBigUInt64LE())
    simpleAllowAcl(sd)
    // NO_AUDIT不请求审计特权；不计算或启用额外特权，也不回退到当前管理员token。
    if (
      !a.AuthzInitializeResourceManager(1, 0, 0, 0, 0, manager) ||
      !a.AuthzInitializeContextFromSid(
        0,
        windowsPointer(subject.readBigUInt64LE()),
        manager.readBigUInt64LE(),
        0,
        0n,
        0,
        context
      )
    ) {
      throw new ServiceError('unsafe_installation', k.GetLastError())
    }
    const request = Buffer.alloc(40)
    request.writeUInt32LE(desired)
    const mask = Buffer.alloc(4)
    const error = Buffer.alloc(4)
    const reply = Buffer.alloc(32)
    reply.writeUInt32LE(1)
    reply.writeBigUInt64LE(BigInt(windowsFfi().ptr(mask)), 8)
    reply.writeBigUInt64LE(BigInt(windowsFfi().ptr(error)), 24)
    if (!a.AuthzAccessCheck(0, context.readBigUInt64LE(), request, 0n, sd, 0, 0, reply, 0)) {
      throw new ServiceError('unsafe_installation', k.GetLastError())
    }
    if (![0, 5].includes(error.readUInt32LE())) {
      throw new ServiceError('unsafe_installation', error.readUInt32LE())
    }
    granted = error.readUInt32LE() === 0 && (mask.readUInt32LE() & desired) === desired
  } catch (error) {
    failure = error
  }
  // 所有本次分配都尝试回收，关闭错误不得抹去先前的权限拒绝事实。
  if (context.readBigUInt64LE() && !a.AuthzFreeContext(context.readBigUInt64LE())) {
    failure ??= new ServiceError('system_command_failed')
  }
  if (manager.readBigUInt64LE() && !a.AuthzFreeResourceManager(manager.readBigUInt64LE())) {
    failure ??= new ServiceError('system_command_failed')
  }
  if (descriptor.readBigUInt64LE() && k.LocalFree(descriptor.readBigUInt64LE()) !== 0n) {
    failure ??= new ServiceError('system_command_failed')
  }
  if (subject.readBigUInt64LE() && k.LocalFree(subject.readBigUInt64LE()) !== 0n) {
    failure ??= new ServiceError('system_command_failed')
  }
  if (failure) {
    throw failure
  }
  return granted
}
