// 用真实回环Streamable HTTP探测固定MCP SDK协商，服务仅为空目录兼容性fixture。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js'
import { lockedDependencies } from '../../scripts/bun/lock.mjs'
import { toolchain } from '../../scripts/bun/toolchain.mjs'

// 执行初始化、工具列表和 ping 往返，关闭客户端后返回兼容性证据。
export async function probeSdk() {
  const runtime = toolchain()
  const wire = []
  class RecordingHttp extends StreamableHTTPClientTransport {
    // 包装入站回调以保留报文，再启动官方HTTP传输。
    async start() {
      const onmessage = this.onmessage
      this.onmessage = /* 记录服务端消息后继续调用原有接收处理器。 */ (message) => {
        wire.push({ direction: 'server_to_client', message })
        onmessage?.(message)
      }
      return super.start()
    }
    // 记录客户端发出的消息，并交给父类执行实际发送。
    async send(message) {
      wire.push({ direction: 'client_to_server', message })
      return super.send(message)
    }
  }
  const server = new Server({ name: 'locked-sdk-http-fixture', version: '1' }, { capabilities: { tools: {} } })
  server.setRequestHandler(
    ListToolsRequestSchema,
    /* 空目录仅验证协议协商，不替代业务工具断言。 */ async () => ({ tools: [] })
  )
  const serverTransport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: /* 随机会话ID不充当认证。 */ () => crypto.randomUUID(),
    enableJsonResponse: true
  })
  await server.connect(serverTransport)
  const listener = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: /* 兼容探针只接受合成测试认证头，不接用户或公网流量。 */ (request) =>
      request.headers.get('authorization') === 'Bearer SDK_PROBE_ONLY'
        ? serverTransport.handleRequest(request)
        : new Response(null, { status: 401 })
  })
  const transport = new RecordingHttp(new URL(`http://127.0.0.1:${listener.port}/mcp`), {
    requestInit: { headers: { authorization: 'Bearer SDK_PROBE_ONLY' } }
  })
  const client = new Client({ name: 'p0-sdk-client', version: '1.32.1' })
  try {
    await client.connect(transport, { timeout: 5000 })
    assert.deepEqual(await client.listTools({}, { timeout: 5000 }), { tools: [] })
    assert.deepEqual(await client.ping({ timeout: 5000 }), {})
  } finally {
    try {
      await client.close()
    } finally {
      await server.close()
      listener.stop(true)
    }
  }
  const initialize = wire.find(
    /* 定位客户端初始化请求以关联协商响应。 */ (r) => r.message.method === 'initialize'
  ).message
  const result = wire.find(
    /* 查找与初始化请求对应且含结果的服务端响应。 */ (r) => r.message.id === initialize.id && r.message.result
  ).message.result
  assert.equal(result.protocolVersion, '2025-11-25')
  assert(
    wire.some(/* 确认客户端完成初始化后发送了就绪通知。 */ (r) => r.message.method === 'notifications/initialized')
  )
  const dependencies = lockedDependencies()
  for (const name of ['@modelcontextprotocol/sdk', 'ajv', 'ws']) {
    const installed = JSON.parse(readFileSync(new URL(`../../node_modules/${name}/package.json`, import.meta.url)))
    assert.equal(installed.version, dependencies[name].version, `${name}: installed version differs from lock`)
  }
  return {
    runtime,
    dependencies: Object.fromEntries(
      ['@modelcontextprotocol/sdk', 'ajv', 'ws'].map(
        /* 仅保留本次兼容性报告涉及的锁定依赖。 */ (name) => [name, dependencies[name]]
      )
    ),
    transport: 'WebStandardStreamableHTTPServerTransport on verified Bun loopback listener',
    client: '@modelcontextprotocol/sdk Client over Streamable HTTP',
    sdk_latest_constant: LATEST_PROTOCOL_VERSION,
    sdk_supported_constants: SUPPORTED_PROTOCOL_VERSIONS,
    negotiated: result.protocolVersion,
    wire,
    scope: 'SDK compatibility probe only; no Gateway/UHP integration, commercial MCP Host or OAuth claim'
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await probeSdk()
  console.log(JSON.stringify(report, null, 2))
}
