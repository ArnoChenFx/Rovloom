// 在标准 SDK stdio 上约束编码、请求关联、取消和输出边界，只管理前端等待与桥接资源。
import { Readable, Writable } from 'node:stream'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  CancelledNotificationSchema,
  ErrorCode,
  InitializeRequestSchema,
  ListToolsRequestSchema,
  type JSONRPCMessage
} from '@modelcontextprotocol/sdk/types.js'
import { createMcpFacade, type FacadeOptions } from './facade.js'
import { MAX_MCP_BYTES } from './schema.js'

const rpcMessages: Record<number, string> = {
  [ErrorCode.ParseError]: 'Parse error',
  [ErrorCode.InvalidRequest]: 'Invalid request',
  [ErrorCode.MethodNotFound]: 'Method not found',
  [ErrorCode.InvalidParams]: 'Invalid params',
  [ErrorCode.InternalError]: 'Internal error'
}

// 沿用 SDK framing，在输入编码、消息关联和输出帧上施加边界。
class FacadeStdioTransport extends StdioServerTransport {
  private readonly utf8 = new TextDecoder('utf-8', { fatal: true })
  private readonly externalIds = new Map<string | number, number>()
  private readonly internalIds = new Map<number, string | number>()
  private nextId = 1
  private stopped = false

  // 在 SDK 输入前安装增量 UTF-8 校验，仍复用标准 stdio framing。
  constructor(stdin: Readable, stdout: Writable) {
    super(stdin, stdout, { maxBufferSize: 1_048_576 })
    const ondata = this._ondata
    this._ondata = /* 拒绝非法编码和过大 chunk，合法字节原样交给 SDK 缓冲器。 */ (chunk) => {
      if (this.stopped) {
        return
      }
      try {
        if (chunk.byteLength > 1_048_576) {
          throw new Error('input_too_large')
        }
        // 增量验证保留跨 chunk 的多字节字符；字节原样交给 SDK framing。
        this.utf8.decode(chunk, { stream: true })
      } catch {
        this.rejectInput()
        return
      }
      ondata(chunk)
    }
  }

  // 仅报告固定输入错误并关闭会话，防止继续派发被改写的请求。
  private rejectInput(): void {
    this.onerror?.(new Error('invalid_stdio_input'))
    void this.close()
  }

  // 安装请求关联和取消归一化，再启动 SDK 的标准输入监听。
  override async start(): Promise<void> {
    const onmessage = this.onmessage
    this.onmessage = /* 拦截重复在途 ID、非法形状和取消；公共 ID 映射为 SDK 私有正整数。 */ (message) => {
      if (this.stopped) {
        return
      }
      if ('id' in message && typeof message.id === 'string' && Buffer.byteLength(message.id) > 128) {
        this.rejectInput()
        return
      }
      if ('method' in message && 'id' in message) {
        if (this.externalIds.has(message.id) || this.externalIds.size >= 1024 || !Number.isSafeInteger(this.nextId)) {
          // 重复在途 ID 会覆盖 SDK 等待关联，必须在进入 SDK 前关闭整个会话。
          this.rejectInput()
          return
        }
        const schema =
          message.method === 'tools/call'
            ? CallToolRequestSchema
            : message.method === 'tools/list'
              ? ListToolsRequestSchema
              : message.method === 'initialize'
                ? InitializeRequestSchema
                : undefined
        if (schema && !schema.safeParse(message).success) {
          void this.writeExternal({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: ErrorCode.InvalidParams, message: 'Invalid params' }
          }).catch(
            /* 将错误响应发送失败收敛为固定诊断，不记录原输入。 */ () => this.onerror?.(new Error('response_failed'))
          )
          return
        }
        // SDK 1.32.1 对 falsey requestId 的取消判断有缺口；私有正整数关联保留公共原 ID。
        const internalId = this.nextId++
        this.externalIds.set(message.id, internalId)
        this.internalIds.set(internalId, message.id)
        onmessage?.({ ...message, id: internalId })
        return
      }
      if ('method' in message && message.method === 'notifications/cancelled') {
        const parsed = CancelledNotificationSchema.safeParse(message)
        if (!parsed.success) {
          this.rejectInput()
          return
        }
        const id = parsed.data.params.requestId
        if (id === undefined) {
          return
        }
        const internalId = this.externalIds.get(id)
        if (internalId !== undefined) {
          this.externalIds.delete(id)
          this.internalIds.delete(internalId)
          // reason 是不可信前端文本，不传给服务等待信号或诊断。
          onmessage?.({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: internalId } })
        }
        return
      }
      onmessage?.(message)
    }
    await super.start()
  }

  // 还原公共响应 ID，并抑制已取消或关闭等待的晚到回复。
  override async send(message: JSONRPCMessage): Promise<void> {
    if (this.stopped) {
      return
    }
    if ('id' in message && !('method' in message)) {
      const externalId = typeof message.id === 'number' ? this.internalIds.get(message.id) : undefined
      if (externalId === undefined) {
        // 已取消或关闭的等待不得泄漏晚到回复，更不能误关联新请求。
        return
      }
      this.internalIds.delete(message.id as number)
      this.externalIds.delete(externalId)
      await this.writeExternal({ ...message, id: externalId })
      return
    }
    await this.writeExternal(message)
  }

  // 脱敏 JSON-RPC 错误并检查最终帧字节数；超限关闭，不回显原异常。
  private async writeExternal(message: JSONRPCMessage): Promise<void> {
    if (this.stopped) {
      return
    }
    const safe =
      'error' in message
        ? {
            jsonrpc: '2.0' as const,
            id: message.id,
            error: { code: message.error.code, message: rpcMessages[message.error.code] ?? 'Request failed' }
          }
        : message
    if (Buffer.byteLength(JSON.stringify(safe)) + 1 > MAX_MCP_BYTES) {
      this.onerror?.(new Error('response_too_large'))
      await this.close()
      return
    }
    await super.send(safe)
  }

  // 幂等释放协议关联并检查截断编码；关闭只终止会话等待。
  override async close(): Promise<void> {
    if (this.stopped) {
      return
    }
    this.stopped = true
    this.externalIds.clear()
    this.internalIds.clear()
    try {
      this.utf8.decode()
    } catch {
      this.onerror?.(new Error('invalid_stdio_input'))
    }
    await super.close()
  }
}

