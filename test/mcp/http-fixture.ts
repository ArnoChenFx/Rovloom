// 用真实回环HTTP监听和标准SDK客户端驱动门面，认证只用明确的合成测试头，不接用户会话。
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { startHttpFacade, type HttpFacadeOptions } from '../../src/mcp/http.js'
import type { GatewayService } from '../../src/mcp/types.js'

export const syntheticHeaders = { authorization: 'Bearer HTTP_TEST_ONLY' }

// 受控服务由用例显式提供；固定身份仅是测试认证stub，不构成产品授权或生产后端。
export function httpFixture(service: GatewayService, options: Partial<Omit<HttpFacadeOptions, 'service'>> = {}) {
  const running = startHttpFacade({
    service,
    authentication: {
      authenticate: /* 合成token仅在本用例的私有回环listener有效。 */ (request) =>
        request.headers.get('authorization') === syntheticHeaders.authorization
          ? { principal_id: 'isolated-caller' }
          : null
    },
    ...options,
    port: 0
  })
  const transport = new StreamableHTTPClientTransport(new URL(running.url), {
    requestInit: { headers: syntheticHeaders }
  })
  const client = new Client({ name: 'isolated-http-sdk', version: '1' })
  const close = /* 关闭客户端后再关闭本例拥有的listener，不把客户端退出当作Gateway停止信号。 */ async () => {
    try {
      await client.close()
    } finally {
      await running.close()
    }
  }
  return { running, transport, client, close }
}

// 读取官方SDK的单请求SSE或JSON响应，保留公共JSON-RPC ID供边界测试比较。
export async function rpcResponse(response: Response): Promise<JSONRPCMessage> {
  const text = await response.text()
  if (response.headers.get('content-type')?.startsWith('text/event-stream')) {
    const line = text
      .split('\n')
      .find(/* 每个用例只发单条请求，取SDK生成的唯一data事件。 */ (value) => value.startsWith('data: '))
    if (!line) {
      throw new Error('missing_rpc_response')
    }
    return JSON.parse(line.slice(6)) as JSONRPCMessage
  }
  return JSON.parse(text) as JSONRPCMessage
}

// 原始HTTP探针仍使用正式门面和SDK协议栈，暴露客户端不便构造的ID及非法字节边界。
export function rawHttp(service: GatewayService, options: Partial<Omit<HttpFacadeOptions, 'service'>> = {}) {
  const fixture = httpFixture(service, options)
  let session: string | undefined
  const wire: JSONRPCMessage[] = []
  const post = /* 发出单条JSON-RPC请求，按当前会话自动补齐标准头，不补造身份。 */ async (
    message: unknown,
    signal?: AbortSignal
  ) => {
    const response = await fetch(fixture.running.url, {
      method: 'POST',
      headers: {
        ...syntheticHeaders,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        ...(session ? { 'mcp-session-id': session, 'mcp-protocol-version': '2025-11-25' } : {})
      },
      body: JSON.stringify(message),
      signal
    })
    session ??= response.headers.get('mcp-session-id') ?? undefined
    return response
  }
  const request = /* 消费并记录真实协议响应，避免留下未结束的SSE等待。 */ async (
    id: string | number,
    method: string,
    params?: unknown
  ) => {
    const response = await post({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
    const message = await rpcResponse(response)
    wire.push(message)
    return message as unknown as Record<string, unknown>
  }
  const initialize = /* 完成初始化及就绪通知，后续请求使用服务端实际生成的会话ID。 */ async () => {
    await request('init', 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'raw-http', version: '1' }
    })
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
  }
  const headers = /* 为非法字节和跨主体用例提供已生成的会话头，不把它视为认证。 */ () => ({
    ...syntheticHeaders,
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-session-id': session!,
    'mcp-protocol-version': '2025-11-25'
  })
  return { ...fixture, wire, post, request, initialize, headers }
}
