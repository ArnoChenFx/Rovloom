// 提供供现有 CLI 调用的最小 service parser 接缝，不建立第二可执行入口。
import { isRole, servicePlatform, validateSpec } from './spec.js'
import { ServiceManager } from './manager.js'
import {
  ServiceError,
  type ServiceAction,
  type ServicePlatform,
  type ServiceRequest,
  type ServiceRole
} from './types.js'

const actions = new Set(['install', 'uninstall', 'start', 'restart', 'stop'])
export const SERVICE_HELP = `service install --role gateway|connector [--executable ABS] [--config ABS] --workdir ABS --user ACCOUNT
service uninstall|start|restart|stop --role gateway|connector
install registers boot startup without starting; uninstall only revokes future boot startup and preserves running instances and their control records.
Omitted --executable uses the current standalone binary; a different binary is rejected.
Omitted --config uses the selected service account's verified home; unavailable identity requires explicit --config.
Linux uses systemd system units; macOS uses system LaunchDaemons; Windows uses boot-triggered tasks, not SCM services or login tasks.
Gateway services support Linux systemd and macOS system LaunchDaemons; local native Connector remains Linux x64. Windows product installation still fails closed with backend_unavailable.
Windows requires --user S-1-5-19 (LocalService); explicit stop/restart may terminate the task; uninstall never stops it.
`

export type ServiceConfigPathResolver = (role: ServiceRole, account: string) => string

// 对非 service 命令返回空，供 PR49 原 parser 继续处理；错误不回显参数。
export function parseServiceCommand(
  args: readonly string[],
  platform: ServicePlatform,
  resolveDefaultConfig?: ServiceConfigPathResolver,
  executable?: string
): ServiceRequest | undefined {
  if (args[0] !== 'service') {
    return undefined
  }
  const action = args[1] as ServiceAction
  if (!actions.has(action) || args.length % 2 !== 0) {
    throw new ServiceError('invalid_arguments')
  }
  const options = new Map<string, string>()
  const allowed = action === 'install' ? ['--role', '--executable', '--config', '--workdir', '--user'] : ['--role']
  for (let i = 2; i < args.length; i += 2) {
    const key = args[i]!
    const value = args[i + 1]!
    if (!allowed.includes(key) || options.has(key) || !value || value.startsWith('--')) {
      throw new ServiceError('invalid_arguments')
    }
    options.set(key, value)
  }
  const role = options.get('--role')
  if (
    !isRole(role) ||
    allowed.some(
      /* config 可由唯一 CLI 的受信路径 helper 解析，其余选项必须明确。 */ (key) =>
        key !== '--config' && !(key === '--executable' && executable) && !options.has(key)
    )
  ) {
    throw new ServiceError('invalid_arguments')
  }
  if (action !== 'install') {
    return { action, role }
  }
  const spec = validateSpec({
    version: 1,
    role,
    platform,
    executable: options.get('--executable') ?? executable,
    config: options.get('--config') ?? resolveDefaultConfig?.(role, options.get('--user')!) ?? missingConfig(),
    directory: options.get('--workdir'),
    account: options.get('--user')
  })
  return { action, role, spec }
}

// 没有可靠身份来源时要求明确路径，不根据环境变量猜测提升前用户。
function missingConfig(): never {
  throw new ServiceError('config_path_required')
}

export type ServiceCommandHost = {
  platform: string
  manager: ServiceManager
  // 生产宿主只提供当前单文件路径，不能由环境变量选择另一程序。
  executable?: string
  // 复用唯一 CLI 的已验证 home/角色默认路径 helper，不接收配置中的身份断言。
  resolveDefaultConfig?: ServiceConfigPathResolver
  // 诊断使用 stderr，仅输出固定错误码或非秘密监管状态；不把 stdout 当作 MCP transport。
  diagnostic(text: string): void
}

// 由唯一 CLI 在读角色配置前调用；未识别则返回 undefined，宿主保留原有控制流。
export async function handleServiceCommand(
  args: readonly string[],
  host: ServiceCommandHost
): Promise<number | undefined> {
  if (args[0] !== 'service') {
    return undefined
  }
  try {
    if (args.length === 2 && args[1] === '--help') {
      host.diagnostic(SERVICE_HELP)
      return 0
    }
    const request = parseServiceCommand(
      args,
      servicePlatform(host.platform),
      host.resolveDefaultConfig,
      host.executable
    )!
    host.diagnostic(JSON.stringify(await host.manager.execute(request)) + '\n')
    return 0
  } catch (error) {
    const code =
      error instanceof ServiceError
        ? error.code
        : error && typeof error === 'object' && 'code' in error && (error.code === 'EACCES' || error.code === 'EPERM')
          ? 'permission_denied'
          : 'system_command_failed'
    host.diagnostic(code + '\n')
    return code === 'invalid_arguments' || code === 'config_path_required'
      ? 2
      : code === 'backend_unavailable' || code === 'unsupported_platform'
        ? 3
        : 1
  }
}
