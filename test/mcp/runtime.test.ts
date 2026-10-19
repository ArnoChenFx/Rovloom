/** 官方 SDK Client/InMemoryTransport 的组件测试；合成 runtime port 不代表 native、stdio 或双机验收。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as pause } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { createRuntimeMcpServer } from '../../src/mcp/runtime.js'
import type { RuntimeMcpDescriptor, RuntimeMcpPort } from '../../src/mcp/runtime.js'
import { createTrustedRequestScope } from '../../src/runtime/request-scope.js'
import type { RuntimeCallInput } from '../../src/runtime/types.js'
import { GatewayError } from '../../src/contracts.js'
import type { Call } from '../../src/store.js'
import { hash } from '../../src/wire/index.js'
import type { JsonObject, V2Target } from '../../src/wire/types.js'

const target: V2Target = { machine_id: 'synthetic-machine', provider_id: 'herdr', profile: 'session', session: 'owned' }
const descriptor: RuntimeMcpDescriptor = {
  target,
  binding_revision: 3,
  contract_ref: 'a'.repeat(64),
  provider_kind: 'herdr',
  methods: [
    {
      method: 'agent.prompt',
      params_schema: { type: 'object', required: ['target', 'text'] },
      response_types: ['agent_prompted']
    }
  ]
}

/** 仅模拟 runtime 的稳定 port，用真实请求作用域检查 facade 没有从参数创建身份或读取 Store 正文。 */
async function fixture(settings: { responded?: boolean; response?: JsonObject; completeAfterGets?: number } = {}) {
  const state = {
    caller: 'alice',
    authorized: true,
    readable: true,
    now: 1000,
    error: undefined as unknown,
    descriptors: [structuredClone(descriptor)],
    admitted: [] as RuntimeCallInput[],
    opens: 0,
    reads: [] as number[],
    gets: 0,
    cancels: 0,
    discovered: [] as string[],
    calls: new Map<string, Call>()
  }
  const scope = createTrustedRequestScope({
    principal: /** 合成宿主只识别两名已知主体，失效后不沿用此前身份。 */ (caller) =>
      state.authorized && ['alice', 'bob'].includes(caller.principal_id)
        ? { id: caller.principal_id, policy: { revision: 'synthetic-policy', grants: [] } }
        : null,
    administrator: /** 本 facade 组件测试没有管理员身份。 */ () => null
  })
  const bytes = Buffer.from(
    JSON.stringify(
      settings.response ?? { id: 'synthetic-native', result: { type: 'agent_prompted', agent_status: 'working' } }
    )
  )
  /** 原调用归属每次由当前认证作用域检查；此处不模拟完整 Router 或 native 授权。 */
  function call(id: string): Call {
    const principal = scope.principal()
    const found = state.calls.get(id.replace(/^result_/, ''))
    if (!found || found.principal !== principal.id) {
      throw new GatewayError('call_not_found')
    }
    return found
  }
  /** 模拟当前原结果读取门禁；只有调用所属主体能访问，权限与实际期限不缓存。 */
  function readable(id: string): Call {
    const found = call(id)
    if (!state.readable) {
      throw new GatewayError('forbidden')
    }
    if (found.state !== 'responded' || state.now >= 77_777) {
      throw new GatewayError('result_not_ready')
    }
    return found
  }
  const runtime: RuntimeMcpPort = {
    runAuthenticated: scope.runAuthenticated,
    store: { clock: /** 相对执行时间只能基于可信 runtime 时钟。 */ () => state.now },
    /** 合成登记保留全部入参，验证 facade 只转交宿主来源和原生 JSON。 */
    admit(input) {
      const principal = scope.principal()
      if (state.error) {
        throw state.error
      }
      state.admitted.push(structuredClone(input))
      const callId = 'call' + state.admitted.length
      const value: Call = {
        call_id: callId,
        principal: principal.id,
        machine_id: input.target.machine_id,
        provider_id: input.target.provider_id,
        binding_revision: input.options.binding_revision,
        provider_kind: 'herdr',
        state: settings.responded === false ? 'dispatching' : 'responded',
        epoch: 'synthetic-epoch',
        attempt_id: 'attempt' + state.admitted.length,
        response: 'PLANTED_STORE_RESPONSE_MUST_NOT_LEAK',
        target_json: JSON.stringify(input.target),
        method: input.native_request.method,
        deadline: input.options.deadline,
        content_expires: 90_000,
        metadata_expires: 100_000,
        dedup_expires: 120_000,
        content_status: 'available'
      }
      state.calls.set(callId, value)
      return { created: true, call: { ...value } }
    },
    /** 合成轮询只更新当前调用状态，不模拟原生完成或另一次派发。 */
    get(id) {
      const found = call(id)
      state.gets++
      if (settings.completeAfterGets && state.gets >= settings.completeAfterGets) {
        found.state = 'responded'
      }
      return { ...found }
    },
    /** 计量显式取消端口，MCP 等待结束不得调用它。 */
    cancel(id) {
      const found = call(id)
      state.cancels++
      found.state = 'outcome_unknown'
      return { ...found }
    },
    results: {
      /** 返回合成原句柄元数据，不读取 Call.response 植入的正文。 */
      open(id) {
        const found = readable(id)
        state.opens++
        return { result_id: 'result_' + found.call_id, bytes: bytes.length, hash: hash(bytes), expires: 77_777 }
      },
      /** 每页重新检查合成当前权限及期限并保持原 cursor/TTL。 */
      read(id, cursor = 0, maxBytes = 65_536) {
        readable(id)
        state.reads.push(maxBytes)
        const page = bytes.subarray(cursor, cursor + maxBytes)
        return {
          result_id: id,
          encoding: 'base64',
          data: page.toString('base64'),
          next_cursor: cursor + page.length,
          eof: cursor + page.length >= bytes.length,
          bytes: bytes.length,
          hash: hash(bytes),
          expires: 77_777
        }
      }
    }
  }
  const server = createRuntimeMcpServer({
    runtime,
    caller: /** 只有受保护宿主能切换当前 caller，工具参数没有此入口。 */ () => ({ principal_id: state.caller }),
    discover: /** 宿主在同一认证作用域交付当前已过滤描述。 */ (caller) => {
      assert.equal(scope.principal().id, caller.principal_id)
      state.discovered.push(caller.principal_id)
      return state.descriptors
    }
  })
  const client = new Client({ name: 'synthetic-facade-component-client', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return {
    state,
    client,
    server,
    close: /** 关闭 MCP 连接只结束组件协议资源，不调用 runtime cancel 或新建角色。 */ async () => {
      await client.close()
      await server.close()
      scope.close()
    }
  }
}

/** 工具回复只有一份 JSON text；原生响应不会在 structuredContent 再复制一份。 */
function body(result: unknown): any {
  const first = CallToolResultSchema.parse(result).content[0]
  assert(first?.type === 'text')
  return JSON.parse(first.text)
}
/** 每次提交完整 Target 与 revision，原参数仅作为需要原 adapter 验证的 JSON。 */
function request(extra: JsonObject = {}): JsonObject {
  return {
    target,
    expected_binding_revision: 3,
    native_request: { method: 'agent.prompt', params: { target: 'owned-agent', text: 'synthetic' } },
    wait_ms: 0,
    ...extra
  }
}

test(
  'MCP lists six generic tools and resolves current host-filtered target descriptions',
  /** 真实 SDK 初始化和工具协议组件回归，不等同于生产身份或原生验收。 */ async () => {
    const f = await fixture()
    try {
      const listed = await f.client.listTools()
      assert.deepEqual(
        listed.tools.map(/** 固定工具面不按原生方法膨胀。 */ (tool) => tool.name),
        [
          'runtime_discover',
          'runtime_describe',
          'runtime_call',
          'runtime_call_get',
          'runtime_call_cancel',
          'runtime_result_read'
        ]
      )
      const discovered = body(await f.client.callTool({ name: 'runtime_discover', arguments: {} }))
      assert.deepEqual(discovered.targets[0].target, target)
      assert.equal(discovered.targets[0].methods[0].params_schema, undefined)
      const described = body(
        await f.client.callTool({ name: 'runtime_describe', arguments: { target, method: 'agent.prompt' } })
      )
      assert.deepEqual(described.descriptor.methods[0].params_schema, descriptor.methods[0]!.params_schema)
      f.state.caller = 'bob'
      f.state.descriptors = []
      assert.deepEqual(body(await f.client.callTool({ name: 'runtime_discover' })), { targets: [] })
      assert.deepEqual(body(await f.client.callTool({ name: 'runtime_describe', arguments: { target } })), {
        gateway_error: { code: 'runtime_target_unavailable' }
      })
      assert.deepEqual(f.state.discovered, ['alice', 'alice', 'bob', 'bob'])
      assert.equal(f.state.admitted.length, 0)
    } finally {
      await f.close()
    }
  }
)

test(
  'MCP call pins the host contract and reads native errors only through original result ports',
  /** native error 原样分层；即使 Call.response 被植入其它内容也不旁路结果门禁。 */ async () => {
    const native = {
      id: 'synthetic-native',
      error: { code: 'native_failure', message: 'original synthetic message', data: { state: 'unknown' } }
    }
    const f = await fixture({ response: native })
    try {
      const result = await f.client.callTool({ name: 'runtime_call', arguments: request({ timeout_ms: 1234 }) })
      const value = body(result)
      assert.equal(result.isError, undefined)
      assert.equal(value.contract_ref, descriptor.contract_ref)
      assert.equal(value.delivery, 'inline')
      assert.deepEqual(value.native_response, native)
      assert.deepEqual(value.call.target, target)
      assert.equal(value.call.response, undefined)
      assert.equal(JSON.stringify(result).includes('PLANTED_STORE_RESPONSE'), false)
      assert.equal(f.state.admitted[0]!.options.deadline, 2234)
      assert.equal(f.state.admitted[0]!.options.contract_ref, descriptor.contract_ref)
      assert.equal(f.state.opens, 1)
      assert.deepEqual(f.state.reads, [65_536])
      const current = body(
        await f.client.callTool({ name: 'runtime_call_get', arguments: { call_id: value.call.call_id } })
      )
      assert.equal(current.contract_ref, undefined)
      assert.deepEqual(current.native_response, native)
      f.state.readable = false
      const denied = await f.client.callTool({ name: 'runtime_call_get', arguments: { call_id: value.call.call_id } })
      assert.equal(denied.isError, true)
      assert.equal(body(denied).call.call_id, value.call.call_id)
      assert.equal(body(denied).delivery, 'metadata_only')
      assert.deepEqual(body(denied).gateway_error, { code: 'forbidden' })
      assert.equal(body(denied).native_response, undefined)
    } finally {
      await f.close()
    }
  }
)

test(
  'MCP rejects caller/source injection, stale target revisions and invalid timing before admission',
  /** 通用字段校验不替代最终原生 schema，也不能接纳模型自报身份或来源。 */ async () => {
    const f = await fixture()
    try {
      for (const extra of [
        { caller: { principal_id: 'bob' } },
        { principal_id: 'bob' },
        { contract_ref: 'b'.repeat(64) },
        { expected_binding_revision: 4 },
        { target: { ...target, session: 'another' } },
        { deadline: 2000, timeout_ms: 1000 },
        { timeout_ms: 0 },
        { deadline: 1000 },
        { wait_ms: 25_001 },
        { native_request: { method: 'agent.prompt', params: {}, id: 'forged' } },
        { native_request: { method: 'agent.prompt', params: {}, auth: 'forged' } }
      ]) {
        const result = await f.client.callTool({ name: 'runtime_call', arguments: request(extra) })
        assert.equal(result.isError, true)
        assert.equal(typeof body(result).gateway_error.code, 'string')
      }
      assert.equal(f.state.admitted.length, 0)
      const valid = body(
        await f.client.callTool({
          name: 'runtime_call',
          arguments: request({
            deadline: 4444,
            history: { history_epoch: 'scope', client_request_key: 'key' },
            native_request: { method: 'agent.prompt', params: { full: { untouched: true } } }
          })
        })
      )
      assert.equal(valid.call.deadline, 4444)
      assert.deepEqual(f.state.admitted[0]!.native_request.params, { full: { untouched: true } })
      assert.deepEqual(f.state.admitted[0]!.options.history, { history_epoch: 'scope', client_request_key: 'key' })
    } finally {
      await f.close()
    }
  }
)

test(
  'MCP short waiting returns call references and only explicit cancel enters the runtime cancel port',
  /** send 后未取得原生回复仍只报告原状态；等待结束和 MCP 关闭不等于 native cancel。 */ async () => {
    const f = await fixture({ responded: false })
    try {
      const pending = body(await f.client.callTool({ name: 'runtime_call', arguments: request({ wait_ms: 10 }) }))
      assert.equal(pending.delivery, 'pending')
      assert.equal(pending.call.state, 'dispatching')
      assert.equal(pending.native_response, undefined)
      assert.equal(f.state.cancels, 0)
      assert.equal(f.state.opens, 0)
      const cancelled = body(
        await f.client.callTool({ name: 'runtime_call_cancel', arguments: { call_id: pending.call.call_id } })
      )
      assert.equal(cancelled.call.state, 'outcome_unknown')
      assert.equal(cancelled.native_work, 'may_continue')
      assert.equal(f.state.cancels, 1)
      f.state.caller = 'bob'
      const denied = body(
        await f.client.callTool({ name: 'runtime_call_get', arguments: { call_id: pending.call.call_id } })
      )
      assert.deepEqual(denied, { gateway_error: { code: 'call_not_found' } })
    } finally {
      await f.close()
      assert.equal(f.state.cancels, 1)
    }
  }
)

test(
  'MCP waiting may observe a native response without interpreting the Agent state as completed',
  /** 只读取已有 call 状态；working 结果值保持原样。 */ async () => {
    const f = await fixture({ responded: false, completeAfterGets: 2 })
    try {
      const value = body(await f.client.callTool({ name: 'runtime_call', arguments: request({ wait_ms: 200 }) }))
      assert.equal(value.call.state, 'responded')
      assert.equal(value.native_response.result.agent_status, 'working')
      assert.equal(f.state.admitted.length, 1)
      assert.equal(f.state.cancels, 0)
    } finally {
      await f.close()
    }
  }
)

test(
  'MCP large results return actual handles and bounded pages preserve the original cursor and expiry',
  /** 不直接读取大正文，不缩掉字段；base64 页面使用既有结果端口和原 TTL。 */ async () => {
    const native = { id: 'synthetic-native', result: { type: 'pane_read', text: 'x'.repeat(90_000) } }
    const f = await fixture({ response: native })
    try {
      const result = await f.client.callTool({ name: 'runtime_call', arguments: request() })
      const value = body(result)
      assert.equal(value.delivery, 'result_handle')
      assert.equal(value.result.bytes, Buffer.byteLength(JSON.stringify(native)))
      assert.equal(value.native_response, undefined)
      assert.deepEqual(f.state.reads, [])
      const pages: Buffer[] = []
      let cursor = 0
      for (;;) {
        const reply = await f.client.callTool({
          name: 'runtime_result_read',
          arguments: { result_id: value.result.result_id, cursor, max_bytes: 65_536 }
        })
        assert(Buffer.byteLength(JSON.stringify(reply)) < 65_536)
        const page = body(reply).result
        assert.equal(page.expires, 77_777)
        assert.equal(page.hash, value.result.hash)
        pages.push(Buffer.from(page.data, 'base64'))
        cursor = page.next_cursor
        if (page.eof) {
          break
        }
      }
      assert.deepEqual(JSON.parse(Buffer.concat(pages).toString()), native)
      f.state.readable = false
      assert.deepEqual(
        body(
          await f.client.callTool({ name: 'runtime_result_read', arguments: { result_id: value.result.result_id } })
        ),
        { gateway_error: { code: 'forbidden' } }
      )
      f.state.readable = true
      f.state.now = 77_777
      assert.deepEqual(
        body(
          await f.client.callTool({ name: 'runtime_result_read', arguments: { result_id: value.result.result_id } })
        ),
        { gateway_error: { code: 'result_not_ready' } }
      )
    } finally {
      await f.close()
    }
  }
)

test(
  'MCP bounds the complete inline envelope and returns stable layered errors without host messages',
  /** 原响应不足 64KiB 但加 envelope 超限时改返回句柄；未知宿主异常不能回显私密消息。 */ async () => {
    const f = await fixture({ response: { id: 'synthetic-native', result: { text: 'x'.repeat(64_900) } } })
    try {
      const large = await f.client.callTool({ name: 'runtime_call', arguments: request() })
      assert.equal(body(large).delivery, 'result_handle')
      assert(Buffer.byteLength(JSON.stringify(large)) < 65_536)
      f.state.error = new Error('PRIVATE_HOST_MESSAGE')
      const unknown = await f.client.callTool({ name: 'runtime_call', arguments: request() })
      assert.deepEqual(body(unknown), { gateway_error: { code: 'runtime_unavailable' } })
      assert.equal(JSON.stringify(unknown).includes('PRIVATE_HOST_MESSAGE'), false)
      f.state.error = new GatewayError('forbidden')
      assert.deepEqual(body(await f.client.callTool({ name: 'runtime_call', arguments: request() })), {
        gateway_error: { code: 'forbidden' }
      })
      f.state.authorized = false
      assert.deepEqual(body(await f.client.callTool({ name: 'runtime_discover' })), {
        gateway_error: { code: 'unauthenticated' }
      })
    } finally {
      await f.close()
    }
  }
)

test(
  'MCP request cancellation only stops the facade wait and leaves the registered call observable',
  /** SDK 取消通知消费当前等待；不自动撤销、重试或改变已登记的原生调用。 */ async () => {
    const f = await fixture({ responded: false })
    const controller = new AbortController()
    try {
      const pending = f.client.callTool({ name: 'runtime_call', arguments: request({ wait_ms: 25_000 }) }, undefined, {
        signal: controller.signal
      })
      const rejected = assert.rejects(pending)
      for (let i = 0; i < 100 && f.state.admitted.length === 0; i++) {
        await pause(1)
      }
      assert.equal(f.state.admitted.length, 1)
      controller.abort()
      await rejected
      await pause(5)
      assert.equal(f.state.cancels, 0)
      const current = body(await f.client.callTool({ name: 'runtime_call_get', arguments: { call_id: 'call1' } }))
      assert.equal(current.call.state, 'dispatching')
      assert.equal(f.state.admitted.length, 1)
    } finally {
      await f.close()
    }
  }
)
