// 提供供现有 CLI 调用的最小 service parser 接缝，不建立第二可执行入口。
import { isRole, servicePlatform, validateSpec } from './spec.js'
import { ServiceManager } from './manager.js'
import { ServiceError, type ServiceAction, type ServicePlatform, type ServiceRequest } from './types.js'

const actions = new Set(['install', 'uninstall', 'start', 'restart', 'stop'])
export const SERVICE_HELP = `service install --role gateway|connector --executable ABS --config ABS --workdir ABS --user ACCOUNT
service uninstall|start|restart|stop --role gateway|connector
install registers boot startup without starting; uninstall disables, stops, then removes only this registration.
Windows requires --user S-1-5-19 (LocalService); stop/restart/uninstall may terminate the task.
`

// 对非 service 命令返回空，供 PR49 原 parser 继续处理；错误不回显参数。
export function parseServiceCommand(args: readonly string[], platform: ServicePlatform): ServiceRequest | undefined {
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
  if (!isRole(role) || options.size !== allowed.length) {
    throw new ServiceError('invalid_arguments')
  }
  if (action !== 'install') {
    return { action, role }
  }
  const spec = validateSpec({
    version: 1,
    role,
    platform,
    executable: options.get('--executable'),
    config: options.get('--config'),
    directory: options.get('--workdir'),
    account: options.get('--user')
  })
  return { action, role, spec }
}

export type ServiceCommandHost = {
  platform: string
  manager: ServiceManager
  // 诊断使用 stderr；输出固定错误码或非秘密监管状态，不污染 MCP stdout。
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
    const request = parseServiceCommand(args, servicePlatform(host.platform))!
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
    return code === 'invalid_arguments' ? 2 : code === 'backend_unavailable' || code === 'unsupported_platform' ? 3 : 1
  }
}
