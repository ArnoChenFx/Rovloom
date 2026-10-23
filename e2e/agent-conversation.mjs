/** OpenCode JSON 事件验收：关联工具输入、Gateway 保留结果与明确续用的两轮会话；不启动模型。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'

export const agentTools = Object.freeze([
  'machines_list',
  'providers_list',
  'runtime_discover',
  'runtime_describe',
  'runtime_call',
  'runtime_call_get',
  'runtime_result_read'
])
export const MAX_AGENT_BYTES = 1024 * 1024
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** 独立读回共用一个 30 秒期限；测试可缩短期限，不能放宽默认上限。 */
export async function readAgentCall(client, callID, { timeoutMs = 30_000 } = {}) {
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30_000, 'independent_read_timeout_invalid')
  const deadline = performance.now() + timeoutMs
  const controller = new AbortController()
  let timer
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('independent_read_timeout'))
      controller.abort()
    }, timeoutMs)
  })
  try {
    return await readAgentCallPages(client, callID, { deadline, signal: controller.signal, expired })
  } finally {
    clearTimeout(timer)
  }
}

/** 只查原 call_id；每页核验且必须取得字节进展，不另发原生请求或刷新期限。 */
async function readAgentCallPages(client, callID, { deadline, signal, expired }) {
  const call = async (name, args) => {
    const remaining = deadline - performance.now()
    assert(remaining > 0, 'independent_read_timeout')
    const result = await Promise.race([
      client.callTool({ name, arguments: args }, CallToolResultSchema, {
        signal,
        timeout: Math.ceil(remaining),
        resetTimeoutOnProgress: false
      }),
      expired
    ])
    assert(performance.now() < deadline, 'independent_read_timeout')
    assert(!result.isError && result.structuredContent?.data, 'independent_mcp_rejected')
    assert.equal(result.content[0]?.type, 'text', 'independent_mcp_text_missing')
    assert.deepEqual(
      JSON.parse(result.content[0].text),
      result.structuredContent,
      'independent_mcp_projection_mismatch'
    )
    return result.structuredContent.data
  }
  const view = await call('runtime_call_get', { call_id: callID, wait_ms: 0 })
  assert(view.state === 'responded' && view.result?.result_id, 'independent_result_unavailable')
  const chunks = []
  const cursors = new Set()
  let cursor
  let size = 0
  let pages = 0
  for (;;) {
    assert(pages++ < 128, 'independent_result_page_limit')
    const page = await call('runtime_result_read', {
      result_id: view.result.result_id,
      max_bytes: 16_384,
      ...(cursor ? { cursor } : {})
    })
    assert.equal(page.encoding, 'base64', 'independent_page_encoding')
    assert.equal(page.result_id, view.result.result_id, 'independent_page_mismatch')
    const chunk = Buffer.from(page.chunk, 'base64')
    assert.equal(chunk.toString('base64'), page.chunk, 'independent_page_base64')
    assert(page.eof === true || chunk.length > 0, 'independent_page_no_progress')
    size += chunk.length
    assert(size <= MAX_AGENT_BYTES, 'independent_result_limit')
    chunks.push(chunk)
    assert.equal(page.sha256, view.result.sha256, 'independent_page_digest')
    if (page.eof === true) {
      const bytes = Buffer.concat(chunks)
      assert.equal(bytes.length, view.result.bytes, 'independent_result_bytes')
      assert.equal(bytes.length, page.total_bytes, 'independent_page_bytes')
      assert.equal(digest(bytes), page.sha256, 'independent_result_digest')
      return { view, bytes }
    }
    assert.equal(page.eof, false, 'independent_eof_invalid')
    cursor = page.next_cursor
    assert(typeof cursor === 'string' && cursor.length > 0 && !cursors.has(cursor), 'independent_cursor_invalid')
    cursors.add(cursor)
  }
}

/** 第二轮只用精确 session ID 续接，不能用“最近会话”或隐式 fork。 */
export function agentArguments(model, prompt, sessionID) {
  return ['run', '--format', 'json', '--model', model, ...(sessionID ? ['--session', sessionID] : []), prompt]
}

export function conversationPrompts(target, nonce) {
  const chain = [
    'Use only the rovloom MCP tools. Do not access files, run commands or delegate.',
    'List machines and providers (rovloom_machines_list, rovloom_providers_list).',
    `The exact target is ${JSON.stringify(target)} and expected_binding_revision is 1.`,
    'Discover its methods, then describe ping (rovloom_runtime_discover, rovloom_runtime_describe).',
    'Submit exactly one ping with params {} through rovloom_runtime_call using the discovered ping contract_ref and an absolute epoch-millisecond deadline of now+60000.',
    'Always query that call_id with rovloom_runtime_call_get, even if already responded. Poll only that call until responded; never resubmit it.',
    'Read every retained result page with rovloom_runtime_result_read using next_cursor until eof. Decode the base64 pong and report its version.'
  ].join('\n')
  return [
    `${chain}\nRemember this synthetic context value for our next turn: ${nonce}\nFinish with exactly: RESULT version=<pong version> context=stored`,
    `${chain}\nRecall the synthetic context value I supplied in our previous turn, without reading files. Make a fresh ping this turn.\nFinish with exactly: RESULT version=<pong version> context=<previous context value>`
  ]
}

