// 验证 Linux 私有存储路径和文件，独占创建同步落盘的文件，并统计无符号链接的目录占用。
import { constants, closeSync, fsyncSync, lstatSync, openSync, readdirSync, writeSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { GatewayError } from '../contracts.js'

// 要求 Linux 规范绝对路径、真实父级目录，以及当前用户拥有的 0700 直接父目录。
export function privatePath(path: string): void {
  // 尚未验证 Windows ACL/macOS 文件语义，不能以 POSIX mode 冒充跨平台支持。
  if (process.platform !== 'linux') {
    throw new GatewayError('unsupported_storage_platform')
  }
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new GatewayError('invalid_storage_path')
  }
  let current = parse(path).root
  for (const part of dirname(path).slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part)
    const st = lstatSync(current)
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new GatewayError('unsafe_storage_path')
    }
  }
  const parent = lstatSync(dirname(path))
  if ((parent.mode & 0o777) !== 0o700 || parent.uid !== process.getuid?.()) {
    throw new GatewayError('private_storage_directory_required')
  }
}
// 要求文件为当前用户独占拥有的 0600 普通文件，拒绝符号链接和额外硬链接。
export function privateFile(path: string): void {
  const st = lstatSync(path)
  if (
    !st.isFile() ||
    st.isSymbolicLink() ||
    st.nlink !== 1 ||
    (st.mode & 0o777) !== 0o600 ||
    st.uid !== process.getuid?.()
  ) {
    throw new GatewayError('unsafe_storage_file')
  }
}
// 以排他且不跟随符号链接的方式创建 0600 文件，写入可选内容并同步文件描述符。
export function createPrivate(path: string, content = ''): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    if (content) {
      writeSync(fd, content)
    }
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
// 递归累计普通文件大小，遇到符号链接或其他特殊文件时拒绝统计。
export function managedBytes(directory: string): number {
  let total = 0
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    const st = lstatSync(path)
    if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) {
      throw new GatewayError('unsafe_storage_file')
    }
    total += st.isDirectory() ? managedBytes(path) : st.size
  }
  return total
}
