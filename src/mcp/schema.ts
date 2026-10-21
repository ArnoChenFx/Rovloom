// 维护固定工具目录、严格参数 schema 和 JSON 预算；原生契约与授权仍由业务服务负责。
import { Ajv } from 'ajv'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { ToolArguments, ToolName } from './types.js'
import { canonical } from '../contracts.js'

export { MCP_REVISION, PRODUCT_VERSION } from './version.js'
export const MAX_MCP_BYTES = 65_536
export const MAX_RESULT_BYTES = 16_384
export const MAX_WAIT_MS = 5_000
export const TOOLS_PAGE_SIZE = 5

const id = { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,128}$' }
const text = { type: 'string', minLength: 1, maxLength: 256, pattern: '\\S' }
const cursor = { type: 'string', minLength: 1, maxLength: 1024 }
const revision = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }
const wait = { type: 'integer', minimum: 0, maximum: MAX_WAIT_MS }
const page = { cursor, limit: { type: 'integer', minimum: 1, maximum: 100 } }
const object = /* 构造拒绝额外字段的对象 schema，保持声明和实际参数校验一致。 */ (
  properties: Record<string, object>,
  required: string[] = []
) => ({
  type: 'object' as const,
  properties,
  required,
  additionalProperties: false
})
const target = {
  oneOf: [
    object({ machine_id: id, provider_id: id, profile: { const: 'session' }, session: text }, [
      'machine_id',
      'provider_id',
      'profile',
      'session'
    ]),
    object({ machine_id: id, provider_id: id, profile: { const: 'host' } }, ['machine_id', 'provider_id', 'profile'])
  ]
}
const targetProperties = { target, expected_binding_revision: revision }
const targetRequired = ['target', 'expected_binding_revision']

const schemas: Record<ToolName, Tool['inputSchema']> = {
  machines_list: object(page),
  machines_get: {
    ...object({ machine_id: id, name: text }),
    oneOf: [
      { properties: { machine_id: id }, required: ['machine_id'] },
      { properties: { name: text }, required: ['name'] }
    ]
  },
  providers_list: object({ machine_id: id, ...page }, ['machine_id']),
  providers_get: object({ machine_id: id, provider_id: id }, ['machine_id', 'provider_id']),
  runtime_discover: object({ ...targetProperties, ...page }, targetRequired),
  runtime_describe: object({ ...targetProperties, method: text }, [...targetRequired, 'method']),
  runtime_call: object(
    {
      ...targetProperties,
      contract_ref: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      native_request: object({ method: text, params: {} }, ['method']),
      deadline: revision,
      wait_ms: wait,
      validation: { enum: ['strict', 'raw-contract'] },
      history: object({ history_epoch: id, client_request_key: id, recovery_generation: id }, [
        'history_epoch',
        'client_request_key',
        'recovery_generation'
      ])
    },
    [...targetRequired, 'contract_ref', 'native_request', 'deadline']
  ),
  runtime_call_get: object({ call_id: id, wait_ms: wait }, ['call_id']),
  runtime_call_cancel: object({ call_id: id }, ['call_id']),
  runtime_result_read: object(
    { result_id: id, cursor, max_bytes: { type: 'integer', minimum: 1, maximum: MAX_RESULT_BYTES } },
    ['result_id']
  ),
  runtime_response_discard: object({ call_id: id }, ['call_id'])
}

const descriptions: Record<ToolName, string> = {
  machines_list: '列出当前 caller 可见的设备；分页和计数须经过当前 ACL。',
  machines_get: '按稳定 ID 或精确名称读取可见设备。',
  providers_list: '列出指定设备下当前 caller 可见的已配置 provider；不返回本机配置。',
  providers_get: '读取显式 provider 的 kind、revision 和 readiness。',
  runtime_discover: '发现显式 Target/revision 的有效能力及来源；不授予执行权限。',
  runtime_describe: '描述显式 Target/revision 下精确方法的原生参数、分类和限制。',
  runtime_call:
    '提交一次显式 Target/revision/契约的原生调用。deadline 是绝对毫秒期限，wait_ms 只控制短等；不重试或管理 provider。',
  runtime_call_get: '按当前归属、双端策略和内容门禁读取调用；短等到期不改变执行期限。',
  runtime_call_cancel: '请求停止等待或桥接；仅报告服务可确认程度，不承诺原生回滚。',
  runtime_result_read: '按当前读取授权和期限读取有界结果页；cursor 由服务绑定 caller 和原结果。',
  runtime_response_discard: '独立清理动作；必须同时验证归属、原方法当前策略及专门 discard_response 权限。'
}

const readOnly = new Set<ToolName>([
  'machines_list',
  'machines_get',
  'providers_list',
  'providers_get',
  'runtime_discover',
  'runtime_describe',
  'runtime_call_get',
  'runtime_result_read'
])
const ajv = new Ajv({ strict: true, allErrors: false, ownProperties: true })
const validators = new Map(
  Object.entries(schemas).map(
    /* 预编译固定工具 schema，不允许请求临时引入外部校验规则。 */ ([name, schema]) => [name, ajv.compile(schema)]
  )
)

// 返回静态工具名称副本，供目录分页和宿主发现使用。
export function toolNames(): ToolName[] {
  return Object.keys(schemas) as ToolName[]
}

// 生成独立 schema 副本和工具元数据，外部修改不能污染运行时校验器。
export function toolDefinition(name: ToolName): Tool {
  return {
    name,
    description: descriptions[name],
    inputSchema: structuredClone(schemas[name]),
    outputSchema: {
      type: 'object',
      properties: {
        data: { type: 'object' },
        gateway_error: object({ code: { type: 'string' }, outcome: { const: 'not_dispatched' } }, ['code']),
        delivery: { type: 'object' }
      },
      additionalProperties: false,
      anyOf: [{ required: ['data'] }, { required: ['gateway_error'] }]
    },
    annotations: {
      readOnlyHint: readOnly.has(name),
      destructiveHint: !readOnly.has(name),
      // 原生方法的幂等性必须由服务核验，不能按工具名推断。
      idempotentHint: readOnly.has(name),
      openWorldHint: true
    }
  }
}

// 只认可目录自有名称，避免继承属性被当成工具。
export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(schemas, name)
}

// 复制并有界校验 JSON 参数，拒绝访问器与循环，再补充保守等待默认值。
export function parseToolArguments<K extends ToolName>(name: K, value: unknown): ToolArguments[K] {
  // 复用现有 JSON 边界；不触发 getter，也不允许后续共享对象改变请求。
  const encoded = canonical(value)
  if (Buffer.byteLength(encoded) > MAX_MCP_BYTES) {
    throw new Error('invalid_arguments')
  }
  const snapshot: unknown = JSON.parse(encoded)
  if (!validators.get(name)?.(snapshot)) {
    throw new Error('invalid_arguments')
  }
  const args = snapshot as Record<string, unknown>
  if (name === 'runtime_call') {
    args.validation ??= 'strict'
    args.wait_ms ??= 0
  }
  if (name === 'runtime_call_get') {
    args.wait_ms ??= 0
  }
  if (name === 'runtime_result_read') {
    args.max_bytes ??= 4096
  }
  return args as ToolArguments[K]
}