export type RunningStdio = {
  closed: Promise<void>
  // 幂等关闭前端桥接和等待；不表示远端工作已终止或回滚。
  close(): Promise<void>
}

// 连接 SDK 门面和字节流，统一处理 EOF、管道故障及资源释放。
export async function startStdioFacade(
  options: FacadeOptions & { stdin?: Readable; stdout?: Writable }
): Promise<RunningStdio> {
  const stdin = options.stdin ?? process.stdin
  const stdout = options.stdout ?? process.stdout
  const transport = new FacadeStdioTransport(stdin, stdout)
  const server = createMcpFacade(options)
  let resolveClosed!: () => void
  const closed = new Promise<void>(
    /* 保存关闭完成通知，供宿主等待桥接生命周期结束。 */ (resolve) => {
      resolveClosed = resolve
    }
  )
  let closing: Promise<void> | undefined
  const detach = /* 移除本模块安装的监听器并通知宿主，避免关闭后保留流引用。 */ () => {
    stdin.off('end', onEnd)
    stdin.off('close', onEnd)
    stdin.off('error', onEnd)
    stdout.off('error', onEnd)
    stdout.off('close', onEnd)
    resolveClosed()
  }
  const close = /* 复用同一关闭 promise，确保并发关闭不会重复清理资源。 */ (): Promise<void> => {
    closing ??= server.close().finally(detach)
    return closing
  }
  const onEnd = /* 将流结束或故障转换为本地桥接关闭，不发业务取消。 */ () => {
    void close().catch(
      /* 关闭失败时只报告固定诊断，不暴露服务异常。 */ () => options.diagnostic?.('mcp_shutdown_error')
    )
  }
  const previousClose = server.onclose
  server.onclose = /* 保留门面的关闭状态更新并移除本地监听器；等待信号由 SDK 关闭路径终止。 */ () => {
    previousClose?.()
    detach()
  }
  stdin.once('end', onEnd)
  stdin.once('close', onEnd)
  stdin.once('error', onEnd)
  stdout.once('error', onEnd)
  stdout.once('close', onEnd)
  try {
    await server.connect(transport)
    if (stdin.readableEnded || stdin.destroyed || stdout.destroyed) {
      await close()
    }
  } catch (error) {
    await close()
    throw error
  }
  return { closed, close }
}
