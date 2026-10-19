// 只用于隔离更新验收的原生样例，不作为产品 CLI、服务或发行入口。
declare const UPDATE_PROBE_VERSION: string

if (process.argv[2] === '--version') {
  process.stderr.write(`Rovloom ${UPDATE_PROBE_VERSION}\n`)
} else if (process.argv[2] === '--fixture-service') {
  process.stdout.write(`fixture-ready:${UPDATE_PROBE_VERSION}\n`)
  const timer = setInterval(/* 自有进程样例保持运行，直到测试通过句柄请求退出。 */ () => {}, 1000)
  process.once(
    'SIGTERM',
    /* 只结束当前自有 fixture，不搜索其它进程。 */ () => {
      clearInterval(timer)
      process.exit(0)
    }
  )
} else {
  process.exitCode = 2
}
