// 定义双角色无密钥配置及严格只读加载边界；不解析凭据、不创建状态或连接。
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { dirname, posix, win32 } from 'node:path'
import { userInfo } from 'node:os'
import { canonical } from '../contracts.js'
import { parseNativeJson } from '../native-contract/json.js'

export type GatewayConfig = Readonly<{
  schema_version: 1
  role: 'gateway'
  state_dir: string
  mcp: 'http'
  mcp_hostname: '127.0.0.1' | '::1'
  mcp_port: number
  authentication_ref: string
}>
export type ConnectorConfig = Readonly<{
  schema_version: 1
  role: 'connector'
  state_dir: string
  gateway_url: string
  provider_config_refs: readonly string[]
}>
export type RoleConfig = GatewayConfig | ConnectorConfig

export const CLI_ERROR_CODES = [
  'invalid_config',
  'invalid_config_path',
  'config_platform_unsupported',
  'config_not_protected',
  'config_unreadable',
  'config_not_found',
  'config_home_unavailable',
  'invalid_arguments',
  'config_role_mismatch',
  'backend_unavailable'
] as const
export class CliError extends Error {
  // 仅保存稳定错误码和退出码，异常文本不携带配置或路径。
  constructor(
    readonly code: (typeof CLI_ERROR_CODES)[number],
    readonly exitCode = 2
  ) {
    super('Rovloom command failed')
    this.name = 'CliError'
  }
}

// 统一拒绝非法配置，避免将输入值混入错误消息。
function fail(): never {
  throw new CliError('invalid_config')
}

// 只接纳规范绝对路径和有界文本；实际目录信任由宿主建立。
function fixedPath(value: unknown, platform: NodeJS.Platform = process.platform): value is string {
  const paths = platform === 'win32' ? win32 : posix
  return (
    typeof value === 'string' &&
    value.length <= 4096 &&
    !Array.from(value).some(
      /* 识别控制字符，防止路径携带不可见的日志或解析分隔符。 */ (char) =>
        char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
    ) &&
    paths.isAbsolute(value) &&
    paths.normalize(value) === value &&
    paths.parse(value).root !== value
  )
}

// 限制引用为非秘密标识符，不把路径或 URI 当作本机配置引用。
function ref(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
}

// 只接纳无凭据的 WSS origin，端点路径仍由受信宿主固定。
function gatewayUrl(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    value.includes('\\') ||
    Array.from(value).some(
      /* 拒绝 URL 中的空白和控制字符，避免规范化掩盖原输入。 */ (char) =>
        char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127
    )
  ) {
    return false
  }
  try {
    const url = new URL(value)
    // 连接地址只能是无凭据 WSS origin；endpoint 路径由受信 transport 宿主固定。
    return (
      url.protocol === 'wss:' &&
      !!url.hostname &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/' &&
      (value === url.origin || value === url.origin + '/')
    )
  } catch {
    return false
  }
}

