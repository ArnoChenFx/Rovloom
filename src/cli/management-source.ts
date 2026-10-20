// 独立受保护管理来源只消费既有会话、授权和逐动作批准；不创建账号、不发行上游凭据或复制会话库。
import { createHash, timingSafeEqual } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Administrator, CallerIdentity, ManagementGrant } from '../mcp/management.js'
import type { ManagementSessionAuthority, ManagementSessionLease } from '../runtime/management-session.js'
import type { IdentityApproval, IdentityIntent } from '../transport/identity-store.js'
import type { ManagementAssets } from '../admin/read-http.js'
import { boundedJson, fields, object } from '../wire/index.js'
import { CliError, type GatewayConfig } from './config.js'
import { loadProductManagementAssets } from './management-assets.js'
import { readRuntimeJson, runtimeReference } from './runtime-files.js'
import type { ProductionManagementHost } from './production.js'

type Session = Readonly<{
  credential_sha256: string
  lease: ManagementSessionLease
  administrator: Administrator
}>
type Source = Readonly<{
  schema_version: 1
  kind: 'management-session-source'
  port: number
  sessions: readonly Session[]
  pairing_policy_refs: readonly string[]
  identity_approvals_ref?: string
}>
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/
const digest = /^[a-f0-9]{64}$/

/** 沿用管理authority的有界引用形状，不将任意文本或控制码映射为管理身份。 */
function reference(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !identifier.test(value)) {
    throw new CliError('invalid_config')
  }
}

/** 只校验既有ManagementGrant的数据形状；实际操作仍由原管理服务逐次授权。 */
function grant(input: unknown): ManagementGrant {
  const value = object(input)
  if (value.action === 'gateway_read' || value.action === 'devices_register') {
    fields(value, ['action'])
  } else if (value.action === 'providers_read' || value.action === 'providers_manage') {
    fields(value, ['action', 'machine_id', 'provider_id'])
    reference(value.machine_id)
    reference(value.provider_id)
  } else if (
    ['devices_read', 'devices_rename', 'devices_disconnect', 'devices_revoke', 'permissions_read'].includes(
      value.action as string
    )
  ) {
    fields(value, ['action', 'machine_id'])
    reference(value.machine_id)
  } else {
    throw new CliError('invalid_config')
  }
  return value as ManagementGrant
}

/** 管理证明必须独立于所有MCP凭据摘要；配置只导出现有管理员记录和固定租期。 */
function parse(input: unknown, config: GatewayConfig): Source {
  const value = object(input)
  fields(value, ['schema_version', 'kind', 'port', 'sessions', 'pairing_policy_refs'], ['identity_approvals_ref'])
  if (
    value.schema_version !== 1 ||
    value.kind !== 'management-session-source' ||
    !Number.isSafeInteger(value.port) ||
    (value.port as number) < 1 ||
    (value.port as number) > 65_535 ||
    value.port === config.mcp_port ||
    !Array.isArray(value.sessions) ||
    value.sessions.length < 1 ||
    value.sessions.length > 16 ||
    !Array.isArray(value.pairing_policy_refs) ||
    value.pairing_policy_refs.length > 32 ||
    new Set(value.pairing_policy_refs).size !== value.pairing_policy_refs.length
  ) {
    throw new CliError('invalid_config')
  }
  for (const policy of value.pairing_policy_refs) {
    reference(policy)
  }
  if (value.identity_approvals_ref !== undefined) {
    runtimeReference(config.state_dir, value.identity_approvals_ref)
  }
  const callers = object(readRuntimeJson(runtimeReference(config.state_dir, config.authentication_ref)))
  if (!Array.isArray(callers.callers)) {
    throw new CliError('invalid_config')
  }
  const credentials = new Set(
    callers.callers.map(/** 同一受保护caller来源的摘要不能兼任独立管理证明。 */ (entry) => object(entry).token_sha256)
  )
  const names = new Set<string>()
  for (const input of value.sessions) {
    const session = object(input)
    fields(session, ['credential_sha256', 'lease', 'administrator'])
    const lease = object(session.lease)
    fields(lease, ['caller', 'management_session_ref', 'issued_at', 'expires_at'])
    const caller = object(lease.caller)
    fields(caller, ['principal_id'])
    reference(caller.principal_id)
    reference(lease.management_session_ref)
    const admin = object(session.administrator)
    fields(admin, ['principal_id', 'session_ref', 'assurance', 'policy_revision', 'grants'])
    reference(admin.policy_revision)
    if (
      admin.principal_id !== caller.principal_id ||
      admin.session_ref !== lease.management_session_ref ||
      admin.assurance !== 'administrator' ||
      !Array.isArray(admin.grants) ||
      admin.grants.length > 64 ||
      typeof session.credential_sha256 !== 'string' ||
      !digest.test(session.credential_sha256) ||
      credentials.has(session.credential_sha256) ||
      !Number.isSafeInteger(lease.issued_at) ||
      (lease.issued_at as number) < 0 ||
      !Number.isSafeInteger(lease.expires_at) ||
      (lease.expires_at as number) <= (lease.issued_at as number)
    ) {
      throw new CliError('invalid_config')
    }
    for (const entry of admin.grants) {
      grant(entry)
    }
    const name = boundedJson([caller.principal_id, lease.management_session_ref])
    if (names.has(name)) {
      throw new CliError('invalid_config')
    }
    names.add(name)
    credentials.add(session.credential_sha256)
  }
  return value as unknown as Source
}

