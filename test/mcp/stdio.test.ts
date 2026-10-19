// 使用真实 SDK stdio 子进程验证门面协议和结果保真；业务方法全部来自明确的隔离 stub。
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { CallToolResultSchema, type CallToolResult, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { configTemplate } from '../../src/cli/index.js'
import { MAX_MCP_BYTES, PRODUCT_VERSION, toolNames } from '../../src/mcp/index.js'
import { managedSdkTestSession } from './sdk-test-session.js'

const stub = fileURLToPath(new URL('./stub-server.ts', import.meta.url))
const target = { machine_id: 'machine', provider_id: 'provider', profile: 'session', session: 'isolated' }
const base = { target, expected_binding_revision: 1 }
const call = /* 构造显式目标、契约和期限的无秘密调用参数，不接真实原生实例。 */ (method: string) => ({
  ...base,
  contract_ref: 'a'.repeat(64),
  deadline: 2_000_000_000_000,
  native_request: { method }
})

// 比较结构化内容和 JSON 文本副本后取业务数据，暴露任何保真差异。
function data(reply: CallToolResult): Record<string, unknown> {
  assert(reply.structuredContent)
  const content = reply.content[0]
  assert(content?.type === 'text')
  assert.deepEqual(JSON.parse(content.text), reply.structuredContent)
  return reply.structuredContent.data as Record<string, unknown>
}

// 启动真实 SDK stdio 子进程并隔离配置、记录和环境，结束后清理资源。
async function isolated(
  lifetime: TestContext,
  mode: string,
  check: (client: StdioTestClient, transport: RecordingStdio, directory: string) => Promise<void>
) {
  const directory = mkdtempSync(join(tmpdir(), 'rovloom-mcp-sdk-'))
  const config = join(directory, 'gateway.json')
  writeFileSync(config, JSON.stringify({ ...configTemplate('gateway'), state_dir: join(directory, 'state') }), {
    mode: 0o600
  })
  const transport = new RecordingStdio({
    command: process.execPath,
    args: ['--no-env-file', stub, mode, config],
    env: { PATH: process.env.PATH ?? '', ROVLOOM_STUB_RECORD: join(directory, 'events.jsonl') },
    stderr: 'pipe'
  })
  const client = new StdioTestClient({ name: 'rovloom-isolated-sdk-test', version: '1.0.0' })
  const session = managedSdkTestSession(lifetime, client, transport)
  lifetime.after(
    /* 先由已登记的SDK清理排空子进程，再删除本例私有记录目录。 */ () =>
      rmSync(directory, { recursive: true, force: true })
  )
  let stderr = ''
  transport.stderr?.on(
    'data',
    /* 收集子进程 stderr，供检查秘密和私有路径没有泄露。 */ (chunk) => {
      stderr += chunk
    }
  )
  const errors: Error[] = []
  client.onerror = /* 记录 SDK 异常，避免协议错误被测试忽略。 */ (error) => errors.push(error)
  await session.run(
    /* 所有断言与SDK等待都由同一生命周期观察，避免超时后的晚到拒绝。 */ async (_client, _transport, signal) => {
      client.waitSignal = signal
      assert.equal(client.getServerVersion()?.name, 'rovloom')
      assert.equal(client.getServerVersion()?.version, PRODUCT_VERSION)
      const initialize = transport.received.find(
        /* 选取初始化响应，核对实际协商 revision 而非依赖版本推断。 */ (message) =>
          'result' in message && message.id === 0
      )
      assert(initialize && 'result' in initialize)
      assert.equal(initialize.result.protocolVersion, '2025-11-25')
      await check(client, transport, directory)
      assert.deepEqual(errors, [])
      for (const message of transport.received) {
        assert(Buffer.byteLength(JSON.stringify(message)) + 1 <= MAX_MCP_BYTES)
      }
      assert(!JSON.stringify(transport.received).includes('SYNTHETIC_SECRET_DO_NOT_PRINT'))
      assert(!stderr.includes('SYNTHETIC_SECRET_DO_NOT_PRINT'))
      assert(!stderr.includes('/private/'))
      assert(
        stderr
          .split('\n')
          .filter(Boolean)
          .every(
            /* 检查每条诊断都来自允许的固定代码集合。 */ (line) =>
              line === 'mcp_service_error' || line === 'mcp_transport_error'
          )
      )
    }
  )
}

class StdioTestClient extends Client {
  waitSignal: AbortSignal | undefined
  // 将 SDK 兼容返回类型收窄到标准工具结果并实际校验其结构。
  override async callTool(...args: Parameters<Client['callTool']>): Promise<CallToolResult> {
    const options = args[2]
    const signal =
      this.waitSignal && options?.signal
        ? AbortSignal.any([this.waitSignal, options.signal])
        : (this.waitSignal ?? options?.signal)
    return CallToolResultSchema.parse(
      await super.callTool(args[0], args[1], { ...options, timeout: options?.timeout ?? 5000, signal })
    )
  }
}

class RecordingStdio extends StdioClientTransport {
  readonly received: JSONRPCMessage[] = []
  readonly sent: JSONRPCMessage[] = []
  // 在启动标准传输前安装接收记录，保留握手和所有回复。
  override async start(): Promise<void> {
    const onmessage = this.onmessage
    this.onmessage = /* 记录收到的帧后交回 SDK，保持真实客户端处理路径。 */ (message) => {
      this.received.push(message)
      onmessage?.(message)
    }
    await super.start()
  }
  // 记录发出的帧并沿用标准发送逻辑，不模拟协议成功。
  override async send(message: JSONRPCMessage): Promise<void> {
    this.sent.push(message)
    await super.send(message)
  }
}

test(
  '真实 SDK stdio 完成分页发现、描述、五方法族调用、状态和结果读取；服务为隔离 stub',
  { timeout: 30_000 },
  /* 通过真实子进程验证目录、描述、五类 stub 调用和结果分页。 */ async (t) => {
    await isolated(
      t,
      'ordinary',
      /* 逐页发现并调用受控方法，比较返回原值与可读句柄页。 */ async (client) => {
        const names: string[] = []
        let cursor: string | undefined
        let pages = 0
        do {
          const page = await client.listTools(cursor ? { cursor } : {}, { signal: client.waitSignal, timeout: 5000 })
          names.push(...page.tools.map(/* 提取目录名称，用于核对静态工具集合和分页完整性。 */ (tool) => tool.name))
          assert(
            page.tools.every(
              /* 核对每项元数据都声明严格参数和结构化输出。 */ (tool) =>
                tool.inputSchema.additionalProperties === false && tool.outputSchema
            )
          )
          cursor = page.nextCursor
          pages++
        } while (cursor)
        assert.equal(pages, 3)
        assert.deepEqual(names, toolNames())
        await assert.rejects(
          client.listTools({ cursor: 'SYNTHETIC_SECRET_DO_NOT_PRINT' }, { signal: client.waitSignal, timeout: 5000 }),
          /Invalid params/
        )
        const machines = data(await client.callTool({ name: 'machines_list', arguments: {} }))
        assert.equal((machines.items as unknown[]).length, 1)
        assert.deepEqual(
          data(await client.callTool({ name: 'machines_list', arguments: { cursor: machines.next_cursor } })),
          {
            items: []
          }
        )
        const discovered = data(await client.callTool({ name: 'runtime_discover', arguments: base }))
        for (const item of discovered.items as { method: string }[]) {
          assert.equal(
            data(await client.callTool({ name: 'runtime_describe', arguments: { ...base, method: item.method } }))
              .method,
            item.method
          )
          const args = {
            ...call(item.method),
            native_request: { method: item.method, params: { nested: ['原文', false, null] } }
          }
          const called = data(await client.callTool({ name: 'runtime_call', arguments: args }))
          assert.deepEqual((called.native_response as Record<string, unknown>).result, {
            method: item.method,
            params: { nested: ['原文', false, null] },
            value: ['值', false, null, 3.25]
          })
          assert.deepEqual(
            data(await client.callTool({ name: 'runtime_call_get', arguments: { call_id: called.call_id } })),
            called
          )
        }
        const first = data(
          await client.callTool({ name: 'runtime_result_read', arguments: { result_id: 'result-test' } })
        )
        const second = data(
          await client.callTool({
            name: 'runtime_result_read',
            arguments: { result_id: 'result-test', cursor: first.next_cursor }
          })
        )
        assert.equal(first.eof, false)
        assert.equal(second.eof, true)
        assert.equal((first.chunk as string) + (second.chunk as string), '隔离分页结果😀'.repeat(100))
        assert.equal(
          data(await client.callTool({ name: 'runtime_call_cancel', arguments: { call_id: 'call-1' } })).cancellation,
          'bridge_stopped'
        )
      }
    )
  }
)

test(
  '真实 SDK 区分参数协议错误、授权错误、原生 error 和超大响应，所有错误均无秘密',
  { timeout: 30_000 },
  /* 组合参数、权限、原生错误和大响应负例，区分协议与业务错误。 */ async (t) => {
    await isolated(
      t,
      'ordinary',
      /* 向标准客户端提交非法形状并检查服务记录，防止错误请求越过边界。 */ async (client, _transport, directory) => {
        for (const args of [
          { ...call('uhp.ping'), principal: 'admin' },
          { ...call('uhp.ping'), admin: true },
          { ...call('uhp.ping'), discard_response: true },
          { ...call('uhp.ping'), native_request: { method: 'uhp.ping', id: 'caller-id' } },
          { ...call('uhp.ping'), native_request: { method: 'uhp.ping', auth: 'SYNTHETIC_SECRET_DO_NOT_PRINT' } },
          { ...call('uhp.ping'), target: { ...target, session: '' } },
          { ...call('uhp.ping'), target: { ...target, profile: 'host' } },
          { ...call('uhp.ping'), expected_binding_revision: 0 },
          { ...call('uhp.ping'), wait_ms: 5001 }
        ]) {
          await assert.rejects(client.callTool({ name: 'runtime_call', arguments: args }), /Invalid params/)
        }
        await assert.rejects(
          client.callTool({ name: 'unknown-SYNTHETIC_SECRET_DO_NOT_PRINT', arguments: {} }),
          /Invalid params/
        )
        await assert.rejects(
          client.request({ method: 'tools/call', params: { name: 3 } }, CallToolResultSchema, {
            signal: client.waitSignal,
            timeout: 5000
          }),
          /Invalid params/
        )
        assert(
          !readFileSync(join(directory, 'events.jsonl'), { encoding: 'utf8', flag: 'a+' }).includes('runtime_call')
        )
        for (const name of ['machines_register', 'machines_rename', 'machines_revoke', 'runtime_response_discard']) {
          const args =
            name === 'machines_register'
              ? { name: 'isolated' }
              : name === 'machines_rename'
                ? { machine_id: 'machine', name: 'new' }
                : name === 'machines_revoke'
                  ? { machine_id: 'machine', confirmation_id: 'confirmed' }
                  : { call_id: 'call-1' }
          const reply = await client.callTool({ name, arguments: args })
          assert.equal(reply.isError, true)
          assert.deepEqual(reply.structuredContent, { gateway_error: { code: 'forbidden' } })
        }
        const error = await client.callTool({ name: 'runtime_call', arguments: call('stub.native_error') })
        assert.equal(error.isError, true)
        assert.deepEqual((data(error).native_response as Record<string, unknown>).error, {
          code: 'native_test',
          message: '原生测试错误',
          data: { nested: [false, null, { kept: '值' }] }
        })
        const thrown = await client.callTool({ name: 'runtime_call', arguments: call('stub.throw') })
        assert.deepEqual(thrown.structuredContent, { gateway_error: { code: 'internal_error' } })
        const large = await client.callTool({ name: 'runtime_call', arguments: call('stub.large') })
        assert.equal(large.isError, true)
        assert.deepEqual(large.structuredContent?.gateway_error, { code: 'response_too_large' })
        const delivery = large.structuredContent?.delivery as Record<string, unknown>
        assert.equal(delivery.truncated, true)
        assert.match(delivery.sha256 as string, /^[a-f0-9]{64}$/)
        assert.equal(delivery.call_id, 'call-2')
        assert.equal(delivery.result_id, undefined)
      }
    )
  }
)

test(
  '受信 caller 缺失时拒绝且不进入业务服务',
  /* 独立运行缺身份边界，不把四个子进程生命周期挤在同一测试预算内。 */ async (t) => {
    await isolated(
      t,
      'unbound',
      /* 在缺少受信身份时请求列表，确认服务从未收到业务调用。 */ async (client, _transport, directory) => {
        assert.deepEqual((await client.callTool({ name: 'machines_list', arguments: {} })).structuredContent, {
          gateway_error: { code: 'unauthenticated' }
        })
        assert.throws(
          /* 尝试读取不存在的服务记录，证明未认证请求没有到达 stub。 */ () =>
            readFileSync(join(directory, 'events.jsonl'))
        )
      }
    )
  }
)

test(
  '注册只返回 pending 标识，不交付配对材料',
  /* 单独验证管理stub的公开投影，不能据此声称真实管理后端已可用。 */ async (t) => {
    await isolated(
      t,
      'admin',
      /* 请求 pending 注册，确认额外 enrollment 被公开投影剔除。 */ async (client) => {
        assert.deepEqual(data(await client.callTool({ name: 'machines_register', arguments: { name: 'isolated' } })), {
          registration_id: 'registration-test',
          status: 'pending',
          hint: '配对材料仅通过受保护本机管理渠道交付；此工具不返回凭据。'
        })
      }
    )
  }
)

test(
  '受信 caller 撤销后下一次请求立即拒绝',
  /* 单独验证每次请求重读同一合成身份来源。 */ async (t) => {
    await isolated(
      t,
      'revoking',
      /* 先读可见列表再撤销身份，确认每次调用都会重读绑定。 */ async (client) => {
        assert(data(await client.callTool({ name: 'machines_list', arguments: {} })).items)
        assert.deepEqual((await client.callTool({ name: 'machines_list', arguments: {} })).structuredContent, {
          gateway_error: { code: 'unauthenticated' }
        })
      }
    )
  }
)

test(
  'CLI 注入同一 stdio facade，实际SDK仍使用标准工具请求',
  /* 单独验证显式CLI测试宿主，不把服务stub当作生产授权或native执行。 */ async (t) => {
    await isolated(
      t,
      'cli',
      /* 经注入 CLI 宿主访问 provider，验证角色入口接到同一 stdio 门面。 */ async (client) => {
        assert.equal(
          (
            data(await client.callTool({ name: 'providers_list', arguments: { machine_id: 'machine' } }))
              .items as unknown[]
          ).length,
          1
        )
      }
    )
  }
)

test(
  'history 原样传给服务且不补发；SDK 取消只停止等待，不调用业务 cancel',
  { timeout: 30_000 },
  /* 验证 history 原样传递及取消只结束等待，不产生业务 cancel 或补发。 */ async (t) => {
    await isolated(
      t,
      'ordinary',
      /* 重复同一历史意图并取消慢请求，核对执行计数和结束证据。 */ async (client, _transport, directory) => {
        const history = {
          history_epoch: 'history-test',
          recovery_generation: 'recovery-test',
          client_request_key: 'key-test'
        }
        const args = { ...call('task.list'), history }
        const first = data(await client.callTool({ name: 'runtime_call', arguments: args }))
        const again = data(await client.callTool({ name: 'runtime_call', arguments: args }))
        assert.equal(first.call_id, again.call_id)
        assert.equal(again.executions, 1)
        const stop = new AbortController()
        const pending = client
          .callTool({ name: 'runtime_call', arguments: { ...call('stub.slow'), wait_ms: 1000 } }, undefined, {
            signal: stop.signal
          })
          .then(
            /* 立即观察意外成功，不能把尚未挂处理器的Promise留在等待窗口中。 */ () => ({ rejected: false }),
            /* 清理信号也可能在下方短等期间触发；立即收敛拒绝，后续仍断言请求确实被拒绝。 */ () => ({
              rejected: true
            })
          )
        await new Promise(/* 给慢调用建立等待的时间，再发送标准客户端取消。 */ (resolve) => setTimeout(resolve, 40))
        stop.abort()
        assert.equal((await pending).rejected, true)
        await new Promise(
          /* 等待受控执行计时器完成，证明前端取消未误杀该测试工作。 */ (resolve) => setTimeout(resolve, 150)
        )
        assert.equal(
          data(await client.callTool({ name: 'runtime_call_get', arguments: { call_id: 'call-2' } })).state,
          'responded'
        )
        const events = readFileSync(join(directory, 'events.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map(/* 解析逐行服务事件，供核对历史参数和独立取消路径。 */ (line) => JSON.parse(line))
        assert.equal(
          events.filter(
            /* 统计传给 stub 的调用次数，检测门面是否自动补发请求。 */ (event) => event.operation === 'runtime_call'
          ).length,
          3
        )
        assert.equal(
          events.filter(
            /* 检查是否错误调用业务取消，区分前端信号与原生动作。 */ (event) =>
              event.operation === 'runtime_call_cancel'
          ).length,
          0
        )
        assert(
          events.some(
            /* 寻找等待停止事件，证明客户端取消已作用于前端等待。 */ (event) => event.event === 'waiting_stopped'
          )
        )
        assert(
          events.some(
            /* 寻找执行完成事件，证明等待取消没有被误报为执行回滚。 */ (event) => event.event === 'execution_finished'
          )
        )
        assert.deepEqual(events[0].args.history, history)
        assert.equal(events[0].args.validation, 'strict')
        assert.equal(events[0].args.wait_ms, 0)
      }
    )
  }
)
