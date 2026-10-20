// 真实provider验收编排：仅通过正式SDK调用既有HTTP MCP，不提供业务stub、原生回复或身份成功替身。
import { createHash, randomBytes } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { CallToolResultSchema, McpError } from '@modelcontextprotocol/sdk/types.js'
import { SERVICE_ERROR_CODES, type ServiceErrorCode, type ToolArguments, type ToolName } from '../../src/mcp/types.js'
import type { JsonObject, V2Target, ValidationMode } from '../../src/wire/types.js'

export type NativeSelection = {
  target: V2Target & { profile: 'session' }
  expected_binding_revision: number
  window_id: string
}
export type NativeFlowRequest = {
  target: V2Target
  expected_binding_revision: number
  native_request: { method: string; params?: unknown }
  validation?: ValidationMode
}
export type NativeMcpObservation = Readonly<{
  stage: 'request' | 'reply' | 'sdk_error' | 'service_error' | 'call' | 'result'
  tool?: ToolName
  request_index: number
  call_index: number
  elapsed_ms: number
  remaining_ms: number
  budget_phase: 'execution' | 'delivery'
  duration_ms?: number
  timeout_ms?: number
  state?:
    | 'created'
    | 'dispatching'
    | 'connector_accepted'
    | 'responded'
    | 'not_dispatched'
    | 'outcome_unknown'
    | 'unknown'
  content?: 'available' | 'unavailable'
  content_reason?: ServiceErrorCode
  result_bytes?: number
  result_pages?: number
}>
export type NativeAgentObservation = {
  session_id: string
  agent_id: string
  status: string
  status_source: 'native' | 'inferred' | 'unknown'
}
export type NativeConversationReply = {
  session_id: string
  agent_id: string
  message_id: string
  prompt_id: string
  text: string
}
export type NativeConversationPlan = {
  // 真实已连接SDK；认证、受控实例启动与产品配置由各owner的实际测试宿主完成。
  client: Client
  signal: AbortSignal
  deadline: number
  discovery: NativeFlowRequest
  // 以下回调只投影原生字段或构造原生参数，不交付成功值或执行替身。
  select(discovered: JsonObject): NativeSelection
  management(selected: NativeSelection): readonly { method: string; params?: unknown }[]
  verifyManagement(responses: readonly JsonObject[], selected: NativeSelection): void
  state(selected: NativeSelection): { method: string; params?: unknown }
  observe(response: JsonObject): NativeAgentObservation
  prompt(text: string, selected: NativeSelection): { method: string; params?: unknown }
  // 从真实发送结果取得原生prompt/task/message关联键，不以本地随机ID替代原生关联。
  promptId(sent: JsonObject): string
  // 同步原生回复可直接投影；异步方法返回undefined后只轮询其原生读取方法，不重发prompt。
  reply(response: JsonObject, sent: JsonObject): NativeConversationReply | undefined
  replyRequest?(sent: JsonObject, selected: NativeSelection): { method: string; params?: unknown }
}

// 所有失败只使用固定阶段码；原生结果、提示、路径或SDK异常不拼入公开异常。
export class NativeFlowError extends Error {
  // 只附加已知工具名与SDK数值码，便于真实入口定位而不公开原生数据或异常文本。
  constructor(
    code: string,
    readonly tool?: ToolName,
    readonly rpcCode?: number,
    readonly serviceCode?: ServiceErrorCode
  ) {
    super(code)
  }
}

// 条件错误只保存调用点提供的固定码，不包含原始断言值。
function requireValue(condition: unknown, code: string): asserts condition {
  if (!condition) {
    throw new NativeFlowError(code)
  }
}

