/** 数据库版本不兼容的本地诊断只交付数字和固定文档地址，不泄露路径或表内容。 */
import { GatewayError } from '../contracts.js'

export const DATABASE_UPGRADE_URL =
  'https://github.com/ArnoChenFx/rovloom/blob/main/docs/OPERATIONS.md#upgrading-from-v01x'

export class DatabaseVersionError extends GatewayError {
  readonly found: number | null

  /** 无法确定唯一数字版本时明确标记 unknown，不能把任意数据库值放进 CLI 输出。 */
  constructor(
    found: unknown,
    readonly expected: number
  ) {
    super('unsupported_database_version')
    this.name = 'DatabaseVersionError'
    this.found = typeof found === 'number' && Number.isSafeInteger(found) && found >= 0 ? found : null
  }
}
