/** 将少量通用 MCP 工具接到既有 provider runtime；身份、账本、原生执行与结果权限均由宿主持有。 */
import { setTimeout as pause } from 'node:timers/promises'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { GatewayError } from '../contracts.js'
import type { createProviderGatewayRuntime } from '../runtime/gateway.js'
import type { Call } from '../store.js'
import type { CallerIdentity } from './management.js'
import { boundedJson, fields, id, object, parseJson, sha, text, uint, validateTarget } from '../wire/index.js'
import type { JsonObject, ProviderKind, V2Target } from '../wire/types.js'

type ProviderRuntime = Awaited<ReturnType<typeof createProviderGatewayRuntime>>
/** 结构端口只投影现有运行时；没有 Store 正文、SQL、另一个 Gateway 或身份创建入口。 */
export type RuntimeMcpPort = Pick<ProviderRuntime, 'runAuthenticated' | 'admit' | 'get' | 'cancel'> & {
  store: Pick<ProviderRuntime['store'], 'clock'>
  results: Pick<ProviderRuntime['results'], 'open' | 'read'>
}
export type RuntimeMcpMethod = Readonly<{
  method: string
  params_schema?: JsonObject
  response_types?: readonly string[]
  description?: string
  [key: string]: unknown
}>
export type RuntimeMcpDescriptor = Readonly<{
  target: V2Target
  binding_revision: number
  contract_ref: string
  provider_kind: ProviderKind
  methods: readonly RuntimeMcpMethod[]
  [key: string]: unknown
}>
export type RuntimeMcpOptions = Readonly<{
  runtime: RuntimeMcpPort
  /** 固定 stdio 身份或当前请求的受保护宿主解析器；绝不从工具参数读取主体。 */
  caller: CallerIdentity | (() => CallerIdentity)
  /** 每次只返回当前 caller 已可见的描述；不把此结果当作后续派发或读取授权。 */
  discover(caller: CallerIdentity): readonly RuntimeMcpDescriptor[] | Promise<readonly RuntimeMcpDescriptor[]>
}>

const OUTPUT_BYTES = 65_536
const PAGE_BYTES = 47_000
const MAX_WAIT = 25_000
const targetSchema = {
  oneOf: [
    {
      type: 'object',
      properties: {
        machine_id: { type: 'string' },
        provider_id: { type: 'string' },
        profile: { const: 'session' },
        session: { type: 'string' }
      },
      required: ['machine_id', 'provider_id', 'profile', 'session'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: { machine_id: { type: 'string' }, provider_id: { type: 'string' }, profile: { const: 'host' } },
      required: ['machine_id', 'provider_id', 'profile'],
      additionalProperties: false
    }
  ]
}

/** 工具只声明通用参数；具体原生方法仍由安装契约及原 adapter 验证。 */
function tool(
  name: string,
  description: string,
  properties: NonNullable<Tool['inputSchema']['properties']>,
  required: string[] = []
): Tool {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } }
}
const tools: Tool[] = [
  tool('runtime_discover', '发现当前调用者可见的完整目标与方法摘要。', {}),
  tool(
    'runtime_describe',
    '读取目标或单个原生方法描述；大契约请指定 method。',
    { target: targetSchema, method: { type: 'string' } },
    ['target']
  ),
  tool(
    'runtime_call',
    '通过现有 runtime 登记并派发原生 RPC；短等到期返回 call_id，不重试或取消原生工作。',
    {
      target: targetSchema,
      expected_binding_revision: { type: 'integer', minimum: 1 },
      native_request: {
        type: 'object',
        properties: { method: { type: 'string' }, params: {} },
        required: ['method', 'params'],
        additionalProperties: false
      },
      deadline: { type: 'integer', minimum: 1 },
      timeout_ms: { type: 'integer', minimum: 1, maximum: 600_000 },
      wait_ms: { type: 'integer', minimum: 0, maximum: MAX_WAIT },
      validation: { enum: ['strict', 'raw-contract'] },
      history: {
        type: 'object',
        properties: { history_epoch: { type: 'string' }, client_request_key: { type: 'string' } },
        required: ['history_epoch', 'client_request_key'],
        additionalProperties: false
      }
    },
    ['target', 'expected_binding_revision', 'native_request']
  ),
  tool(
    'runtime_call_get',
    '读取原调用状态和当前允许的原生结果；不会重新派发。',
    { call_id: { type: 'string' }, wait_ms: { type: 'integer', minimum: 0, maximum: MAX_WAIT } },
    ['call_id']
  ),
  tool(
    'runtime_call_cancel',
    '请求现有 runtime 停止等待或桥接；原生工作可能继续，不表示回滚。',
    { call_id: { type: 'string' } },
    ['call_id']
  ),
  tool(
    'runtime_result_read',
    '按原句柄和当前权限读取 base64 字节页；实际页可小于 max_bytes，按 next_cursor 继续。',
    {
      result_id: { type: 'string' },
      cursor: { type: 'integer', minimum: 0 },
      max_bytes: { type: 'integer', minimum: 1, maximum: OUTPUT_BYTES }
    },
    ['result_id']
  )
]

