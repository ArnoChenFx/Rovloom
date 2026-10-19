// 有界同源管理POST客户端；CSRF来自既有受保护bootstrap的内存端口，不缓存身份或自动重试。
import type { ManagementArguments, ManagementReply } from '../mcp/management.js'
import type { ManagementFetch } from './http-client.js'
import {
  checkManagementWriteReply,
  managementWriteBody,
  MANAGEMENT_WRITE_REPLY_BYTES,
  ManagementClientError,
  type ManagementClientOperation,
  type ManagementClientProblem,
  type ManagementWriteTransport
} from './write-contract.js'

export type ManagementWriteClientOptions = Readonly<{
  /** 只由页面已完成的受保护会话bootstrap提供原值，不从URL/持久存储/普通管理DTO取值。 */
  csrf(signal: AbortSignal): Promise<string | null>
  fetcher?: ManagementFetch
  /** 只允许收紧等待期限，取消不代表设备动作回滚。 */
  timeout_ms?: number
}>
const operations = new Set<ManagementClientOperation>([
  'history_open',
  'write_state_get',
  'operations_get',
  'confirmations_create',
  'confirmations_confirm',
  'devices_rename',
  'devices_disconnect',
  'devices_revoke'
])

/** 无需交付的正文及时丢弃，取消失败不输出响应或底层异常。 */
function discard(response: Response): void {
  void response.body?.cancel().catch(/* 仅释放响应流，不暴露正文。 */ () => {})
}
/** 在解析前限制UTF-8字节，严格拒绝重定向、非JSON和未知输出字段。 */
async function json(response: Response, signal: AbortSignal): Promise<unknown> {
  if (
    response.redirected ||
    response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json' ||
    !response.body
  ) {
    discard(response)
    throw new ManagementClientError('invalid_response')
  }
  const length = response.headers.get('content-length')
  if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > MANAGEMENT_WRITE_REPLY_BYTES)) {
    discard(response)
    throw new ManagementClientError('invalid_response')
  }
  const reader = response.body.getReader()
  const pieces: Uint8Array[] = []
  let bytes = 0
  /** 断开/超时取消实际正文流，忽略取消的任务仍占客户端额度。 */
  const cancel = () => {
    void reader.cancel().catch(/* 取消异常不离开客户端边界。 */ () => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      if (signal.aborted) {
        throw new ManagementClientError('aborted')
      }
      const next = await reader.read()
      if (signal.aborted) {
        throw new ManagementClientError('aborted')
      }
      if (next.done) {
        break
      }
      bytes += next.value.byteLength
      if (bytes > MANAGEMENT_WRITE_REPLY_BYTES) {
        cancel()
        throw new ManagementClientError('invalid_response')
      }
      pieces.push(next.value)
    }
    const body = new Uint8Array(bytes)
    let offset = 0
    for (const piece of pieces) {
      body.set(piece, offset)
      offset += piece.byteLength
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
    } catch {
      throw new ManagementClientError('invalid_response')
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}
/** 失败正文永不进入页面、错误或日志，HTTP状态只映射到固定分类。 */
function problem(status: number): ManagementClientProblem {
  return status === 401
    ? 'unauthenticated'
    : status === 403
      ? 'forbidden'
      : status === 400 || status === 404 || status === 409
        ? 'conflict'
        : status === 429
          ? 'busy'
          : 'outcome_unconfirmed'
}

/** 创建每次至多发送一次的客户端；没有默认CSRF或管理员信任。 */
export function createManagementWriteClient(
  options: ManagementWriteClientOptions
): ManagementWriteTransport & { close(): void } {
  if (!options || typeof options.csrf !== 'function') {
    throw new ManagementClientError('invalid_request')
  }
  const timeout = options.timeout_ms ?? 5000
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 5000) {
    throw new ManagementClientError('invalid_request')
  }
  const fetcher =
    options.fetcher ??
    /* 使用浏览器既有同源cookie，不加入Authorization或身份字段。 */ ((path, init) => globalThis.fetch(path, init))
  const pending = new Set<AbortController>()
  let closed = false
  return {
    /** 取消只结束前端等待，迟到结果不自动转成重试或重新确认。 */
    async execute<K extends ManagementClientOperation>(
      operation: K,
      args: ManagementArguments[K],
      signal: AbortSignal
    ): Promise<ManagementReply[K]> {
      if (closed || signal.aborted) {
        throw new ManagementClientError('aborted')
      }
      if (!operations.has(operation)) {
        throw new ManagementClientError('invalid_request')
      }
      const body = managementWriteBody(operation, args)
      const snapshot = JSON.parse(body) as ManagementArguments[K]
      if (signal.aborted) {
        throw new ManagementClientError('aborted')
      }
      if (pending.size >= 8) {
        throw new ManagementClientError('busy')
      }
      const controller = new AbortController()
      pending.add(controller)
      let sent = false
      /** 实际工作完成前不释放额度，取消不合作的后端不能被重复请求无限堆积。 */
      const work = async (): Promise<ManagementReply[K]> => {
        try {
          const csrf = await options.csrf(controller.signal)
          if (controller.signal.aborted) {
            throw new ManagementClientError('aborted')
          }
          if (typeof csrf !== 'string' || !/^[a-zA-Z0-9_-]{32,256}$/.test(csrf)) {
            throw new ManagementClientError('unauthenticated')
          }
          sent = true
          const response = await fetcher('/admin/v1/actions/' + operation, {
            method: 'POST',
            credentials: 'same-origin',
            mode: 'same-origin',
            redirect: 'error',
            cache: 'no-store',
            headers: { accept: 'application/json', 'content-type': 'application/json', 'x-rovloom-csrf': csrf },
            body,
            signal: controller.signal
          })
          if (controller.signal.aborted) {
            discard(response)
            throw new ManagementClientError('aborted')
          }
          if (response.status !== 200) {
            discard(response)
            throw new ManagementClientError(problem(response.status))
          }
          return checkManagementWriteReply(operation, await json(response, controller.signal), snapshot)
        } catch (error) {
          throw new ManagementClientError(error instanceof ManagementClientError ? error.problem : 'unavailable', sent)
        } finally {
          pending.delete(controller)
        }
      }
      /** 既有页面取消信号只作用于本次等待，不修改原意图的关联。 */
      const abort = () => controller.abort()
      signal.addEventListener('abort', abort, { once: true })
      let interrupt!: () => void
      const stopped = new Promise<never>(
        /* 超时返回固定分类，底层工作收尾仍受pending额度约束。 */ (_resolve, reject) => {
          interrupt = /* 保守携带已开始发送的事实，不声称远端未提交。 */ () =>
            reject(new ManagementClientError('aborted', sent))
          controller.signal.addEventListener('abort', interrupt, { once: true })
        }
      )
      const timer = setTimeout(abort, timeout)
      try {
        return await Promise.race([work(), stopped])
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        controller.signal.removeEventListener('abort', interrupt)
      }
    },
    /** 幂等停止新请求及当前等待，不关闭Gateway或清理持久操作记录。 */
    close(): void {
      closed = true
      for (const controller of pending) {
        controller.abort()
      }
    }
  }
}
