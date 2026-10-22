// 请求本机 MCP 端点做健康检查；返回 401 表示认证监听已建立。
const port = Number(process.env.ROVLOOM_HEALTH_PORT ?? 9444)
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  process.exit(1)
}
try {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    signal: AbortSignal.timeout(3000),
    // 健康检查直连本机，不经过任何代理。
    proxy: ''
  })
  process.exit(res.status === 401 ? 0 : 1)
} catch {
  process.exit(1)
}
