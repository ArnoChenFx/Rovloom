// 只绑定 Windows 内核报告的直接父进程并持有查询/同步句柄；不接收 PID，不终止任何进程。
import { win32 } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { UpdateError } from '../contract.js'
import { windowsLibrary } from './native.js'

export type WindowsProcessStamp = Readonly<{ image: string; born: string }>
export type WindowsParentPort = {
  self(): WindowsProcessStamp
  parent(): Readonly<WindowsProcessStamp & { handle: bigint }>
  poll(handle: bigint): 'running' | 'exited'
  close(handle: bigint): void
}
type Kernel = {
  GetCurrentProcessId(): number
  GetCurrentProcess(): bigint
  CreateToolhelp32Snapshot(flags: number, pid: number): bigint
  Process32FirstW(handle: bigint, entry: Buffer): number
  Process32NextW(handle: bigint, entry: Buffer): number
  OpenProcess(access: number, inherit: number, pid: number): bigint
  QueryFullProcessImageNameW(handle: bigint, flags: number, text: Buffer, length: Buffer): number
  GetProcessTimes(handle: bigint, born: Buffer, exit: Buffer, kernel: Buffer, user: Buffer): number
  WaitForSingleObject(handle: bigint, milliseconds: number): number
  CloseHandle(handle: bigint): number
  GetLastError(): number
}
const INVALID_HANDLE = 0xffffffffffffffffn
let kernel: Kernel | undefined

// 仅加载固定系统 DLL；Windows HANDLE 采用 u64，不能用表示虚拟地址的 ptr 截断它。
function systemKernel(): Kernel {
  if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch) || process.versions.bun !== '1.4.3') {
    throw new UpdateError('replacement_unavailable')
  }
  if (!kernel) {
    kernel = windowsLibrary<Kernel>('kernel32', {
      GetCurrentProcessId: { args: [], returns: 'u32' },
      GetCurrentProcess: { args: [], returns: 'u64' },
      CreateToolhelp32Snapshot: { args: ['u32', 'u32'], returns: 'u64' },
      Process32FirstW: { args: ['u64', 'buffer'], returns: 'i32' },
      Process32NextW: { args: ['u64', 'buffer'], returns: 'i32' },
      OpenProcess: { args: ['u32', 'i32', 'u32'], returns: 'u64' },
      QueryFullProcessImageNameW: { args: ['u64', 'u32', 'buffer', 'buffer'], returns: 'i32' },
      GetProcessTimes: { args: ['u64', 'buffer', 'buffer', 'buffer', 'buffer'], returns: 'i32' },
      WaitForSingleObject: { args: ['u64', 'u32'], returns: 'u32' },
      CloseHandle: { args: ['u64'], returns: 'i32' },
      GetLastError: { args: [], returns: 'u32' }
    })
  }
  return kernel
}

// 原始 Win32 失败只产生固定公开码；不回显路径、PID、token 或异常字符串。
function nativeFailure(api: Kernel): UpdateError {
  return new UpdateError(api.GetLastError() === 5 ? 'permission_denied' : 'replacement_unavailable')
}

// Windows 路径必须为本机磁盘的规范绝对路径，不能用 UNC、设备、ADS 或路径控制字符。
function imagePath(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    !/^[A-Za-z]:\\/u.test(value) ||
    win32.normalize(value) !== value ||
    /[<>"|?*]/u.test(value) ||
    Array.from(value).some(
      /* 路径控制字符不能进入内核路径。 */ (c) => c.codePointAt(0)! < 32 || c.codePointAt(0) === 127
    ) ||
    value.slice(3).includes(':') ||
    !value.toLowerCase().endsWith('.exe')
  ) {
    throw new UpdateError('unsafe_installation')
  }
  return value
}

// 纯身份验证供封存事务与原生绑定共用，未知 PID/句柄字段不能被忽略。
export function windowsProcessStamp(value: unknown): WindowsProcessStamp {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'born,image'
  ) {
    throw new UpdateError('invalid_arguments')
  }
  const input = value as WindowsProcessStamp
  imagePath(input.image)
  if (typeof input.born !== 'string' || !/^[1-9]\d{0,19}$/u.test(input.born) || BigInt(input.born) > INVALID_HANDLE) {
    throw new UpdateError('unsafe_installation')
  }
  return Object.freeze({ image: input.image, born: input.born })
}

// 固定大小的 UTF-16/FILETIME 输出由调用者持有，不读取 native 返回的任意长度或地址。
function stamp(api: Kernel, handle: bigint): WindowsProcessStamp {
  const text = Buffer.alloc(32768 * 2)
  const length = Buffer.alloc(4)
  length.writeUInt32LE(32768)
  if (!api.QueryFullProcessImageNameW(handle, 0, text, length)) {
    throw nativeFailure(api)
  }
  const units = length.readUInt32LE()
  if (units < 1 || units >= 32768) {
    throw new UpdateError('unsafe_installation')
  }
  const born = Buffer.alloc(8)
  if (!api.GetProcessTimes(handle, born, Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8))) {
    throw nativeFailure(api)
  }
  if (!born.readBigUInt64LE()) {
    throw new UpdateError('unsafe_installation')
  }
  return Object.freeze({
    image: imagePath(text.toString('utf16le', 0, units * 2)),
    born: born.readBigUInt64LE().toString()
  })
}

