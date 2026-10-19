/** 浏览器管理读取只走固定同源 GET；凭据由浏览器会话承载，不接受自报管理员身份。 */
import type { ManagementReply } from '../mcp/management.js'
import type { ManagementReadTransport } from './read.js'
import { ReadError } from './reader.js'
import { MANAGEMENT_REPLY_BYTES, managementReadPath } from './http-contract.js'
import { checkManagementReadReply } from './validate.js'

export type ManagementFetch = (path: string, init: RequestInit) => Promise<Response>

/** 丢弃无需读取的正文；失败或忽略取消的流不能阻塞固定错误响应。 */
function discard(response: Response): void {
  void response.body?.cancel().catch(
    /** 已有公开失败不被正文取消错误覆盖。 */
    () => {}
  )
}

/** 在读取响应正文时保持取消有效，并在 JSON 解析前限制总字节数。 */
async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get('content-length')
  if (length !== null && (!/^[0-9]+$/u.test(length) || Number(length) > MANAGEMENT_REPLY_BYTES)) {
    discard(response)
    throw new ReadError('invalid_response')
  }
  if (!response.body) {
    throw new ReadError('invalid_response')
  }
  const reader = response.body.getReader()
  /** 取消底层读取，不能等待忽略请求信号的响应继续提供数据。 */
  const cancel = () => {
    void reader.cancel().catch(
      /** 取消错误不替换已有公开失败，也不向页面暴露正文。 */
      () => {}
    )
  }
  signal.addEventListener('abort', cancel, { once: true })
  let bytes = 0
  const pieces: Uint8Array[] = []
  try {
    while (true) {
      if (signal.aborted) {
        throw new ReadError('unavailable')
      }
      const next = await reader.read()
      if (signal.aborted) {
        throw new ReadError('unavailable')
      }
      if (next.done) {
        break
      }
      bytes += next.value.byteLength
      if (bytes > MANAGEMENT_REPLY_BYTES) {
        cancel()
        throw new ReadError('invalid_response')
      }
      pieces.push(next.value)
    }
    const body = new Uint8Array(bytes)
    let offset = 0
    for (const piece of pieces) {
      body.set(piece, offset)
      offset += piece.byteLength
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
  } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}

/** 接入页面现有读取组合器；请求和重定向均限定同源，不缓存身份或管理 DTO。 */
export function createManagementHttpRead(
  fetcher: ManagementFetch = /* 默认使用浏览器原生同源 fetch，不加入 bearer 或身份字段。 */ (path, init) =>
    globalThis.fetch(path, init)
): ManagementReadTransport {
  return /* 固定读取一次，所有错误只转换为可公开分类，不自动重试。 */ async (operation, args, signal) => {
    if (signal.aborted) {
      throw new ReadError('unavailable')
    }
    const path = managementReadPath(operation, args)
    let response: Response
    try {
      response = await fetcher(path, {
        method: 'GET',
        credentials: 'same-origin',
        mode: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        headers: { accept: 'application/json' },
        signal
      })
    } catch {
      throw new ReadError('unavailable')
    }
    try {
      if (signal.aborted) {
        discard(response)
        throw new ReadError('unavailable')
      }
      if (response.status !== 200) {
        discard(response)
        throw new ReadError(
          response.status === 401
            ? 'unauthenticated'
            : response.status === 403
              ? 'forbidden'
              : response.status === 404
                ? 'not_found'
                : response.status === 400 || response.status === 409
                  ? 'conflict'
                  : response.status === 504
                    ? 'timeout'
                    : response.status === 502
                      ? 'invalid_response'
                      : 'unavailable'
        )
      }
      if (response.redirected || response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') {
        discard(response)
        throw new ReadError('invalid_response')
      }
      const value = await readJson(response, signal)
      return checkManagementReadReply(operation, value, args) as ManagementReply[typeof operation]
    } catch (error) {
      if (error instanceof ReadError) {
        throw error
      }
      throw new ReadError(signal.aborted ? 'unavailable' : 'invalid_response')
    }
  }
}
