// 解析固定 CLI 命令并调用显式角色宿主；缺后端明确拒绝，标准输出与诊断通道分离。
import type { Readable, Writable } from 'node:stream'
import type { GatewayService, StdioCallerProvider } from '../mcp/types.js'
import { PRODUCT_VERSION } from '../mcp/version.js'
import {
  CLI_ERROR_CODES,
  CliError,
  configTemplate,
  readConfig,
  type ConnectorConfig,
  type GatewayConfig
} from './config.js'

export const HELP = `Rovloom ${PRODUCT_VERSION} — 内部技术预览

用法：
  rovloom --help
  rovloom --version
  rovloom config template gateway|connector
  rovloom config check --config /absolute/protected/config.json
  rovloom gateway --config /absolute/protected/config.json
  rovloom connector --config /absolute/protected/config.json

配置文件及所在目录须由当前 POSIX 用户持有，权限分别为 0600/0700。
模板只含非秘密引用；不接受 argv secret、URL 凭据、动态模块或任意 shell RPC。
Gateway stdout 仅用于 MCP。当前独立入口尚未接入生产后端，启动明确返回 backend_unavailable。
宿主可通过 CliRuntime 注入已验证服务与本机 caller；不开放配对、凭据签发或账号注册命令。
退出码：0 成功/正常关闭，2 参数或配置错误，3 后端不可用，1 运行或关闭失败。
`

export type RunningConnector = {
  closed: Promise<void>
  // 释放本地宿主资源并报告关闭失败，不伪造原生取消结果。
  close(): Promise<void>
}
export type GatewayRuntime = {
  service: GatewayService
  caller: StdioCallerProvider
  // 在前端关闭后释放宿主拥有的资源，保留可能已送达工作的历史证据。
  close(): Promise<void>
}
// 宿主负责单 writer、transport/native 接线、配置来源和资源释放；不从配置加载可执行模块。
export type CliRuntime = {
  // 建立受信服务及 caller 绑定并交出资源所有权；未提供时角色启动明确拒绝。
  gateway?: (config: GatewayConfig) => Promise<GatewayRuntime>
  // 启动受信出站宿主并返回其生命周期；具体认证和传输不由 CLI 补造。
  connector?: (config: ConnectorConfig) => Promise<RunningConnector>
}
export type CliIo = { stdin: Readable; stdout: Writable; stderr: Writable; signal: AbortSignal }
type Command =
  | { action: 'help' | 'version' }
  | { action: 'template'; role: 'gateway' | 'connector' }
  | { action: 'check' | 'gateway' | 'connector'; path: string }

// 解析固定命令形状，未知参数只返回稳定错误，不回显 argv。
export function parseCommand(args: readonly string[]): Command {
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
  if (args.length === 4 && args[0] === 'config' && args[1] === 'check' && args[2] === '--config') {
    return { action: 'check', path: args[3]! }
  }
  if (args.length === 3 && (args[0] === 'gateway' || args[0] === 'connector') && args[1] === '--config') {
    return { action: args[0], path: args[2]! }
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
export async function runCli(args: readonly string[], io: CliIo, runtime: CliRuntime = {}): Promise<number> {
  try {
    const command = parseCommand(args)
    if (command.action === 'help') {
      io.stderr.write(HELP)
      return 0
    }
    if (command.action === 'version') {
      io.stderr.write(`Rovloom ${PRODUCT_VERSION}\n`)
      return 0
    }
    if (command.action === 'template') {
      io.stdout.write(JSON.stringify(configTemplate(command.role), null, 2) + '\n')
      return 0
    }
    if (!('path' in command)) {
      throw new CliError('invalid_arguments')
    }
    const config = readConfig(command.path)
    if (command.action === 'check') {
      io.stderr.write('config_valid\n')
      return 0
    }
    if (config.role !== command.action) {
      throw new CliError('config_role_mismatch')
    }
    if (io.signal.aborted) {
      return 0
    }
    if (config.role === 'connector') {
      if (!runtime.connector) {
        throw new CliError('backend_unavailable', 3)
      }
      await untilStopped(await runtime.connector(config), io.signal)
      return 0
    }
    if (!runtime.gateway) {
      throw new CliError('backend_unavailable', 3)
    }
    const gateway = await runtime.gateway(config)
    try {
      // 仅在真实Gateway宿主建立后加载stdio；help、版本、配置和缺后端拒绝保持轻量。
      const { startStdioFacade } = await import('../mcp/stdio.js')
      const stdio = await startStdioFacade({
        service: gateway.service,
        caller: gateway.caller,
        stdin: io.stdin,
        stdout: io.stdout,
        diagnostic: /* 只把受限诊断码写入 stderr，保持 Gateway stdout 专用于协议。 */ (code) =>
          io.stderr.write(code + '\n')
      })
      await untilStopped(stdio, io.signal)
    } finally {
      await gateway.close()
    }
    return 0
  } catch (error) {
    if (error instanceof CliError && CLI_ERROR_CODES.includes(error.code)) {
      // 错误只由固定代码组成，绝不打印 argv、配置内容、异常 message 或 stack。
      io.stderr.write(error.code + '\n')
      return error.exitCode
    }
    io.stderr.write('runtime_failed\n')
    return 1
  }
}
