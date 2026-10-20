// 真实 Store/Wire/loopback 的双 provider 回归；安装来源和原生执行仅使用明确合成 stub。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { providerIsolationFixture } from './provider-isolation-helpers.js'
import { until } from './helpers.js'

/** 两个来源都必须独立 ready，不能用设备整体 ready 掩盖单实例尚未接纳。 */
async function ready(
  w: ReturnType<typeof providerIsolationFixture>,
  client: ReturnType<ReturnType<typeof providerIsolationFixture>['connect']>
) {
  await until(
    /** 只观察已认证通道和原实例健康，不补造来源或许可。 */ () => {
      const providers = w.f.gateway.status().devices[0]?.providers ?? []
      return (
        client.status().phase === 'ready' &&
        providers.length === 2 &&
        providers.every(/** 两个实例均经过各自实际快照与原配置核对。 */ (provider) => provider.ready)
      )
    }
  )
}

for (const failure of ['readiness', 'snapshot_replaced', 'snapshot_readiness'] as const) {
  test(
    `Connector ${failure} 只关闭失败 provider，恢复不复活旧 binding，显式新 epoch 才使用新 revision`,
    /** 故障发生时两个实际 RPC 都已 accepted，健康调用仍沿原 Wire 完成。 */ async () => {
      const w = providerIsolationFixture()
      const { f, state, work, targets } = w
      const client = w.connect()
      try {
        await ready(w, client)
        const epoch = client.status().connection_epoch!
        const failed = f.call(targets[0]!)
        const healthy = f.call(targets[1]!)
        f.gateway.dispatch(failed.call_id)
        f.gateway.dispatch(healthy.call_id)
        await until(
          /** 两份独立工作均已启动并收到真实 accepted。 */ () =>
            work.has(failed.call_id) &&
            work.has(healthy.call_id) &&
            f.store.call(f.principal.id, failed.call_id).state === 'connector_accepted' &&
            f.store.call(f.principal.id, healthy.call_id).state === 'connector_accepted'
        )
        if (failure === 'readiness') {
          state.connector.set(targets[0]!.provider_id, false)
        } else if (failure === 'snapshot_replaced') {
          state.changed.add(targets[0]!.provider_id)
        } else {
          state.failOnSnapshot.add(targets[0]!.provider_id)
        }
        await until(
          /** 只有该实例的调用收敛为未知，不能冒充未派发。 */ () =>
            f.store.call(f.principal.id, failed.call_id).state === 'outcome_unknown'
        )
        assert.equal(work.get(failed.call_id)!.signal.aborted, true)
        assert.equal(work.get(healthy.call_id)!.signal.aborted, false)
        assert.equal(f.store.call(f.principal.id, healthy.call_id).state, 'connector_accepted')
        assert.equal(f.gateway.status().connections, 1)
        assert.equal(client.status().connection_epoch, epoch)
        assert.equal(client.status().reconnects, 0)
        const failedSources = state.sources.filter(
          /** 本次原 epoch 的同一实例在两端分别释放自己的 owner。 */ (source) =>
            source.provider === targets[0]!.provider_id && source.epoch === epoch
        )
        assert.equal(failedSources.length, 2)
        assert(failedSources.every(/** 每个原 owner 只关闭一次。 */ (source) => source.closed && source.closes === 1))
        const gets = failedSources.map(/** 记录关闭后不再重试旧 getter。 */ (source) => source.gets)
        state.connector.set(targets[0]!.provider_id, true)
        state.changed.delete(targets[0]!.provider_id)
        const heartbeats = state.heartbeats.connector + state.heartbeats.gateway
        await until(
          /** 至少再完成两轮原连接心跳，确认不是瞬间状态。 */ () =>
            state.heartbeats.connector + state.heartbeats.gateway >= heartbeats + 4
        )
        assert.deepEqual(
          failedSources.map(/** 恢复不会重新读取旧来源。 */ (source) => source.gets),
          gets
        )
        assert.equal(
          client
            .status()
            .providers.find(/** 精确匹配失败实例。 */ (provider) => provider.provider_id === targets[0]!.provider_id)!
            .ready,
          false
        )
        assert.equal(
          f.gateway
            .status()
            .devices[0]!.providers.find(
              /** 健康实例继续可用。 */ (provider) => provider.provider_id === targets[1]!.provider_id
            )!.ready,
          true
        )
        const blocked = f.call(targets[0]!)
        assert.throws(
          /** 原 binding 的新调用不能在本 epoch 重启或自动换目标。 */ () => f.gateway.dispatch(blocked.call_id),
          /provider_not_ready/
        )
        assert.equal(state.executions.length, 2)
        work.get(failed.call_id)!.finish()
        work.get(healthy.call_id)!.finish()
        await until(
          /** 健康调用仍以原 permit 提交真实响应事务。 */ () =>
            f.store.call(f.principal.id, healthy.call_id).state === 'responded'
        )
        assert.equal(f.store.call(f.principal.id, failed.call_id).state, 'outcome_unknown')
        assert.equal(f.gateway.resolveOriginalRead(failed.call_id), undefined)
        assert(f.gateway.resolveOriginalRead(healthy.call_id))
        assert.equal(client.status().connection_epoch, epoch)
        assert.equal(client.status().reconnects, 0)

        client.stop()
        await until(/** 此次断连是测试显式操作，故障本身此前未重连。 */ () => f.gateway.status().connections === 0)
        const disabled = f.store.setProviderEnabled(w.device.machine_id, targets[0]!.provider_id, 1, false)
        const replacement = f.store.setProviderEnabled(
          w.device.machine_id,
          targets[0]!.provider_id,
          disabled.binding_revision,
          true
        )
        f.localBindings.set(w.device.machine_id + '/' + targets[0]!.provider_id, replacement)
        const fresh = w.connect()
        await ready(w, fresh)
        assert.notEqual(fresh.status().connection_epoch, epoch)
        const intended = f.call(targets[0]!)
        f.gateway.dispatch(intended.call_id)
        await until(/** 只执行明确登记的新 revision、新 epoch 意图。 */ () => work.has(intended.call_id))
        work.get(intended.call_id)!.finish()
        await until(
          /** 新意图正常完成，旧未知调用不会被重放或补造成功。 */ () =>
            f.store.call(f.principal.id, intended.call_id).state === 'responded'
        )
        assert.equal(state.executions.length, 3)
        assert.throws(
          /** 原 Store 继续拒绝跨 revision 读取旧作用域，不为恢复补造旧调用状态。 */ () =>
            f.store.call(f.principal.id, failed.call_id),
          /provider_binding_mismatch/
        )
        assert.throws(
          /** 旧意图不能迁入新 binding 或新 epoch 重派。 */ () => f.gateway.dispatch(failed.call_id),
          /provider_binding_mismatch/
        )
        assert.equal(state.executions.at(-1)!.binding_revision, replacement.binding_revision)
      } finally {
        w.stop()
      }
    }
  )
}

