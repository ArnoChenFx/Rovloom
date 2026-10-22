/** 手动量测：一次 runtime_call_get（结果句柄已存在）在 Gateway 事件循环上的同步耗时分布。
 * 用法：bun --no-env-file test/runtime/bench-call-get.ts；加 `--cpu-prof --cpu-prof-md` 可看热点。不进默认测试集。
 * 记录（Bun 1.4.3，Linux，本机）：优化前 p50 26 ms / p95 39 ms；能力快照规范 JSON 按对象缓存后 p50 10 ms；
 * 再加 SQLite 语句缓存后 p50 7 ms / p95 9 ms。其中 SQLite 读取本身约占 10%。
 */
import { RuntimeGatewayService } from '../../src/mcp/runtime-service.js'
import { runtimeFixture } from './helpers.js'
const f = await runtimeFixture()
await f.ready()
const admitted = await f.gateway.runAuthenticated(f.caller, () =>
  f.gateway.admit({
    target: f.target,
    native_request: { method: 'task.add', params: { title: 'prof' } },
    options: { binding_revision: 1, contract_ref: f.reference, deadline: f.state.store.clock() + 25_000 }
  })
)
await f.responded(admitted.call.call_id)
await f.gateway.runAuthenticated(f.caller, () => f.gateway.results.open(admitted.call.call_id))
const service = new RuntimeGatewayService(f.mcp)
const times: number[] = []
for (let i = 0; i < 400; i++) {
  const t = performance.now()
  await service.execute(
    'runtime_call_get',
    { call_id: admitted.call.call_id, wait_ms: 0 },
    { caller: f.caller, wait_signal: new AbortController().signal }
  )
  times.push(performance.now() - t)
}
times.sort((a, b) => a - b)
console.log('p50', times[200]!.toFixed(2), 'p95', times[380]!.toFixed(2))
service.close()
await f.close()
process.exit(0)
