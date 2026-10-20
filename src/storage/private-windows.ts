// Windows Gateway 私有文件原语：固定系统 API、实际 SID/DACL/文件 ID 和无共享删除的目录/数据库租约。
import { randomUUID, createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { win32 } from 'node:path'
import { GatewayError } from '../contracts.js'
import { windowsFfi, windowsLibrary, windowsWide } from '../update/windows/native.js'
import { inspectWindowsFileSecurity, windowsCurrentSid, windowsPrivateAttributes } from '../update/windows/security.js'
import { checkWindowsPrivateAcl } from './windows-private-acl.js'
import { windowsStorageAncestors, windowsStoragePath } from './windows-path.js'

type Kernel = {
  CreateFileW(
    path: Buffer,
    access: number,
    share: number,
    attributes: number,
    creation: number,
    flags: number,
    template: bigint
  ): bigint
  CloseHandle(handle: bigint): number
  GetLastError(): number
  GetFileType(handle: bigint): number
  GetFileInformationByHandle(handle: bigint, info: Buffer): number
  GetFileInformationByHandleEx(handle: bigint, kind: number, bytes: Buffer, size: number): number
  GetFinalPathNameByHandleW(handle: bigint, text: Buffer, size: number, flags: number): number
  GetDriveTypeW(root: Buffer): number
  GetVolumeInformationW(
    root: Buffer,
    name: number,
    nameSize: number,
    serial: Buffer,
    maximum: Buffer,
    flags: Buffer,
    type: Buffer,
    typeSize: number
  ): number
  CreateDirectoryW(path: Buffer, attributes: Buffer): number
  ReadFile(handle: bigint, bytes: Buffer, size: number, count: Buffer, overlap: number): number
  WriteFile(handle: bigint, bytes: Buffer, size: number, count: Buffer, overlap: number): number
  FlushFileBuffers(handle: bigint): number
  MoveFileExW(from: Buffer, to: Buffer, flags: number): number
  DeleteFileW(path: Buffer): number
}
type Stamp = Readonly<{ id: string; size: number; signature: string }>
let kernel: Kernel | undefined
const invalid = 0xffffffffffffffffn

// 与安装器共用固定 DLL/ABI 载入器；不调用 Authz、不选择身份或启用任何特权。
function api(): Kernel {
  if (process.platform !== 'win32') {
    throw new GatewayError('unsupported_storage_platform')
  }
  kernel ??= windowsLibrary<Kernel>('kernel32', {
    CreateFileW: { args: ['buffer', 'u32', 'u32', 'ptr', 'u32', 'u32', 'u64'], returns: 'u64' },
    CloseHandle: { args: ['u64'], returns: 'i32' },
    GetLastError: { args: [], returns: 'u32' },
    GetFileType: { args: ['u64'], returns: 'u32' },
    GetFileInformationByHandle: { args: ['u64', 'buffer'], returns: 'i32' },
    GetFileInformationByHandleEx: { args: ['u64', 'u32', 'buffer', 'u32'], returns: 'i32' },
    GetFinalPathNameByHandleW: { args: ['u64', 'buffer', 'u32', 'u32'], returns: 'u32' },
    GetDriveTypeW: { args: ['buffer'], returns: 'u32' },
    GetVolumeInformationW: {
      args: ['buffer', 'ptr', 'u32', 'buffer', 'buffer', 'buffer', 'buffer', 'u32'],
      returns: 'i32'
    },
    CreateDirectoryW: { args: ['buffer', 'buffer'], returns: 'i32' },
    ReadFile: { args: ['u64', 'buffer', 'u32', 'buffer', 'ptr'], returns: 'i32' },
    WriteFile: { args: ['u64', 'buffer', 'u32', 'buffer', 'ptr'], returns: 'i32' },
    FlushFileBuffers: { args: ['u64'], returns: 'i32' },
    MoveFileExW: { args: ['buffer', 'buffer', 'u32'], returns: 'i32' },
    DeleteFileW: { args: ['buffer'], returns: 'i32' }
  })
  return kernel
}

// 保留 ENOENT/EEXIST 供现有配置与锁处理；错误不包含路径或正文。
function nativeError(code = api().GetLastError()): GatewayError {
  return new GatewayError(
    [2, 3].includes(code)
      ? 'ENOENT'
      : [80, 183].includes(code)
        ? 'EEXIST'
        : [5, 1314].includes(code)
          ? 'EACCES'
          : [32, 33].includes(code)
            ? 'EBUSY'
            : 'storage_io_failed'
  )
}

// 规范 DOS 路径转换为明确长路径，不能接受调用方提供的设备命名空间。
function wide(path: string): Buffer {
  return windowsWide('\\\\?\\' + windowsStoragePath(path))
}

// 文件 ID、DACL 和同卷 rename 仅在实际本地 NTFS 卷成立。
function volume(path: string): void {
  const k = api()
  const root = windowsWide(win32.parse(windowsStoragePath(path)).root)
  const type = Buffer.alloc(32)
  if (k.GetDriveTypeW(root) !== 3) {
    throw new GatewayError('unsupported_storage_filesystem')
  }
  if (!k.GetVolumeInformationW(root, 0, 0, Buffer.alloc(4), Buffer.alloc(4), Buffer.alloc(4), type, 16)) {
    throw nativeError()
  }
  if (type.toString('utf16le').split('\0')[0] !== 'NTFS') {
    throw new GatewayError('unsupported_storage_filesystem')
  }
}

// 每个句柄只关闭一次；不能将关闭失败当作完成。
function close(handle: bigint): void {
  if (!api().CloseHandle(handle)) {
    throw nativeError()
  }
}

// 只回收本次创建且尚未发布的临时文件；失败不被当作发布或清理成功。
function removeTemporary(path: string): void {
  if (!api().DeleteFileW(wide(path))) {
    throw nativeError()
  }
}

// 实际句柄必须是预期磁盘对象，无 reparse/大小写敏感别名；文件另拒绝硬链接及附加数据流。
function stamp(handle: bigint, path: string, directory: boolean, privateLeaf: boolean): Stamp {
  const k = api()
  const info = Buffer.alloc(52)
  const id = Buffer.alloc(24)
  const basic = Buffer.alloc(40)
  if (
    k.GetFileType(handle) !== 1 ||
    !k.GetFileInformationByHandle(handle, info) ||
    !k.GetFileInformationByHandleEx(handle, 18, id, id.length) ||
    !k.GetFileInformationByHandleEx(handle, 0, basic, basic.length)
  ) {
    throw nativeError()
  }
  const attributes = info.readUInt32LE()
  if ((attributes & 0x400) !== 0 || !!(attributes & 16) !== directory) {
    throw new GatewayError('unsafe_storage_file')
  }
  const final = Buffer.alloc(32768 * 2)
  const units = k.GetFinalPathNameByHandleW(handle, final, 32768, 0)
  if (
    units < 1 ||
    units >= 32768 ||
    final.toString('utf16le', 0, units * 2).toLowerCase() !== ('\\\\?\\' + path).toLowerCase()
  ) {
    throw new GatewayError('unsafe_storage_path')
  }
  const size = Number((BigInt(info.readUInt32LE(32)) << 32n) | BigInt(info.readUInt32LE(36)))
  if (!Number.isSafeInteger(size)) {
    throw new GatewayError('unsafe_storage_file')
  }
  if (directory) {
    const sensitivity = Buffer.alloc(4)
    if (!k.GetFileInformationByHandleEx(handle, 23, sensitivity, sensitivity.length)) {
      throw nativeError()
    }
    if (sensitivity.readUInt32LE() !== 0) {
      throw new GatewayError('unsafe_storage_path')
    }
  } else {
    if (info.readUInt32LE(40) !== 1 || (attributes & ~(32 | 128 | 8192)) !== 0) {
      throw new GatewayError('unsafe_storage_file')
    }
    const streams = Buffer.alloc(65536)
    if (!k.GetFileInformationByHandleEx(handle, 7, streams, streams.length)) {
      throw nativeError()
    }
    if (
      streams.readUInt32LE() !== 0 ||
      streams.readUInt32LE(4) !== 14 ||
      streams.toString('utf16le', 24, 38) !== '::$DATA' ||
      streams.readBigUInt64LE(8) !== BigInt(size)
    ) {
      throw new GatewayError('unsafe_storage_file')
    }
  }
  const security = inspectWindowsFileSecurity(handle, directory && !privateLeaf)
  if (privateLeaf) {
    checkWindowsPrivateAcl(
      security.owner,
      security.entries.map(
        /* 实际 ACE 标志来自同一 GetSecurityInfo；旧类型允许缺省的调用点不会补出继承授权。 */ (entry) => ({
          ...entry,
          fileInherit: entry.fileInherit === true,
          directoryInherit: entry.directoryInherit === true
        })
      ),
      windowsCurrentSid(),
      security.protectedDacl,
      directory,
      !directory
    )
  }
  const identity = id.toString('hex')
  return Object.freeze({
    id: identity,
    size,
    signature: createHash('sha256')
      .update(identity)
      .update(info.subarray(0, 12))
      .update(info.subarray(20, 52))
      .update(basic.subarray(24, 32))
      .update(security.digest)
      .digest('hex')
  })
}

// 打开时禁止 reparse，并省略 FILE_SHARE_DELETE；读取配置时还禁止共享写入。
function open(path: string, directory: boolean, write = false, share = 3): bigint {
  const handle = api().CreateFileW(
    wide(path),
    directory ? 0x00020080 : write ? 0xc0020000 : 0x80020000,
    share,
    0,
    3,
    directory ? 0x02200000 : 0x00200000,
    0n
  )
  if (!handle || handle === invalid) {
    throw nativeError()
  }
  return handle
}

// 目录链持有无共享删除句柄直到全部操作结束，避免预检后祖先被改名或换成 junction。
class DirectoryLease {
  private handles: bigint[] = []
  // 从根逐级检查实际对象；私有叶要求当前 SID 与安全的 SQLite 文件/目录继承权限。
  constructor(directory: string, create = false) {
    volume(directory)
    try {
      for (const path of windowsStorageAncestors(directory)) {
        let handle: bigint
        try {
          handle = open(path, true)
        } catch (error) {
          if (!create || !(error instanceof GatewayError) || error.code !== 'ENOENT') {
            throw error
          }
          const attributes = windowsPrivateAttributes()
          try {
            if (!api().CreateDirectoryW(wide(path), attributes.bytes)) {
              const code = api().GetLastError()
              if (code !== 183) {
                throw nativeError(code)
              }
            }
          } finally {
            attributes.dispose()
          }
          handle = open(path, true)
        }
        this.handles.push(handle)
        stamp(handle, path, true, path === directory)
      }
    } catch (error) {
      this.close()
      throw error
    }
  }
  // 关闭全部自有句柄；一次失败仍尝试其余句柄，不放弃回收。
  close(): void {
    let failure: unknown
    for (const handle of this.handles.splice(0).reverse()) {
      try {
        close(handle)
      } catch (error) {
        failure ??= error
      }
    }
    if (failure) {
      throw failure
    }
  }
}

// 只验证私有直接父目录，不创建对象或修改已有 ACL。
export function windowsPrivatePath(path: string): void {
  const lease = new DirectoryLease(win32.dirname(windowsStoragePath(path)))
  lease.close()
}

// 仅缺失目录应用新建私有安全描述符；已有宽松目录必须原样拒绝。
export function ensureWindowsPrivateDirectory(path: string): void {
  const lease = new DirectoryLease(path, true)
  lease.close()
}

// 同一对象的私有元数据读取，返回的摘要只用于可信宿主的并发替换检查。
export function windowsPrivateStamp(path: string): string {
  const lease = new DirectoryLease(win32.dirname(windowsStoragePath(path)))
  let handle: bigint | undefined
  try {
    handle = open(path, false)
    return stamp(handle, path, false, true).signature
  } finally {
    try {
      if (handle !== undefined) {
        close(handle)
      }
    } finally {
      lease.close()
    }
  }
}

// 运行状态普通文件检查与 JSON 读取共用实际句柄语义。
export function windowsPrivateFile(path: string): void {
  windowsPrivateStamp(path)
}

// 写入前核对实际新对象的 ACL；文件创建成功后失败会留下对象，保持已有崩溃锁拒绝语义。
function createHandle(path: string): bigint {
  const attributes = windowsPrivateAttributes()
  try {
    const handle = api().CreateFileW(wide(path), 0xc0020000, 0, windowsFfi().ptr(attributes.bytes), 1, 0x80200080, 0n)
    if (!handle || handle === invalid) {
      throw nativeError()
    }
    return handle
  } finally {
    attributes.dispose()
  }
}

// 所有字节都必须真实写完并 FlushFileBuffers；部分写入或系统拒绝不返回成功。
function writeBody(handle: bigint, path: string, bytes: Uint8Array): void {
  if (bytes.byteLength > 16_777_216) {
    throw new GatewayError('invalid_storage_limit')
  }
  stamp(handle, path, false, true)
  let offset = 0
  while (offset < bytes.byteLength) {
    const block = Buffer.from(bytes.subarray(offset, Math.min(offset + 1_048_576, bytes.byteLength)))
    const count = Buffer.alloc(4)
    if (!api().WriteFile(handle, block, block.length, count, 0)) {
      throw nativeError()
    }
    const written = count.readUInt32LE()
    if (written < 1 || written > block.length) {
      throw new GatewayError('storage_io_failed')
    }
    offset += written
  }
  if (!api().FlushFileBuffers(handle)) {
    throw nativeError()
  }
}

// 排他创建固定目标；创建失败不自动删锁或接管已有文件。
export function createWindowsPrivate(path: string, content = ''): void {
  const lease = new DirectoryLease(win32.dirname(windowsStoragePath(path)))
  let handle: bigint | undefined
  try {
    handle = createHandle(path)
    writeBody(handle, path, Buffer.from(content))
  } finally {
    try {
      if (handle !== undefined) {
        close(handle)
      }
    } finally {
      lease.close()
    }
  }
}

// 配置读取在同一不可共享写入/删除句柄上有界完成，末次核对身份、ACL 与修改时间。
export function readWindowsPrivate(path: string, maximum: number): Buffer {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16_777_216) {
    throw new GatewayError('invalid_storage_limit')
  }
  const lease = new DirectoryLease(win32.dirname(windowsStoragePath(path)))
  let handle: bigint | undefined
  const bytes = Buffer.alloc(maximum + 1)
  let keep = false
  try {
    handle = open(path, false, false, 1)
    const before = stamp(handle, path, false, true)
    if (before.size > maximum) {
      throw new GatewayError('unsafe_storage_file')
    }
    let length = 0
    while (length < bytes.length) {
      const block = Buffer.alloc(Math.min(bytes.length - length, 1_048_576))
      const count = Buffer.alloc(4)
      if (!api().ReadFile(handle, block, block.length, count, 0)) {
        throw nativeError()
      }
      const read = count.readUInt32LE()
      if (read > block.length) {
        throw new GatewayError('storage_io_failed')
      }
      block.copy(bytes, length, 0, read)
      block.fill(0)
      if (read === 0) {
        break
      }
      length += read
    }
    if (length !== before.size || length > maximum || stamp(handle, path, false, true).signature !== before.signature) {
      throw new GatewayError('unsafe_storage_file')
    }
    keep = true
    return bytes.subarray(0, length)
  } finally {
    if (!keep) {
      bytes.fill(0)
    }
    try {
      if (handle !== undefined) {
        close(handle)
      }
    } finally {
      lease.close()
    }
  }
}

