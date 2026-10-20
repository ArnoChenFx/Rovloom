#!/usr/bin/env bun
// 提供同一产物的双角色命令入口，将进程信号接到本地桥接关闭并设置退出码。
import { runCli } from './run.js'
import type { CliRuntime } from './run.js'

const stop = new AbortController()
const onSignal = /* 将进程终止信号转换为前端关闭请求，不直接取消原生工作。 */ () => stop.abort()
process.once('SIGINT', onSignal)
process.once('SIGTERM', onSignal)
let runtime: CliRuntime | undefined
let setup: import('./setup-runtime.js').CliSetup | undefined
// 仅角色命令加载真实静态工厂和TTY引导；同一进程复用本机确认对象，重开不重复签发。
async function product(): Promise<CliRuntime> {
  if (!runtime) {
    const { createProductSources } = await import('./product-sources.js')
    const { CliSetup } = await import('./setup-runtime.js')
    setup = new CliSetup()
    runtime = (await import('./production.js')).createProductionCliRuntime(createProductSources(), setup)
  }
  return runtime
}
try {
  process.exitCode = await runCli(
    process.argv.slice(2),
    {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      signal: stop.signal
    },
    {
      prepare: /* CLI解析及真实配置核验后才准备当前角色，不影响help/check模板。 */ async (config, path, io) =>
        (await product()).prepare!(config, path, io),
      gateway: /* 只有角色启动才加载静态工厂；help/version/template保持离线且不打开状态。 */ async (config) => {
        return (await product()).gateway!(config)
      },
      connector: /* 真实provider负责既有配置与资源，CLI不提供native成功替身。 */ async (config) => {
        const running = await (await product()).connector!(config)
        setup?.observe(running)
        return running
      }
    }
  )
} finally {
  setup?.close()
  process.off('SIGINT', onSignal)
  process.off('SIGTERM', onSignal)
}
