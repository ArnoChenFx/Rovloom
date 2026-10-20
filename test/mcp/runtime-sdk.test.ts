// 经真实HTTP SDK和角色工厂验证MCP接线；身份、策略及自建native listener均是隔离fixture。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { RuntimeGatewayService } from '../../src/mcp/runtime-service.js'
import { httpFixture } from './http-fixture.js'

// 对照结构化和文本副本后读取数据，避免网关改写原生结果时仍让测试通过。
function data(value: unknown): Record<string, unknown> {
  const reply = CallToolResultSchema.parse(value)
  assert(!reply.isError, JSON.stringify(reply.structuredContent))
  assert(reply.structuredContent)
  assert(reply.content[0]?.type === 'text')
  assert.deepEqual(JSON.parse(reply.content[0].text), reply.structuredContent)
  return reply.structuredContent.data as Record<string, unknown>
}

test(
  '真实HTTP SDK接实际runtime准入、去重、原Wire结果分页、显式取消及撤权',
  { timeout: 30_000 },
  /* 动态加载真实native fixture；其编译失败照常报告，不用stub或缓存替代。 */ async (testContext) => {
    let phase = 'fixture_import'
    let cleanup = 'not_started'
    testContext.after(
      /* 超时和断言失败都保留固定阶段；原始native/HTTP输入和错误值不进入诊断。 */ () => {
        if (phase !== 'complete' || cleanup !== 'complete') {
          console.error(`[mcp-http-failure] case=runtime-sdk phase=${phase} cleanup=${cleanup}`)
        }
      }
    )
    const { runtimeFixture } = await import('../runtime/helpers.js')
    phase = 'fixture_open'
    const f = await runtimeFixture()
    const service = new RuntimeGatewayService({
      runtime: f.gateway,
      identities: {
        principal: /* 复用已进入fixture runtime的当前身份，不给SDK创建第二份权限。 */ (caller) => {
          const principal = f.gateway.principal()
          return principal.id === caller.principal_id ? principal : null
        },
        administrator: /* 普通测试caller没有管理会话，不能通过此组合获得管理权限。 */ () => null
      },
      localPolicies: /* 明确的fixture政策，与原runtime固定tuple相同，不代表生产策略来源。 */ () => ({
        revision: 'local1',
        grants: [{ target: f.target, methods: ['task.add'], actions: ['dispatch', 'read', 'cancel'] }]
      })
    })
    const http = httpFixture(service, {
      authentication: {
        authenticate: /* 仅本用例自建listener认识的合成HTTP身份。 */ () => f.caller
      }
    })
    try {
      phase = 'ready'
      await f.ready()
      phase = 'http_connect'
      await http.client.connect(http.transport)
      const history = f.state.store.openHistory('synthetic', f.target, 1)
      const args = {
        target: f.target,
        expected_binding_revision: 1,
        contract_ref: f.reference,
        native_request: { method: 'task.add', params: { title: 'synthetic_mcp' } },
        deadline: f.state.store.clock() + 25_000,
        wait_ms: 5000,
        history: {
          history_epoch: history.history_epoch,
          client_request_key: 'mcp_one_intent',
          recovery_generation: f.state.store.generation()
        }
      }
      phase = 'call'
      const call = data(await http.client.callTool({ name: 'runtime_call', arguments: args }, CallToolResultSchema))
      phase = 'duplicate'
      const duplicate = data(
        await http.client.callTool({ name: 'runtime_call', arguments: args }, CallToolResultSchema)
      )
      assert.equal(duplicate.call_id, call.call_id)
      assert.equal(call.state, 'responded')
      assert.equal(call.contract_ref, f.reference)
      assert.equal(f.native.state.responses, 1)
      assert.equal(f.claims(), 1)
      const result = call.result as { result_id: string; bytes: number; expires_at: number }
      assert(result.result_id)
      const chunks: Buffer[] = []
      let cursor: string | undefined
      let firstNext: string | undefined
      do {
        phase = 'result_page'
        const page = data(
          await http.client.callTool(
            {
              name: 'runtime_result_read',
              arguments: { result_id: result.result_id, max_bytes: 32, ...(cursor ? { cursor } : {}) }
            },
            CallToolResultSchema
          )
        )
        assert.equal(page.expires_at, result.expires_at)
        assert.equal(page.encoding, 'base64')
        chunks.push(Buffer.from(page.chunk as string, 'base64'))
        if (!cursor) {
          firstNext = page.next_cursor as string | undefined
        }
        cursor = page.next_cursor as string | undefined
      } while (cursor)
      assert.equal(Buffer.concat(chunks).byteLength, result.bytes)
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()).error, f.native.response.error)
      assert(firstNext)
      phase = 'changed_cursor'
      const changedPage = await http.client.callTool(
        {
          name: 'runtime_result_read',
          arguments: { result_id: result.result_id, max_bytes: 64, cursor: firstNext }
        },
        CallToolResultSchema
      )
      assert.deepEqual(changedPage.structuredContent, { gateway_error: { code: 'invalid_cursor' } })
      phase = 'cancel'
      const cancelled = data(
        await http.client.callTool(
          {
            name: 'runtime_call_cancel',
            arguments: { call_id: call.call_id }
          },
          CallToolResultSchema
        )
      )
      assert.equal(cancelled.cancellation, 'unsupported')
      assert.equal(f.native.state.responses, 1)
      f.authorize(false)
      phase = 'revoked_read'
      const denied = await http.client.callTool(
        {
          name: 'runtime_result_read',
          arguments: { result_id: result.result_id }
        },
        CallToolResultSchema
      )
      assert.deepEqual(denied.structuredContent, { gateway_error: { code: 'unauthenticated' } })
      phase = 'client_close'
      await http.client.close()
      assert.equal(f.gateway.transport.status().stopped, false)
      assert.equal(f.state.store.health().mode, 'active')
      phase = 'complete'
    } finally {
      cleanup = 'http'
      await http.close()
      cleanup = 'service'
      service.close()
      cleanup = 'runtime'
      await f.close()
      cleanup = 'complete'
    }
  }
)
