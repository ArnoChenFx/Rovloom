// 受控 Windows 文件原语；原语本身不授予更新许可，完整事务仍须持有安装/角色锁及父退出证明。
import { win32 } from 'node:path'
import { createHash } from 'node:crypto'
import { MAX_BINARY_BYTES, UpdateError } from '../contract.js'
import { windowsLibrary, windowsWide, WindowsNativeError } from './native.js'
import { verifyWindowsFileSecurity, windowsPrivateAttributes } from './security.js'
import type { WindowsFileIdentity } from './protocol.js'

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
  GetFileInformationByHandle(handle: bigint, info: Buffer): number
  GetFileInformationByHandleEx(handle: bigint, kind: number, info: Buffer, length: number): number
  GetFinalPathNameByHandleW(handle: bigint, text: Buffer, length: number, flags: number): number
  GetVolumeInformationW(
    root: Buffer,
    name: number,
    nameLength: number,
    serial: Buffer,
    maximum: Buffer,
    flags: Buffer,
    type: Buffer,
    typeLength: number
  ): number
  ReadFile(handle: bigint, bytes: Buffer, count: number, read: Buffer, overlapped: number): number
  WriteFile(handle: bigint, bytes: Buffer, count: number, written: Buffer, overlapped: number): number
  FlushFileBuffers(handle: bigint): number
  ReplaceFileW(
    target: Buffer,
    replacement: Buffer,
    previous: Buffer,
    flags: number,
    excluded: number,
    reserved: number
  ): number
  MoveFileExW(from: Buffer, to: Buffer, flags: number): number
  CreateDirectoryW(path: Buffer, attributes: Buffer): number
}
let kernel: Kernel | undefined
const INVALID = 0xffffffffffffffffn

// 只加载固定 Kernel32 字符串/句柄 API；flags 均由源代码常量给出，不接受 CLI 控制。
function api(): Kernel {
  kernel ??= windowsLibrary<Kernel>('kernel32', {
    CreateFileW: { args: ['buffer', 'u32', 'u32', 'ptr', 'u32', 'u32', 'u64'], returns: 'u64' },
    CloseHandle: { args: ['u64'], returns: 'i32' },
    GetLastError: { args: [], returns: 'u32' },
    GetFileInformationByHandle: { args: ['u64', 'buffer'], returns: 'i32' },
    GetFileInformationByHandleEx: { args: ['u64', 'u32', 'buffer', 'u32'], returns: 'i32' },
    GetFinalPathNameByHandleW: { args: ['u64', 'buffer', 'u32', 'u32'], returns: 'u32' },
    GetVolumeInformationW: {
      args: ['buffer', 'ptr', 'u32', 'buffer', 'buffer', 'buffer', 'buffer', 'u32'],
      returns: 'i32'
    },
    ReadFile: { args: ['u64', 'buffer', 'u32', 'buffer', 'ptr'], returns: 'i32' },
    WriteFile: { args: ['u64', 'buffer', 'u32', 'buffer', 'ptr'], returns: 'i32' },
    FlushFileBuffers: { args: ['u64'], returns: 'i32' },
    ReplaceFileW: { args: ['buffer', 'buffer', 'buffer', 'u32', 'ptr', 'ptr'], returns: 'i32' },
    MoveFileExW: { args: ['buffer', 'buffer', 'u32'], returns: 'i32' },
    CreateDirectoryW: { args: ['buffer', 'buffer'], returns: 'i32' }
  })
  return kernel
}

// 内部文件/目录路径也必须为规范 DOS 路径，不能以 ADS、设备名或控制字符绕过固定文件名。
function path(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    !/^[A-Za-z]:\\/u.test(value) ||
    win32.normalize(value) !== value ||
    /[<>"|?*]/u.test(value) ||
    value.slice(3).includes(':') ||
    Array.from(value).some(
      /* NUL/控制字符不能进入 Win32 参数。 */ (c) => c.codePointAt(0)! < 32 || c.codePointAt(0) === 127
    ) ||
    value
      .slice(3)
      .split('\\')
      .some(
        /* 拒绝 Win32 会折叠的尾点/空格以及保留设备名。 */ (part) =>
          /[. ]$/u.test(part) || /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/iu.test(part)
      )
  ) {
    throw new UpdateError('unsafe_installation')
  }
  return value
}