/** 验证标准Basic封装中的独立高熵证明，只返回摘要；原值不写入租期、配置或诊断。 */
function proof(request: Request): { principal_id: string; sha256: Buffer } | null {
  const raw = request.headers.get('authorization')
  if (!raw || raw.length > 600 || !/^Basic [A-Za-z0-9+/]+={0,2}$/i.test(raw)) {
    return null
  }
  const encoded = raw.slice(6)
  const bytes = Buffer.from(encoded, 'base64')
  try {
    if (bytes.toString('base64') !== encoded) {
      return null
    }
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const separator = value.indexOf(':')
    const principal = value.slice(0, separator)
    const secret = value.slice(separator + 1)
    if (separator < 1 || !identifier.test(principal) || !/^[A-Za-z0-9_-]{32,256}$/.test(secret)) {
      return null
    }
    return { principal_id: principal, sha256: createHash('sha256').update(secret).digest() }
  } catch {
    return null
  } finally {
    bytes.fill(0)
  }
}

/** 逐动作批准只复用现有完整IdentityIntent，字段、代次或revision漂移都不能匹配。 */
function identityIntent(input: unknown): IdentityIntent {
  const value = object(input)
  fields(value, ['action', 'machine_id', 'recovery_generation', 'revision', 'connection_epoch'])
  if (
    !['install', 'rotate', 'finish_rotation', 'revoke', 're_pair', 'takeover'].includes(value.action as string) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0
  ) {
    throw new CliError('invalid_config')
  }
  reference(value.machine_id)
  reference(value.recovery_generation)
  if (value.connection_epoch !== null) {
    reference(value.connection_epoch)
  }
  return value as IdentityIntent
}

