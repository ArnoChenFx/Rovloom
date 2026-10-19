// 验证真实 RPC adapter 的有界 seen 契约及 fresh epoch 恢复，扩展检查可直接以 attemptLimit=128 运行。
import assert from 'node:assert/strict'
import { wireFixture } from './wire-execution-helpers.js'
import { until } from './helpers.js'

/** 标准回归可收紧上限以缩短运行；128 的扩展回归仍执行实际 IPC、同一 adapter 和真实持久 claim。 */
export async function verifyRpcCapacity(attemptLimit = 128) {
  assert(Number.isSafeInteger(attemptLimit) && attemptLimit > 0 && attemptLimit <= 128)
  const f = await wireFixture({ nativeLimits: { attempts: attemptLimit } })
  try {
    const device = f.pair('mock_real_rpc_capacity')
    const client = f.connect(device)
    await f.ready(client)
    const epoch = client.status().connection_epoch
    const session = f.sessions[0]!
    for (let i = 0; i < attemptLimit; i++) {
      const call = f.f.call(device.target)
      const binding = f.f.gateway.dispatch(call.call_id)
      await until(
        /** 真实证据提交才算完成，不把 hook 或 accepted 当作成功。 */
        () => ['responded', 'outcome_unknown'].includes(f.f.store.call(f.f.principal.id, call.call_id).state)
      )
      assert.equal(f.f.store.call(f.f.principal.id, call.call_id).state, 'responded', `执行 ${i + 1} 次`)
      assert.equal(client.status().connection_epoch, epoch)
      assert.equal(f.sessions.length, 1)
      assert.equal(f.sessions[0]!.rpc, session.rpc)
      const original = f.f.gateway.resolveOriginalRead(call.call_id)!
      assert(original)
      original.wire.checkResultRetention(binding, JSON.parse(f.f.store.call(f.f.principal.id, call.call_id).response!))
      original.wire.release(binding)
    }
    const rejected = f.f.call(device.target)
    f.f.gateway.dispatch(rejected.call_id)
    await until(
      /** 满额的新意图可能已写到通道，Gateway 按 unknown 保守终结，不能自动重放。 */
      () => f.f.store.call(f.f.principal.id, rejected.call_id).state === 'outcome_unknown'
    )
    assert.deepEqual(f.state.rpcErrors, [{ code: 'local_attempt_limit', outcome: 'not_dispatched' }])
    assert.equal(f.state.hook, attemptLimit + 1)
    assert.equal(f.state.auth, attemptLimit)
    assert.equal(f.state.nativeCompleted, attemptLimit)
    assert.equal(f.claimCount(), attemptLimit)
    assert.equal(f.native.state.responses, attemptLimit)
    await until(
      /** 关闭满额 adapter 后重新认证只建立 fresh epoch，不重发旧请求。 */
      () => client.status().phase === 'ready' && client.status().connection_epoch !== epoch
    )
    assert.equal(f.sessions.length, 2)
    assert.notEqual(f.sessions[1]!.rpc, session.rpc)
    assert.equal(f.state.auth, attemptLimit)
    assert.equal(f.claimCount(), attemptLimit)
    const fresh = f.f.call(device.target)
    const binding = f.f.gateway.dispatch(fresh.call_id)
    await until(
      /** 只有宿主显式创建并派发的新意图，才在新 adapter 继续原生执行。 */
      () => f.f.store.call(f.f.principal.id, fresh.call_id).state === 'responded'
    )
    const original = f.f.gateway.resolveOriginalRead(fresh.call_id)!
    original.wire.checkResultRetention(binding, JSON.parse(f.f.store.call(f.f.principal.id, fresh.call_id).response!))
    assert.equal(f.f.store.call(f.f.principal.id, rejected.call_id).state, 'outcome_unknown')
    assert.equal(f.f.store.call(f.f.principal.id, rejected.call_id).response, null)
    assert.equal(f.state.hook, attemptLimit + 2)
    assert.equal(f.state.nativeCompleted, attemptLimit + 1)
    assert.equal(f.state.auth, attemptLimit + 1)
    assert.equal(f.claimCount(), attemptLimit + 1)
    assert.equal(f.native.state.responses, attemptLimit + 1)
    assert.equal(f.f.executions, 0)
    assert.equal(client.status().running, 0)
    return {
      limit: attemptLimit,
      intents: attemptLimit + 2,
      claims: f.claimCount(),
      rejected: 'local_attempt_limit',
      epochs: 2
    }
  } finally {
    await f.close()
  }
}
