/** 只读 HTTPS 下载的三次有限尝试；不接受 method/body，不用于配对、native 写入或服务控制。 */
import { setTimeout as pause } from 'node:timers/promises'

const transient = new Set([408, 429, 500, 502, 503, 504])
const connections = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_SOCKET'
])

/** 固定公开错误不带 URL、header、响应或底层网络错误正文。 */
export class NetworkReadError extends Error {
  constructor(code) {
    super(code)
    this.name = 'NetworkReadError'
  }
}

/** 每跳校验 HTTPS；跨 origin 后永久移除凭据，不把 GitHub token 带到 CDN。 */
async function request(url, headers, signal, fetcher) {
  for (let redirect = 0; redirect <= 5; redirect++) {
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new NetworkReadError('read_url_invalid')
    }
    signal.throwIfAborted()
    const response = await fetcher(url, { method: 'GET', redirect: 'manual', headers, signal })
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return response
    }
    void response.body?.cancel().catch(() => {})
    const location = response.headers.get('location')
    if (!location || redirect === 5) {
      throw new NetworkReadError('read_redirect_invalid')
    }
    let next
    try {
      next = new URL(location, url)
    } catch {
      throw new NetworkReadError('read_redirect_invalid')
    }
    if (next.origin !== url.origin) {
      headers.delete('authorization')
      headers.delete('cookie')
    }
    url = next
  }
  throw new NetworkReadError('read_redirect_invalid')
}

/** 整个下载（含正文、退避和重定向）共用总期限；只有瞬态网络错误或明确瞬态状态重试。 */
export async function readNetwork(
  rawUrl,
  { maxBytes, timeoutMs = 90_000, signal, headers: inputHeaders, fetcher = fetch, wait = pause } = {}
) {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 180_000
  ) {
    throw new NetworkReadError('read_options_invalid')
  }
  const overall = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)])
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    throw new NetworkReadError('read_url_invalid')
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    let response
    let retryAfter = 0
    try {
      overall.throwIfAborted()
      // 慢但持续成功的下载可用完整原预算；失败后的重试只用剩余时间。
      const active = overall
      response = await request(url, new Headers(inputHeaders), active, fetcher)
      if (transient.has(response.status)) {
        const seconds = response.headers.get('retry-after')
        if (seconds !== null && /^\d+$/u.test(seconds)) {
          retryAfter = Number(seconds) * 1000
          if (retryAfter > 5000) {
            throw new NetworkReadError('read_retry_after_exceeds_budget')
          }
        }
        throw new NetworkReadError('read_transient_status')
      }
      if (response.status !== 200 || !response.body) {
        throw new NetworkReadError('read_http_rejected')
      }
      const declared = response.headers.get('content-length')
      if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maxBytes)) {
        throw new NetworkReadError('read_size_limit')
      }
      const reader = response.body.getReader()
      const parts = []
      let size = 0
      try {
        while (true) {
          active.throwIfAborted()
          const item = await reader.read()
          active.throwIfAborted()
          if (item.done) {
            break
          }
          size += item.value.byteLength
          if (size > maxBytes) {
            throw new NetworkReadError('read_size_limit')
          }
          parts.push(Buffer.from(item.value))
        }
        return Buffer.concat(parts, size)
      } finally {
        void reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    } catch (error) {
      void response?.body?.cancel().catch(() => {})
      if (overall.aborted) {
        throw new NetworkReadError('read_aborted')
      }
      const connectionCode = error?.cause?.code ?? error?.code
      const retryable =
        error?.message === 'read_transient_status' ||
        error?.name === 'TimeoutError' ||
        connections.has(connectionCode) ||
        (error instanceof TypeError && !connectionCode)
      if (!retryable || attempt === 2) {
        throw error instanceof NetworkReadError ? error : new NetworkReadError('read_network_failed')
      }
      try {
        await wait(Math.max(250 * 2 ** attempt, retryAfter), undefined, { signal: overall })
      } catch {
        throw new NetworkReadError('read_aborted')
      }
    }
  }
  throw new NetworkReadError('read_network_failed')
}