/** 只公开稳定错误码，宿主异常消息、堆栈和 native error 不混入 gateway_error。 */
function errorCode(error: unknown): string {
  return error instanceof GatewayError && /^[a-z][a-z0-9_]{0,95}$/.test(error.code) ? error.code : 'runtime_unavailable'
}

/** 单份 JSON text 避免复制正文；整个工具回复保留协议 envelope 的预算。 */
function reply(body: JsonObject, isError = false): CallToolResult {
  const result: CallToolResult = {
    content: [{ type: 'text', text: boundedJson(body) }],
    ...(isError ? { isError: true } : {})
  }
  if (Buffer.byteLength(JSON.stringify(result)) > OUTPUT_BYTES - 256) {
    throw new GatewayError('mcp_result_too_large')
  }
  return result
}

/** 验证等待时长；等待预算独立于原始执行期限，不更改调用或原生工作的状态。 */
function waitBudget(value: unknown, fallback: number): number {
  const result = value === undefined ? fallback : value
  if (!Number.isSafeInteger(result) || (result as number) < 0 || (result as number) > MAX_WAIT) {
    throw new GatewayError('invalid_wait')
  }
  return result as number
}

/** 从现有元数据投影完整目标，不读取或返回 Call.response，也不推测旧调用的契约来源。 */
function callMetadata(call: Call): JsonObject {
  const target = parseJson(call.target_json)
  validateTarget(target)
  return {
    call_id: call.call_id,
    attempt_id: call.attempt_id,
    target,
    binding_revision: call.binding_revision,
    provider_kind: call.provider_kind,
    method: call.method,
    state: call.state,
    epoch: call.epoch,
    deadline: call.deadline,
    content_expires: call.content_expires,
    metadata_expires: call.metadata_expires,
    dedup_expires: call.dedup_expires,
    content_status: call.content_status
  }
}

/** 发现保留宿主已过滤的来源、传输和保证，只有大参数 schema 留给单方法 describe。 */
function methodSummary(method: RuntimeMcpMethod): JsonObject {
  const summary: JsonObject = {}
  for (const [key, value] of Object.entries(method)) {
    if (key !== 'params_schema') {
      summary[key] = value
    }
  }
  return summary
}

