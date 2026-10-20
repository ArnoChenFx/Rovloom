// Gateway 私有文件统一走同描述符 POSIX 边界；Windows 未接入等效 ACL 前明确拒绝。
import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { GatewayError } from '../contracts.js'
import {
  createPosixPrivate,
  ensurePosixPrivateDirectory,
  posixPrivateFile,
  posixPrivatePath,
  readPosixPrivate
} from './private-posix.js'

// 要求规范绝对路径、无软链接祖先，以及属于当前用户的私有直接父目录。
export function privatePath(path: string): void {
  posixPrivatePath(path)
}
// 要求文件为当前用户独占拥有的 0600 普通文件，拒绝符号链接和额外硬链接。
export function privateFile(path: string): void {
  posixPrivatePath(path)
  posixPrivateFile(path)
}
// 以排他且不跟随符号链接的方式创建 0600 文件，写入可选内容并同步文件描述符。
export function createPrivate(path: string, content = ''): void {
  createPosixPrivate(path, content)
}
// 同一 fd 有界读取并核对读取前后身份；角色配置可允许所有者自行收紧写权限。
export function readPrivateBytes(path: string, maximum: number, ownerOnly = false): Buffer {
  return readPosixPrivate(path, maximum, ownerOnly)
}
// 只创建缺失的私有目录，不修复已有用户对象。
export function ensurePrivateDirectory(path: string): void {
  ensurePosixPrivateDirectory(path)
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
