// 将既有管理员会话显式映射到短期管理 cookie；只保存秘密摘要，不建立账户、身份库或 HTTP 认证协议。
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomBytes } from 'node:crypto'
import { GatewayError } from '../contracts.js'
import type { ManagementSessionSource } from '../admin/session-adapter.js'
import type { Administrator, CallerIdentity, GatewayIdentitySource } from '../mcp/management.js'
import type { Principal } from '../router.js'
import { boundedJson, validatePolicies } from '../wire/index.js'

export type ManagementSessionLease = Readonly<{
  caller: CallerIdentity
  management_session_ref: string
  issued_at: number
  expires_at: number
}>
export type ManagementSessionBootstrap = ManagementSessionLease & Readonly<{ cookie: string; csrf: string }>
export type ManagementBootstrapOptions = Readonly<{ signal?: AbortSignal; rotate?: false; reauthenticate?: true }>
export type CurrentManagementSession = Readonly<{
  principal: Principal
  administrator: Administrator
  session: ManagementSessionLease
  wait_signal: AbortSignal
}>
export type ManagementSessionAuthority = Readonly<{
  identities: GatewayIdentitySource
  sessions: ManagementSessionSource
  // 仅由受保护本机产品动作调用；普通 HTTP/MCP 参数不得接到此入口。
  bootstrap(lease: ManagementSessionLease, options?: ManagementBootstrapOptions): ManagementSessionBootstrap
  revoke(caller: CallerIdentity, sessionRef: string): void
  runAuthenticated<T>(rawCookie: string, signal: AbortSignal, operation: () => T | Promise<T>): Promise<T>
  current(): CurrentManagementSession
  close(): void
}>
type LeaseRecord = {
  name: string
  session: ManagementSessionLease
  policy: string
  cookie_sha256: string | undefined
  csrf_sha256: string | undefined
  revoked: boolean
  expiry_only: boolean
  upstream: ManagementSessionLease
}
type Proof = { lease: LeaseRecord; cookie_sha256: string; signal: AbortSignal }
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/
const nonce = /^[a-zA-Z0-9_-]{43}$/

/** 管理引用沿用 PR69 接口的有界形式，不能从任意 JSON 猜出新会话或执行 getter。 */
function reference(value: unknown): string {
  if (typeof value !== 'string' || !identifier.test(value)) {
    throw new GatewayError('unauthenticated')
  }
  return value
}

/** 输入只接受明确的数据属性，受信本机调用也不能把可重入 getter 当成租期。 */
function data(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    return false
  }
  if (Object.getOwnPropertySymbols(value).length || Object.getOwnPropertyNames(value).length !== fields.length) {
    return false
  }
  return fields.every(
    /** 检查属性描述符而不执行来源之外的用户代码。 */ (field) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, field)
      return descriptor?.enumerable === true && 'value' in descriptor
    }
  )
}

/** cookie 与 CSRF 原值只在 bootstrap 的交付对象中出现，内存查询始终使用 SHA-256。 */
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** 原管理员引用与 principal 共同寻址固定租期，不签发新的 management session ref。 */
function key(caller: CallerIdentity, sessionRef: string): string {
  return digest(boundedJson([reference(caller.principal_id), reference(sessionRef)]))
}