/** 仅接受完整 JSON 事件；文本、stderr、工具输出内的 RESULT 都不能充当 assistant 回复。 */
function parseTurn(stdout) {
  assert(Buffer.byteLength(stdout) <= MAX_AGENT_BYTES, 'agent_output_limit')
  const lines = stdout.split('\n').filter((line) => line.trim())
  assert(lines.length > 0, 'agent_events_missing')
  const events = lines.map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      throw new Error('agent_event_json_invalid')
    }
  })
  const sessionID = events[0]?.sessionID
  assert(typeof sessionID === 'string' && sessionID.length > 0, 'agent_session_missing')
  const messageIDs = new Set()
  const partIDs = new Set()
  const toolIDs = new Set()
  const tools = []
  const texts = []
  for (const event of events) {
    assert.equal(event?.sessionID, sessionID, 'agent_session_drift')
    assert(['step_start', 'step_finish', 'tool_use', 'text'].includes(event.type), 'agent_event_unexpected')
    const part = event.part
    assert.equal(part?.sessionID, sessionID, 'agent_part_session_drift')
    assert(typeof part.messageID === 'string' && part.messageID.length > 0, 'agent_message_missing')
    assert(typeof part.id === 'string' && !partIDs.has(part.id), 'agent_part_replay')
    partIDs.add(part.id)
    messageIDs.add(part.messageID)
    if (event.type === 'text') {
      assert.equal(part.type, 'text', 'agent_text_type')
      assert.equal(typeof part.text, 'string', 'agent_text_missing')
      texts.push(part.text)
    }
    if (event.type === 'tool_use') {
      // 工具前的文本不能成为最终回答；仅保留最后工具事件之后的新文本。
      texts.length = 0
      assert.equal(part.type, 'tool', 'agent_tool_type')
      assert(
        agentTools.some((name) => part.tool === `rovloom_${name}`),
        'agent_tool_not_allowed'
      )
      assert(typeof part.callID === 'string' && !toolIDs.has(part.callID), 'agent_tool_replay')
      toolIDs.add(part.callID)
      assert.equal(part.state?.status, 'completed', 'agent_tool_failed')
      assert.notEqual(part.state.metadata?.truncated, true, 'agent_tool_truncated')
      let output
      try {
        output = JSON.parse(part.state.output)
      } catch {
        throw new Error('agent_tool_output_invalid')
      }
      assert(output?.data && !output.gateway_error, 'agent_gateway_error')
      tools.push({ name: part.tool.slice('rovloom_'.length), input: part.state.input, data: output.data })
    }
  }
  assert.equal(events.at(-1).type, 'step_finish', 'agent_finish_missing')
  assert.equal(events.at(-1).part.reason, 'stop', 'agent_finish_incomplete')
  const text = texts.join('\n')
  // 空白文本不能让工具前猜出的 RESULT 借助后续 trim 变成有效回答。
  assert(text.trim().length > 0, 'agent_reply_missing')
  return { sessionID, messageIDs, tools, text }
}

