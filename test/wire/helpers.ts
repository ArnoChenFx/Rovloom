// 加载离线 P0 schema 和记录，提供隔离的 Wire 测试身份、门禁及断言工具。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Ajv2020 } from 'ajv/dist/2020.js'
import type { AnySchema } from 'ajv'
import type {
  AttemptBinding,
  AttemptIdentity,
  AuthenticatedEnvelope,
  CodecContext,
  NativePayloadValidator,
  RequestGate,
  VersionOffer,
  StreamFeature,
  ValidationMode,
  ContractSource,
  ProviderBinding,
  ProviderPolicies
} from '../../src/wire/types.js'
import { contractRef } from '../../src/wire/provider.js'
import { WireError } from '../../src/wire/validation.js'

export const bundle = JSON.parse(
  readFileSync(new URL('../../fixtures/p0/linux-luvus-0.14.3/schema-bundle.json', import.meta.url), 'utf8')
)
export const transcript: Record<string, any>[] = JSON.parse(
  readFileSync(new URL('../../fixtures/p0/linux-luvus-0.14.3/transcript.json', import.meta.url), 'utf8')
)
export const ajv = new Ajv2020({
  strict: false,
  allErrors: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false
})
for (const [url, schema] of Object.entries(bundle.documents)) {
  ajv.addSchema(schema as AnySchema, url)
}
for (const url of Object.keys(bundle.documents)) {
  assert(ajv.getSchema(url))
}
export const nativeRequest = ajv.getSchema(bundle.request.$id)!
export const nativeResponse = ajv.getSchema(bundle.response.$id)!
export const nativeControl = ajv.getSchema(bundle.terminal.control_frame.$id)!
export const nativeTerminalResponse = ajv.getSchema(bundle.terminal.response.$id)!
export const nativeEvent = ajv.getSchema(bundle.event.$id)!
export const terminalEvent = ajv.getSchema(bundle.terminal.event.$id)!
const catalog = new Map(
  Object.keys(bundle.event_catalog.properties).map(
    /* 按事件名编译离线事件数据 schema，并生成名称到校验器的映射项。 */ (name) => [
      name,
      ajv.compile({ $ref: `${bundle.event_catalog.$id}#/properties/${name}` })
    ]
  )
)
// 这是固定 P0 schema 的测试注入器，不是生产安全分类表或原生模块的替代品。
export const allowedGate: RequestGate = {
  classification_status: 'trusted_complete',
  schema_status: 'complete',
  transport_status: 'supported',
  authorized: true,
  secret_result_authorized: true,
  raw_contract_authorized: false
}
// 创建固定 P0 schema 的测试校验器，并注入指定的测试门禁结果。
export function fixtureValidator(gate: RequestGate = allowedGate): NativePayloadValidator {
  return {
    // 返回独立的测试门禁副本，避免外部修改原配置。
    requestGate: () => ({ ...gate }),
    // 使用离线请求根 schema 校验完整原生请求。
    validateRequest(r) {
      if (!nativeRequest(r)) {
        throw new WireError('native_request_invalid')
      }
    },
    // 核对测试句柄、独立来源与原生 ID，再校验响应 schema。
    validateResponse(r, c) {
      if (c.native_handle !== nativeHandle || c.trusted_source !== trustedSource) {
        throw new WireError('native_handle_mismatch')
      }
      if (r.id !== c.binding.native_request_id) {
        throw new WireError('native_id_mismatch')
      }
      if (!nativeResponse(r)) {
        throw new WireError('native_response_invalid')
      }
    },
    // 为本测试夹具提供默认放行的逐输入派发门禁。
    checkDispatch() {},
    // 按输入、响应或事件类型选择对应的离线流帧 schema。
    validateStreamFrame(r, context) {
      const valid =
        context.direction === 'input'
          ? nativeControl(r)
          : Object.hasOwn(r, 'id')
            ? nativeResponse(r) && nativeTerminalResponse(r)
            : r.event === 'terminal.frame'
              ? terminalEvent(r)
              : nativeEvent(r) && catalog.get(r.event as string)?.(r.data)
      if (!valid) {
        throw new WireError('native_stream_frame_invalid')
      }
    }
  }
}
export const identity = {
  machine_id: 'machine_1',
  recovery_generation: 'recovery_1',
  connection_epoch: 'connection_1'
}
export const source: ContractSource = {
  provider_kind: 'luvus',
  protocol_family: 'uhp',
  binary_version: '0.14.3',
  binary_sha256: '895073022da8edd231c9d4c810d68627b954b61e4e9f9f2d5d19e2c2fcf282a9',
  schema_sha256: transcript.find(
    /* 定位安装版 schema 的采集记录以读取固定来源摘要。 */ (r) => r.label === 'installed-schema'
  )!.raw_stdout_sha256,
  schema_origin: 'installed_cli',
  schema_command: 'luvus uhp schema',
  server_version: '0.14.3',
  native_protocol_version: '1.0',
  runtime_generation: null,
  adapter_revision: 'synthetic_adapter_1',
  classification_revision: 'synthetic_review_1',
  support_basis: 'live_catalog'
}
export const provider: ProviderBinding = {
  machine_id: identity.machine_id,
  provider_id: 'provider_1',
  kind: 'luvus',
  config_ref: 'config_1',
  binding_revision: 1,
  enabled: true
}
export const attempt: AttemptIdentity = {
  call_id: 'call_1',
  attempt_id: 'attempt_1',
  native_request_id: 'proxy-ping',
  target: {
    machine_id: identity.machine_id,
    provider_id: provider.provider_id,
    profile: 'session',
    session: 'p0-issue3'
  },
  provider_kind: 'luvus',
  binding_revision: 1,
  contract_ref: contractRef(source),
  registration: {
    deadline: 1000,
    history: { history_epoch: 'history_1', client_request_key: 'key_1' },
    caller_policy_revision: 'caller_policy_1',
    local_policy_revision: 'local_policy_1'
  }
}
export const binding: AttemptBinding = { ...identity, ...attempt }
export const nativeHandle = Object.freeze({ synthetic_test_handle: true })
export const trustedSource = Object.freeze({ synthetic_test_source: true })
const methods = JSON.parse(
  readFileSync(new URL('../../fixtures/native-contract/coverage.json', import.meta.url), 'utf8')
).methods.map(/* 从覆盖清单中提取可供测试授权的方法名称。 */ (r: any) => r.method)
export const offer: VersionOffer = {
  major: 2,
  minor: 0,
  capabilities: ['rpc', 'history_scope', 'late_evidence', 'objects', 'events', 'terminal_observe', 'terminal_control'],
  required: ['rpc']
}
// 构造含独立 provider、契约、调用锚点和双端权限的认证测试上下文。
export function context(
  direction: 'gateway_to_connector' | 'connector_to_gateway' = 'gateway_to_connector',
  native = fixtureValidator(),
  anchor = binding,
  method = 'ping',
  transport: 'rpc' | 'stream' = 'rpc',
  feature?: StreamFeature,
  mode: ValidationMode = 'strict'
): Extract<CodecContext, { phase: 'authenticated' }> {
  const grants: ProviderPolicies['caller']['grants'] = [
    {
      target: structuredClone(anchor.target),
      methods,
      actions: ['dispatch', 'read', 'stream_input', 'cancel']
    }
  ]
  return {
    phase: 'authenticated',
    direction,
    connection: {
      ...identity,
      authenticated: true,
      active: true,
      negotiated: { major: 2, minor: 0, capabilities: [...offer.capabilities] as any }
    },
    validators: { luvus: native },
    // 返回固定测试 provider 的独立副本。
    resolveProvider: () => ({ ...provider }),
    // 返回明确标为已验证的固定测试契约来源。
    resolveContract: () => ({ source: { ...source }, support_status: 'validated' }),
    policies: {
      caller: { revision: 'caller_policy_1', grants: structuredClone(grants) },
      local: { revision: 'local_policy_1', grants: structuredClone(grants) }
    },
    // 提供独立注入的测试原生来源令牌。
    resolveNativeSource: () => trustedSource,
    // 返回测试登记锚点及其专属原生句柄和传输配置。
    resolveAttempt: () => ({
      binding: anchor,
      method,
      mode,
      transport,
      feature,
      ...(transport === 'stream' ? { stream_id: 'stream_1' } : {}),
      native_handle: nativeHandle
    })
  }
}
// 为指定载荷补齐固定版本、消息标识和认证连接字段。
export function frame<K extends AuthenticatedEnvelope['type']>(
  type: K,
  payload: Extract<AuthenticatedEnvelope, { type: K }>['payload']
): Extract<AuthenticatedEnvelope, { type: K }> {
  return {
    protocol_major: 2,
    protocol_minor: 0,
    type,
    message_id: 'message_1',
    ...identity,
    payload
  } as any
}
// 移除原生请求 ID，模拟由可信调用登记随后注入 ID 的请求正文。
export function withoutId(value: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, ...request } = value
  return request
}
export const request = frame('request', {
  attempt,
  expected_binding_revision: 1,
  native_request: { method: 'ping', params: {} },
  validation: 'strict'
})
export const ping = JSON.parse(
  transcript.find(/* 查找真实 P0 ping 记录以构造响应夹具。 */ (v) => v.label === 'proxy-ping')!.stdout
)
export const response = frame('response', { attempt, native_response: ping })
// 执行待拒绝操作，并要求抛出的结构化错误码与预期完全一致。
export function rejects(action: () => unknown, code: string): void {
  assert.throws(
    action,
    /* 判断异常是否为携带预期错误码的 Error 实例。 */ (e: unknown) =>
      e instanceof Error && 'code' in e && e.code === code,
    code
  )
}
