// 先构建当前源码对应的离线原生执行器，再把全部测试与 JUnit 参数交给固定 Bun。
import { buildSchemaWorker } from './build-worker.mjs'

await buildSchemaWorker()
const args = process.argv.slice(2)
const isolated = args[0] === '--isolated'
if (isolated) {
  args.shift()
}
const child = Bun.spawn([process.execPath, '--no-env-file', 'test', './test', ...args], {
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
  env: { ...process.env, ...(isolated ? { ROVLOOM_TEST_ISOLATED_VALIDATOR: '1' } : {}) }
})
process.exit(await child.exited)