function pingTrace(turn, target) {
  const order = turn.tools.map((tool) => agentTools.indexOf(tool.name))
  assert(
    order.every((value, index) => index === 0 || value >= order[index - 1]),
    'agent_tool_order'
  )
  const only = (name) => {
    const matches = turn.tools.filter((tool) => tool.name === name)
    assert.equal(matches.length, 1, `agent_${name}_count`)
    return matches[0]
  }
  assert(
    only('machines_list').data.items.some((item) => item.machine_id === target.machine_id),
    'agent_machine_missing'
  )
  const providers = only('providers_list')
  assert.equal(providers.input.machine_id, target.machine_id, 'agent_provider_machine')
  assert(
    providers.data.items.some(
      (item) =>
        item.machine_id === target.machine_id &&
        item.provider_id === target.provider_id &&
        item.kind === 'herdr' &&
        item.enabled === true &&
        item.binding_revision === 1
    ),
    'agent_provider_missing'
  )
  const discovered = only('runtime_discover')
  const described = only('runtime_describe')
  const submitted = only('runtime_call')
  for (const tool of [discovered, described, submitted]) {
    assert.deepEqual(tool.input.target, target, 'agent_target_mismatch')
    assert.equal(tool.input.expected_binding_revision, 1, 'agent_binding_mismatch')
  }
  const ping = discovered.data.items.find((item) => item.method === 'ping')
  assert(typeof ping?.contract_ref === 'string', 'agent_ping_missing')
  assert.equal(described.input.method, 'ping', 'agent_describe_method')
  assert.equal(described.data.method, 'ping', 'agent_described_method')
  assert.equal(described.data.contract_ref, ping.contract_ref, 'agent_described_contract')
  assert.equal(submitted.input.contract_ref, ping.contract_ref, 'agent_call_contract')
  assert.deepEqual(submitted.input.native_request, { method: 'ping', params: {} }, 'agent_ping_only')
  const callID = submitted.data.call_id
  assert(typeof callID === 'string' && callID.length > 0, 'agent_call_missing')
  const checkBinding = (view) => {
    assert.deepEqual(view.target, target, 'agent_call_target')
    assert.equal(view.provider_kind, 'herdr', 'agent_call_provider_kind')
    assert.equal(view.binding_revision, 1, 'agent_call_binding')
    if (view.state !== 'created' || view.contract_ref !== null) {
      assert.equal(view.contract_ref, ping.contract_ref, 'agent_call_view_contract')
    }
  }
  checkBinding(submitted.data)
  const gets = turn.tools.filter((tool) => tool.name === 'runtime_call_get')
  assert(gets.length > 0, 'agent_call_get_missing')
  for (const get of gets) {
    assert.equal(get.input.call_id, callID, 'agent_query_call_mismatch')
    assert.equal(get.data.call_id, callID, 'agent_queried_call_mismatch')
    checkBinding(get.data)
    assert(
      ['created', 'dispatching', 'connector_accepted', 'responded'].includes(get.data.state),
      'agent_call_not_responded'
    )
  }
  const view = gets.at(-1).data
  assert.equal(view.state, 'responded', 'agent_call_incomplete')
  assert(typeof view.result?.result_id === 'string', 'agent_result_missing')
  const pages = turn.tools.filter((tool) => tool.name === 'runtime_result_read')
  assert(pages.length > 0, 'agent_result_read_missing')
  let cursor
  const chunks = []
  for (const [index, page] of pages.entries()) {
    assert.equal(page.input.result_id, view.result.result_id, 'agent_result_mismatch')
    assert.equal(page.data.result_id, view.result.result_id, 'agent_page_result_mismatch')
    assert.equal(page.data.encoding, 'base64', 'agent_page_encoding')
    assert.equal(page.data.total_bytes, view.result.bytes, 'agent_page_bytes')
    assert.equal(page.input.cursor, cursor, 'agent_result_cursor')
    assert.equal(page.data.eof, index === pages.length - 1, 'agent_result_incomplete')
    assert.equal(page.data.sha256, view.result.sha256, 'agent_page_digest')
    assert(typeof page.data.chunk === 'string', 'agent_result_chunk')
    const chunk = Buffer.from(page.data.chunk, 'base64')
    assert.equal(chunk.toString('base64'), page.data.chunk, 'agent_result_encoding')
    chunks.push(chunk)
    cursor = page.data.next_cursor
    if (!page.data.eof) {
      assert(typeof cursor === 'string' && cursor.length > 0, 'agent_next_cursor_missing')
    }
  }
  const bytes = Buffer.concat(chunks)
  assert.equal(bytes.length, view.result.bytes, 'agent_result_bytes')
  assert.equal(digest(bytes), view.result.sha256, 'agent_result_digest')
  let pong
  try {
    pong = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error('agent_pong_invalid')
  }
  assert.equal(pong.result?.type, 'pong', 'agent_pong_missing')
  assert(typeof pong.result.version === 'string' && pong.result.version.length > 0, 'agent_version_missing')
  return { view, bytes, version: pong.result.version }
}

/** readCall 必须由独立 MCP 客户端查询 Agent 的 call_id，不能另发 ping 代替其执行证据。 */
export async function verifyConversation({ target, nonce, runTurn, readCall }) {
  const prompts = conversationPrompts(target, nonce)
  let first
  let previousTrace
  for (const [index, prompt] of prompts.entries()) {
    const turn = parseTurn(await runTurn(prompt, first?.sessionID))
    if (first) {
      assert.equal(turn.sessionID, first.sessionID, 'agent_session_not_reused')
      assert(
        [...turn.messageIDs].every((id) => !first.messageIDs.has(id)),
        'agent_history_replayed'
      )
    }
    const trace = pingTrace(turn, target)
    if (previousTrace) {
      assert.notEqual(trace.view.call_id, previousTrace.view.call_id, 'agent_call_reused')
      assert.notEqual(trace.view.result.result_id, previousTrace.view.result.result_id, 'agent_result_reused')
    }
    const actual = await readCall(trace.view.call_id)
    assert.equal(actual.view.call_id, trace.view.call_id, 'independent_call_mismatch')
    assert.equal(actual.view.state, 'responded', 'independent_call_not_responded')
    for (const key of ['target', 'provider_kind', 'binding_revision', 'contract_ref']) {
      assert.deepEqual(actual.view[key], trace.view[key], 'independent_call_binding_mismatch')
    }
    assert.deepEqual(actual.view.result, trace.view.result, 'independent_result_mismatch')
    assert.deepEqual(actual.bytes, trace.bytes, 'independent_bytes_mismatch')
    const expected = `RESULT version=${trace.version} context=${index === 0 ? 'stored' : nonce}`
    const lines = turn.text.trim().split('\n')
    assert.equal(lines.at(-1), expected, 'agent_context_or_version_mismatch')
    assert.equal(lines.filter((line) => line.startsWith('RESULT ')).length, 1, 'agent_result_ambiguous')
    first ??= turn
    previousTrace = trace
  }
  return { rounds: 2, session_reused: true, context_recalled: true, gateway_results_verified: 2 }
}
