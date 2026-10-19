// 使用真实SDK stdio子进程验证实际Store数据流；合成身份和人工历史fixture不构成原生或生产接线证明。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { sdkTestSession } from './sdk-test-session.js'

test(
  '真实SDK经stdio访问实际Store：查询、元数据和事务清理可用，原生执行与结果正文仍拒绝',
  /* 直接运行隔离数据库宿主，不使用GatewayService方法stub替代Store。 */ async (t) => {
    const session = sdkTestSession(t, {
      command: process.execPath,
      args: ['--no-env-file', fileURLToPath(new URL('./store-server.ts', import.meta.url))],
      env: { PATH: process.env.PATH ?? '' },
      stderr: 'pipe'
    })
    let stderr = ''
    session.transport.stderr?.on(
      'data',
      /* 只用于断言诊断不包含固定合成秘密，不读取用户日志。 */ (chunk) => {
        stderr += chunk
      }
    )
    await session.run(
      /* 全部SDK请求共享清理信号，正常断言失败继续使测试失败。 */ async (client, _transport, signal) => {
        const options = { signal, timeout: 5000 }
        const devices = await client.callTool(
          { name: 'machines_list', arguments: { limit: 1 } },
          CallToolResultSchema,
          options
        )
        assert(!devices.isError)
        assert(devices.structuredContent)
        const payload = devices.structuredContent as { data: { items: { machine_id: string }[]; next_cursor: string } }
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
        await session.close()
        assert(!stderr.includes('SYNTHETIC_SECRET_DO_NOT_PRINT'))
      }
    )
  }
)
