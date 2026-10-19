/** 一次消费宿主已保护的 CSRF meta 到页面内存；不读取 cookie、创建身份或续期会话。 */
import type { ManagementWriteClientOptions } from './write-client.js'

const marker = 'meta[name="rovloom-management-bootstrap"]'

/** 沿用 CLI 的单 meta 交付契约；重复或无效交付失败关闭，截止后永久丢弃原值。 */
export function createManagementPageCsrf(page: Document = document): ManagementWriteClientOptions['csrf'] {
  const elements = [...page.querySelectorAll<HTMLMetaElement>(marker)]
  let value = elements.length === 1 ? elements[0]!.content : ''
  const expiry = elements.length === 1 ? Number(elements[0]!.dataset.expiresAt) : NaN
  for (const element of elements) {
    element.remove()
  }
  if (!/^[a-zA-Z0-9_-]{43}$/.test(value) || !Number.isSafeInteger(expiry)) {
    value = ''
  }
  return /** 取消仅拒绝本次取值；到期不再因墙钟回退恢复旧 token。 */ async (signal) => {
    if (signal.aborted) {
      return null
    }
    if (Date.now() >= expiry) {
      value = ''
    }
    return value || null
  }
}
