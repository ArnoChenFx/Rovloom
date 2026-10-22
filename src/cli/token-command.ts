// rovloom token：管理 MCP Bearer 令牌注册表；令牌原值只在 create/rotate 时写入 stdout 一次。
import type { Writable } from 'node:stream'
import { boundedJson } from '../wire/index.js'
import { CLI_ERROR_CODES, CliError, readConfig } from './config.js'
import { resolveRoleConfigPath, type ConfigPathEnvironment } from './config-path.js'
import { readRuntimeJson, runtimeReference } from './runtime-files.js'
import { setupFileStamp, writeSetupFile } from './setup-files.js'
import {
  REGISTRY_MAX_BYTES,
  createCaller,
  parseRegistry,
  renewCaller,
  revokeCaller,
  rotateCaller,
  setDiscardPermission,
  summarize
} from './token-registry.js'
import type { CallerRegistry } from './token-registry.js'
import { isAdminPlaceholder } from './admin-registry.js'

export const TOKEN_HELP = `用法：
  rovloom token list [--config /absolute/path/gateway.json]
  rovloom token create --principal ID --like EXISTING_ID [--ttl-days N]
  rovloom token renew --principal ID [--ttl-days N]
  rovloom token rotate --principal ID [--ttl-days N] [--grace-minutes M]
  rovloom token revoke --principal ID
  rovloom token permissions --principal ID --discard-response true|false

令牌注册表位于 Gateway 状态目录；Gateway 每次认证重读，修改立即生效、无需重启。
create/rotate 把新令牌原值只写到 stdout 一次（注册表只保存 SHA-256 摘要）；其余信息写到 stderr。
create 的新主体权限克隆自 --like 指定的现有主体，不扩大权限。renew 延长到期时间、令牌不变。
rotate 签发新令牌；--grace-minutes 内旧令牌继续有效（默认 0，立即失效）。revoke 删除主体。
permissions 显式管理结果删除权限，热生效；默认关闭。删除结果前应先读取并保存所需内容。
ttl 默认 30 天（1-365）。
`

type Flags = {
  sub: string
  config?: string
  principal?: string
  like?: string
  days?: number
  grace?: number
  discard?: boolean
}

function parse(args: readonly string[]): Flags {
  const sub = args[1]
  if (!sub || !['list', 'create', 'renew', 'rotate', 'revoke', 'permissions'].includes(sub)) {
    throw new CliError('invalid_arguments')
  }
  const flags: Flags = { sub }
  for (let index = 2; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (value === undefined) {
      throw new CliError('invalid_arguments')
    }
    const number = () => {
      if (!/^[0-9]{1,6}$/.test(value)) {
        throw new CliError('invalid_arguments')
      }
      return Number(value)
    }
    if (name === '--config' && flags.config === undefined) {
      flags.config = value
    } else if (name === '--principal' && flags.principal === undefined) {
      flags.principal = value
    } else if (name === '--like' && flags.like === undefined) {
      flags.like = value
    } else if (name === '--discard-response' && flags.discard === undefined && ['true', 'false'].includes(value)) {
      flags.discard = value === 'true'
    } else if (name === '--ttl-days' && flags.days === undefined) {
      flags.days = number()
    } else if (name === '--grace-minutes' && flags.grace === undefined) {
      flags.grace = number()
    } else {
      throw new CliError('invalid_arguments')
    }
  }
  const allowed: Record<string, readonly (keyof Flags)[]> = {
    list: [],
    create: ['principal', 'like', 'days'],
    renew: ['principal', 'days'],
    rotate: ['principal', 'days', 'grace'],
    revoke: ['principal'],
    permissions: ['principal', 'discard']
  }
  const required: Record<string, readonly (keyof Flags)[]> = {
    list: [],
    create: ['principal', 'like'],
    renew: ['principal'],
    rotate: ['principal'],
    revoke: ['principal'],
    permissions: ['principal', 'discard']
  }
  for (const key of ['principal', 'like', 'days', 'grace', 'discard'] as const) {
    if (flags[key] !== undefined && !allowed[sub]!.includes(key)) {
      throw new CliError('invalid_arguments')
    }
  }
  if (required[sub]!.some(/* 缺少必填参数。 */ (key) => flags[key] === undefined)) {
    throw new CliError('invalid_arguments')
  }
  return flags
}

