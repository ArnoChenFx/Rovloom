// 用独立 stdio 子进程探测固定 MCP SDK 的协商结果，记录报文及依赖版本。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js'
import { lockedDependencies } from '../../scripts/bun/lock.mjs'
import { toolchain } from '../../scripts/bun/toolchain.mjs'

// 执行初始化、工具列表和 ping 往返，关闭客户端后返回兼容性证据。
export async function probeSdk() {
  const runtime = toolchain()
  const wire = []
  class RecordingStdio extends StdioClientTransport {
    // 包装入站回调以保留报文，再启动父类 stdio 传输。
    async start() {
      const onmessage = this.onmessage
      this.onmessage = /* 记录服务端消息后继续调用原有接收处理器。 */ (message, extra) => {
        wire.push({ direction: 'server_to_client', message })
        onmessage?.(message, extra)
      }
      return super.start()
    }
    // 记录客户端发出的消息，并交给父类执行实际发送。
    async send(message) {
      wire.push({ direction: 'client_to_server', message })
      return super.send(message)
    }
  }
  const transport = new RecordingStdio({
    command: process.execPath,
    args: ['--no-env-file', fileURLToPath(new URL('./sdk-compatibility-server.mjs', import.meta.url))],
    env: { PATH: process.env.PATH ?? '' },
    stderr: 'pipe'
  })
  let stderr = ''
  transport.stderr?.on(
    'data',
    /* 累积子进程错误输出，稍后断言兼容探针无额外诊断。 */ (bytes) => {
      stderr += bytes
    }
  )
  const client = new Client({ name: 'p0-sdk-client', version: '1.32.1' })
  try {
    await client.connect(transport, { timeout: 5000 })
    assert.deepEqual(await client.listTools({}, { timeout: 5000 }), { tools: [] })
    assert.deepEqual(await client.ping({ timeout: 5000 }), {})
  } finally {
    await client.close()
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
  assert.equal(stderr, '')
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
    childRuntime: 'same verified Bun executable with --no-env-file',
    client: '@modelcontextprotocol/sdk Client over child-process stdio',
    sdk_latest_constant: LATEST_PROTOCOL_VERSION,
    sdk_supported_constants: SUPPORTED_PROTOCOL_VERSIONS,
    negotiated: result.protocolVersion,
    stderr,
    wire,
    scope: 'SDK compatibility probe only; no Gateway/UHP integration, commercial MCP Host, HTTP or OAuth claim'
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await probeSdk()
  console.log(JSON.stringify(report, null, 2))
}
