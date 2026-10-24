// 解析固定 CLI 命令并调用显式角色宿主；缺后端明确拒绝，标准输出与诊断通道分离。
import type { Readable, Writable } from 'node:stream'
import type { GatewayService } from '../mcp/types.js'
import type { HttpAuthenticationProvider } from '../mcp/http.js'
import type { ServiceCommandHost } from '../service/command.js'
import { ServiceError } from '../service/types.js'
import { PRODUCT_VERSION } from '../mcp/version.js'
import { resolveRoleConfigPath, type ConfigPathEnvironment } from './config-path.js'
import { serviceDiagnostic } from './service-output.js'
import { readOrCreateRoleConfig } from './first-config.js'
import { readRuntimeConfig } from './runtime-config.js'
import { isWildcardHostname } from '../mcp/listen.js'
import {
  CLI_ERROR_CODES,
  CliCancelled,
  CliError,
  configTemplate,
  configDocument,
  readConfig,
  type ConnectorConfig,
  type GatewayConfig
} from './config.js'

const WILDCARD_LISTEN_WARNING =
  'wildcard_listener\nMCP/management listen on all interfaces over plain HTTP; protect them with a firewall or a TLS reverse proxy.\nMCP/管理页监听所有网卡且为明文 HTTP；请用防火墙或 TLS 反向代理收口。\n'

export const HELP = `Rovloom ${PRODUCT_VERSION}

用法：
  rovloom --help
  rovloom --version
  rovloom config template gateway|connector
  rovloom config init connector [--provider luvus|herdr|mixed] [--config /absolute/path/config.json]
  rovloom config init gateway [--container] [--config /absolute/path/config.json]
  rovloom config check [--role gateway|connector] [--config /absolute/path/config.json]
  rovloom config check-runtime [--role gateway|connector] [--config /absolute/path/config.json]
  rovloom gateway [--add-device | --repair-device] [--config /absolute/path/config.json] [--non-interactive]
  rovloom connector [--repair | --claim] [--config /absolute/path/config.json] [--non-interactive]
  rovloom service --help
  rovloom token --help
  rovloom doctor --help
  rovloom storage --help
  rovloom admin --help

gateway / connector 启动对应角色。首次运行时在真实本地终端完成一次性配对与原生安装批准；
在终端拒绝配对提示时，Gateway 保持未配对运行，可先运行 rovloom admin create 再从管理页完成首台配对；
--add-device 在已完成的引导之上再配对一台 Connector（沿用同一 MCP 凭据，授权随之扩大到新设备）；
--repair-device / --repair 重新配对已配对的同一设备（凭据丢失或泄漏），保留原生设置与 MCP 授权。
--claim 让未配对的 Connector 向运行中的 Gateway 在线认领管理员创建的配对申请（管理页核对码批准，Gateway 不停机）。
这四个选项需要真实本地终端，不可与 --non-interactive 合用。--non-interactive 关闭本地交互引导（服务以此运行）。
token 管理 MCP Bearer 令牌，admin 管理管理页管理员，service 管理开机服务；详见各自的 --help。
config check 只读检查配置文件；check-runtime 另核对程序管理的状态，不读取凭据。

省略 --config 时读取 ~/.config/rovloom/gateway.json 或 connector.json（Windows 同样使用用户 home）。
文件缺失时首次运行会生成默认配置，已有文件不会被覆盖或重置。
Gateway 支持 Linux/macOS/Windows；Connector 支持 Linux x64、Windows x64 与 macOS（x64 / arm64，仅附着已运行的 Herdr / Luvus）。
首次引导按 Connector 的 native.provider 选择 luvus（默认）、herdr 或 mixed。
Agent 与模型登录需独立准备；原生 ready 不代表模型已回复。
退出码：0 成功/正常关闭，2 参数或配置错误，3 后端不可用，1 运行或关闭失败。
`

