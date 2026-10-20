// 固定ref只解析到角色私有目录；受保护数据不能选择模块、shell或新的信任来源。
import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { privateFile, privatePath } from '../storage/files.js'
import { parseNativeJson } from '../native-contract/json.js'
import { CliError } from './config.js'

// 引用只构造固定文件名，拒绝路径、URL及目录跳转。
export function runtimeReference(directory: string, reference: unknown, suffix = '.json'): string {
  if (typeof reference !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(reference) || !['.json'].includes(suffix)) {
    throw new CliError('invalid_config')
  }
  return join(directory, 'managed', reference + suffix)
}

// 复用存储模块的Linux目录/文件保护检查，并在实际descriptor上再次限制单链接、大小及权限。
export function readRuntimeFile(path: string, maximum: number): Buffer {
  if (process.platform !== 'linux') {
    throw new CliError('config_platform_unsupported')
  }
  let descriptor: number | undefined
  try {
    privatePath(path)
    privateFile(path)
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(descriptor)
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > maximum
    ) {
      throw new CliError('config_not_protected')
    }
    const bytes = Buffer.alloc(maximum + 1)
    let length = 0
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null)
      if (!count) {
        break
      }
      length += count
    }
    if (length > maximum) {
      bytes.fill(0)
      throw new CliError('invalid_config')
    }
    return bytes.subarray(0, length)
  } catch (error) {
    if (error instanceof CliError) {
      throw error
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CliError('backend_unavailable', 3)
    }
    throw new CliError('config_unreadable')
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor)
    }
  }
}

// 私有JSON同样使用现有重复键/UTF8/深度门禁；不以JSON.parse绕过正式字节契约。
export function readRuntimeJson(path: string, maximum = 16_384): unknown {
  const bytes = readRuntimeFile(path, maximum)
  try {
    const parsed = parseNativeJson(bytes, { object_bytes: maximum, object_depth: 32, object_nodes: 100_000 })
    if (!parsed.ok) {
      throw new CliError('invalid_config')
    }
    return parsed.value
  } finally {
    bytes.fill(0)
  }
}