/** 本机 mcp-client 凭据文件若属于同一主体，随续期/轮换同步更新，已配置的本地客户端无需手工改。 */
function syncClientFile(
  stateDir: string,
  principal: string,
  token: string | undefined,
  issued: number,
  expires: number
) {
  const path = runtimeReference(stateDir, 'mcp-client')
  let current: Record<string, unknown>
  try {
    current = readRuntimeJson(path) as Record<string, unknown>
  } catch (error) {
    if (error instanceof CliError && error.code === 'backend_unavailable') {
      return
    }
    throw error
  }
  if (current.principal_id !== principal) {
    return
  }
  writeSetupFile(
    path,
    boundedJson({ ...current, ...(token ? { token } : {}), issued_at: issued, expires_at: expires }, 16_384),
    true
  )
}

/** 处理 token 子命令并返回退出码；诊断只含固定错误码。 */
export async function handleTokenCommand(
  args: readonly string[],
  io: { stdout: Writable; stderr: Writable },
  environment?: ConfigPathEnvironment,
  now: () => number = Date.now
): Promise<number> {
  try {
    if (args.length === 2 && args[1] === '--help') {
      io.stderr.write(TOKEN_HELP)
      return 0
    }
    const flags = parse(args)
    const config = readConfig(resolveRoleConfigPath('gateway', flags.config, environment))
    if (config.role !== 'gateway') {
      throw new CliError('config_role_mismatch')
    }
    const path = runtimeReference(config.state_dir, 'mcp-callers')
    const stamp = setupFileStamp(path)
    const registry: CallerRegistry = parseRegistry(readRuntimeJson(path, REGISTRY_MAX_BYTES))
    const at = now()
    let next: CallerRegistry | undefined
    let issued: string | undefined
    if (flags.sub === 'list') {
      // 管理页管理员在注册表里的占位主体没有任何 MCP 权限，由 rovloom admin 管理，不在这里列出。
      const placeholders = new Set(
        registry.callers.filter((entry) => isAdminPlaceholder(entry)).map((entry) => entry.principal.id)
      )
      for (const row of summarize(registry, at).filter((entry) => !placeholders.has(entry.principal))) {
        io.stdout.write(
          [row.principal, row.status, new Date(row.expires_at).toISOString(), row.rotating ? 'rotating' : '-'].join(
            '\t'
          ) + '\n'
        )
      }
      return 0
    }
    if (flags.sub === 'create') {
      const made = createCaller(registry, flags.principal!, flags.like!, at, flags.days)
      next = made.registry
      io.stderr.write('created ' + flags.principal + ' expires ' + new Date(made.expires_at).toISOString() + '\n')
      io.stdout.write(made.token + '\n')
    } else if (flags.sub === 'renew') {
      const renewed = renewCaller(registry, flags.principal!, at, flags.days)
      next = renewed.registry
      io.stderr.write('renewed ' + flags.principal + ' expires ' + new Date(renewed.expires_at).toISOString() + '\n')
    } else if (flags.sub === 'rotate') {
      const rotated = rotateCaller(registry, flags.principal!, at, { days: flags.days, graceMinutes: flags.grace })
      next = rotated.registry
      io.stderr.write('rotated ' + flags.principal + ' expires ' + new Date(rotated.expires_at).toISOString() + '\n')
      issued = rotated.token
      io.stdout.write(rotated.token + '\n')
    } else if (flags.sub === 'permissions') {
      next = setDiscardPermission(registry, flags.principal!, flags.discard!)
      io.stderr.write('permissions ' + flags.principal + ' discard_response=' + String(flags.discard) + '\n')
    } else {
      next = revokeCaller(registry, flags.principal!)
      io.stderr.write('revoked ' + flags.principal + '\n')
    }
    // 先落盘注册表（带字节代次，防并发编辑），再同步本机客户端凭据文件。
    writeSetupFile(path, boundedJson(next, REGISTRY_MAX_BYTES), true, stamp)
    if (flags.sub === 'renew' || flags.sub === 'rotate') {
      const entry = next.callers.find(/* 取目标主体的新到期。 */ (e) => e.principal.id === flags.principal)!
      syncClientFile(config.state_dir, flags.principal!, issued, entry.issued_at, entry.expires_at)
    }
    return 0
  } catch (error) {
    if (error instanceof CliError && CLI_ERROR_CODES.includes(error.code)) {
      io.stderr.write(error.code + '\n')
      return error.exitCode
    }
    io.stderr.write('runtime_failed\n')
    return 1
  }
}
