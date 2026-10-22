/** 两机验收（e2e/two_host.py）的 MCP 侧步骤。
 * 用法：MCP_CONFIG=<mcp.json> bun e2e/two-host-check.mjs <step>
 *   ping          重试直到 Herdr 对 ping 应答（最多 150 秒），打印版本
 *   offline       等到 Gateway 把设备的 link 判为 offline（静默断网由心跳超时发现，最多 150 秒）
 *   unavailable   设备离线时一次调用必须在 15 秒内以未派发/不可用结束，不能悬挂
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { setTimeout as pause } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'

const [step] = process.argv.slice(2)
assert(process.env.MCP_CONFIG && step, 'MCP_CONFIG and a step are required')
const mcp = JSON.parse(readFileSync(process.env.MCP_CONFIG, 'utf8'))
const target = mcp.targets[0]
const client = new Client({ name: 'two-host', version: '1' })
await client.connect(
  new StreamableHTTPClientTransport(new URL(mcp.url), {
    requestInit: { headers: { authorization: `Bearer ${mcp.token}` } }
  })
)
async function tool(name, args) {
  const result = await client.callTool({ name, arguments: args }, CallToolResultSchema)
  return { isError: result.isError === true, data: result.structuredContent?.data, raw: result.structuredContent }
}
const FINISHED = new Set(['responded', 'not_dispatched', 'outcome_unknown'])
/** 发现 ping 的契约并提交一次调用，返回终态视图（或提交错误）。 */
async function ping(patience) {
  const discovered = await tool('runtime_discover', { target, expected_binding_revision: 1, limit: 100 })
  if (discovered.isError) {
    return { error: discovered.raw }
  }
  const submitted = await tool('runtime_call', {
    target,
    expected_binding_revision: 1,
    contract_ref: discovered.data.items.find((item) => item.method === 'ping').contract_ref,
    native_request: { method: 'ping', params: {} },
    deadline: Date.now() + 30_000,
    wait_ms: 300
  })
  if (submitted.isError) {
    return { error: submitted.raw }
  }
  let view = submitted.data
  const stop = Date.now() + patience
  while (!FINISHED.has(view.state) && Date.now() < stop) {
    const next = await tool('runtime_call_get', { call_id: view.call_id, wait_ms: 200 })
    if (next.isError) {
      return { error: next.raw }
    }
    view = next.data
  }
  return view
}
try {
  if (step === 'ping') {
    for (let attempt = 0; attempt < 75; attempt++) {
      const view = await ping(10_000)
      if (view.state === 'responded') {
        console.log(JSON.stringify({ ok: true, attempts: attempt + 1 }))
        process.exit(0)
      }
      await pause(2000)
    }
    throw new Error('ping never responded')
  } else if (step === 'offline') {
    for (let attempt = 0; attempt < 75; attempt++) {
      const machine = await tool('machines_get', { machine_id: target.machine_id })
      if (!machine.isError && machine.data.link === 'offline') {
        console.log(JSON.stringify({ ok: true, link: machine.data.link }))
        process.exit(0)
      }
      await pause(2000)
    }
    throw new Error('device link never became offline')
  } else if (step === 'unavailable') {
    const started = Date.now()
    const view = await ping(15_000)
    const elapsed = Date.now() - started
    assert(elapsed < 15_000, `call hung for ${elapsed}ms: ${JSON.stringify(view)}`)
    assert(view.error || view.state === 'not_dispatched', `expected unavailable, got ${JSON.stringify(view)}`)
    console.log(JSON.stringify({ ok: true, elapsed_ms: elapsed }))
  } else {
    throw new Error('unknown step: ' + step)
  }
} finally {
  await client.close()
}
