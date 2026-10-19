// 将真实管理请求与独立本机 Luvus custody grant 相交，不把 providers_manage 或 MCP 权限升级为 token 发行。
import { randomUUID } from 'node:crypto'
import { GatewayError } from '../contracts.js'
import { boundedJson } from '../wire/index.js'
import type { ManagementSessionAuthority } from './management-session.js'
import type { NativeCustodyApprovalWriter, NativeCustodyAuthorizer, NativeCustodyIntent } from './native-custody.js'

export type LuvusCustodyGrant = Readonly<{
  action: 'issue_restricted_delegation'
  principal_id: string
  root_id: string
  root_revision: number
  config_ref: string
  config_digest: string
  server_generation: string
  scopes: readonly ('read' | 'orchestration')[]
  methods: readonly string[]
  max_token_ttl_s: number
  expires_at: number
}>

/** 原生发行是独立能力；完整本机目标、实例代次、scope、method 与 TTL 必须属于同一条 grant。 */
function allows(grant: LuvusCustodyGrant, intent: NativeCustodyIntent, actor: string, at: number): boolean {
  if (!grant || !Array.isArray(intent.scopes) || !Array.isArray(intent.methods)) {
    return false
  }
  return (
    grant.action === 'issue_restricted_delegation' &&
    grant.principal_id === actor &&
    grant.root_id === intent.root_id &&
    grant.root_revision === intent.root_revision &&
    grant.config_ref === intent.config_ref &&
    grant.config_digest === intent.config_digest &&
    grant.server_generation === intent.server_generation &&
    Number.isSafeInteger(grant.expires_at) &&
    at < grant.expires_at &&
    Number.isSafeInteger(grant.max_token_ttl_s) &&
    grant.max_token_ttl_s >= 1 &&
    grant.max_token_ttl_s <= 300 &&
    intent.token_ttl_s >= 1 &&
    intent.token_ttl_s <= grant.max_token_ttl_s &&
    Array.isArray(grant.scopes) &&
    Array.isArray(grant.methods) &&
    intent.scopes.length > 0 &&
    intent.methods.length > 0 &&
    intent.scopes.every(/** 每个实际请求 scope 均在同一精确 grant 内。 */ (scope) => grant.scopes.includes(scope)) &&
    intent.methods.every(
      /** 不拼接不同 grant 的方法与 scope，也不解释通配符。 */ (method) => grant.methods.includes(method)
    )
  )
}

/** 只在当前真实管理员作用域内落一次批准；grants 来自受保护本机政策，不接收公共请求自报的允许标记。 */
export function createLuvusCustodyAuthorizer(
  options: Readonly<{
    sessions: ManagementSessionAuthority
    approvals: NativeCustodyApprovalWriter
    grants(): readonly LuvusCustodyGrant[]
    now?: () => number
  }>
): NativeCustodyAuthorizer {
  if (!options.sessions || typeof options.grants !== 'function' || typeof options.approvals?.approve !== 'function') {
    throw new GatewayError('native_custody_authorization_required')
  }
  const now = options.now ?? Date.now
  let observed = -1
  let denied = false
  /** 审批时钟回退使本次桥永久拒绝，不重设签发期限或重用先前成功的管理员。 */
  function time(): number {
    const at = now()
    if (denied || !Number.isSafeInteger(at) || at < 0 || at < observed) {
      denied = true
      throw new GatewayError('native_custody_authorization_required')
    }
    observed = at
    return at
  }
  return /** 真实 process 交付精确 intent；随机 confirmation 只用于审计和唯一消费，不产生权限。 */ (input) => {
    const intent = JSON.parse(boundedJson(input, 8192)) as NativeCustodyIntent
    const current = options.sessions.current()
    const grants = JSON.parse(boundedJson(options.grants(), 262_144)) as readonly LuvusCustodyGrant[]
    if (!Array.isArray(grants) || grants.length > 1024) {
      throw new GatewayError('native_custody_forbidden')
    }
    const at = time()
    const selected = grants.find(
      /** 每条 grant 独立判定，禁止把多个范围拼成未授予的组合。 */ (grant) =>
        allows(grant, intent, current.administrator.principal_id, at)
    )
    if (!selected) {
      throw new GatewayError('native_custody_forbidden')
    }
    // 本机政策回调也可能关闭或撤销会话，审批文件创建之前重新核对同一实际管理员。
    const latest = options.sessions.current()
    const checkedAt = time()
    if (
      latest.administrator.principal_id !== current.administrator.principal_id ||
      latest.session.management_session_ref !== current.session.management_session_ref ||
      latest.administrator.policy_revision !== current.administrator.policy_revision ||
      !allows(selected, intent, latest.administrator.principal_id, checkedAt)
    ) {
      throw new GatewayError('native_custody_forbidden')
    }
    const expires = Math.min(latest.session.expires_at, selected.expires_at, checkedAt + 60_000)
    if (expires <= checkedAt) {
      throw new GatewayError('native_custody_forbidden')
    }
    const approval = options.approvals.approve(intent, {
      actor: latest.administrator.principal_id,
      confirmation_id: randomUUID(),
      expires_at: expires
    })
    // writer 的可信时钟或文件检查也可能重入撤销；未通过最终核验的批准不交给发行路径。
    const committedAt = time()
    const committed = options.sessions.current()
    if (
      committed.administrator.principal_id !== latest.administrator.principal_id ||
      committed.session.management_session_ref !== latest.session.management_session_ref ||
      committed.administrator.policy_revision !== latest.administrator.policy_revision ||
      committedAt >= expires
    ) {
      throw new GatewayError('native_custody_forbidden')
    }
    return approval
  }
}