// SQLite 打开前验证全部已有辅助文件；数据文件和祖先租约持有到实际数据库关闭之后。
export function retainWindowsDatabase(path: string): () => void {
  const lease = new DirectoryLease(win32.dirname(windowsStoragePath(path)))
  let handle: bigint | undefined
  try {
    handle = open(path, false)
    stamp(handle, path, false, true)
    for (const suffix of ['-journal', '-wal', '-shm']) {
      let auxiliary: bigint | undefined
      try {
        auxiliary = open(path + suffix, false)
        stamp(auxiliary, path + suffix, false, true)
      } catch (error) {
        if (!(error instanceof GatewayError) || error.code !== 'ENOENT') {
          throw error
        }
      } finally {
        if (auxiliary !== undefined) {
          close(auxiliary)
        }
      }
    }
  } catch (error) {
    try {
      if (handle !== undefined) {
        close(handle)
      }
    } finally {
      lease.close()
    }
    throw error
  }
  let closed = false
  return /* 不能由 GC 推断 writer 已结束；只有调用方关闭 SQLite 后才显式释放。 */ () => {
    if (!closed) {
      closed = true
      try {
        close(handle!)
      } finally {
        lease.close()
      }
    }
  }
}

// 自有临时文件完成 flush 后同卷发布；默认不覆盖，替换必须匹配实际原文件摘要。
export function writeWindowsPrivateAtomic(
  path: string,
  bytes: Uint8Array | string,
  replace = false,
  expected?: string
): void {
  const lease = new DirectoryLease(win32.dirname(windowsStoragePath(path)))
  const temporary = win32.join(win32.dirname(path), '.rovloom-private-' + randomUUID() + '.tmp')
  let handle: bigint | undefined
  let created = false
  try {
    if (replace && (!expected || windowsPrivateStamp(path) !== expected)) {
      throw new GatewayError('config_changed')
    }
    handle = createHandle(temporary)
    created = true
    writeBody(handle, temporary, typeof bytes === 'string' ? Buffer.from(bytes) : bytes)
    const complete = handle
    handle = undefined
    close(complete)
    if (replace && windowsPrivateStamp(path) !== expected) {
      throw new GatewayError('config_changed')
    }
    if (!api().MoveFileExW(wide(temporary), wide(path), replace ? 9 : 8)) {
      throw nativeError()
    }
    created = false
    windowsPrivateFile(path)
  } finally {
    try {
      if (handle !== undefined) {
        close(handle)
      }
    } finally {
      try {
        if (created) {
          removeTemporary(temporary)
        }
      } finally {
        lease.close()
      }
    }
  }
}