// 原生适配器内部派生父 PID，仅用 QUERY_LIMITED_INFORMATION|SYNCHRONIZE 权限打开；无终止权限。
export const nativeWindowsParent: WindowsParentPort = {
  self: /* 当前进程的伪句柄只用于只读查询，不关闭或传给其它进程。 */ () => {
    const api = systemKernel()
    return stamp(api, api.GetCurrentProcess())
  },
  parent: /* 只消费内核快照中当前进程自己的父关系，不提供任意 PID 查询入口。 */ () => {
    const api = systemKernel()
    const snapshot = api.CreateToolhelp32Snapshot(2, 0)
    if (!snapshot || snapshot === INVALID_HANDLE) {
      throw nativeFailure(api)
    }
    let parent = 0
    let enumerationFailure: unknown
    try {
      // 两种受支持 64 位 ABI 的 PROCESSENTRY32W 均为 568 字节，父 PID 偏移 32。
      const entry = Buffer.alloc(568)
      entry.writeUInt32LE(entry.length)
      let more = api.Process32FirstW(snapshot, entry)
      for (let count = 0; more && count < 65536; count++) {
        if (entry.readUInt32LE(8) === api.GetCurrentProcessId()) {
          parent = entry.readUInt32LE(32)
          break
        }
        more = api.Process32NextW(snapshot, entry)
      }
    } catch (error) {
      enumerationFailure = error
    }
    const closeFailure = api.CloseHandle(snapshot) ? undefined : nativeFailure(api)
    if (enumerationFailure) {
      throw enumerationFailure
    }
    if (closeFailure) {
      throw closeFailure
    }
    if (!parent || parent === api.GetCurrentProcessId()) {
      throw new UpdateError('replacement_unavailable')
    }
    const handle = api.OpenProcess(0x00101000, 0, parent)
    if (!handle || handle === INVALID_HANDLE) {
      throw nativeFailure(api)
    }
    try {
      return Object.freeze({ handle, ...stamp(api, handle) })
    } catch (error) {
      api.CloseHandle(handle)
      throw error
    }
  },
  poll: /* 查询同一进程对象是否 signaled，PID 重用不会重定向持有句柄。 */ (handle) => {
    const api = systemKernel()
    const state = api.WaitForSingleObject(handle, 0)
    if (state === 0) {
      return 'exited'
    }
    if (state === 258) {
      return 'running'
    }
    throw nativeFailure(api)
  },
  close: /* 只释放此模块取得的同步/查询句柄，不发送 signal 或控制目标生命周期。 */ (handle) => {
    const api = systemKernel()
    if (!api.CloseHandle(handle)) {
      throw nativeFailure(api)
    }
  }
}

export class WindowsBoundParent {
  #closed = false
  // 句柄能力只能由核对过出生时间及映像路径的工厂建立。
  private constructor(
    private readonly handle: bigint,
    private readonly port: WindowsParentPort
  ) {}

  // 期望值来自当前安装进程封存的事务；无 PID 参数，出生时间不匹配时拒绝并关闭自有句柄。
  static bind(expected: WindowsProcessStamp, port: WindowsParentPort = nativeWindowsParent): WindowsBoundParent {
    const identity = windowsProcessStamp(expected)
    const actual = port.parent()
    if (!actual.handle || actual.handle === INVALID_HANDLE) {
      throw new UpdateError('replacement_unavailable')
    }
    try {
      if (actual.image !== identity.image || actual.born !== identity.born) {
        throw new UpdateError('target_changed')
      }
      return new WindowsBoundParent(actual.handle, port)
    } catch (error) {
      port.close(actual.handle)
      throw error
    }
  }

  // 期限或取消只报非零，不能杀父进程；替换模块必须在此成功后才取得继续能力。
  async waitForExit(signal?: AbortSignal, timeout = 30_000): Promise<void> {
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30_000) {
      throw new UpdateError('invalid_arguments')
    }
    const until = performance.now() + timeout
    while (true) {
      if (this.#closed) {
        throw new UpdateError('replacement_unavailable')
      }
      if (signal?.aborted || performance.now() >= until) {
        throw new UpdateError('update_io_pending')
      }
      if (this.port.poll(this.handle) === 'exited') {
        return
      }
      await pause(Math.min(25, Math.max(1, until - performance.now())))
    }
  }

  // 文件操作前再次核验已 signaled 的同一对象；仅早先的 IPC EOF 不能证明父进程退出。
  assertExited(): void {
    if (this.#closed || this.port.poll(this.handle) !== 'exited') {
      throw new UpdateError('update_busy')
    }
  }

  // 调用方显式释放，关闭失败仍非零；不依赖 finalizer 操作可能复用的句柄值。
  close(): void {
    if (!this.#closed) {
      this.port.close(this.handle)
      this.#closed = true
    }
  }
}
