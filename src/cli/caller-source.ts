// 只读消费独立配置者已交付的caller和凭据摘要；不创建账户、签发凭据或保存秘密原值。
import { createHash, timingSafeEqual } from 'node:crypto'
import type { CallerIdentity, GatewayIdentitySource } from '../mcp/management.js'
import type { HttpAuthenticationProvider } from '../mcp/http.js'
import type { Principal } from '../router.js'
import type { ProviderPolicy } from '../wire/types.js'
import { boundedJson, fields, id, object, validatePolicies } from '../wire/index.js'
import { CliError } from './config.js'
import { readRuntimeJson } from './runtime-files.js'

type Caller = { principal: Principal; token_sha256: string; issued_at: number; expires_at: number }
type Source = { local_policy: ProviderPolicy; callers: Caller[] }

// 精确校验外部导出的现有身份及固定到期；配置本身不能声明authenticated或source_verified。
function parse(value: unknown, resource: string): Source {
  try {
    const source = object(value)
    fields(source, ['schema_version', 'kind', 'resource', 'local_policy', 'callers'])
    if (
      source.schema_version !== 1 ||
      source.kind !== 'mcp-caller-source' ||
      source.resource !== resource ||
      !Array.isArray(source.callers) ||
      !source.callers.length ||
      source.callers.length > 64
    ) {
      throw new Error('invalid_caller_source')
    }
    const local = source.local_policy as ProviderPolicy
    const principals = new Set<string>()
    const credentials = new Set<string>()
    for (const input of source.callers) {
      const caller = object(input)
      fields(caller, ['principal', 'token_sha256', 'issued_at', 'expires_at'])
      const principal = object(caller.principal)
      fields(principal, ['id', 'policy'])
      id(principal.id)
      if (
        !/^[a-zA-Z0-9_-]{1,128}$/.test(principal.id as string) ||
        typeof caller.token_sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(caller.token_sha256) ||
        !Number.isSafeInteger(caller.issued_at) ||
        (caller.issued_at as number) < 0 ||
        !Number.isSafeInteger(caller.expires_at) ||
        (caller.expires_at as number) <= (caller.issued_at as number) ||
        principals.has(principal.id as string) ||
        credentials.has(caller.token_sha256)
      ) {
        throw new Error('invalid_caller_source')
      }
      validatePolicies({ caller: principal.policy as ProviderPolicy, local })
      principals.add(principal.id as string)
      credentials.add(caller.token_sha256)
    }
    return source as unknown as Source
  } catch {
    throw new CliError('invalid_config')
  }
}

// 固定资源和配置代次的只读adapter；删除、替换内容、权限丢失或时钟回拨使本轮永久拒绝，重启才重载。
export function openCallerSource(
  path: string,
  resource: string,
  administrator?: GatewayIdentitySource['administrator']
) {
  const input = readRuntimeJson(path)
  const initial = boundedJson(input, 16_384)
  const source = parse(input, resource)
  let closed = false
  let observed = 0
  const time = /* 同步IO前后及最后交付都核对当前时间，回拨后不能靠新请求重置本轮高水位。 */ () => {
    const at = Date.now()
    if (closed || !Number.isSafeInteger(at) || at < observed) {
      closed = true
      throw new CliError('backend_unavailable', 3)
    }
    observed = at
    return at
  }
  const current = /* 每次认证、策略和身份读取均重新验证同一受保护来源，不缓存最近成功身份。 */ () => {
    try {
      time()
      if (boundedJson(readRuntimeJson(path), 16_384) !== initial) {
        throw new Error('caller_source_changed')
      }
      return time()
    } catch {
      closed = true
      throw new CliError('backend_unavailable', 3)
    }
  }
  const identities: GatewayIdentitySource = Object.freeze({
    // 只返回该来源中当前仍有效的既有主体，交付后不共享可变政策对象。
    principal(caller: CallerIdentity): Principal | null {
      try {
        const now = current()
        const found = source.callers.find(
          /* 既有凭据到期也撤去当前身份，旧MCP会话或长等待不能滑动续期。 */ (entry) =>
            entry.principal.id === caller.principal_id && now >= entry.issued_at && now < entry.expires_at
        )
        const principal = found ? structuredClone(found.principal) : null
        return found && time() < found.expires_at ? principal : null
      } catch {
        return null
      }
    },
    // 独立管理员回调前后都复验caller，回调中的同步撤权不能留下旧角色。
    administrator(caller: CallerIdentity, sessionRef: string) {
      // 普通caller文件没有管理角色；只消费独立宿主已验证的现有管理员来源。
      if (!identities.principal(caller) || !administrator) {
        return null
      }
      const admin = administrator(caller, sessionRef)
      return identities.principal(caller) ? admin : null
    }
  })
  const authentication: HttpAuthenticationProvider = Object.freeze({
    // 固定资源的bearer只比较既有摘要；信号、当前源和精确到期都必须仍有效。
    authenticate(request, signal) {
      if (signal.aborted || request.url !== resource) {
        return null
      }
      const authorization = request.headers.get('authorization')
      if (!authorization || !/^Bearer [A-Za-z0-9_-]{32,256}$/.test(authorization)) {
        return null
      }
      try {
        const now = current()
        const digest = createHash('sha256').update(authorization.slice(7)).digest()
        const found = source.callers.find(
          /* 摘要比较不反射credential；同一受保护文件固定唯一主体及原始到期。 */ (entry) =>
            timingSafeEqual(digest, Buffer.from(entry.token_sha256, 'hex')) &&
            now >= entry.issued_at &&
            now < entry.expires_at
        )
        return found && time() < found.expires_at && !signal.aborted
          ? Object.freeze({ principal_id: found.principal.id })
          : null
      } catch {
        return null
      }
    }
  })
  return Object.freeze({
    identities,
    authentication,
    localPolicies: /* 当前本机策略仍由同一受保护源持有，不从caller请求复制。 */ () => {
      current()
      return structuredClone(source.local_policy)
    },
    close: /* 关闭只撤销本轮读取能力，不删除外部身份或修改既有凭据。 */ () => {
      closed = true
    }
  })
}