/** 从角色私有ref读取独立管理来源；正常启动只验证配置，不bootstrap cookie或消费任何批准。 */
export function openProtectedManagementSource(
  config: GatewayConfig,
  ref: string,
  options: Readonly<{ now?: () => number; assets?: ManagementAssets }> = {}
) {
  const path = runtimeReference(config.state_dir, ref)
  let source: Source
  try {
    source = parse(readRuntimeJson(path), config)
  } catch (error) {
    if (error instanceof CliError) {
      throw error
    }
    throw new CliError('invalid_config')
  }
  const initial = boundedJson(source, 16_384)
  const now = options.now ?? Date.now
  const origin = `http://127.0.0.1:${source.port}`
  let observed = 0
  let closed = false
  let authority: ManagementSessionAuthority | undefined
  const time = /** 时钟回退永久关闭本轮来源，恢复文件或重复认证不能续期。 */ () => {
    const at = now()
    if (closed || !Number.isSafeInteger(at) || at < observed) {
      closed = true
      throw new CliError('backend_unavailable', 3)
    }
    observed = at
    return at
  }
  const current = /** 每次认证、管理员读取及批准都重读同一受保护配置代次。 */ () => {
    try {
      time()
      if (boundedJson(readRuntimeJson(path), 16_384) !== initial) {
        throw new CliError('backend_unavailable', 3)
      }
      return time()
    } catch {
      closed = true
      throw new CliError('backend_unavailable', 3)
    }
  }
  const session = /** 精确现有caller/session和固定期限，不按最近登录者选择管理员。 */ (
    caller: CallerIdentity,
    sessionRef: string
  ) => {
    const at = current()
    return source.sessions.find(
      /** 返回前仍由调用者复核时间和外部身份来源。 */ (entry) =>
        entry.lease.caller.principal_id === caller.principal_id &&
        entry.lease.management_session_ref === sessionRef &&
        at >= entry.lease.issued_at &&
        at < entry.lease.expires_at
    )
  }
  const administrator = /** 独立来源失效时只返回null，原authority立即撤去已有cookie权限。 */ (
    caller: CallerIdentity,
    sessionRef: string
  ): Administrator | null => {
    try {
      const found = session(caller, sessionRef)
      return found && current() < found.lease.expires_at ? structuredClone(found.administrator) : null
    } catch {
      return null
    }
  }
  const management: ProductionManagementHost = {
    port: source.port,
    bootstrap_challenge: 'basic',
    http: { assets: options.assets ?? loadProductManagementAssets() },
    resolveLease: /** 只认证实际同源根页面的独立证明；MCP Bearer、URL、普通header不建立租期。 */ async (
      request,
      signal
    ) => {
      if (signal.aborted) {
        return null
      }
      try {
        const url = new URL(request.url)
        if (
          url.origin !== origin ||
          request.headers.get('host') !== url.host ||
          url.search ||
          url.username ||
          url.password ||
          request.method !== 'GET' ||
          !['/', '/index.html'].includes(url.pathname) ||
          (request.headers.has('origin') && request.headers.get('origin') !== origin) ||
          (request.headers.has('sec-fetch-site') &&
            !['none', 'same-origin'].includes(request.headers.get('sec-fetch-site')!))
        ) {
          return null
        }
        const at = current()
        const supplied = proof(request)
        if (!supplied) {
          return null
        }
        try {
          const found = source.sessions.find(
            /** 摘要恒定时间比较；所有原始证明均不进入lease或管理员DTO。 */ (entry) =>
              entry.lease.caller.principal_id === supplied.principal_id &&
              timingSafeEqual(supplied.sha256, Buffer.from(entry.credential_sha256, 'hex')) &&
              at >= entry.lease.issued_at &&
              at < entry.lease.expires_at
          )
          return found && !signal.aborted && current() < found.lease.expires_at ? structuredClone(found.lease) : null
        } finally {
          supplied.sha256.fill(0)
        }
      } catch {
        return null
      }
    },
    pairingPolicy: /** 只识别来源已批准的既有策略引用，原管理grant/确认和Store仍逐动作核对。 */ (policyRef, admin) => {
      try {
        const active = authority?.current()
        return (
          !!active &&
          isDeepStrictEqual(active.administrator, admin) &&
          !!administrator(active.session.caller, active.session.management_session_ref) &&
          source.pairing_policy_refs.includes(policyRef)
        )
      } catch {
        return false
      }
    }
  }
  return Object.freeze({
    administrator,
    management,
    bindAuthority: /** 唯一组合器只绑定一次原authority，不接受另一个会话库或重绑定。 */ (
      value: ManagementSessionAuthority
    ) => {
      if (closed || authority || !value || typeof value.current !== 'function') {
        throw new CliError('invalid_config')
      }
      authority = value
    },
    authorizeIdentity: /** 当前管理cookie作用域与精确预批准tuple同时存在才交付原一次性确认。 */ (
      intent: IdentityIntent
    ): IdentityApproval => {
      const at = current()
      const active = authority?.current()
      const bound = active ? session(active.session.caller, active.session.management_session_ref) : undefined
      if (!bound || !source.identity_approvals_ref) {
        throw new CliError('backend_unavailable', 3)
      }
      const document = object(readRuntimeJson(runtimeReference(config.state_dir, source.identity_approvals_ref)))
      fields(document, ['schema_version', 'kind', 'approvals'])
      if (
        document.schema_version !== 1 ||
        document.kind !== 'identity-approval-source' ||
        !Array.isArray(document.approvals) ||
        document.approvals.length > 64
      ) {
        throw new CliError('invalid_config')
      }
      let approved: IdentityApproval | undefined
      for (const input of document.approvals) {
        const entry = object(input)
        fields(entry, ['principal_id', 'management_session_ref', 'intent', 'approval'])
        reference(entry.principal_id)
        reference(entry.management_session_ref)
        const candidate = identityIntent(entry.intent)
        const approval = object(entry.approval)
        fields(approval, ['actor', 'confirmation_id', 'expires_at'])
        reference(approval.actor)
        reference(approval.confirmation_id)
        if (!Number.isSafeInteger(approval.expires_at)) {
          throw new CliError('invalid_config')
        }
        if (
          entry.principal_id === bound.lease.caller.principal_id &&
          entry.management_session_ref === bound.lease.management_session_ref &&
          approval.actor === entry.principal_id &&
          isDeepStrictEqual(candidate, intent)
        ) {
          if (
            approved ||
            (approval.expires_at as number) <= at ||
            (approval.expires_at as number) > Math.min(at + 300_000, bound.lease.expires_at)
          ) {
            throw new CliError('backend_unavailable', 3)
          }
          approved = approval as IdentityApproval
        }
      }
      if (
        !approved ||
        current() >= approved.expires_at ||
        !administrator(bound.lease.caller, bound.lease.management_session_ref)
      ) {
        throw new CliError('backend_unavailable', 3)
      }
      return structuredClone(approved)
    },
    close: /** 关闭只撤去内存读取能力；原配置、凭据和持久一次性消费记录保持所属模块所有。 */ () => {
      closed = true
      authority = undefined
    }
  })
}