/** 官方 SDK Server 只提供 facade；连接/关闭 MCP transport 不会接管或关闭宿主 runtime。 */
export function createRuntimeMcpServer(options: RuntimeMcpOptions): Server {
  const runtime = options.runtime
  const server = new Server({ name: 'rovloom-runtime', version: '0.1.0' }, { capabilities: { tools: {} } })

  /** 每次重新快照当前过滤后的描述，不缓存最近 caller、来源或权限。 */
  async function descriptors(caller: CallerIdentity): Promise<RuntimeMcpDescriptor[]> {
    const values = JSON.parse(boundedJson(await options.discover(caller))) as RuntimeMcpDescriptor[]
    if (!Array.isArray(values)) {
      throw new GatewayError('runtime_descriptor_invalid')
    }
    const seen = new Set<string>()
    for (const value of values) {
      validateTarget(value.target)
      uint(value.binding_revision, true)
      sha(value.contract_ref)
      if (!['herdr', 'luvus'].includes(value.provider_kind) || !Array.isArray(value.methods)) {
        throw new GatewayError('runtime_descriptor_invalid')
      }
      const key = boundedJson(value.target)
      if (seen.has(key)) {
        throw new GatewayError('runtime_descriptor_conflict')
      }
      seen.add(key)
      const methods = new Set<string>()
      for (const method of value.methods) {
        text(method.method, 256)
        if (methods.has(method.method)) {
          throw new GatewayError('runtime_descriptor_conflict')
        }
        methods.add(method.method)
      }
    }
    return values
  }

  /** 只按当前可见的完整目标匹配来源；方法名、provider 名或设备广告均不能代替 Target。 */
  async function describe(caller: CallerIdentity, target: unknown): Promise<RuntimeMcpDescriptor> {
    validateTarget(target)
    const key = boundedJson(target)
    const found = (await descriptors(caller)).find(
      /** 完整 tuple 必须精确同值。 */ (entry) => boundedJson(entry.target) === key
    )
    if (!found) {
      throw new GatewayError('runtime_target_unavailable')
    }
    return found
  }

  /** 仅轮询原 get 端口；客户端取消或等待到期都不进入 runtime.cancel。 */
  async function wait(call: Call, milliseconds: number, signal: AbortSignal): Promise<Call> {
    if (signal.aborted) {
      throw new GatewayError('request_cancelled')
    }
    const end = performance.now() + milliseconds
    while (['created', 'dispatching', 'connector_accepted'].includes(call.state) && performance.now() < end) {
      try {
        await pause(Math.min(25, Math.max(1, end - performance.now())), undefined, { signal })
      } catch {
        throw new GatewayError('request_cancelled')
      }
      call = runtime.get(call.call_id)
    }
    if (signal.aborted) {
      throw new GatewayError('request_cancelled')
    }
    return runtime.get(call.call_id)
  }

  /** 正文只经实际结果句柄读取；任何读取失败都保留当前可见调用引用和分层错误。 */
  function callReply(call: Call, extra: JsonObject = {}): CallToolResult {
    const base = { call: callMetadata(call), ...extra }
    if (call.state !== 'responded') {
      return reply({
        ...base,
        delivery: ['created', 'dispatching', 'connector_accepted'].includes(call.state) ? 'pending' : 'metadata_only'
      })
    }
    try {
      const result = runtime.results.open(call.call_id)
      if (result.bytes <= OUTPUT_BYTES) {
        const page = runtime.results.read(result.result_id, 0, OUTPUT_BYTES)
        if (page.eof) {
          const native = object(parseJson(Buffer.from(page.data, 'base64'), OUTPUT_BYTES))
          try {
            return reply({ ...base, delivery: 'inline', native_response: native })
          } catch (error) {
            if (!(error instanceof GatewayError) || error.code !== 'mcp_result_too_large') {
              throw error
            }
          }
        }
      }
      return reply({ ...base, delivery: 'result_handle', result })
    } catch (error) {
      return reply(
        {
          ...base,
          call: callMetadata(runtime.get(call.call_id)),
          delivery: 'metadata_only',
          gateway_error: { code: errorCode(error) }
        },
        true
      )
    }
  }

  server.setRequestHandler(
    ListToolsRequestSchema,
    /** 工具名和通用参数不包含实例或 caller 秘密。 */ async () => ({ tools })
  )
  server.setRequestHandler(
    CallToolRequestSchema,
    /** 每个工具请求进入同一受保护 caller 作用域。 */ async (request, extra) => {
      try {
        const supplied = typeof options.caller === 'function' ? options.caller() : options.caller
        const caller = Object.freeze({ principal_id: supplied.principal_id })
        return await runtime.runAuthenticated(
          caller,
          /** 原生参数不参与身份解析。 */ async () => {
            if (extra.signal.aborted) {
              throw new GatewayError('request_cancelled')
            }
            const args = object(parseJson(boundedJson(request.params.arguments ?? {}, OUTPUT_BYTES)))
            switch (request.params.name) {
              case 'runtime_discover': {
                fields(args, [])
                const values = await descriptors(caller)
                return reply({
                  targets: values.map(
                    /** 发现仅给方法摘要；完整参数从 describe 获取。 */ (value) => ({
                      ...value,
                      methods: value.methods.map(methodSummary)
                    })
                  )
                })
              }
              case 'runtime_describe': {
                fields(args, ['target'], ['method'])
                const descriptor = await describe(caller, args.target)
                if (args.method === undefined) {
                  return reply({ descriptor })
                }
                text(args.method, 256)
                const method = descriptor.methods.find(
                  /** 未在当前过滤描述中出现的方法不可探测。 */ (value) => value.method === args.method
                )
                if (!method) {
                  throw new GatewayError('runtime_method_unavailable')
                }
                return reply({ descriptor: { ...descriptor, methods: [method] } })
              }
              case 'runtime_call': {
                fields(
                  args,
                  ['target', 'expected_binding_revision', 'native_request'],
                  ['deadline', 'timeout_ms', 'wait_ms', 'validation', 'history']
                )
                const descriptor = await describe(caller, args.target)
                uint(args.expected_binding_revision, true)
                if (args.expected_binding_revision !== descriptor.binding_revision) {
                  throw new GatewayError('provider_binding_mismatch')
                }
                const native = object(args.native_request)
                if (Object.hasOwn(native, 'id') || Object.hasOwn(native, 'auth')) {
                  throw new GatewayError('reserved_request_field')
                }
                fields(native, ['method', 'params'])
                text(native.method, 256)
                if (
                  !descriptor.methods.some(
                    /** 当前可见方法表不能扩大原授权。 */ (method) => method.method === native.method
                  )
                ) {
                  throw new GatewayError('runtime_method_unavailable')
                }
                const milliseconds = waitBudget(args.wait_ms, 1000)
                if (args.deadline !== undefined && args.timeout_ms !== undefined) {
                  throw new GatewayError('invalid_deadline')
                }
                const now = runtime.store.clock()
                uint(now)
                let deadline = args.deadline
                if (deadline === undefined) {
                  const timeout = args.timeout_ms ?? 30_000
                  if (!Number.isSafeInteger(timeout) || (timeout as number) < 1 || (timeout as number) > 600_000) {
                    throw new GatewayError('invalid_timeout')
                  }
                  deadline = now + (timeout as number)
                }
                if (!Number.isSafeInteger(deadline) || (deadline as number) <= now) {
                  throw new GatewayError('invalid_deadline')
                }
                if (
                  args.validation !== undefined &&
                  args.validation !== 'strict' &&
                  args.validation !== 'raw-contract'
                ) {
                  throw new GatewayError('invalid_validation_mode')
                }
                let history: { history_epoch: string; client_request_key: string } | undefined
                if (args.history !== undefined) {
                  const value = object(args.history)
                  fields(value, ['history_epoch', 'client_request_key'])
                  id(value.history_epoch)
                  id(value.client_request_key)
                  history = { history_epoch: value.history_epoch, client_request_key: value.client_request_key }
                }
                if (extra.signal.aborted) {
                  throw new GatewayError('request_cancelled')
                }
                const admitted = runtime.admit({
                  target: descriptor.target,
                  native_request: { method: native.method, params: native.params },
                  options: {
                    binding_revision: descriptor.binding_revision,
                    contract_ref: descriptor.contract_ref,
                    deadline: deadline as number,
                    validation: args.validation ?? 'strict',
                    ...(history ? { history } : {})
                  }
                })
                const current = await wait(admitted.call, milliseconds, extra.signal)
                return callReply(current, { created: admitted.created, contract_ref: descriptor.contract_ref })
              }
              case 'runtime_call_get': {
                fields(args, ['call_id'], ['wait_ms'])
                id(args.call_id)
                const milliseconds = waitBudget(args.wait_ms, 0)
                return callReply(await wait(runtime.get(args.call_id), milliseconds, extra.signal))
              }
              case 'runtime_call_cancel': {
                fields(args, ['call_id'])
                id(args.call_id)
                return reply({
                  call: callMetadata(runtime.cancel(args.call_id)),
                  delivery: 'metadata_only',
                  native_work: 'may_continue'
                })
              }
              case 'runtime_result_read': {
                fields(args, ['result_id'], ['cursor', 'max_bytes'])
                id(args.result_id)
                const cursor = args.cursor ?? 0
                const maximum = args.max_bytes ?? PAGE_BYTES
                uint(cursor)
                uint(maximum, true)
                if (maximum > OUTPUT_BYTES) {
                  throw new GatewayError('invalid_result_page_size')
                }
                return reply({ result: runtime.results.read(args.result_id, cursor, Math.min(maximum, PAGE_BYTES)) })
              }
              default:
                throw new GatewayError('runtime_tool_unavailable')
            }
          }
        )
      } catch (error) {
        return reply({ gateway_error: { code: errorCode(error) } }, true)
      }
    }
  )
  return server
}