// 备份在实际数据库关闭后同步同一私有文件对象，不对只读句柄伪报 flush 成功。
export function syncWindowsPrivate(path: string): void {
  const lease = new DirectoryLease(win32.dirname(windowsStoragePath(path)))
  let handle: bigint | undefined
  try {
    handle = open(path, false, true)
    stamp(handle, path, false, true)
    if (!api().FlushFileBuffers(handle)) {
      throw nativeError()
    }
  } finally {
    try {
      if (handle !== undefined) {
        close(handle)
      }
    } finally {
      lease.close()
    }
  }
}

// 配额统计也打开真实对象拒绝 reparse/硬链接/ADS；不按路径 stat 假定 Windows junction 是普通目录。
export function windowsManagedBytes(directory: string): number {
  const lease = new DirectoryLease(windowsStoragePath(directory))
  try {
    let total = 0
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = win32.join(directory, entry.name)
      if (!entry.isDirectory() && !entry.isFile()) {
        throw new GatewayError('unsafe_storage_file')
      }
      const handle = open(path, entry.isDirectory())
      let info: Stamp
      try {
        info = stamp(handle, path, entry.isDirectory(), true)
      } finally {
        close(handle)
      }
      total += entry.isDirectory() ? windowsManagedBytes(path) : info.size
      if (!Number.isSafeInteger(total)) {
        throw new GatewayError('storage_quota')
      }
    }
    return total
  } finally {
    lease.close()
  }
}