// 查询真实卷类型；未证明 NTFS 的卷不套用本模块的文件 ID、ACL 与原子替换语义。
function ntfs(value: string): void {
  const k = api()
  const type = Buffer.alloc(32)
  if (
    !k.GetVolumeInformationW(
      windowsWide(win32.parse(value).root),
      0,
      0,
      Buffer.alloc(4),
      Buffer.alloc(4),
      Buffer.alloc(4),
      type,
      16
    )
  ) {
    throw new WindowsNativeError(k.GetLastError())
  }
  if (type.toString('utf16le').split('\0')[0] !== 'NTFS') {
    throw new UpdateError('unsupported_platform')
  }
}

// no-reparse 打开并核验最终路径；祖先目录不共享 DELETE，防止持锁期间目录名被迁移。
function open(value: string, directory: boolean): bigint {
  const k = api()
  path(value)
  const handle = k.CreateFileW(windowsWide(value), 0x80020000, directory ? 3 : 7, 0, 3, 0x02200000, 0n)
  if (!handle || handle === INVALID) {
    throw new WindowsNativeError(k.GetLastError())
  }
  let failure: unknown
  try {
    const info = Buffer.alloc(52)
    if (!k.GetFileInformationByHandle(handle, info)) {
      throw new WindowsNativeError(k.GetLastError())
    }
    const flags = info.readUInt32LE()
    if ((flags & 0x400) !== 0 || !!(flags & 16) !== directory) {
      throw new UpdateError('unsafe_installation')
    }
    const text = Buffer.alloc(32768 * 2)
    const units = k.GetFinalPathNameByHandleW(handle, text, 32768, 0)
    if (units < 1 || units >= 32768 || text.toString('utf16le', 0, units * 2) !== '\\\\?\\' + value) {
      throw new UpdateError('unsafe_installation')
    }
    verifyWindowsFileSecurity(handle, directory)
    if (directory) {
      const sensitivity = Buffer.alloc(4)
      if (!k.GetFileInformationByHandleEx(handle, 23, sensitivity, 4)) {
        throw new WindowsNativeError(k.GetLastError())
      }
      if (sensitivity.readUInt32LE() !== 0) {
        throw new UpdateError('unsafe_installation')
      }
    }
  } catch (error) {
    failure = error
  }
  if (failure) {
    k.CloseHandle(handle)
    throw failure
  }
  return handle
}

// 对应架构的原生 PE32+ 才可执行；DOS stub、脚本或 DLL 不被视作候选产品。
function pe(bytes: Buffer, arch: 'x64' | 'arm64'): void {
  if (bytes.length < 64 || bytes[0] !== 77 || bytes[1] !== 90) {
    throw new UpdateError('candidate_unusable')
  }
  const at = bytes.readUInt32LE(0x3c)
  if (
    at < 64 ||
    at + 26 > bytes.length ||
    bytes.readUInt32LE(at) !== 0x00004550 ||
    bytes.readUInt16LE(at + 4) !== (arch === 'x64' ? 0x8664 : 0xaa64) ||
    !(bytes.readUInt16LE(at + 22) & 2) ||
    bytes.readUInt16LE(at + 22) & 0x2000 ||
    bytes.readUInt16LE(at + 24) !== 0x20b
  ) {
    throw new UpdateError('candidate_unusable')
  }
}

