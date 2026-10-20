// 使用真实SDK HTTP连接验证实际Store数据流；合成身份和人工历史fixture不构成原生或生产接线证明。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { httpFixture } from './http-fixture.js'
import { storeFixture } from './store-fixture.js'

test(
  '真实SDK经HTTP访问实际Store：查询、元数据和事务清理可用，原生执行与结果正文仍拒绝',
  /* 直接运行隔离数据库宿主，不使用GatewayService方法stub替代Store。 */ async () => {
    const fixture = storeFixture()
    const diagnostics: string[] = []
    const session = httpFixture(fixture.service, {
      diagnostic: /* 收集真实HTTP门面固定诊断，不能用空stderr伪装无错误。 */ (code) => {
        diagnostics.push(code)
      },
      authentication: { authenticate: /* 合成alice只用于实际Store授权回归。 */ () => ({ principal_id: 'alice' }) }
    })
    try {
      await session.client.connect(session.transport, { timeout: 5000 })
      const client = session.client
      const signal = new AbortController().signal
      const options = { signal, timeout: 5000 }
      const devices = await client.callTool(
        { name: 'machines_list', arguments: { limit: 1 } },
        CallToolResultSchema,
        options
      )
      assert(!devices.isError)
      assert(devices.structuredContent)
      const payload = devices.structuredContent as {
        data: { items: { machine_id: string }[]; next_cursor: string }
      }
      assert.equal(payload.data.items[0]?.machine_id, 'machine_a')
      const detail = await client.callTool(
        { name: 'runtime_call_get', arguments: { call_id: 'call_fixture' } },
        CallToolResultSchema,
        options
      )
      assert(!detail.isError)
      assert(!JSON.stringify(detail).includes('SYNTHETIC_SECRET_DO_NOT_PRINT'))
      const unavailable = await client.callTool(
        { name: 'runtime_result_read', arguments: { result_id: 'result_fixture' } },
        CallToolResultSchema,
        options
      )
      assert.equal(unavailable.isError, true)
      assert.deepEqual(unavailable.structuredContent, { gateway_error: { code: 'backend_unavailable' } })
      const discarded = await client.callTool(
        { name: 'runtime_response_discard', arguments: { call_id: 'call_fixture' } },
        CallToolResultSchema,
        options
      )
      assert(!discarded.isError)
      assert.deepEqual(discarded.structuredContent, {
        data: { call_id: 'call_fixture', content_status: 'discarded' }
      })
      const after = await client.callTool(
        { name: 'runtime_call_get', arguments: { call_id: 'call_fixture' } },
        CallToolResultSchema,
        options
      )
      assert.equal((after.structuredContent as { data: { content_status: string } }).data.content_status, 'discarded')
      await session.client.close()
      assert.deepEqual(diagnostics, [])
    } finally {
      await session.close()
      fixture.close()
    }
  }
)
