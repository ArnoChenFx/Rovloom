/** 自有真实验收的 stdio 宿主：复用生产角色与 MCP facade，显式通知结束后才回收本次资源。 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseArgs } from 'node:util'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createRuntimeMcpServer } from '../../../src/mcp/runtime.js'
import { herdrEnvironment } from '../../../src/connector/herdr/local.js'
import { createHerdrWorkflowHost } from './workflow-host.js'

const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    binary: { type: 'string' },
    report: { type: 'string' },
    opencode: { type: 'string' }
  }
})
for (const value of [values.root, values.binary, values.report]) {
  if (!value || !isAbsolute(value)) {
    throw new Error('absolute_owned_fixture_paths_required')
  }
}
const host = await createHerdrWorkflowHost({ root: values.root!, binary: values.binary! })
if (values.opencode) {
  // 官方 installer 只认 HOME/.config/opencode；仅为本次空白 HOME 安装真实事件插件。
  mkdirSync(join(host.config.home, '.config', 'opencode'), { recursive: true, mode: 0o700 })
  try {
    await promisify(execFile)(host.config.binary, ['integration', 'install', 'opencode'], {
      env: herdrEnvironment(host.config),
      cwd: host.config.cwd,
      timeout: 10_000,
      maxBuffer: 65_536
    })
  } catch {
    await host.close()
    throw new Error('owned_opencode_hook_install_failed')
  }
}
const server = createRuntimeMcpServer({
  runtime: host.runtime,
  caller: host.caller_identity,
  /** 只描述本次合成 caller 的唯一受保护目标。 */
  discover: () => [host.describe()]
})
let finishing: Promise<void> | undefined

/** fixture owner 显式结束，报告只写外部新文件；不是产品 MCP 管理或停止 Gateway 的工具。 */
function finish(): Promise<void> {
  finishing ??= /** 共享同一清理，避免 EOF 和结束通知同时释放资源。 */ (async () => {
    // 启动时已核验并固定的来源快照；结束时安装失效也不能阻断 owner 清理。
    const source = host.provider_ref.expected_source
    const cleanup = await host.close()
    writeFileSync(
      values.report!,
      JSON.stringify({
        cleanup,
        native_claims: host.claimCount(),
        source
      }) + '\n',
      { mode: 0o600, flag: 'wx' }
    )
    await server.close()
    process.stdin.pause()
  })()
  return finishing
}

/** 私有 fixture 生命周期通知不注册为产品工具，不包含 native 调用或权限捷径。 */
server.fallbackNotificationHandler = /** 私有通知只进入本次 owner 的显式清理。 */ async (notification) => {
  if (notification.method !== 'notifications/rovloom_fixture_finish') {
    throw new Error('unknown_fixture_notification')
  }
  await finish()
}
/** stdio 所属 owner 消失时仍尽力清理自己的唯一实例。 */
process.stdin.once('end', /** EOF 只清理所属资源，不产生新的原生调用权限。 */ () => void finish())
/** 只停止本次 fixture；不读取其它 PID 或会话。 */
process.once('SIGTERM', /** 信号与结束通知共享同一清理结果。 */ () => void finish())
/** fixture 异常仅向 stderr 给稳定码，避免原生输出或第三方凭据进入诊断。 */
server.onerror = /** 仅输出固定错误码。 */ () => process.stderr.write('owned_fixture_protocol_error\n')
await server.connect(new StdioServerTransport())