/** 交付 PR69 的正式消费来源；构造不创建秘密，首次租期和撤销墓碑直到宿主关闭都不遗忘。 */
export function createManagementSessionAuthority(
  source: GatewayIdentitySource,
  options: Readonly<{ now?: () => number; max_sessions?: number }> = {}
): ManagementSessionAuthority {
  if (typeof source?.principal !== 'function' || typeof source.administrator !== 'function') {
    throw new GatewayError('management_session_source_required')
  }
  const now = options.now ?? Date.now
  const capacity = options.max_sessions ?? 1024
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4096) {
    throw new GatewayError('management_session_limit')
  }
  const leases = new Map<string, LeaseRecord>()
  const cookies = new Map<string, LeaseRecord>()
  const scope = new AsyncLocalStorage<{ proof: Proof; active: boolean }>()
  let closed = false
  let observed = -1

  /** 摘要立即失效但保留原引用墓碑，显式撤销或到期不能再 bootstrap 延长。 */
  function invalidate(lease: LeaseRecord, expiryOnly = false): void {
    if (lease.cookie_sha256) {
      cookies.delete(lease.cookie_sha256)
    }
    lease.cookie_sha256 = undefined
    lease.csrf_sha256 = undefined
    lease.revoked = true
    lease.expiry_only = expiryOnly
  }

  /** 停止来源并使全部异步后代失去当前作用域，不修改原身份后端。 */
  function close(): void {
    closed = true
    cookies.clear()
    leases.clear()
    scope.disable()
  }

  /** 时钟回退永久关闭宿主，不能靠新请求或再次 bootstrap 重置旧截止。 */
  function time(): number {
    const at = now()
    if (closed || !Number.isSafeInteger(at) || at < 0 || at < observed) {
      close()
      throw new GatewayError('unauthenticated')
    }
    observed = at
    return at
  }

  /** 每次从同一实际身份服务解析 principal 和普通管理员，并在全部回调结束后复核截止。 */
  function base(
    session: ManagementSessionLease,
    policy?: string
  ): { principal: Principal; administrator: Administrator } {
    const at = time()
    if (at < session.issued_at || at >= session.expires_at) {
      throw new GatewayError('unauthenticated')
    }
    const principal = source.principal(session.caller)
    const admin = source.administrator(session.caller, session.management_session_ref)
    const current = JSON.parse(boundedJson({ principal, administrator: admin }, 65_536)) as {
      principal: Principal | null
      administrator: Administrator | null
    }
    if (
      !current.principal ||
      current.principal.id !== session.caller.principal_id ||
      !current.administrator ||
      current.administrator.principal_id !== current.principal.id ||
      current.administrator.session_ref !== session.management_session_ref ||
      current.administrator.assurance !== 'administrator' ||
      !reference(current.administrator.policy_revision) ||
      !Array.isArray(current.administrator.grants) ||
      current.administrator.grants.length > 4096 ||
      (policy !== undefined && current.administrator.policy_revision !== policy)
    ) {
      throw new GatewayError('unauthenticated')
    }
    validatePolicies({ caller: current.principal.policy, local: current.principal.policy })
    if (time() >= session.expires_at) {
      throw new GatewayError('unauthenticated')
    }
    return { principal: current.principal, administrator: current.administrator }
  }

  /** 固定租期、摘要代次与当前政策都重新检查；任何已观察到的失效保持永久拒绝。 */
  function resolve(lease: LeaseRecord, cookieDigest?: string) {
    if (
      lease.revoked ||
      leases.get(lease.name) !== lease ||
      !lease.cookie_sha256 ||
      (cookieDigest !== undefined && lease.cookie_sha256 !== cookieDigest)
    ) {
      throw new GatewayError('unauthenticated')
    }
    if (time() >= lease.session.expires_at) {
      invalidate(lease, true)
      throw new GatewayError('unauthenticated')
    }
    let current: ReturnType<typeof base>
    try {
      current = base(lease.session, lease.policy)
    } catch {
      invalidate(lease)
      throw new GatewayError('unauthenticated')
    }
    // 旧请求的摘要代次失效只拒绝该请求，不撤销显式旋转后仍有效的新 cookie。
    if (
      lease.revoked ||
      leases.get(lease.name) !== lease ||
      !lease.cookie_sha256 ||
      (cookieDigest !== undefined && lease.cookie_sha256 !== cookieDigest)
    ) {
      throw new GatewayError('unauthenticated')
    }
    return { ...current, session: lease.session }
  }

  /** 作用域入口只认当前随机 cookie，JSON 管理 context、旧 cookie 和中止信号均不能代入。 */
  function required(rawCookie: string, signal: AbortSignal): Proof {
    time()
    if (signal.aborted || typeof rawCookie !== 'string' || !nonce.test(rawCookie)) {
      throw new GatewayError('unauthenticated')
    }
    const cookieDigest = digest(rawCookie)
    const lease = cookies.get(cookieDigest)
    if (!lease) {
      throw new GatewayError('unauthenticated')
    }
    resolve(lease, cookieDigest)
    if (signal.aborted) {
      throw new GatewayError('unauthenticated')
    }
    return { lease, cookie_sha256: cookieDigest, signal }
  }

  const identities: GatewayIdentitySource = Object.freeze({
    /** 普通 principal 仍来自原身份服务，管理 cookie 不赋予 MCP 或设备权限。 */
    principal(caller: CallerIdentity): Principal | null {
      try {
        time()
        const principal = source.principal(caller)
        time()
        return principal
      } catch {
        return null
      }
    },
    /** 慢正文与异步写步骤之后仍按同一固定租期和当前原服务重新检查管理员。 */
    administrator(caller: CallerIdentity, sessionRef: string): Administrator | null {
      try {
        const lease = leases.get(key(caller, sessionRef))
        return lease ? resolve(lease).administrator : null
      } catch {
        return null
      }
    }
  })
  const sessions: ManagementSessionSource = Object.freeze({
    identities,
    /** 只返回 PR69 所需的当前安全引用和摘要，原 cookie/CSRF 不进入返回 DTO。 */
    async resolveCookie(rawCookie, signal) {
      try {
        const proof = required(rawCookie, signal)
        return Object.freeze({
          caller: proof.lease.session.caller,
          session_ref: proof.lease.session.management_session_ref,
          expires_at: proof.lease.session.expires_at,
          csrf_sha256: proof.lease.csrf_sha256!
        })
      } catch {
        return null
      }
    }
  })

  return Object.freeze({
    identities,
    sessions,
    /** 显式本机用户动作先验证既有管理员，再只交付一次随机秘密；重入不会晚注册或续期。 */
    bootstrap(input: ManagementSessionLease, options: ManagementBootstrapOptions = {}): ManagementSessionBootstrap {
      try {
        const signal = options.signal
        const rotate = options.rotate
        const at = time()
        if (
          signal?.aborted ||
          !data(input, ['caller', 'management_session_ref', 'issued_at', 'expires_at']) ||
          !data(input.caller, ['principal_id']) ||
          !Number.isSafeInteger(input.issued_at) ||
          input.issued_at < 0 ||
          !Number.isSafeInteger(input.expires_at) ||
          input.expires_at <= input.issued_at ||
          input.issued_at > at ||
          input.expires_at <= at
        ) {
          throw new GatewayError('unauthenticated')
        }
        const caller = Object.freeze({ principal_id: reference(input.caller.principal_id) })
        const sessionRef = reference(input.management_session_ref)
        const name = key(caller, sessionRef)
        const existing = leases.get(name)
        const previousCookie = existing?.cookie_sha256
        const previousRevoked = existing?.revoked
        const previousExpiry = existing?.expiry_only
        let lease = existing
        if (lease && options.reauthenticate === true) {
          // 只有重新验证的独立上游证明可轮换本地到期窗口；显式撤销/政策失效的墓碑不可恢复。
          if (
            (lease.revoked && !lease.expiry_only) ||
            at < lease.session.expires_at ||
            input.issued_at !== lease.upstream.issued_at ||
            input.expires_at !== lease.upstream.expires_at
          ) {
            throw new GatewayError('unauthenticated')
          }
          const session = Object.freeze({
            ...lease.upstream,
            expires_at: Math.min(lease.upstream.expires_at, at + 300_000)
          })
          try {
            base(session, lease.policy)
          } catch {
            invalidate(lease)
            throw new GatewayError('unauthenticated')
          }
          lease = { ...lease, session, revoked: false, expiry_only: false }
        } else if (lease) {
          // 页面首次交付仍拒绝隐式旋转；恢复由已认证页面交付缓存负责。
          if (rotate === false) {
            throw new GatewayError('unauthenticated')
          }
          resolve(lease)
          if (input.issued_at !== lease.session.issued_at || input.expires_at < lease.session.expires_at) {
            throw new GatewayError('unauthenticated')
          }
        } else {
          const session = Object.freeze({
            caller,
            management_session_ref: sessionRef,
            issued_at: input.issued_at,
            expires_at: Math.min(input.expires_at, at + 300_000)
          })
          const current = base(session)
          if (leases.has(name) || leases.size >= capacity) {
            throw new GatewayError('unauthenticated')
          }
          lease = {
            name,
            session,
            policy: current.administrator.policy_revision,
            cookie_sha256: undefined,
            csrf_sha256: undefined,
            revoked: false,
            expiry_only: false,
            upstream: Object.freeze({
              caller,
              management_session_ref: sessionRef,
              issued_at: input.issued_at,
              expires_at: input.expires_at
            })
          }
        }
        const cookie = randomBytes(32).toString('base64url')
        const csrf = randomBytes(32).toString('base64url')
        if (
          time() >= lease.session.expires_at ||
          lease.revoked ||
          signal?.aborted ||
          closed ||
          leases.get(name) !== existing ||
          (existing &&
            (existing.cookie_sha256 !== previousCookie ||
              existing.revoked !== previousRevoked ||
              existing.expiry_only !== previousExpiry)) ||
          (!existing && leases.size >= capacity)
        ) {
          throw new GatewayError('unauthenticated')
        }
        if (lease.cookie_sha256) {
          cookies.delete(lease.cookie_sha256)
        }
        lease.cookie_sha256 = digest(cookie)
        lease.csrf_sha256 = digest(csrf)
        leases.set(name, lease)
        cookies.set(lease.cookie_sha256, lease)
        return Object.freeze({ ...lease.session, cookie, csrf })
      } catch {
        throw new GatewayError('unauthenticated')
      }
    },
    /** 显式撤销只作用于已绑定原引用，未知引用不能挤占容量或创建管理身份。 */
    revoke(caller: CallerIdentity, sessionRef: string): void {
      const lease = leases.get(key(caller, sessionRef))
      if (lease) {
        invalidate(lease)
      }
    },
    /** 真正 cookie 进入受信管理作用域；await 后交付前再次验证，结束即撤销逃逸任务能力。 */
    async runAuthenticated<T>(rawCookie: string, signal: AbortSignal, operation: () => T | Promise<T>): Promise<T> {
      const proof = required(rawCookie, signal)
      const context = { proof, active: true }
      return scope.run(
        context,
        /** 本次操作结束的 finally 会封闭所有继承同一 ALS 的后代。 */ async () => {
          try {
            const result = await operation()
            resolve(proof.lease, proof.cookie_sha256)
            if (signal.aborted || !context.active || scope.getStore() !== context) {
              throw new GatewayError('unauthenticated')
            }
            return result
          } finally {
            context.active = false
          }
        }
      )
    },
    /** 每次 custody 审批重读当前原身份、租期、cookie 代次与请求有效性。 */
    current(): CurrentManagementSession {
      const active = scope.getStore()
      if (!active?.active || active.proof.signal.aborted) {
        throw new GatewayError('unauthenticated')
      }
      const current = resolve(active.proof.lease, active.proof.cookie_sha256)
      if (!active.active || active.proof.signal.aborted || scope.getStore() !== active) {
        throw new GatewayError('unauthenticated')
      }
      return { ...current, wait_signal: active.proof.signal }
    },
    close
  })
}
