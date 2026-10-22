// rovloom admin：管理页管理员的签发、列表与撤销；口令原值只在 create 时写入 stdout 一次，Gateway 热读，无需重启。
import type { Writable } from 'node:stream'
import { boundedJson, fields, object } from '../wire/index.js'
import { CLI_ERROR_CODES, CliError, readConfig, type GatewayConfig } from './config.js'
import { resolveRoleConfigPath, type ConfigPathEnvironment } from './config-path.js'
import { readRuntimeJson, runtimeReference } from './runtime-files.js'
import { readSetupJson, setupFileStamp, writeSetupFile } from './setup-files.js'
import {
  emptyManagement,
  issueAdmin,
  revokeAdmin,
  summarizeAdmins,
  type ManagementFile,
  DEFAULT_ADMIN_TTL_DAYS
} from './admin-registry.js'
import { REGISTRY_MAX_BYTES, parseRegistry } from './token-registry.js'

export const ADMIN_HELP = `用法：
  rovloom admin list [--config /absolute/path/gateway.json]
  rovloom admin create [--principal ID] [--ttl-days N] [--config /absolute/path/gateway.json]
  rovloom admin revoke [--principal ID] [--config /absolute/path/gateway.json]

管理页（默认 http://127.0.0.1:9445/）用 HTTP Basic 登录：用户名是管理员 ID（默认 admin），密码是 create 输出的口令。
口令原值只在 create 时写到 stdout 一次（Gateway 只保存 SHA-256 摘要）；其余信息写到 stderr。丢失口令就再 create 一次：
同名管理员被重新签发，旧口令与已登录的浏览器会话立即失效。revoke 删除管理员，同样立即生效。修改无需重启 Gateway。
管理员不能调用 MCP，也与 MCP 令牌、设备凭据互不通用；有效期默认 ${DEFAULT_ADMIN_TTL_DAYS} 天（1-365）。
需要先完成 Gateway 首次配对（此时才存在 MCP 调用方注册表）。
`

type Flags = { sub: string; config?: string; principal?: string; days?: number }

function parse(args: readonly string[]): Flags {
  const sub = args[1]
  if (!sub || !['list', 'create', 'revoke'].includes(sub)) {
    throw new CliError('invalid_arguments')
  }
  const flags: Flags = { sub }
  for (let index = 2; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (value === undefined) {
      throw new CliError('invalid_arguments')
    }
    if (name === '--config' && flags.config === undefined) {
      flags.config = value
    } else if (name === '--principal' && flags.principal === undefined) {
      flags.principal = value
    } else if (name === '--ttl-days' && flags.days === undefined && /^[0-9]{1,6}$/.test(value)) {
      flags.days = Number(value)
    } else {
      throw new CliError('invalid_arguments')
    }
  }
  const allowed: Record<string, readonly (keyof Flags)[]> = {
    list: [],
    create: ['principal', 'days'],
    revoke: ['principal']
  }
  for (const key of ['principal', 'days'] as const) {
    if (flags[key] !== undefined && !allowed[sub]!.includes(key)) {
      throw new CliError('invalid_arguments')
    }
  }
  return flags
}

/** 读取已有来源文件并做形状校验；缺失时返回空来源。Gateway 读取时还会做完整校验。 */
function loadManagement(path: string, port: number): { file: ManagementFile; exists: boolean } {
  const raw = readSetupJson(path)
  if (raw === undefined) {
    return { file: emptyManagement(port), exists: false }
  }
  const value = object(raw)
  fields(value, ['schema_version', 'kind', 'port', 'sessions', 'pairing_policy_refs'])
  if (
    value.schema_version !== 1 ||
    value.kind !== 'management-session-source' ||
    value.port !== port ||
    !Array.isArray(value.sessions)
  ) {
    throw new CliError('invalid_config')
  }
  return { file: value as unknown as ManagementFile, exists: true }
}

/** 在 Gateway 状态目录签发（或重新签发）一个管理员：先写调用方注册表再写来源文件；返回口令原值仅此一次。 */
export function writeAdminFiles(
  config: GatewayConfig,
  principal: string,
  at: number,
  days?: number
): { secret: string; expires_at: number } {
  const callersPath = runtimeReference(config.state_dir, 'mcp-callers')
  const managementPath = runtimeReference(config.state_dir, 'management')
  const callersStamp = setupFileStamp(callersPath)
  const callers = parseRegistry(readRuntimeJson(callersPath, REGISTRY_MAX_BYTES))
  const { file, exists } = loadManagement(managementPath, config.management_port)
  const stamp = exists ? setupFileStamp(managementPath) : undefined
  const issued = issueAdmin(callers, file, principal, at, days)
  // 先写注册表再写来源：中途失败至多留下无权限的占位主体，重跑 create 会替换它。
  writeSetupFile(callersPath, boundedJson(issued.callers, REGISTRY_MAX_BYTES), true, callersStamp)
  writeSetupFile(managementPath, boundedJson(issued.management, 65_536), exists, stamp)
  return { secret: issued.secret, expires_at: issued.expires_at }
}

/** 管理页的来源文件是否已存在（首次引导只在没有任何管理员记录时才自动创建）。 */
export function managementSourceExists(config: GatewayConfig): boolean {
  return readSetupJson(runtimeReference(config.state_dir, 'management')) !== undefined
}

/** 处理 admin 子命令并返回退出码；诊断只含固定错误码。 */
export async function handleAdminCommand(
  args: readonly string[],
  io: { stdout: Writable; stderr: Writable },
  environment?: ConfigPathEnvironment,
  now: () => number = Date.now
): Promise<number> {
  try {
    if (args.length === 2 && args[1] === '--help') {
      io.stderr.write(ADMIN_HELP)
      return 0
    }
    const flags = parse(args)
    const config = readConfig(resolveRoleConfigPath('gateway', flags.config, environment))
    if (config.role !== 'gateway' || !config.management_enabled) {
      throw new CliError(config.role !== 'gateway' ? 'config_role_mismatch' : 'invalid_arguments')
    }
    const callersPath = runtimeReference(config.state_dir, 'mcp-callers')
    const managementPath = runtimeReference(config.state_dir, 'management')
    const at = now()
    const principal = flags.principal ?? 'admin'
    if (flags.sub === 'create') {
      const issued = writeAdminFiles(config, principal, at, flags.days)
      io.stderr.write(
        'created administrator ' +
          principal +
          ' expires ' +
          new Date(issued.expires_at).toISOString() +
          '\nlogin at http://127.0.0.1:' +
          config.management_port +
          '/ with user "' +
          principal +
          '" and the password below (shown once)\n'
      )
      io.stdout.write(issued.secret + '\n')
      return 0
    }
    const callersStamp = setupFileStamp(callersPath)
    const callers = parseRegistry(readRuntimeJson(callersPath, REGISTRY_MAX_BYTES))
    const { file, exists } = loadManagement(managementPath, config.management_port)
    if (flags.sub === 'list') {
      for (const row of summarizeAdmins(file, at)) {
        io.stdout.write([row.principal, row.status, new Date(row.expires_at).toISOString()].join('\t') + '\n')
      }
      return 0
    }
    const stamp = exists ? setupFileStamp(managementPath) : undefined
    const revoked = revokeAdmin(callers, file, principal)
    writeSetupFile(managementPath, boundedJson(revoked.management, 65_536), true, stamp)
    writeSetupFile(callersPath, boundedJson(revoked.callers, REGISTRY_MAX_BYTES), true, callersStamp)
    io.stderr.write('revoked administrator ' + principal + '\n')
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
