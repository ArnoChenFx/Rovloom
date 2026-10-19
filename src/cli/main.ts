#!/usr/bin/env bun
// 提供同一产物的双角色命令入口，将进程信号接到本地桥接关闭并设置退出码。
import { runCli } from './run.js'

const stop = new AbortController()
const onSignal = /* 将进程终止信号转换为前端关闭请求，不直接取消原生工作。 */ () => stop.abort()
process.once('SIGINT', onSignal)
process.once('SIGTERM', onSignal)
try {
  process.exitCode = await runCli(process.argv.slice(2), {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    signal: stop.signal
  })
} finally {
  process.off('SIGINT', onSignal)
  process.off('SIGTERM', onSignal)
}
