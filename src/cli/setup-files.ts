// 为程序管理的初始化状态原子落盘；不覆盖未知文件，不把内部状态变成第二份用户配置。
import {
  closeSync,
  fsyncSync,
  fchmodSync,
  linkSync,
  statSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { privatePath, readPrivateBytes } from '../storage/files.js'
import { boundedJson } from '../wire/index.js'
import { CliError } from './config.js'
import { readRuntimeJson } from './runtime-files.js'

// 只比较配置字节，防止覆盖并发编辑；权限、所有者和文件对象身份不作为代次。
export function setupFileStamp(path: string): string {
  const bytes = readPrivateBytes(path, 16_777_216)
  try {
    return createHash('sha256').update(bytes).digest('hex')
  } finally {
    bytes.fill(0)
  }
}

// 调用方仅能写自己的固定状态路径；首次使用link排他发布，更新须保留已核对的文件代次。
export function writeSetupFile(
  path: string,
  bytes: Uint8Array | string,
  replace = false,
  expectedStamp?: string
): void {
  privatePath(path)
  const previous = replace ? (expectedStamp ?? setupFileStamp(path)) : undefined
  if (replace && setupFileStamp(path) !== previous) {
    throw new CliError('config_changed')
  }
  const temporary = join(dirname(path), '.rovloom-setup-' + randomUUID() + '.tmp')
  let fd: number | undefined
  let created = false
  try {
    const mode = replace ? statSync(path).mode & 0o777 : 0o600
    fd = openSync(temporary, 'wx', mode)
    created = true
    // 仅为新临时文件复制已有普通权限，原文件及目录的权限不作修复。
    if (replace && process.platform !== 'win32') {
      fchmodSync(fd, mode)
    }
    writeFileSync(fd, bytes)
    fsyncSync(fd)
    const complete = fd
    fd = undefined
    closeSync(complete)
    if (replace) {
      if (setupFileStamp(path) !== previous) {
        throw new CliError('config_changed')
      }
      renameSync(temporary, path)
    } else {
      linkSync(temporary, path)
      unlinkSync(temporary)
    }
    created = false
  } catch (error) {
    if (error instanceof CliError) {
      throw error
    }
    throw new CliError('config_unreadable')
  } finally {
    try {
      if (fd !== undefined) {
        closeSync(fd)
      }
    } finally {
      if (created) {
        unlinkSync(temporary)
      }
    }
  }
}

// 状态文档沿用现有有界JSON门禁；不存在与损坏严格区分，只有不存在才返回空值。
export function readSetupJson(path: string, maximum = 16_384): unknown | undefined {
  try {
    return readRuntimeJson(path, maximum)
  } catch (error) {
    if (error instanceof CliError && error.code === 'backend_unavailable') {
      return undefined
    }
    throw error
  }
}

// 内部元数据也有明确预算，不输出对象内容或通过字符串转换放宽JSON边界。
export function writeSetupJson(path: string, value: unknown, replace = false, maximum = 16_384): void {
  writeSetupFile(path, boundedJson(value, maximum), replace)
}
