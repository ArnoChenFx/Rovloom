// 源码入口只读取固定构建产物；模块/单文件构建用既有资源插件替换此定位器，不从配置选择网页路径。
import { fileURLToPath } from 'node:url'
import { loadManagementAssets } from '../admin/assets.js'
import { CliError } from './config.js'

/** 管理面显式启用后才读取实际前端产物；缺包明确拒绝，不生成空页面或fixture成功。 */
export function loadProductManagementAssets() {
  try {
    return loadManagementAssets(fileURLToPath(new URL('../../dist/webui/', import.meta.url)))
  } catch {
    throw new CliError('backend_unavailable', 3)
  }
}
