/** 从宿主指定的构建目录读取固定管理静态产物；HTTP 请求不能选择磁盘路径或测试数据。 */
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { managementAssetType, type ManagementAssets } from './read-http.js'

/** 只读取常量入口和受限 chunk 名，拒绝符号链接、过大文件和缺失核心产物。 */
export function loadManagementAssets(directory: string): ManagementAssets {
  if (!isAbsolute(directory) || !lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) {
    throw new Error('management_assets_invalid')
  }
  const result = new Map<string, Uint8Array<ArrayBuffer>>()
  let total = 0
  for (const name of readdirSync(directory)) {
    const path = name === 'index.html' ? '/' : '/' + name
    if (!managementAssetType(path)) {
      continue
    }
    const file = join(directory, name)
    const stat = lstatSync(file)
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 1_048_576 ||
      result.size >= 32 ||
      (total += stat.size) > 4_194_304
    ) {
      throw new Error('management_assets_invalid')
    }
    const body = readFileSync(file)
    if (body.byteLength !== stat.size) {
      throw new Error('management_assets_invalid')
    }
    result.set(path, new Uint8Array(body))
  }
  for (const path of [
    '/',
    '/browser.js',
    '/theme.js',
    '/manage.css',
    '/rovloom-mark-transparent.png',
    '/rovloom-logo.png'
  ]) {
    if (!result.has(path)) {
      throw new Error('management_assets_missing')
    }
  }
  return result
}