export type RunningConnector = {
  closed: Promise<void>
  transport?: Pick<ReturnType<typeof import('../transport/connector.js').createConnector>, 'status'>
  // 释放本地宿主资源并报告关闭失败，不伪造原生取消结果。
  close(): Promise<void>
}
export type GatewayRuntime = {
  service: GatewayService
  authentication: HttpAuthenticationProvider
  closed?: Promise<void>
  setupRequired?: boolean
  reconfigure?: Promise<void>
  // 宿主可观察实际MCP地址以发布本机就绪状态；此回调不提供认证或权限。
  listening?(url: string): void | Promise<void>
  // 在前端关闭后释放宿主拥有的资源，保留可能已送达工作的历史证据。
  close(): Promise<void>
}
// 服务宿主提供真实监管器及已验证默认路径；诊断由唯一CLI固定写入stderr。
export type CliServiceHost = Omit<ServiceCommandHost, 'diagnostic'>
// 宿主负责单 writer、transport/native 接线、配置来源和资源释放；不从配置加载可执行模块。
export type CliRuntime = {
  service?: CliServiceHost
  // 只在角色启动调用本机引导；help/check/template不创建状态或读取stdin。
  prepare?(
    config: GatewayConfig | ConnectorConfig,
    path: string,
    io: CliIo,
    options?: CliPrepareOptions
  ): Promise<GatewayConfig | ConnectorConfig>
  // 建立受信服务及 caller 绑定并交出资源所有权；未提供时角色启动明确拒绝。
  gateway?: (config: GatewayConfig) => Promise<GatewayRuntime>
  // 启动受信出站宿主并返回其生命周期；具体认证和传输不由 CLI 补造。
  connector?: (config: ConnectorConfig) => Promise<RunningConnector>
}
// 已配对设备的重新配对：Gateway 用 --repair-device 签发新码，Connector 用 --repair 兑换。
// 加入下一台设备：Gateway 用 --add-device 在已完成的引导之上再签发一次配对。
export type CliPrepareOptions = { repair?: true; addDevice?: true; claim?: true }
export type CliIo = { stdin: Readable; stdout: Writable; stderr: Writable; signal: AbortSignal }
type Command =
  | { action: 'help' | 'version' }
  | { action: 'template'; role: 'gateway' | 'connector' }
  | { action: 'check' | 'check-runtime'; checks: readonly { role?: 'gateway' | 'connector'; path: string }[] }
  | {
      action: 'gateway' | 'connector'
      path: string
      nonInteractive?: true
      serviceId?: string
      repair?: true
      addDevice?: true
      claim?: true
    }

// 解析固定命令形状，未知参数只返回稳定错误，不回显 argv。
export function parseCommand(args: readonly string[], environment?: ConfigPathEnvironment): Command {
  if (args.length === 0 || (args.length === 1 && ['--help', '-h', 'help'].includes(args[0]!))) {
    return { action: 'help' }
  }
  if (args.length === 1 && args[0] === '--version') {
    return { action: 'version' }
  }
  if (args.length === 2 && ['gateway', 'connector'].includes(args[0]!) && args[1] === '--help') {
    return { action: 'help' }
  }
  if (
    args.length === 3 &&
    args[0] === 'config' &&
    args[1] === 'template' &&
    (args[2] === 'gateway' || args[2] === 'connector')
  ) {
    return { action: 'template', role: args[2] }
  }
  if (args[0] === 'config' && (args[1] === 'check' || args[1] === 'check-runtime')) {
    let role: 'gateway' | 'connector' | undefined
    let explicit: string | undefined
    for (let index = 2; index < args.length; index += 2) {
      const value = args[index + 1]
      if (value === undefined) {
        throw new CliError('invalid_arguments')
      }
      if (args[index] === '--role' && role === undefined && (value === 'gateway' || value === 'connector')) {
        role = value
      } else if (args[index] === '--config' && explicit === undefined) {
        explicit = value
      } else {
        throw new CliError('invalid_arguments')
      }
    }
    return {
      action: args[1],
      checks:
        role || explicit !== undefined
          ? [{ ...(role ? { role } : {}), path: explicit ?? resolveRoleConfigPath(role!, undefined, environment) }]
          : (['gateway', 'connector'] as const).map(
              /* 无歧义地逐个选择两份用户文件，不选择任一角色作为隐式默认。 */ (selected) => ({
                role: selected,
                path: resolveRoleConfigPath(selected, undefined, environment)
              })
            )
    }
  }
  const serviceId = args.at(-2) === '--service-id' ? args.at(-1) : undefined
  const serviceArgs = serviceId !== undefined ? args.slice(0, -2) : args
  const nonInteractive = serviceArgs.at(-1) === '--non-interactive'
  if (serviceId !== undefined && (!nonInteractive || !/^[a-f0-9]{64}$/u.test(serviceId))) {
    throw new CliError('invalid_arguments')
  }
  const withoutNonInteractive = nonInteractive ? serviceArgs.slice(0, -1) : serviceArgs
  // 重新配对标志只属于各自角色且必须交互：Gateway 是 --repair-device，Connector 是 --repair。
  const flag = withoutNonInteractive[1]
  const repair = withoutNonInteractive[0] === 'gateway' ? flag === '--repair-device' : flag === '--repair'
  const addDevice = withoutNonInteractive[0] === 'gateway' && flag === '--add-device'
  const claim = withoutNonInteractive[0] === 'connector' && flag === '--claim'
  if ((repair || addDevice || claim) && nonInteractive) {
    throw new CliError('invalid_arguments')
  }
  const roleArgs =
    repair || addDevice || claim
      ? [withoutNonInteractive[0]!, ...withoutNonInteractive.slice(2)]
      : withoutNonInteractive
  if (
    (roleArgs[0] === 'gateway' || roleArgs[0] === 'connector') &&
    (roleArgs.length === 1 || (roleArgs.length === 3 && roleArgs[1] === '--config'))
  ) {
    return {
      action: roleArgs[0],
      path: resolveRoleConfigPath(roleArgs[0], roleArgs[2], environment),
      ...(nonInteractive ? { nonInteractive: true } : {}),
      ...(serviceId ? { serviceId } : {}),
      ...(repair ? { repair: true as const } : {}),
      ...(addDevice ? { addDevice: true as const } : {}),
      ...(claim ? { claim: true as const } : {})
    }
  }
  throw new CliError('invalid_arguments')
}

