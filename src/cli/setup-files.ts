// 为程序管理的初始化状态原子落盘；不覆盖未知文件，不把内部状态变成第二份用户配置。
import {
  constants,
  closeSync,
  fsyncSync,
  fchmodSync,
  linkSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { privateFile, privatePath } from '../storage/files.js'
import { boundedJson } from '../wire/index.js'
import { CliError } from './config.js'
import { readRuntimeJson } from './runtime-files.js'

// 同步发布或清理后的目录项，不以rename返回代替持久完成。
function syncParent(path: string): void {
  const fd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

// 捕获受保护目标的完整代次，原子替换前发现外部改动即拒绝。
function stamp(path: string): string {
  privateFile(path)
  const stat = lstatSync(path, { bigint: true })
  return [stat.dev, stat.ino, stat.uid, stat.mode, stat.nlink, stat.size, stat.ctimeNs].join(':')
}

// 调用方仅能写自己的固定状态路径；首次使用link排他发布，更新须保留已核对的文件代次。
export function writeSetupFile(path: string, bytes: Uint8Array | string, replace = false): void {
  privatePath(path)
  const previous = replace ? stamp(path) : undefined
  const temporary = join(dirname(path), '.rovloom-setup-' + randomUUID() + '.tmp')
  let fd: number | undefined
  let created = false
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    created = true
    fchmodSync(fd, 0o600)
    writeFileSync(fd, bytes)
    fsyncSync(fd)
    const complete = fd
    fd = undefined
    closeSync(complete)
    if (replace) {
      if (stamp(path) !== previous) {
        throw new CliError('configuration_required')
      }
      renameSync(temporary, path)
    } else {
      linkSync(temporary, path)
      unlinkSync(temporary)
    }
    created = false
    syncParent(path)
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
        syncParent(path)
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
