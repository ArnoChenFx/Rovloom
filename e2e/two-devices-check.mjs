/** 一个 Gateway 上两台 Connector 的 MCP 侧验收（e2e/quickstart.py --second-device）。
 * 用法：MCP_CONFIG=<mcp.json> MCP_TARGETS='[{...},{...}]' bun e2e/two-devices-check.mjs
 *   用同一个未改变的 Bearer：machines_list 恰好两台，且两个 Target 都能 discover 并 ping 成功（设备刚重连时限时重试）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { setTimeout as pause } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'

assert(process.env.MCP_CONFIG && process.env.MCP_TARGETS, 'MCP_CONFIG and MCP_TARGETS are required')
const mcp = JSON.parse(readFileSync(process.env.MCP_CONFIG, 'utf8'))
const targets = JSON.parse(process.env.MCP_TARGETS)
const client = new Client({ name: 'two-devices', version: '1' })
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
async function ping(target) {
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
  for (let i = 0; i < 50 && !FINISHED.has(view.state); i++) {
    view = (await tool('runtime_call_get', { call_id: view.call_id, wait_ms: 200 })).data ?? view
  }
  return view
}
try {
  const machines = await tool('machines_list', {})
  assert.equal(machines.isError, false, JSON.stringify(machines.raw))
  assert.equal(machines.data.items.length, targets.length, JSON.stringify(machines.data))
  const seen = []
  for (const target of targets) {
    let last
    for (let attempt = 0; attempt < 60; attempt++) {
      last = await ping(target)
      if (last.state === 'responded') {
        break
      }
      await pause(2000)
    }
    assert.equal(last.state, 'responded', `${target.machine_id}: ${JSON.stringify(last)}`)
    seen.push(target.machine_id)
  }
  assert.equal(new Set(seen).size, targets.length)
  console.log(JSON.stringify({ ok: true, machines: seen.length }))
} finally {
  await client.close()
}
