/** 从已安装 Herdr 的官方 request 根描述窗口与 Agent 操作，描述数据和执行校验共用同一来源。 */
import type { HerdrInstallation } from './installation.js'
import { HERDR_READONLY_REVIEW, isReviewedHerdrSource } from './review.js'
import { herdrResponseRule } from './methods.js'
import { boundedJson, contractRef, fail, object, uint, validateTarget } from '../../wire/index.js'
import type { ContractSource, JsonObject, V2Target } from '../../wire/types.js'

/** 仅为方法描述重定位官方参数引用，执行时仍使用原始完整安装 schema。 */
export function describeHerdrParams(document: JsonObject, method: string): JsonObject {
  const request = object(object(document.schemas).request)
  const definitions = object(request.$defs)
  if (!Array.isArray(request.oneOf)) {
    fail('herdr_schema_root_unavailable')
  }
  const branch = request.oneOf.find(
    /** 在官方 union 中按精确 method 常量定位参数分支。 */ (value) =>
      object(object(object(value).properties).method).const === method
  )
  if (!branch) {
    fail('herdr_method_unreviewed')
  }
  const selected = structuredClone(object(object(branch).properties).params)
  const defs: JsonObject = {}
  const visited = new Set<string>()

  /** 只搬运实际参数引用闭包；保留递归、枚举、必填项及数字边界，不生成宽松替代 schema。 */
  function relocate(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(relocate)
      return
    }
    if (value === null || typeof value !== 'object') {
      return
    }
    const record = value as JsonObject
    const ref = record.$ref
    if (typeof ref === 'string') {
      const prefix = '#/schemas/request/$defs/'
      if (!ref.startsWith(prefix)) {
        fail('herdr_schema_reference_unavailable')
      }
      const name = ref.slice(prefix.length)
      if (!Object.hasOwn(definitions, name)) {
        fail('herdr_schema_reference_unavailable')
      }
      record.$ref = '#/$defs/' + name
      if (!visited.has(name)) {
        visited.add(name)
        defs[name] = structuredClone(definitions[name])!
        relocate(defs[name])
      }
    }
    for (const child of Object.values(record)) {
      relocate(child)
    }
  }
  relocate(selected)
  return { ...object(selected), $schema: document.$schema!, $defs: defs }
}

/** 纯展示函数保留本机安装或配置契约的证据边界；不发行来源品牌、派发或读取许可。 */
export function describeHerdrContract(
  input: Readonly<{
    target: V2Target
    binding_revision: number
    source: ContractSource
    document: JsonObject
    source_basis: 'local_installation' | 'configured_connector_contract'
  }>
) {
  validateTarget(input.target)
  uint(input.binding_revision, true)
  if (!isReviewedHerdrSource(input.source)) {
    fail('herdr_contract_unreviewed')
  }
  const { source, document } = input
  return {
    target: structuredClone(input.target),
    binding_revision: input.binding_revision,
    provider_kind: 'herdr' as const,
    contract_ref: contractRef(source),
    source: structuredClone(source),
    source_basis: input.source_basis,
    methods: HERDR_READONLY_REVIEW.methods
      .filter(
        /** 可选方法仅在本轮实际 request union 存在时展示；缺失不阻断其它方法。 */ (method) => {
          const request = object(object(document.schemas).request)
          return (
            Array.isArray(request.oneOf) &&
            request.oneOf.some(
              /** 精确匹配原生 method 常量。 */ (branch) =>
                object(object(object(branch).properties).method).const === method
            )
          )
        }
      )
      .map(
        /** 方法描述携带真实参数和原生结果类型，不把进程或状态探测解释为消息完成确认。 */ (method) => ({
          method,
          params_schema: describeHerdrParams(document, method),
          response_types: herdrResponseRule(method),
          transport: 'rpc',
          limits: {
            request_frame_bytes: HERDR_READONLY_REVIEW.frame_bytes,
            response_frame_bytes: HERDR_READONLY_REVIEW.frame_bytes,
            frame_size_basis: 'utf8_json_including_lf',
            response_pagination: 'unavailable',
            response_objects: false,
            ...(method === 'pane.read' || method === 'agent.read'
              ? {
                  line_window: {
                    parameter: 'lines',
                    selection: 'last_lines',
                    native_max_lines: 1000,
                    guarantees_frame_fit: false
                  }
                }
              : {})
          },
          completion:
            method === 'agent.prompt' || method === 'agent.wait' ? 'native_agent_state_only' : 'native_response'
        })
      )
  }
}

/** 描述精确配置目标的已接入操作；当前 caller 可见性仍由原 Gateway 宿主逐次过滤。 */
export function describeHerdrTarget(installation: HerdrInstallation, target: V2Target) {
  if (boundedJson(target) !== boundedJson(installation.config.target)) {
    fail('herdr_local_binding_mismatch')
  }
  return describeHerdrContract({
    target,
    binding_revision: installation.config.binding_revision,
    source: installation.record().wire.source,
    document: installation.schemaDocument(),
    source_basis: 'local_installation'
  })
}