// SDK截止服从执行/交付各自的固定期限；轮询和分页不滑动续期，时钟只由测试宿主显式提供。
export function createNativeMcpInvoker(
  client: Client,
  signal: AbortSignal,
  deadline: number,
  observe?: (event: NativeMcpObservation) => void,
  options: { deliveryLimit?: number; now?(): number } = {}
) {
  const deliveryLimit = options.deliveryLimit ?? deadline
  const now = options.now ?? Date.now
  const calls: { call_id: string; method: string; target: V2Target }[] = []
  const startedAt = performance.now()
  let requestIndex = 0
  let callIndex = 0
  let activeDeadline = deadline
  let budgetPhase: NativeMcpObservation['budget_phase'] = 'execution'
  const report = /* 诊断只投影固定阶段、计数、状态及耗时，不带ID、请求、回复或秘密。 */ (
    event: Omit<NativeMcpObservation, 'request_index' | 'call_index' | 'elapsed_ms' | 'remaining_ms' | 'budget_phase'>
  ) => {
    observe?.({
      ...event,
      request_index: requestIndex,
      call_index: callIndex,
      elapsed_ms: Math.round(performance.now() - startedAt),
      remaining_ms: Math.max(0, activeDeadline - now()),
      budget_phase: budgetPhase
    })
  }
  const remaining = /* deadline属于这次显式真实验收，不改变产品或既有测试预算。 */ () => {
    const value = activeDeadline - now()
    requireValue(Number.isSafeInteger(activeDeadline) && value > 0 && !signal.aborted, 'native_flow_deadline')
    return value
  }
  const tool = /* 所有业务动作均经过真实HTTP SDK，拒绝工具错误或文本/结构不一致。 */ async <K extends ToolName>(
    name: K,
    args: ToolArguments[K]
  ): Promise<JsonObject> => {
    let raw: unknown
    const started = performance.now()
    const timeout = Math.min(30_000, remaining())
    requestIndex++
    report({ stage: 'request', tool: name, timeout_ms: timeout })
    try {
      raw = await client.callTool({ name, arguments: args }, CallToolResultSchema, {
        signal,
        timeout
      })
    } catch (error) {
      report({ stage: 'sdk_error', tool: name, duration_ms: Math.round(performance.now() - started) })
      throw new NativeFlowError('native_flow_mcp_request', name, error instanceof McpError ? error.code : undefined)
    }
    const response = CallToolResultSchema.parse(raw)
    if (response.isError || !response.structuredContent) {
      report({ stage: 'service_error', tool: name, duration_ms: Math.round(performance.now() - started) })
      const code = (response.structuredContent?.gateway_error as { code?: unknown } | undefined)?.code
      throw new NativeFlowError(
        'native_flow_mcp_rejected',
        name,
        undefined,
        SERVICE_ERROR_CODES.includes(code as ServiceErrorCode) ? (code as ServiceErrorCode) : undefined
      )
    }
    requireValue(response.content[0]?.type === 'text', 'native_flow_mcp_text')
    requireValue(
      JSON.stringify(JSON.parse(response.content[0].text)) === JSON.stringify(response.structuredContent),
      'native_flow_mcp_mismatch'
    )
    const value = response.structuredContent.data
    requireValue(value && typeof value === 'object' && !Array.isArray(value), 'native_flow_mcp_data')
    report({ stage: 'reply', tool: name, duration_ms: Math.round(performance.now() - started) })
    return value as JsonObject
  }
  const invoke = /* 每个原生请求只准入一次，等待仅查询该原call_id。 */ async (
    request: NativeFlowRequest
  ): Promise<JsonObject> => {
    activeDeadline = deadline
    budgetPhase = 'execution'
    callIndex++
    const described = await tool('runtime_describe', {
      target: request.target,
      expected_binding_revision: request.expected_binding_revision,
      method: request.native_request.method
    })
    requireValue(
      typeof described.contract_ref === 'string' && /^[a-f0-9]{64}$/.test(described.contract_ref),
      'native_flow_contract'
    )
    let call = await tool('runtime_call', {
      ...request,
      contract_ref: described.contract_ref,
      deadline,
      // 首次准入先取得原call_id；后续短等只读取此调用，不延迟或重复提交业务意图。
      wait_ms: 0
    })
    requireValue(typeof call.call_id === 'string', 'native_flow_call_id')
    const callId = call.call_id
    let contractSeen = false
    const checkBinding = /* created未建attempt时契约为null；一旦出现真实契约就不能退回空值或换契约。 */ () => {
      requireValue(
        isDeepStrictEqual(call.target, request.target) && call.binding_revision === request.expected_binding_revision,
        'native_flow_call_binding'
      )
      if (call.contract_ref === described.contract_ref) {
        contractSeen = true
        return
      }
      if (
        call.contract_ref === null &&
        ['outcome_unknown', 'not_dispatched'].includes(String(call.state)) &&
        call.result === undefined
      ) {
        return
      }
      requireValue(call.contract_ref === null && call.state === 'created' && !contractSeen, 'native_flow_call_binding')
    }
    const reportCall = /* 只输出有限状态枚举，不包含call_id、target或原结果句柄。 */ () => {
      const state = [
        'created',
        'dispatching',
        'connector_accepted',
        'responded',
        'not_dispatched',
        'outcome_unknown'
      ].includes(String(call.state))
        ? (call.state as NativeMcpObservation['state'])
        : 'unknown'
      const reason = call.content_reason_code
      report({
        stage: 'call',
        state,
        content: call.result ? 'available' : 'unavailable',
        ...(SERVICE_ERROR_CODES.includes(reason as ServiceErrorCode)
          ? { content_reason: reason as ServiceErrorCode }
          : {})
      })
    }
    checkBinding()
    reportCall()
    calls.push({ call_id: callId, method: request.native_request.method, target: structuredClone(request.target) })
    while (call.state !== 'responded') {
      requireValue(
        ['created', 'dispatching', 'connector_accepted'].includes(String(call.state)),
        'native_flow_call_failed'
      )
      await setTimeout(Math.min(100, remaining()), undefined, { signal })
      call = await tool('runtime_call_get', { call_id: callId, wait_ms: 0 })
      requireValue(call.call_id === callId, 'native_flow_call_changed')
      checkBinding()
      reportCall()
    }
    const result = call.result as JsonObject | undefined
    requireValue(result && typeof result.result_id === 'string', 'native_flow_result_unavailable')
    requireValue(
      typeof result.expires_at === 'number' && Number.isSafeInteger(result.expires_at),
      'native_flow_result_expiry'
    )
    // 已完成执行的结果按原句柄TTL读取；只在进入交付阶段固定一次上限，分页不滑动续期。
    activeDeadline = Math.min(deliveryLimit, result.expires_at, now() + 30_000)
    budgetPhase = 'delivery'
    const bytes: Buffer[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    let size = 0
    let pages = 0
    do {
      const page = await tool('runtime_result_read', {
        result_id: result.result_id,
        max_bytes: 16_384,
        ...(cursor ? { cursor } : {})
      })
      requireValue(
        typeof page.chunk === 'string' &&
          page.sha256 === result.sha256 &&
          page.total_bytes === result.bytes &&
          page.expires_at === result.expires_at,
        'native_flow_result_changed'
      )
      requireValue(page.encoding === 'base64' || page.encoding === 'utf8', 'native_flow_result_encoding')
      const chunk = Buffer.from(page.chunk, page.encoding === 'base64' ? 'base64' : 'utf8')
      pages++
      size += chunk.length
      requireValue(size <= 1_048_576, 'native_flow_result_limit')
      bytes.push(chunk)
      requireValue(page.next_cursor === undefined || typeof page.next_cursor === 'string', 'native_flow_result_cursor')
      cursor = page.next_cursor as string | undefined
      requireValue(page.eof === !cursor, 'native_flow_result_eof')
      if (cursor) {
        requireValue(chunk.length > 0 && !cursors.has(cursor), 'native_flow_result_stalled')
        cursors.add(cursor)
      }
    } while (cursor)
    const response = Buffer.concat(bytes)
    requireValue(
      response.length === result.bytes && createHash('sha256').update(response).digest('hex') === result.sha256,
      'native_flow_result_digest'
    )
    const value = JSON.parse(response.toString('utf8')) as JsonObject
    requireValue(
      value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        (value.error === null || value.error === undefined),
      'native_flow_native_error'
    )
    report({ stage: 'result', result_bytes: response.length, result_pages: pages })
    return value
  }
  return { invoke, tool, calls, remaining }
}

// owner须把真实官方管理、状态和消息方法映射到同一流程，保留原生能力差异，不以进程存在推断Agent空闲。
async function conversation(plan: NativeConversationPlan) {
  const { invoke, tool, calls, remaining } = createNativeMcpInvoker(plan.client, plan.signal, plan.deadline)
  const tools: string[] = []
  const toolCursors = new Set<string>()
  let cursor: string | undefined
  do {
    const page = await plan.client.listTools(cursor ? { cursor } : undefined, {
      signal: plan.signal,
      timeout: Math.min(10_000, remaining())
    })
    tools.push(...page.tools.map(/* 正式SDK目录必须包含后续调用实际使用的工具。 */ (entry) => entry.name))
    cursor = page.nextCursor
    if (cursor) {
      requireValue(!toolCursors.has(cursor), 'native_flow_tools_stalled')
      toolCursors.add(cursor)
    }
  } while (cursor)
  for (const name of ['providers_get', 'runtime_describe', 'runtime_call', 'runtime_call_get', 'runtime_result_read']) {
    requireValue(tools.includes(name), 'native_flow_missing_tool')
  }
  const provider = await tool('providers_get', {
    machine_id: plan.discovery.target.machine_id,
    provider_id: plan.discovery.target.provider_id
  })
  requireValue(provider.binding_revision === plan.discovery.expected_binding_revision, 'native_flow_binding_changed')
  const discovered = await invoke(plan.discovery)
  const selected = structuredClone(plan.select(discovered))
  requireValue(
    selected.target.profile === 'session' && selected.target.session.length > 0 && selected.window_id.length > 0,
    'native_flow_selection'
  )
  requireValue(
    selected.target.machine_id === plan.discovery.target.machine_id &&
      selected.target.provider_id === plan.discovery.target.provider_id &&
      selected.expected_binding_revision === plan.discovery.expected_binding_revision,
    'native_flow_provider_changed'
  )
  const native = /* 在已选窗口/session原样调用owner提供的官方方法，不另造原生API。 */ (request: {
    method: string
    params?: unknown
  }) =>
    invoke({
      target: selected.target,
      expected_binding_revision: selected.expected_binding_revision,
      native_request: request
    })
  const management: JsonObject[] = []
  const actions = plan.management(selected)
  requireValue(actions.length > 0, 'native_flow_management_missing')
  for (const action of actions) {
    management.push(await native(action))
  }
  plan.verifyManagement(management, selected)
  const observe = /* 状态必须来自原生字段，不能把ready/进程或自行推断当成Agent状态。 */ async () => {
    const raw = await native(plan.state(selected))
    const observation = structuredClone(plan.observe(raw))
    requireValue(
      observation.status_source === 'native' && observation.status.length > 0 && observation.agent_id.length > 0,
      'native_flow_native_state_missing'
    )
    requireValue(observation.session_id === selected.target.session, 'native_flow_session_changed')
    return { raw, observation }
  }
  const before = await observe()
  const marker = randomBytes(16).toString('hex')
  const prompts = [
    `Remember this exact conversation marker: ${marker}. Reply with only ACK.`,
    'What exact conversation marker did I ask you to remember in my previous message? Reply with only that marker.'
  ]
  const replies: NativeConversationReply[] = []
  for (const prompt of prompts) {
    const sent = await native(plan.prompt(prompt, selected))
    const promptId = plan.promptId(sent)
    requireValue(typeof promptId === 'string' && promptId.length > 0, 'native_flow_prompt_id_missing')
    let response = plan.reply(sent, sent)
    while (!response) {
      requireValue(plan.replyRequest, 'native_flow_reply_reader_missing')
      await setTimeout(Math.min(100, remaining()), undefined, { signal: plan.signal })
      response = plan.reply(await native(plan.replyRequest(sent, selected)), sent)
    }
    requireValue(
      response.session_id === before.observation.session_id && response.agent_id === before.observation.agent_id,
      'native_flow_agent_changed'
    )
    requireValue(response.prompt_id === promptId, 'native_flow_reply_unrelated')
    requireValue(
      response.message_id.length > 0 &&
        !replies.some(/* 两轮不能复用同一条历史回复。 */ (previous) => previous.message_id === response.message_id),
      'native_flow_reply_reused'
    )
    replies.push(structuredClone(response))
  }
  requireValue(replies[0]!.text.trim() === 'ACK' && replies[1]!.text.trim() === marker, 'native_flow_context_lost')
  const after = await observe()
  requireValue(after.observation.agent_id === before.observation.agent_id, 'native_flow_agent_changed')
  // 返回原生证据供owner受控验收使用；本模块不打印或保存窗口、提示、回复及原生正文。
  return { selected, discovered, management, before, after, replies, calls }
}

// owner的字段投影或SDK自身也可能抛出含原文异常；对外只交付固定流程错误，正文只在成功返回的证据中。
export async function runNativeConversation(plan: NativeConversationPlan) {
  try {
    return await conversation(plan)
  } catch (error) {
    throw error instanceof NativeFlowError ? error : new NativeFlowError('native_flow_failed')
  }
}