// 等待角色结束或本地终止信号，最终释放桥接资源并传播关闭失败。
async function untilStopped(running: RunningConnector, signal: AbortSignal): Promise<void> {
  let wake!: () => void
  const stopped = new Promise<void>(
    /* 保存本地终止通知，供 AbortSignal 唤醒角色等待。 */ (resolve) => {
      wake = resolve
    }
  )
  signal.addEventListener('abort', wake, { once: true })
  try {
    if (!signal.aborted) {
      await Promise.race([running.closed, stopped])
    }
  } finally {
    signal.removeEventListener('abort', wake)
    await running.close()
  }
}

// 执行配置和角色分支；缺宿主明确拒绝，所有失败仅输出固定诊断。
export async function runCli(
  args: readonly string[],
  io: CliIo,
  runtime: CliRuntime = {},
  environment?: ConfigPathEnvironment
): Promise<number> {
  try {
    if (args[0] === 'service') {
      const { SERVICE_HELP, handleServiceCommand } = await import('../service/command.js')
      if (args.length === 2 && args[1] === '--help') {
        io.stderr.write(SERVICE_HELP)
        return 0
      }
      if (!runtime.service) {
        throw new CliError('backend_unavailable', 3)
      }
      const host = runtime.service
      const code = await handleServiceCommand(args, {
        ...host,
        resolveDefaultConfig: host.resolveDefaultConfig
          ? /* 仅统一共享helper的明确身份缺失；其它宿主故障保留失败语义。 */ (role, account) => {
              try {
                return host.resolveDefaultConfig!(role, account)
              } catch (error) {
                if (error instanceof CliError && error.code === 'config_home_unavailable') {
                  throw new ServiceError('config_path_required')
                }
                throw error
              }
            }
          : undefined,
        diagnostic: /* 重建固定错误或监管状态，畸形code/状态不会泄露到stderr。 */ (text) =>
          io.stderr.write(serviceDiagnostic(text))
      })
      if (code !== undefined) {
        return code
      }
      throw new CliError('invalid_arguments')
    }
    if (args[0] === 'admin') {
      const { handleAdminCommand } = await import('./admin-command.js')
      return await handleAdminCommand(args, io, environment)
    }
    if (args[0] === 'doctor' || args[0] === 'storage') {
      const { handleStorageCommand } = await import('./storage-command.js')
      return await handleStorageCommand(args, io, environment)
    }
    if (args[0] === 'token') {
      const { handleTokenCommand } = await import('./token-command.js')
      return await handleTokenCommand(args, io, environment)
    }
    if (args[0] === 'config' && args[1] === 'init') {
      const { initializeRoleConfig } = await import('./config-init.js')
      initializeRoleConfig(args, environment)
      io.stderr.write('config_ready\n')
      return 0
    }
    const command = parseCommand(args, environment)
    if (command.action === 'help') {
      io.stderr.write(HELP)
      return 0
    }
    if (command.action === 'version') {
      io.stderr.write(`Rovloom ${PRODUCT_VERSION}\n`)
      return 0
    }
    if (command.action === 'template') {
      io.stdout.write(JSON.stringify(configDocument(configTemplate(command.role)), null, 2) + '\n')
      return 0
    }
    if ('checks' in command) {
      let code = 0
      for (const selected of command.checks) {
        const prefix = command.checks.length > 1 ? selected.role + ' ' : ''
        try {
          const config = readConfig(selected.path)
          if (selected.role && config.role !== selected.role) {
            throw new CliError('config_role_mismatch')
          }
          if (command.action === 'check-runtime') {
            readRuntimeConfig(config)
          }
          io.stderr.write(prefix + (command.action === 'check' ? 'config_valid\n' : 'runtime_config_valid\n'))
        } catch (error) {
          if (!(error instanceof CliError) || !CLI_ERROR_CODES.includes(error.code)) {
            throw error
          }
          io.stderr.write(prefix + error.code + '\n')
          code = error.exitCode
        }
      }
      return code
    }
    if (!('path' in command)) {
      throw new CliError('invalid_arguments')
    }
    let config = readOrCreateRoleConfig(command.action, command.path, environment)
    if (config.role !== command.action) {
      throw new CliError('config_role_mismatch')
    }
    if (io.signal.aborted) {
      return 0
    }
    if (!command.nonInteractive) {
      config =
        (await runtime.prepare?.(config, command.path, io, {
          ...(command.repair ? { repair: true as const } : {}),
          ...(command.addDevice ? { addDevice: true as const } : {}),
          ...(command.claim ? { claim: true as const } : {})
        })) ?? config
    }
    if (config.role !== command.action) {
      throw new CliError('config_role_mismatch')
    }
    if (config.role === 'connector') {
      if (!config.gateway_url) {
        throw new CliError('configuration_required')
      }
      if (!runtime.connector) {
        throw new CliError('backend_unavailable', 3)
      }
      await untilStopped(await runtime.connector(config), io.signal)
      return 0
    }
    if (!runtime.gateway) {
      throw new CliError('backend_unavailable', 3)
    }
    let reload = false
    let warnedWildcard = false
    do {
      reload = false
      const gateway = await runtime.gateway(config)
      // 通配监听是明文 HTTP 暴露到所有网卡：提示一次，防护靠 Bearer/管理员密码与宿主机防火墙或 TLS 反代。
      if (
        !warnedWildcard &&
        (isWildcardHostname(config.mcp_hostname) ||
          (config.management_enabled && isWildcardHostname(config.management_hostname)))
      ) {
        warnedWildcard = true
        io.stderr.write(WILDCARD_LISTEN_WARNING)
      }
      try {
        // 只有宿主建立后才加载HTTP SDK；stdin EOF和客户端断开均不结束Gateway。
        const { startHttpFacade } = await import('../mcp/http.js')
        const http = startHttpFacade({
          service: gateway.service,
          authentication: gateway.authentication,
          hostname: config.mcp_hostname,
          port: config.mcp_port,
          ...(config.mcp_public_url ? { publicUrl: config.mcp_public_url } : {}),
          ...(config.mcp_lan ? { lan: true } : {}),
          diagnostic: /* 只把受限诊断码写入stderr，不输出凭据、URL或协议正文。 */ (code) => io.stderr.write(code + '\n')
        })
        try {
          await gateway.listening?.(http.url)
          if (gateway.setupRequired) {
            io.stderr.write(
              'gateway_listening ' +
                http.url +
                '\npairing_required\nGateway is running; complete local pairing and native setup before using an Agent.\nGateway 已启动；使用 Agent 前仍需完成本地配对和原生初始化。\n'
            )
          }
          await untilStopped(
            {
              closed: Promise.race([
                http.closed,
                ...(gateway.closed ? [gateway.closed] : []),
                ...(gateway.reconfigure
                  ? [
                      gateway.reconfigure.then(
                        /* 新配置提交后只唤醒本轮关闭，不复用旧provider或epoch。 */ () => {
                          reload = true
                        }
                      )
                    ]
                  : [])
              ]),
              close: http.close
            },
            io.signal
          )
        } finally {
          await http.close()
        }
      } finally {
        await gateway.close()
      }
    } while (reload && !io.signal.aborted)
    return 0
  } catch (error) {
    if (error instanceof CliCancelled && io.signal.aborted) {
      return 0
    }
    if (error instanceof CliError && CLI_ERROR_CODES.includes(error.code)) {
      // 错误只由固定代码组成，绝不打印 argv、配置内容、异常 message 或 stack。
      io.stderr.write(error.code + '\n')
      if (error.code === 'configuration_required') {
        io.stderr.write(
          'Setup requires a local terminal, a reachable Gateway, completed pairing and a compatible installed Luvus. Preserve uncertain setup state for owner review.\n初始化需本地终端、可达 Gateway、完整配对及兼容 Luvus 安装；结果不确定时保留原状态并由所有者核查。\n'
        )
      }
      return error.exitCode
    }
    io.stderr.write('runtime_failed\n')
    return 1
  }
}
