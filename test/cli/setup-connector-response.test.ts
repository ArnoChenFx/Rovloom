/** Gateway 对配对请求返回非 200 时，Connector 必须得到固定拒绝，而不是因响应流已锁定而崩溃。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { responseJson } from '../../src/cli/setup-connector.js'

test('非 200 响应以 configuration_required 拒绝，且不触发 ReadableStream locked 异常', async () => {
  for (const status of [400, 409, 500]) {
    await assert.rejects(responseJson(new Response(JSON.stringify({ error: 'setup_not_completed' }), { status })), {
      code: 'configuration_required'
    })
  }
  // 空响应体同样固定拒绝。
  await assert.rejects(responseJson(new Response(null, { status: 200 })), { code: 'configuration_required' })
})

test('200 响应按有界严格 JSON 解析，超限或重复键被拒绝', async () => {
  assert.deepEqual(await responseJson(new Response(JSON.stringify({ ok: 1 }), { status: 200 })), { ok: 1 })
  await assert.rejects(responseJson(new Response('{"a":1,"a":2}', { status: 200 })))
  await assert.rejects(responseJson(new Response('x'.repeat(20_000), { status: 200 })))
})