test(
  'Gateway 单 provider 来源丢失时丢弃在途迟到响应，健康 provider 的原调用与后续调用继续工作',
  /** 客户端尚未收到撤回时已发出的合成响应，不能复活失效来源或关闭健康通道。 */ async () => {
    const w = providerIsolationFixture()
    const { f, state, work, targets } = w
    const client = w.connect()
    try {
      await ready(w, client)
      const epoch = client.status().connection_epoch
      const failed = f.call(targets[0]!)
      const healthy = f.call(targets[1]!)
      f.gateway.dispatch(failed.call_id)
      f.gateway.dispatch(healthy.call_id)
      await until(
        /** 两份工作真实进入各自的合成原生等待。 */ () => work.has(failed.call_id) && work.has(healthy.call_id)
      )
      state.gateway.set(targets[0]!.provider_id, false)
      work.get(failed.call_id)!.finish()
      await until(
        /** 等待真实迟到帧到达 Gateway，及原调用保持未知。 */ () =>
          state.received.some(
            /** 仅核对实际 socket 收到的同一响应。 */ (response) =>
              response.side === 'gateway' && response.call === failed.call_id
          ) && f.store.call(f.principal.id, failed.call_id).state === 'outcome_unknown'
      )
      assert.equal(f.store.call(f.principal.id, failed.call_id).response, null)
      assert.equal(work.get(healthy.call_id)!.signal.aborted, false)
      assert.equal(f.gateway.status().connections, 1)
      assert.equal(client.status().connection_epoch, epoch)
      state.gateway.set(targets[0]!.provider_id, true)
      work.get(healthy.call_id)!.finish()
      await until(
        /** 健康来源的原在途调用仍可完成。 */ () => f.store.call(f.principal.id, healthy.call_id).state === 'responded'
      )
      const next = f.call(targets[1]!)
      f.gateway.dispatch(next.call_id)
      await until(/** 无须重连即可显式发起另一个健康请求。 */ () => work.has(next.call_id))
      work.get(next.call_id)!.finish()
      await until(
        /** 后续调用仍沿原 epoch 提交。 */ () => f.store.call(f.principal.id, next.call_id).state === 'responded'
      )
      assert.equal(
        client
          .status()
          .providers.find(
            /** 恢复底层健康仍不复活失败来源。 */ (provider) => provider.provider_id === targets[0]!.provider_id
          )!.ready,
        false
      )
      assert.equal(client.status().connection_epoch, epoch)
      assert.equal(client.status().reconnects, 0)
      assert(f.gateway.resolveOriginalRead(healthy.call_id))
    } finally {
      w.stop()
    }
  }
)
