// 受审查 Windows 模块只加载固定系统 DLL；不接受运行时库路径、脚本或 caller 符号表。
import { createRequire } from 'node:module'
import { UpdateError } from '../contract.js'

export type WindowsFfi = {
  dlopen(path: string, definitions: Record<string, { args: string[]; returns: string }>): { symbols: unknown }
  ptr(bytes: Uint8Array): number
  toArrayBuffer(pointer: number, offset: number, length: number): ArrayBuffer
}
const libraries = new Set<unknown>()
let ffi: WindowsFfi | undefined

// 实验性 native 边界严格限制在锁定 Bun/Windows 64 位版本；缺能力明确失败，不调用 shell 回退。
export function windowsFfi(): WindowsFfi {
  if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch) || process.versions.bun !== '1.4.3') {
    throw new UpdateError('replacement_unavailable')
  }
  if (!ffi) {
    try {
      ffi = createRequire(import.meta.url)('bun:ffi') as WindowsFfi
    } catch {
      throw new UpdateError('replacement_unavailable')
    }
  }
  return ffi
}

// 仅内部固定调用点定义 ABI；保留 library 对象，避免仍用符号时其动态库生命周期丢失。
export function windowsLibrary<T>(
  name: 'kernel32' | 'advapi32' | 'authz',
  definitions: Record<string, { args: string[]; returns: string }>
): T {
  try {
    const library = windowsFfi().dlopen(`C:\\Windows\\System32\\${name}.dll`, definitions)
    libraries.add(library)
    return library.symbols as T
  } catch {
    throw new UpdateError('replacement_unavailable')
  }
}

// HANDLE 与虚拟地址严格区分；只将受 Win32 验证的实际内存指针转换为 JS 地址。
export function windowsPointer(value: bigint): number {
  if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new UpdateError('replacement_unavailable')
  }
  return Number(value)
}

// UTF-16 参数始终由本次调用持有，不能以 NUL 截断被审查路径或账户名。
export function windowsWide(value: string): Buffer {
  if (value.includes('\0')) {
    throw new UpdateError('unsafe_installation')
  }
  return Buffer.from(value + '\0', 'utf16le')
}

export class WindowsNativeError extends UpdateError {
  // 保留无秘密的原生数字供部分成功状态分类；公共诊断仍只使用固定 UpdateError code。
  constructor(readonly win32: number) {
    super(
      win32 === 5 || win32 === 1314
        ? 'permission_denied'
        : win32 === 32 || win32 === 33
          ? 'update_busy'
          : 'staging_failed'
    )
  }
}
