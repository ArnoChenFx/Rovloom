// 为真实SDK测试装配CLI、受保护本机caller和实际Store；身份政策仍为明确合成fixture，不连接原生或设备服务。
import { createLocalCallerProvider, createStoreCliRuntime, readConfig, runCli } from '../../src/cli/index.js'
import { policy } from './store-fixture.js'

const configPath = process.argv[2]!
const config = readConfig(configPath)
if (config.role !== 'gateway') {
  throw new Error('invalid isolated test role')
}
const runtime = createStoreCliRuntime({
  caller: createLocalCallerProvider(process.argv[3]!, config.caller_binding_ref),
  identities: {
    principal: /* 仅为合成alice提供现有tuple政策，文件绑定本身不创建权限。 */ (caller) =>
      caller.principal_id === 'alice' ? { id: 'alice', policy: policy() } : null,
    administrator: /* 本例没有独立管理员会话，不能因本机身份而升级。 */ () => null
  },
  localPolicies: /* 使用同一合成完整tuple集合，实际Store/Router执行当前授权。 */ () => policy(undefined, 'local_1')
})
const stop = new AbortController()
const onSignal = /* 仅结束前端与本机资源，不模拟原生取消或设备断开。 */ () => stop.abort()
process.once('SIGINT', onSignal)
process.once('SIGTERM', onSignal)
try {
  process.exitCode = await runCli(
    ['gateway', '--config', configPath],
    { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, signal: stop.signal },
    runtime
  )
} finally {
  process.off('SIGINT', onSignal)
  process.off('SIGTERM', onSignal)
}
