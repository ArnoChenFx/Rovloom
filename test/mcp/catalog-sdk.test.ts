// 用真实SDK访问实际catalog宿主；客户端只取固定测试tuple，不额外编译原生schema。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { target, catalogMethods } from './fixture-values.js'
import { httpFixture } from './http-fixture.js'
import { catalogFixture } from './catalog-fixture.js'

test(
  '真实SDK HTTP发现/描述实际catalog；调用与结果读取仍明确缺后端',
  /* SDK和catalog不是stub，可信来源/身份仍为人工fixture，不能当作五方法族native验收。 */ async () => {
    const fixture = catalogFixture()
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
      const listed = await client.callTool(
        { name: 'runtime_discover', arguments: { target, expected_binding_revision: 1 } },
        CallToolResultSchema,
        { signal, timeout: 5000 }
      )
      assert.equal(listed.isError, undefined)
      const data = (listed.structuredContent as { data: { items: { method: string; contract_ref: string }[] } }).data
      assert.deepEqual(
        data.items.map(/* 比较真实安装契约中的授权方法名，不使用自造stub方法。 */ (row) => row.method).sort(),
        [...catalogMethods].sort()
      )
      const described = await client.callTool(
        { name: 'runtime_describe', arguments: { target, expected_binding_revision: 1, method: 'ping' } },
        CallToolResultSchema,
        { signal, timeout: 5000 }
      )
      assert.equal(described.isError, undefined)
      const call = await client.callTool(
        {
          name: 'runtime_call',
          arguments: {
            target,
            expected_binding_revision: 1,
            contract_ref: data.items[0]!.contract_ref,
            native_request: { method: 'ping', params: {} },
            deadline: 1_020_000
          }
        },
        CallToolResultSchema,
        { signal, timeout: 5000 }
      )
      assert.deepEqual(call.structuredContent, { gateway_error: { code: 'backend_unavailable' } })
      const read = await client.callTool(
        { name: 'runtime_result_read', arguments: { result_id: 'not_issued' } },
        CallToolResultSchema,
        { signal, timeout: 5000 }
      )
      assert.deepEqual(read.structuredContent, { gateway_error: { code: 'backend_unavailable' } })
      assert.deepEqual(diagnostics, [])
    } finally {
      await session.close()
      fixture.close()
    }
  }
)