// 通过同一原生句柄流式核验默认数据流的真实字节和安全描述符，不把下载 chunk 摘要当落盘证明。
export function readWindowsExecutable(value: string, arch: 'x64' | 'arm64'): WindowsFileIdentity {
  const k = api()
  ntfs(path(value))
  const handle = open(value, false)
  let result: WindowsFileIdentity | undefined
  let failure: unknown
  try {
    const info = Buffer.alloc(52)
    const id = Buffer.alloc(24)
    if (!k.GetFileInformationByHandle(handle, info) || !k.GetFileInformationByHandleEx(handle, 18, id, id.length)) {
      throw new WindowsNativeError(k.GetLastError())
    }
    const attributes = info.readUInt32LE()
    const size = Number((BigInt(info.readUInt32LE(32)) << 32n) | BigInt(info.readUInt32LE(36)))
    if (attributes & 1) {
      throw new UpdateError('permission_denied')
    }
    if ((attributes & ~(32 | 128 | 8192)) !== 0 || info.readUInt32LE(40) !== 1 || size < 1 || size > MAX_BINARY_BYTES) {
      throw new UpdateError('unsafe_installation')
    }
    const streams = Buffer.alloc(65536)
    if (!k.GetFileInformationByHandleEx(handle, 7, streams, streams.length)) {
      throw new WindowsNativeError(k.GetLastError())
    }
    const nameLength = streams.readUInt32LE(4)
    if (
      streams.readUInt32LE() !== 0 ||
      nameLength !== 14 ||
      streams.toString('utf16le', 24, 24 + nameLength) !== '::$DATA' ||
      streams.readBigUInt64LE(8) !== BigInt(size)
    ) {
      throw new UpdateError('unsafe_installation')
    }
    const hash = createHash('sha256')
    const block = Buffer.alloc(1024 * 1024)
    const count = Buffer.alloc(4)
    let total = 0
    const header = Buffer.alloc(65536)
    let headerBytes = 0
    while (true) {
      if (!k.ReadFile(handle, block, block.length, count, 0)) {
        throw new WindowsNativeError(k.GetLastError())
      }
      const bytes = count.readUInt32LE()
      if (!bytes) {
        break
      }
      if (bytes > block.length || total + bytes > MAX_BINARY_BYTES) {
        throw new UpdateError('unsafe_installation')
      }
      if (headerBytes < header.length) {
        const captured = Math.min(bytes, header.length - headerBytes)
        block.copy(header, headerBytes, 0, captured)
        headerBytes += captured
      }
      hash.update(block.subarray(0, bytes))
      total += bytes
    }
    if (total !== size) {
      throw new UpdateError('target_changed')
    }
    pe(header.subarray(0, headerBytes), arch)
    result = Object.freeze({
      volume: id.readBigUInt64LE().toString(),
      fileId: id.subarray(8, 24).toString('hex'),
      size,
      sha256: hash.digest('hex'),
      security: verifyWindowsFileSecurity(handle, false)
    })
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
  return result!
}

export class WindowsPathLease {
  #handles: bigint[]
  #directories = new Map<string, string>()
  #closed = false
  // 私有工厂持有全体祖先目录句柄，不能靠 caller 的布尔标志跳过路径证明。
  private constructor(
    readonly executable: string,
    handles: bigint[]
  ) {
    this.#handles = handles
    Object.freeze(this)
  }

  // 对目标的祖先逐层验证并禁止改名；叶文件的身份/摘要另由 readWindowsExecutable 在每次操作前核验。
  static acquire(executable: string): WindowsPathLease {
    path(executable)
    if (!executable.toLowerCase().endsWith('.exe')) {
      throw new UpdateError('unsafe_installation')
    }
    ntfs(executable)
    const paths: string[] = []
    let current = win32.dirname(executable)
    while (true) {
      paths.unshift(current)
      if (paths.length > 128) {
        throw new UpdateError('unsafe_installation')
      }
      if (current === win32.parse(current).root) {
        break
      }
      current = win32.dirname(current)
    }
    const handles: bigint[] = []
    try {
      for (const directory of paths) {
        handles.push(open(directory, true))
      }
      return new WindowsPathLease(executable, handles)
    } catch (error) {
      for (const handle of handles.reverse()) {
        api().CloseHandle(handle)
      }
      throw error
    }
  }

  // 仅在已验证父目录下新建私有事务目录；不得复用既有名称或修复其 ACL。
  createDirectory(transactionId: string): string {
    if (this.#closed || !/^[0-9a-f]{32}$/u.test(transactionId)) {
      throw new UpdateError('invalid_arguments')
    }
    const directory = win32.join(win32.dirname(this.executable), `.rovloom-update-${transactionId}`)
    const attributes = windowsPrivateAttributes()
    const k = api()
    const created = k.CreateDirectoryW(windowsWide(directory), attributes.bytes)
    const failure = created ? undefined : new WindowsNativeError(k.GetLastError())
    attributes.dispose()
    if (failure) {
      throw failure
    }
    this.#handles.push(open(directory, true))
    this.#directories.set(transactionId, directory)
    return directory
  }

  // 文件原语只操作此能力自己创建的事务目录，不能用另一个 nonce 指向未知已有目录。
  directory(transactionId: string): string {
    this.assertActive()
    const directory = this.#directories.get(transactionId)
    if (!directory) {
      throw new UpdateError('invalid_arguments')
    }
    return directory
  }

  // 祖先句柄持续持有直到真实文件 I/O 静止；本低层能力不替代跨进程安装/角色锁。
  assertActive(): void {
    if (this.#closed) {
      throw new UpdateError('replacement_unavailable')
    }
  }

  // 所有自有句柄均尝试关闭，任何 close 失败继续非零，不由 finalizer 隐式重用。
  close(): void {
    if (!this.#closed) {
      let failure: WindowsNativeError | undefined
      for (const handle of this.#handles) {
        if (!api().CloseHandle(handle)) {
          failure ??= new WindowsNativeError(api().GetLastError())
        }
      }
      this.#handles = []
      this.#closed = true
      if (failure) {
        throw failure
      }
    }
  }
}

// 替换目标固定为已验证安装，候选/备份固定在同盘私有事务目录；不使用忽略 ACL 或不支持的写穿选项。
export function replaceWindowsExecutable(lease: WindowsPathLease, transactionId: string, rollback = false): void {
  lease.assertActive()
  if (!/^[0-9a-f]{32}$/u.test(transactionId)) {
    throw new UpdateError('invalid_arguments')
  }
  const directory = lease.directory(transactionId)
  const k = api()
  if (
    !k.ReplaceFileW(
      windowsWide(lease.executable),
      windowsWide(win32.join(directory, rollback ? 'previous.exe' : 'candidate.exe')),
      windowsWide(win32.join(directory, rollback ? 'rejected.exe' : 'previous.exe')),
      0,
      0,
      0
    )
  ) {
    throw new WindowsNativeError(k.GetLastError())
  }
}

// 回执使用独占新文件、真实完整写入、FlushFileBuffers 和固定路径的写穿 rename；失败不能报告成功。
export function writeWindowsReceipt(
  lease: WindowsPathLease,
  transactionId: string,
  sequence: number,
  bytes: Uint8Array
): void {
  lease.assertActive()
  if (
    !/^[0-9a-f]{32}$/u.test(transactionId) ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    sequence > 64 ||
    bytes.length < 1 ||
    bytes.length > 4096
  ) {
    throw new UpdateError('invalid_arguments')
  }
  const directory = lease.directory(transactionId)
  const temporary = win32.join(directory, `receipt-${sequence}.tmp`)
  const k = api()
  const handle = k.CreateFileW(windowsWide(temporary), 0xc0020000, 0, 0, 1, 0x80000080, 0n)
  if (!handle || handle === INVALID) {
    throw new WindowsNativeError(k.GetLastError())
  }
  let failure: unknown
  try {
    verifyWindowsFileSecurity(handle, false)
    let offset = 0
    while (offset < bytes.length) {
      const count = Buffer.alloc(4)
      const block = Buffer.from(bytes.subarray(offset))
      if (!k.WriteFile(handle, block, block.length, count, 0)) {
        throw new WindowsNativeError(k.GetLastError())
      }
      const written = count.readUInt32LE()
      if (!written || written > block.length) {
        throw new UpdateError('staging_failed')
      }
      offset += written
    }
    if (!k.FlushFileBuffers(handle)) {
      throw new WindowsNativeError(k.GetLastError())
    }
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
  if (!k.MoveFileExW(windowsWide(temporary), windowsWide(win32.join(directory, 'receipt.json')), 9)) {
    throw new WindowsNativeError(k.GetLastError())
  }
}
