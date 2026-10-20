// 解析固定 CLI 命令并调用显式角色宿主；缺后端明确拒绝，标准输出与诊断通道分离。
import type { Readable, Writable } from 'node:stream'
import type { GatewayService } from '../mcp/types.js'
import type { HttpAuthenticationProvider } from '../mcp/http.js'
import type { ServiceCommandHost } from '../service/command.js'
import type { CliUpdateHost } from './update.js'
import { ServiceError } from '../service/types.js'
import { PRODUCT_VERSION } from '../mcp/version.js'
import { resolveRoleConfigPath, type ConfigPathEnvironment } from './config-path.js'
import { serviceDiagnostic } from './service-output.js'
import { readOrCreateRoleConfig } from './first-config.js'
import { readRuntimeConfig } from './runtime-config.js'
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

export const HELP = `Rovloom ${PRODUCT_VERSION} — 内部技术预览

用法：
  rovloom --help
  rovloom --version
  rovloom config template gateway|connector
  rovloom config check [--role gateway|connector] [--config /absolute/path/config.json]
  rovloom config check-runtime [--role gateway|connector] [--config /absolute/path/config.json]
  rovloom gateway [--config /absolute/path/config.json]
  rovloom connector [--config /absolute/path/config.json]
  rovloom service --help
  rovloom update --check
  rovloom update --help

省略 --config 时分别读取 ~/.config/rovloom/gateway.json 或 connector.json；Windows 同样使用用户 home。
角色文件读取、首次生成及Gateway运行支持Linux/macOS/Windows；原生Connector和首次配对审批仍要求Linux。
显式 --config 优先。角色首次缺失配置时生成单份默认配置，不覆盖已有文件；无法确定home返回config_home_unavailable。
文件访问沿用操作系统权限；新建时使用默认权限，不修改已有文件及目录的权限。
各角色默认配置与用户配置是同一份文件；check省略路径时读取所选role的默认文件。
check既无role也无路径时分别检查两份；检查始终只读，不为缺失文件生成默认值。
模板只含分组业务参数；不接受 argv secret、URL 凭据、动态模块或任意 shell RPC。
check-runtime核对单份角色配置及程序管理状态，不读取凭据或宣称原生Agent就绪。
Gateway 持续提供 Streamable HTTP MCP；客户端退出不停止服务，stdout 不承载 MCP 协议。
Gateway使用HTTP/WS及唯一双库；用户不维护runtime/ref/证书文件，WSS客户端保持系统证书验证。
Linux真实本地TTY可批准Gateway一次性配对，并由Connector输入地址/隐藏码、持久保存身份及发现初始化Luvus。
首次引导仅接入一个Luvus provider；Herdr引导、Agent模型认证与已有配置恢复管理仍未接通。
非TTY缺地址/身份/provider时返回configuration_required；不读取stdin，不假报Agent或模型就绪。
service 操作须注入受信监管宿主；默认配置仅由其已验证身份 resolver 提供，不猜测提权前用户。
update只检查官方稳定发行；当前预发行版本按SemVer比较，缺少安全替换事务不能报告升级成功。
角色退出码：0 成功/正常关闭，2 参数或配置错误，3 后端不可用，1 运行或关闭失败。
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
  update?: CliUpdateHost
  // 只在角色启动调用本机引导；help/check/template不创建状态或读取stdin。
  prepare?(config: GatewayConfig | ConnectorConfig, path: string, io: CliIo): Promise<GatewayConfig | ConnectorConfig>
  // 建立受信服务及 caller 绑定并交出资源所有权；未提供时角色启动明确拒绝。
  gateway?: (config: GatewayConfig) => Promise<GatewayRuntime>
  // 启动受信出站宿主并返回其生命周期；具体认证和传输不由 CLI 补造。
  connector?: (config: ConnectorConfig) => Promise<RunningConnector>
}
export type CliIo = { stdin: Readable; stdout: Writable; stderr: Writable; signal: AbortSignal }
type Command =
  | { action: 'help' | 'version' }
  | { action: 'template'; role: 'gateway' | 'connector' }
  | { action: 'check' | 'check-runtime'; checks: readonly { role?: 'gateway' | 'connector'; path: string }[] }
  | { action: 'gateway' | 'connector'; path: string }

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
  if (
    (args[0] === 'gateway' || args[0] === 'connector') &&
    (args.length === 1 || (args.length === 3 && args[1] === '--config'))
  ) {
    return { action: args[0], path: resolveRoleConfigPath(args[0], args[2], environment) }
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
    if (args[0] === 'update') {
      const { runUpdateCommand } = await import('./update.js')
      return await runUpdateCommand(
        args,
        /* 更新状态仅进入固定stderr边界。 */ (text) => io.stderr.write(text),
        runtime.update,
        io.signal
      )
    }
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
          ? /* 仅统一共享helper的明确身份缺失；其它宿主故障保留失败语义。 */ (role) => {
              try {
                return host.resolveDefaultConfig!(role)
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
    config = (await runtime.prepare?.(config, command.path, io)) ?? config
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
    do {
      reload = false
      const gateway = await runtime.gateway(config)
      try {
        // 只有宿主建立后才加载HTTP SDK；stdin EOF和客户端断开均不结束Gateway。
        const { startHttpFacade } = await import('../mcp/http.js')
        const http = startHttpFacade({
          service: gateway.service,
          authentication: gateway.authentication,
          hostname: config.mcp_hostname,
          port: config.mcp_port,
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
