// 仅供SDK初始化失败清理测试的协议替身：拒绝revision并保持存活，等待父测试显式释放。
let buffer = ''
const keepAlive = setInterval(/* 保持自有进程存活，不能让stdin EOF代替真实关闭等待。 */ () => {}, 1000)
process.on('SIGTERM', /* 故意忽略首次终止，让测试能识别是否真正等待了SDK原关闭过程。 */ () => {})
process.on(
  'SIGUSR1',
  /* 只有父测试持有本进程pid并发出释放信号后，才清理计时器并退出。 */ () => {
    clearInterval(keepAlive)
    process.exit(0)
  }
)
process.stdin.on('end', /* 忽略EOF以制造可控的初始化失败关闭竞态；不访问任何backend。 */ () => {})
process.stdin.on(
  'data',
  /* 仅回应initialize，返回结构合法但不受支持的协议revision。 */ (chunk) => {
    buffer += chunk.toString()
    while (buffer.includes('\n')) {
      const newline = buffer.indexOf('\n')
      const request = JSON.parse(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
      if (request.method === 'initialize') {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              protocolVersion: '1900-01-01',
              capabilities: {},
              serverInfo: { name: 'synthetic-reject', version: '1' }
            }
          }) + '\n'
        )
      }
    }
  }
)
