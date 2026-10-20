// 仅在 macOS 对持有的文件描述符读取扩展 ACL；不执行 shell、不修改权限或信任未知 ACE。
import { createRequire } from 'node:module'
import { GatewayError } from '../contracts.js'

type AclApi = {
  __error(): number
  acl_get_fd_np(fd: number, type: number): number
  acl_valid(acl: number): number
  acl_get_entry(acl: number, index: number, entry: Buffer): number
  acl_get_tag_type(entry: number, tag: Buffer): number
  acl_get_permset_mask_np(entry: number, mask: Buffer): number
  acl_free(acl: number): number
}
let library: { symbols: AclApi } | undefined
let memory: { toArrayBuffer(pointer: number, offset: number, length: number): ArrayBuffer } | undefined

// 固定 ABI 与系统库，非本机受测架构不通过布尔开关或外部命令替代检查。
function api(): AclApi {
  if (process.platform !== 'darwin' || !['x64', 'arm64'].includes(process.arch) || process.versions.bun !== '1.4.3') {
    throw new GatewayError('unsupported_storage_platform')
  }
  if (!library) {
    const ffi = createRequire(import.meta.url)('bun:ffi')
    memory = ffi
    library = ffi.dlopen('/usr/lib/libSystem.B.dylib', {
      __error: { args: [], returns: 'ptr' },
      acl_get_fd_np: { args: ['i32', 'i32'], returns: 'ptr' },
      acl_valid: { args: ['ptr'], returns: 'i32' },
      acl_get_entry: { args: ['ptr', 'i32', 'buffer'], returns: 'i32' },
      acl_get_tag_type: { args: ['ptr', 'buffer'], returns: 'i32' },
      acl_get_permset_mask_np: { args: ['ptr', 'buffer'], returns: 'i32' },
      acl_free: { args: ['ptr'], returns: 'i32' }
    })
  }
  return library!.symbols
}

// errno 只从当前线程的原生槽读取；未知地址不能被当作“没有 ACL”。
function nativeErrno(a: AclApi): number {
  const pointer = a.__error()
  if (pointer <= 0 || !Number.isSafeInteger(pointer)) {
    throw new GatewayError('unsafe_storage_acl')
  }
  return Buffer.from(memory!.toArrayBuffer(pointer, 0, 4)).readInt32LE()
}

// 私有叶节点不接受扩展 allow；祖先只允许不授予写入/删除/改权限的已知读取权限。
export function assertMacosAclEntry(tag: number, permissions: bigint, privateLeaf: boolean): void {
  const known = 0x103ffen
  const mutation = 0x3574n
  if (
    ![1, 2].includes(tag) ||
    permissions < 0n ||
    (permissions & ~known) !== 0n ||
    (tag === 1 && (privateLeaf ? permissions !== 0n : (permissions & mutation) !== 0n))
  ) {
    throw new GatewayError('unsafe_storage_acl')
  }
}

// Darwin acl_get_entry 成功返回0，EINVAL表示已验证 ACL 的索引末尾；不使用 Linux 返回值语义。
export function assertMacosDescriptorAcl(fd: number, privateLeaf: boolean): void {
  if (process.platform !== 'darwin') {
    return
  }
  const a = api()
  const acl = a.acl_get_fd_np(fd, 0x100)
  if (!acl) {
    // Darwin 对有效 fd 缺少 FILESEC_ACL 属性返回 NULL/ENOENT；其它读取失败仍拒绝。
    if (nativeErrno(a) === 2) {
      return
    }
    throw new GatewayError('unsafe_storage_acl')
  }
  if (a.acl_valid(acl) !== 0) {
    a.acl_free(acl)
    throw new GatewayError('unsafe_storage_acl')
  }
  let failure: unknown
  let complete = false
  try {
    for (let index = 0; index <= 128; index++) {
      const entry = Buffer.alloc(8)
      if (a.acl_get_entry(acl, index, entry) !== 0) {
        if (nativeErrno(a) === 22) {
          complete = true
          break
        }
        throw new GatewayError('unsafe_storage_acl')
      }
      if (index === 128) {
        throw new GatewayError('unsafe_storage_acl')
      }
      const pointer = entry.readBigUInt64LE()
      if (pointer === 0n || pointer > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new GatewayError('unsafe_storage_acl')
      }
      const tag = Buffer.alloc(4)
      const mask = Buffer.alloc(8)
      if (a.acl_get_tag_type(Number(pointer), tag) !== 0 || a.acl_get_permset_mask_np(Number(pointer), mask) !== 0) {
        throw new GatewayError('unsafe_storage_acl')
      }
      assertMacosAclEntry(tag.readUInt32LE(), mask.readBigUInt64LE(), privateLeaf)
    }
    if (!complete) {
      throw new GatewayError('unsafe_storage_acl')
    }
  } catch (error) {
    failure = error
  }
  const freed = a.acl_free(acl) === 0
  if (failure) {
    throw failure
  }
  if (!freed) {
    throw new GatewayError('unsafe_storage_acl')
  }
}
