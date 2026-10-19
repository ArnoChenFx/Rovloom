/** 固定 Herdr 已评审 RPC 的精确参数范围；只做分类，不建立实例来源、认证或执行许可。 */

/** 首个元数据写入只使用单一自定义命名空间、显式序号和有限原生 TTL，不接纳永久 token。 */
export const HERDR_WORKSPACE_METADATA_SCOPE = Object.freeze({
  method: 'workspace.report_metadata',
  source: 'rovloom',
  token: 'rovloom_note',
  workspace_id_pattern: '^w[123456789ABCDEFGHJKMNPQRSTVWXYZ0]{1,12}$',
  value_max_chars: 64,
  ttl_min_ms: 100,
  ttl_max_ms: 60_000
})

/** 只识别 JSON 记录；数组、null 与其它值不能充当请求或参数对象。 */
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 参数必须逐项显式提供，不以额外字段、默认值或归一化扩大固定方法范围。 */
function exact(value: Record<string, unknown>, names: readonly string[]): boolean {
  const keys = Object.keys(value)
  return (
    keys.length === names.length && names.every(/** 必需字段只能取自当前记录。 */ (name) => Object.hasOwn(value, name))
  )
}

/** 同一纯分类供 Store 与原生编码器使用；结果为 true 仍须完整 schema、当前授权和来源门禁。 */
export function reviewedHerdrRequest(value: unknown): boolean {
  if (!record(value) || !exact(value, ['method', 'params']) || !record(value.params)) {
    return false
  }
  if (value.method === 'ping') {
    return exact(value.params, [])
  }
  if (value.method !== HERDR_WORKSPACE_METADATA_SCOPE.method) {
    return false
  }
  const params = value.params
  if (
    !exact(params, ['workspace_id', 'source', 'tokens', 'seq', 'ttl_ms']) ||
    typeof params.workspace_id !== 'string' ||
    !new RegExp(HERDR_WORKSPACE_METADATA_SCOPE.workspace_id_pattern).test(params.workspace_id) ||
    params.source !== HERDR_WORKSPACE_METADATA_SCOPE.source ||
    !record(params.tokens) ||
    !exact(params.tokens, [HERDR_WORKSPACE_METADATA_SCOPE.token]) ||
    typeof params.seq !== 'number' ||
    !Number.isSafeInteger(params.seq) ||
    params.seq < 1 ||
    typeof params.ttl_ms !== 'number' ||
    !Number.isSafeInteger(params.ttl_ms) ||
    params.ttl_ms < HERDR_WORKSPACE_METADATA_SCOPE.ttl_min_ms ||
    params.ttl_ms > HERDR_WORKSPACE_METADATA_SCOPE.ttl_max_ms
  ) {
    return false
  }
  const token = params.tokens[HERDR_WORKSPACE_METADATA_SCOPE.token]
  return (
    token === null ||
    (typeof token === 'string' &&
      token.length <= HERDR_WORKSPACE_METADATA_SCOPE.value_max_chars &&
      token.trim() === token &&
      /^[\x20-\x7e]+$/.test(token))
  )
}

/** 成功响应类型来自对应官方分派函数；此枚举不包含请求正文，也不表示修改一定被应用。 */
export function herdrResponseRule(method: string): 'pong' | 'ok' | undefined {
  if (method === 'ping') {
    return 'pong'
  }
  if (method === HERDR_WORKSPACE_METADATA_SCOPE.method) {
    return 'ok'
  }
  return undefined
}
