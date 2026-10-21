// 统一facade与实际RuntimeGatewayService的SDK组件回归；原生端口明确为stub，真实Wire另有隔离验收。
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CallToolResultSchema, ErrorCode } from '@modelcontextprotocol/sdk/types.js'
import { createMcpFacade, MAX_RESULT_BYTES, toolNames } from '../../src/mcp/index.js'
import { GatewayError } from '../../src/contracts.js'
import { object } from '../../src/wire/index.js'
import type { JsonObject } from '../../src/wire/types.js'
import { projectionFixture, type ProjectionFixtureOptions } from './runtime-service-fixture.js'
import { sdkTestLifecycle } from './sdk-lifecycle.js'
import { readRuntimeResponse } from '../../scripts/herdr/verify-runtime.js'

/** 使用统一服务、真实Store/Router与SDK；组件stub不提供任何原生执行成功证据。 */
async function fixture(options: ProjectionFixtureOptions, request: { signal: AbortSignal; timeout: number }) {
  const f = projectionFixture(options)
  const server = createMcpFacade({
    service: f.service,
    context: {
      resolve: /** 身份只来自本合成宿主，工具参数没有此入口。 */ async (signal) => ({
        caller: f.context.caller,
        wait_signal: signal
      })
    }
  })
  const client = new Client({ name: 'unified-runtime-component', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  let closing: Promise<void> | undefined
  const close = /** 同一清理覆盖半建SDK与重复关闭，不产生native取消。 */ (): Promise<void> => {
    closing ??= /** 先停SDK再回收同一个临时writer，失败也继续后续清理。 */ (async () => {
      try {
        await client.close()
      } finally {
        try {
          await server.close()
        } finally {
          f.close()
        }
      }
    })()
    return closing
  }
  try {
    await server.connect(serverTransport)
    await client.connect(clientTransport, request)
  } catch (error) {
    await close()
    throw error
  }
  return { ...f, client, close }
}

/** 沿用原五秒runner期限，取得、测试主体与SDK等待都由已验证作用域排空。 */
function withFixture(
  context: TestContext,
  options: ProjectionFixtureOptions,
  action: (value: Awaited<ReturnType<typeof fixture>>, lifecycle: ReturnType<typeof sdkTestLifecycle>) => Promise<void>
) {
  const lifecycle = sdkTestLifecycle(context, 'runtime-sdk', 5000)
  return lifecycle.run(
    /** after必须等实际取得及主体结束，不把取消等待冒充完成。 */ async () => {
      const value = await lifecycle.acquire(
        'runtime',
        /** 仅使用本例原剩余期限连接SDK。 */ () => fixture(options, lifecycle.options()),
        /** 半建失败由fixture回收，成功取得归作用域释放。 */ (resource) => resource.close()
      )
      await action(value, lifecycle)
      lifecycle.complete()
    }
  )
}

/** 结构化与文本副本必须逐字段一致，不沿用旧单文本envelope。 */
function payload(result: unknown): JsonObject {
  const reply = CallToolResultSchema.parse(result)
  assert.equal(reply.content.length, 1)
  const first = reply.content[0]
  assert(first?.type === 'text')
  const body = object(JSON.parse(first.text))
  assert.deepEqual(body, reply.structuredContent)
  return body
}

/** 只从当前统一data字段取业务视图，网关拒绝不能混进成功结果。 */
function data(result: unknown): JsonObject {
  assert.notEqual(CallToolResultSchema.parse(result).isError, true)
  return object(payload(result).data)
}

test(
  '统一SDK目录分三页，严格参数先于准入，原contract/deadline/client_request_key与params保持原值',
  /** 只核对投影；准入stub返回人工历史，不能称为真实native派发。 */ async (testContext) => {
    return withFixture(
      testContext,
      {},
      /** 组件结束由同一作用域负责。 */ async (f) => {
        try {
          const names: string[] = []
          let cursor: string | undefined
          let pages = 0
          do {
            const page = await f.client.listTools(cursor ? { cursor } : undefined)
            names.push(...page.tools.map(/** 保留静态通用工具顺序。 */ (entry) => entry.name))
            cursor = page.nextCursor
            pages++
            assert(pages <= 3)
          } while (cursor)
          assert.deepEqual(names, toolNames())
          assert.equal(pages, 3)
          for (const extra of [
            { caller: 'bob' },
            { timeout_ms: 1000 },
            { wait_ms: 5001 },
            { contract_ref: undefined }
          ]) {
            await assert.rejects(f.client.callTool({ name: 'runtime_call', arguments: { ...f.args, ...extra } }), {
              code: ErrorCode.InvalidParams
            })
          }
          assert.equal(f.calls.length, 0)
          const client_request_key = 'one_intent'
          const native = { method: 'pane.read', params: { full: { untouched: true } } }
          const result = data(
            await f.client.callTool({
              name: 'runtime_call',
              arguments: { ...f.args, native_request: native, client_request_key }
            })
          )
          assert.equal(result.call_id, 'call_fixture')
          assert.deepEqual(f.calls[0]!.native_request, native)
          assert.equal(f.calls[0]!.options.contract_ref, f.args.contract_ref)
          assert.equal(f.calls[0]!.options.deadline, f.args.deadline)
          assert.equal(f.calls[0]!.options.client_request_key, client_request_key)
        } finally {
          await f.close()
        }
      }
    )
  }
)

test(
  '统一服务短等到期仍交付登记调用，只有显式取消进入原取消端口',
  /** 使用真实Router登记为created，不派发；短等本身使用真实Store查询与有界timer。 */ async (testContext) => {
    return withFixture(
      testContext,
      { pending: true },
      /** 组件结束由同一作用域负责。 */ async (f) => {
        try {
          const pending = data(await f.client.callTool({ name: 'runtime_call', arguments: { ...f.args, wait_ms: 10 } }))
          assert.equal(pending.call_id, f.registered[0])
          assert.equal(pending.state, 'created')
          assert.equal(pending.content_delivery, 'unavailable')
          assert.equal(pending.result, undefined)
          assert.equal(f.calls.length, 1)
          assert.equal(f.cancelled(), 0)
          const current = data(
            await f.client.callTool({ name: 'runtime_call_get', arguments: { call_id: pending.call_id } })
          )
          assert.equal(current.state, 'created')
          const cancelled = data(
            await f.client.callTool({ name: 'runtime_call_cancel', arguments: { call_id: pending.call_id } })
          )
          assert.equal(cancelled.call_id, pending.call_id)
          assert.equal(f.cancelled(), 1)
          assert.equal(f.calls.length, 1)
        } finally {
          await f.close()
        }
      }
    )
  }
)

for (const native of [
  { id: 'synthetic_native', result: { type: 'agent_prompted', agent_status: 'working', text: 'x'.repeat(90_000) } },
  {
    id: 'synthetic_native',
    error: { code: 'synthetic', message: 'preserve', data: { deep: ['汉字', { revision: 7 }] } }
  }
]) {
  test(
    'responded与原生业务状态分开，句柄分页保留完整字节：' + ('error' in native ? 'native_error' : 'working'),
    /** 响应是人工历史，真实Router执行每页身份/ACL/期限检查；不伪造Agent或native运行。 */ async (testContext) => {
      return withFixture(
        testContext,
        { response: native },
        /** 组件结束由同一作用域负责。 */ async (f) => {
          try {
            const reply = await f.client.callTool({ name: 'runtime_call', arguments: { ...f.args, wait_ms: 200 } })
            const view = data(reply)
            assert.equal(view.state, 'responded')
            assert.equal(view.content_delivery, 'result_handle')
            assert.equal(view.native_response, undefined)
            const handle = object(view.result)
            const chunks: Buffer[] = []
            let cursor: string | undefined
            do {
              const result = await f.client.callTool({
                name: 'runtime_result_read',
                arguments: {
                  result_id: handle.result_id,
                  max_bytes: MAX_RESULT_BYTES,
                  ...(cursor ? { cursor } : {})
                }
              })
              assert(Buffer.byteLength(JSON.stringify(result)) < 65_536)
              const page = data(result)
              assert.equal(page.expires_at, handle.expires_at)
              assert.equal(page.sha256, handle.sha256)
              const chunk = Buffer.from(String(page.chunk), 'base64')
              assert(chunk.byteLength > 0 && chunk.byteLength <= MAX_RESULT_BYTES)
              chunks.push(chunk)
              cursor = page.next_cursor as string | undefined
            } while (cursor)
            const recovered = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            assert.deepEqual(recovered, native)
            // 真实Herdr验收脚本复用同一协议读取器，本例仅验证SDK/句柄协议，不启动原生或模型。
            assert.deepEqual(await readRuntimeResponse(f.client, view), native)
            if ('result' in native) {
              assert.equal(object(recovered.result).agent_status, 'working')
              assert(chunks.length > 1)
            } else {
              assert.deepEqual(object(recovered.error).data, native.error!.data)
              assert.notEqual(CallToolResultSchema.parse(reply).isError, true)
            }
            assert.equal(f.calls.length, 1)
            assert.equal(f.cancelled(), 0)
          } finally {
            await f.close()
          }
        }
      )
    }
  )
}

test(
  'SDK取消只终止统一服务等待，已登记调用仍可查询且不重新准入',
  /** 握手由真实准入端口进入后才推进，不用sleep猜测取消时机。 */ async (testContext) => {
    return withFixture(
      testContext,
      { pending: true },
      /** 组件结束由同一作用域负责。 */ async (f, lifecycle) => {
        const controller = new AbortController()
        try {
          const pending = f.client.callTool(
            { name: 'runtime_call', arguments: { ...f.args, wait_ms: 5000 } },
            undefined,
            {
              signal: controller.signal
            }
          )
          const rejected = assert.rejects(pending)
          await lifecycle.wait(f.admission)
          controller.abort()
          await rejected
          const current = data(
            await f.client.callTool({ name: 'runtime_call_get', arguments: { call_id: f.registered[0] } })
          )
          assert.equal(current.state, 'created')
          assert.equal(f.calls.length, 1)
          assert.equal(f.cancelled(), 0)
          f.readFailure(new Error('PRIVATE_HOST_MESSAGE'))
          const failure = await f.client.callTool({
            name: 'runtime_result_read',
            arguments: { result_id: 'result_fixture' }
          })
          assert.deepEqual(payload(failure), { gateway_error: { code: 'internal_error' } })
          assert(!JSON.stringify(failure).includes('PRIVATE_HOST_MESSAGE'))
          f.readFailure(new GatewayError('forbidden'))
          assert.deepEqual(
            payload(
              await f.client.callTool({ name: 'runtime_result_read', arguments: { result_id: 'result_fixture' } })
            ),
            { gateway_error: { code: 'forbidden' } }
          )
        } finally {
          await f.close()
        }
      }
    )
  }
)