// 创建独立配置快照并检查角色字段、路径和引用，不创建任何状态。
export function parseConfig(value: unknown, platform: NodeJS.Platform = process.platform): RoleConfig {
  let snapshot: Record<string, unknown>
  try {
    snapshot = JSON.parse(canonical(value)) as Record<string, unknown>
  } catch {
    return fail()
  }
  if (
    !snapshot ||
    Array.isArray(snapshot) ||
    snapshot.schema_version !== 1 ||
    !fixedPath(snapshot.state_dir, platform)
  ) {
    return fail()
  }
  if (snapshot.role === 'gateway') {
    const allowed = ['schema_version', 'role', 'state_dir', 'mcp', 'mcp_hostname', 'mcp_port', 'authentication_ref']
    if (
      Object.keys(snapshot).length !== allowed.length ||
      Object.keys(snapshot).some(
        /* 识别 Gateway 配置中未声明的字段，拒绝额外身份或秘密参数。 */ (key) => !allowed.includes(key)
      ) ||
      snapshot.mcp !== 'http' ||
      !['127.0.0.1', '::1'].includes(snapshot.mcp_hostname as string) ||
      !Number.isSafeInteger(snapshot.mcp_port) ||
      (snapshot.mcp_port as number) < 1 ||
      (snapshot.mcp_port as number) > 65_535 ||
      !ref(snapshot.authentication_ref)
    ) {
      return fail()
    }
    return Object.freeze(snapshot) as GatewayConfig
  }
  if (snapshot.role === 'connector') {
    const allowed = ['schema_version', 'role', 'state_dir', 'gateway_url', 'provider_config_refs']
    const refs = snapshot.provider_config_refs
    if (
      Object.keys(snapshot).length !== allowed.length ||
      Object.keys(snapshot).some(
        /* 识别 Connector 配置中未声明的字段，保持角色配置严格分离。 */ (key) => !allowed.includes(key)
      ) ||
      !gatewayUrl(snapshot.gateway_url) ||
      !Array.isArray(refs) ||
      refs.length > 32 ||
      refs.some(/* 逐项检查 provider 引用，防止混入本地路径或任意模块入口。 */ (entry) => !ref(entry)) ||
      new Set(refs).size !== refs.length
    ) {
      return fail()
    }
    Object.freeze(refs)
    return Object.freeze(snapshot) as ConnectorConfig
  }
  return fail()
}

// 生成经过同一校验器检查的无密钥角色模板。
export function configTemplate(
  role: 'gateway' | 'connector',
  platform: NodeJS.Platform = process.platform
): RoleConfig {
  const base = platform === 'win32' ? 'C:\\absolute\\protected\\rovloom' : '/absolute/protected/rovloom'
  const paths = platform === 'win32' ? win32 : posix
  return parseConfig(
    role === 'gateway'
      ? {
          schema_version: 1,
          role,
          state_dir: paths.join(base, 'gateway'),
          mcp: 'http',
          mcp_hostname: '127.0.0.1',
          mcp_port: 9444,
          authentication_ref: 'mcp-http'
        }
      : {
          schema_version: 1,
          role,
          state_dir: paths.join(base, 'connector'),
          gateway_url: 'wss://localhost:9443',
          provider_config_refs: []
        },
    platform
  )
}

// 共用有界私有JSON读取边界；重复键、非法编码和非regular文件均拒绝，不加载模块或身份。
export function readProtectedJson(path: string): unknown {
  if (!fixedPath(path)) {
    throw new CliError('invalid_config_path')
  }
  let fd: number | undefined
  try {
    const os = userInfo()
    if (process.platform === 'win32' || os.uid < 0) {
      throw new CliError('config_platform_unsupported')
    }
    const parent = lstatSync(dirname(path))
    if (!parent.isDirectory() || parent.uid !== os.uid || (parent.mode & 0o077) !== 0) {
      throw new CliError('config_not_protected')
    }
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.uid !== os.uid || (stat.mode & 0o077) !== 0 || stat.size > 16_384) {
      throw new CliError('config_not_protected')
    }
    // 按 descriptor 有界读取，避免读取过程中增长的文件耗尽内存。
    const buffer = Buffer.alloc(16_385)
    const length = readSync(fd, buffer, 0, buffer.length, 0)
    if (length > 16_384) {
      throw new CliError('invalid_config')
    }
    const parsed = parseNativeJson(buffer.subarray(0, length), {
      object_bytes: 16_384,
      object_depth: 16,
      object_nodes: 4096
    })
    if (!parsed.ok) {
      throw new CliError('invalid_config')
    }
    return parsed.value
  } catch (error) {
    if (error instanceof CliError) {
      throw error
    }
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CliError('config_not_found')
    }
    throw new CliError('config_unreadable')
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
    }
  }
}

// 读取受保护角色配置后继续执行精确字段校验，不从文件扩张宿主能力。
export function readConfig(path: string): RoleConfig {
  return parseConfig(readProtectedJson(path))
}
