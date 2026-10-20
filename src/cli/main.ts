#!/usr/bin/env bun
// 提供同一产物的双角色命令入口，将进程信号接到本地桥接关闭并设置退出码。
import { runCli } from './run.js'

const stop = new AbortController()
const onSignal = /* 将进程终止信号转换为前端关闭请求，不直接取消原生工作。 */ () => stop.abort()
process.once('SIGINT', onSignal)
process.once('SIGTERM', onSignal)
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
      gateway: /* 只有角色启动才加载静态工厂；help/version/template保持离线且不打开状态。 */ async (config) => {
        const { createProductSources } = await import('./product-sources.js')
        return (await import('./production.js')).createProductionCliRuntime(createProductSources()).gateway!(config)
      },
      connector: /* 真实provider负责既有配置与资源，CLI不提供native成功替身。 */ async (config) => {
        const { createProductSources } = await import('./product-sources.js')
        return (await import('./production.js')).createProductionCliRuntime(createProductSources()).connector!(config)
      }
    }
  )
} finally {
  process.off('SIGINT', onSignal)
  process.off('SIGTERM', onSignal)
}
