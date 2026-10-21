// 验证真实 Store 设备凭据、真实双端 socket 及 adapter 回收的完整组合：认证、重配、撤销、重连与重启。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../../src/store.js'
import type { JsonObject } from '../../src/wire/types.js'
import { realFixture } from './real-helpers.js'
import { until } from './helpers.js'
import { management } from '../storage/helpers.js'
import { clockWrites } from '../storage/clock-write-helpers.js'

test(
  '真实 WS 双 Connector：Store 事务认证、独立 provider 与响应账本，复制凭据不能抢占',
  { timeout: 15_000 },
  /** WS 只信任本次 mock CA；Store 同一事务核对凭据摘要并分配 epoch，整个路径没有 mock 桥。 */
  async () => {
    const f = realFixture()
    try {
      const a = f.pair('mock_real_a')
      const b = f.pair('mock_real_b')
      const ca = f.connector(a)
      const cb = f.connector(b)
      await f.ready(ca, cb)
      assert.equal(f.f.gateway.url.startsWith('ws://127.0.0.1:'), true)
      const first = f.f.call(a.target)
      const second = f.f.call(b.target)
      const ba = f.f.gateway.dispatch(first.call_id)
      const bb = f.f.gateway.dispatch(second.call_id)
      await until(
        /** 两个设备都必须各自完成真实 Store 事务，accepted 不算完成。 */
        () =>
          f.f.store.call(f.f.principal.id, first.call_id).state === 'responded' &&
          f.f.store.call(f.f.principal.id, second.call_id).state === 'responded'
      )
      assert.notEqual(ba.connection_epoch, bb.connection_epoch)
      assert.equal(f.f.executions, 2)
      const copied = f.connector(a)
      await until(
        /** 重复在线凭据进入有界退避，不覆盖原认证 socket。 */
        () => copied.status().reconnects > 0
      )
      assert.equal(ca.status().connection_epoch, ba.connection_epoch)
      assert.equal(cb.status().connection_epoch, bb.connection_epoch)
      const inspect = new DatabaseSync(f.storePath, { readOnly: true })
      try {
        assert.equal(inspect.prepare("SELECT details FROM audit WHERE action='connected'").all().length, 2)
      } finally {
        inspect.close()
      }
    } finally {
      f.close()
    }
  }
)

test(
  '真实 Store reset：旧 fence 与缺确认无副作用，精确 fence 才关闭全部资源并同 ID 新配对',
  { timeout: 15_000 },
  /** 在真实数据库提交前后检查 socket、adapter、凭据摘要和管理确认，旧凭据永不自动复活。 */
  async () => {
    const f = realFixture()
    try {
      const a = f.pair('mock_reset_a')
      const b = f.pair('mock_reset_b')
      const ca = f.connector(a)
      const cb = f.connector(b)
      await f.ready(ca, cb)
      const epoch = ca.status().connection_epoch!
      const record = f.records[0]!.connection.machine_id === a.machine_id ? f.records[0]! : f.records[1]!
      assert.throws(
        /** 精确旧 epoch 不匹配，必须在任何外部关闭之前拒绝。 */
        () => f.reset(a.machine_id, 'stale_epoch'),
        /device_epoch_mismatch/
      )
      assert.throws(
        /** 当前 epoch 也不能省略独立管理员确认。 */
        () => f.reset(a.machine_id, epoch),
        /management_authorization_required/
      )
      assert.equal(record.native.adapter.stats().closed, false)
      assert.equal(ca.status().connection_epoch, epoch)
      f.approve(a.machine_id, epoch)
      f.reset(a.machine_id, epoch)
      assert.equal(f.f.store.machine(a.machine_id).status, 'pending')
      assert.equal(record.native.adapter.stats().closed, true)
      assert.equal(record.native.adapter.stats().snapshot_bytes, 0)
      assert.throws(
        /** 旧实际 socket 的 backend 不能因 Store pending 或其它新连接而重新可用。 */
        () => record.native.backend.connection(),
        /authentication_required/
      )
      assert.equal(
        f.events.some(
          /** 真实 COMMIT 后通知只作用于重配设备。 */
          (event) => event.kind === 'device_fence' && event.machine_id === a.machine_id
        ),
        true
      )
      assert.equal(cb.status().phase, 'ready')
      const old = a.credential.credential
      ca.stop()
      const device = f.f.store.redeem(f.f.store.issueEnrollment(a.machine_id))
      a.credential = { ...device, recovery_generation: f.f.store.generation() }
      assert.throws(
        /** 同 ID 重配也不允许旧凭据重新通过认证。 */
        () => f.lifecycle.authenticate(a.machine_id, a.credential.recovery_generation, old),
        /invalid_device_credential/
      )
      const fresh = f.connector(a)
      await f.ready(fresh, cb)
      assert.equal(fresh.status().machine_id, a.machine_id)
      assert.notEqual(fresh.status().connection_epoch, epoch)
      const call = f.f.call(a.target)
      f.f.gateway.dispatch(call.call_id)
      await until(
        /** 新 epoch 可执行新调用，不迁移或重放旧工作。 */
        () => f.f.store.call(f.f.principal.id, call.call_id).state === 'responded'
      )
    } finally {
      f.close()
    }
  }
)

test(
  '真实 Store 提交失败：reset 整体回滚，旧连接、adapter 与 epoch 保持有效',
  { timeout: 15_000 },
  /** 在真实 Store COMMIT 点故障，随后走公开受保护 resumeStorage；没有外部状态需要保留。 */
  async () => {
    const f = realFixture()
    try {
      const a = f.pair('mock_rollback_a')
      const ca = f.connector(a)
      await f.ready(ca)
      const epoch = ca.status().connection_epoch!
      const record = f.records[0]!
      f.approve(a.machine_id, epoch)
      f.failStore = true
      assert.throws(
        /** Store 事务失败：此时尚未关闭任何 socket。 */
        () => f.reset(a.machine_id, epoch),
        /storage_degraded/
      )
      f.failStore = false
      f.f.store.resumeStorage()
      assert.equal(f.f.store.health().mode, 'active')
      f.f.store.assertConnection(record.connection)
      assert.equal(f.f.store.machine(a.machine_id).status, 'online')
      assert.equal(record.native.adapter.stats().closed, false)
      assert.equal(
        f.events.some(
          /** 回滚不能发布 device_fence 通知。 */
          (event) => event.kind === 'device_fence'
        ),
        false
      )
      assert.deepEqual(record.native.backend.connection(), record.connection)
    } finally {
      f.close()
    }
  }
)

test(
  '真实撤销：设备凭据失效且 socket 被断开，不影响其它设备',
  { timeout: 15_000 },
  /** 撤销在 Store 单事务中清凭据和 epoch；宿主随后关闭通道，A 的旧凭据不能重连。 */
  async () => {
    const f = realFixture()
    try {
      const a = f.pair('mock_revoke_a')
      const b = f.pair('mock_revoke_b')
      const ca = f.connector(a)
      const cb = f.connector(b)
      await f.ready(ca, cb)
      f.f.store.revoke(a.machine_id)
      f.f.gateway.disconnect(a.machine_id)
      assert.equal(f.f.store.machine(a.machine_id).status, 'revoked')
      assert.throws(
        /** 撤销后凭据不能再认证。 */
        () => f.lifecycle.authenticate(a.machine_id, a.credential.recovery_generation, a.credential.credential),
        /invalid_device_credential/
      )
      assert.equal(f.f.gateway.status().devices.length, 1)
      assert.equal(cb.status().phase, 'ready')
      const call = f.f.call(b.target)
      f.f.gateway.dispatch(call.call_id)
      await until(
        /** B 的新调用仍经真实 Store 提交，不受 A 撤销影响。 */
        () => f.f.store.call(f.f.principal.id, call.call_id).state === 'responded'
      )
    } finally {
      f.close()
    }
  }
)

test(
  '真实重连 fresh epoch 不重放未知调用，旧 adapter/订阅全部关闭并释放监听容量',
  { timeout: 15_000 },
  /** 已接收但未完成的 mock native 执行只收到观察关闭，旧结果不得交给新 epoch。 */
  async () => {
    const f = realFixture()
    let release: ((value: JsonObject) => void) | undefined
    let nativeId = ''
    let executions = 0
    try {
      const a = f.pair('mock_reconnect')
      const ca = f.connector(a, {
        /** 延迟合成结果，复现派发后断线且不能确认原生是否生效的窗口。 */
        execute: (raw) => {
          executions++
          nativeId = JSON.parse(raw).id
          return new Promise(
            /** 保留本次 mock 原生结果完成器；测试最后才允许其结束。 */
            (resolve) => {
              release = resolve
            }
          )
        }
      })
      await f.ready(ca)
      const epoch = ca.status().connection_epoch!
      const old = f.records[0]!
      const call = f.f.call(a.target)
      f.f.gateway.dispatch(call.call_id)
      await until(
        /** 等待真实 request 已送达 Connector，避免把未发送当作未知执行。 */
        () => executions === 1
      )
      f.f.gateway.disconnect(a.machine_id)
      await until(
        /** 自动重连继续同一 machine ID，但必须取得新提交的 epoch。 */
        () => ca.status().phase === 'ready' && ca.status().connection_epoch !== epoch
      )
      assert.equal(ca.status().machine_id, a.machine_id)
      assert.equal(old.native.adapter.stats().closed, true)
      assert.equal(old.native.adapter.stats().snapshot_bytes, 0)
      assert.equal(f.f.store.call(f.f.principal.id, call.call_id).state, 'outcome_unknown')
      release!({ id: nativeId, result: { id: 'mock_late' } })
      await until(
        /** 忽略关闭的工作实际结束后才释放并发额度。 */
        () => ca.status().running === 0
      )
      assert.equal(executions, 1)
      assert.equal(f.f.store.call(f.f.principal.id, call.call_id).state, 'outcome_unknown')
      ca.stop()
      f.f.gateway.stop()
      const subscriptions = []
      /** 只用于容量检查的无副作用宿主监听器，不记录内容或身份。 */
      const listener = () => undefined
      for (let index = 0; index < 127; index++) {
        subscriptions.push(f.f.store.subscribeInvalidation(listener.bind({ index })))
      }
      try {
        assert.throws(
          /** 唯一剩余的是 fixture 观察器；所有 socket adapter 关闭后必须释放其监听槽。 */
          () => f.f.store.subscribeInvalidation(listener),
          /listener_limit/
        )
      } finally {
        for (const unsubscribe of subscriptions) {
          unsubscribe()
        }
      }
    } finally {
      release?.({ id: nativeId, result: { id: 'mock_cleanup' } })
      f.close()
    }
  }
)

test(
  '错误凭据不产生认证 epoch 或 ready，设备保持 offline',
  { timeout: 15_000 },
  /** 凭据不匹配时不能靠已有 Store 配对状态认证，也不能注册 socket session。 */
  () => {
    const f = realFixture()
    try {
      const a = f.pair('mock_wrong_credential')
      assert.throws(
        /** 格式合法但摘要不匹配。 */
        () => f.lifecycle.authenticate(a.machine_id, a.credential.recovery_generation, 'x'.repeat(43)),
        /invalid_device_credential/
      )
      assert.throws(
        /** 格式非法的凭据在触碰 Store 前拒绝。 */
        () => f.lifecycle.authenticate(a.machine_id, a.credential.recovery_generation, 'short'),
        /invalid_device_credential/
      )
      assert.throws(
        /** 旧代次拒绝。 */
        () => f.lifecycle.authenticate(a.machine_id, 'other_generation', a.credential.credential),
        /invalid_device_credential/
      )
      assert.equal(f.f.store.machine(a.machine_id).status, 'offline')
      assert.equal(f.f.gateway.status().devices.length, 0)
      assert.equal(f.records.length, 0)
    } finally {
      f.close()
    }
  }
)

test(
  '重开 Store 后凭据仍有效，在线状态被重置为 offline 并分配新 epoch',
  { timeout: 15_000 },
  /** 正常重开真实 SQLite；持久的只有凭据摘要，不恢复任何旧连接。 */
  async () => {
    const f = realFixture()
    try {
      const a = f.pair('mock_restart')
      const ca = f.connector(a)
      await f.ready(ca)
      const epoch = ca.status().connection_epoch!
      ca.stop()
      f.f.gateway.stop()
      f.f.store.close()
      const store = new Store(
        f.storePath,
        /** 重开继续同一可信测试时间。 */
        () => f.f.now,
        { management }
      )
      try {
        assert.equal(store.machine(a.machine_id).status, 'offline')
        const next = store.connect(a.machine_id, a.credential.credential)
        assert.notEqual(next, epoch)
        assert.throws(
          /** 在线设备不能被第二次认证覆盖。 */
          () => store.connect(a.machine_id, a.credential.credential),
          /duplicate_device_connection/
        )
      } finally {
        store.close()
      }
    } finally {
      f.close()
    }
  }
)

test(
  '生命周期 backend 每次连接观察都校验 Store fence，不写时钟，撤销后立即拒绝',
  /** 具体 socket 的每次观察都重新执行 fence 门禁，同毫秒不能借缓存权限。 */
  async () => {
    const f = realFixture()
    try {
      const device = f.pair('mock_backend_clock')
      const client = f.connector(device)
      await f.ready(client)
      const record = f.records[0]!
      let fences = 0
      const assertConnection = f.f.store.assertConnection.bind(f.f.store)
      f.f.store.assertConnection = /** 每次仍核对当前 Store 代次、状态与 epoch。 */ (connection, lease) => {
        fences++
        return assertConnection(connection, lease)
      }
      f.f.now++
      const first = clockWrites(
        f.f.store,
        /** 原 backend 完整执行 epoch 校验。 */ () => record.native.backend.connection()
      )
      assert.equal(first.updates, 0)
      assert.deepEqual(first.result, record.connection)
      assert.equal(fences, 1)
      const repeated = clockWrites(
        f.f.store,
        /** 同毫秒也必须重新执行 fence 门禁。 */ () => record.native.backend.connection()
      )
      assert.equal(repeated.updates, 0)
      assert.equal(fences, 2)
      f.f.store.revoke(device.machine_id)
      assert.throws(
        /** 撤销后具体 socket 仍保存相同上下文也必须被 Store fence 拒绝。 */ () => record.native.backend.connection(),
        /connection_unavailable/
      )
      assert.equal(fences, 3)
    } finally {
      f.close()
    }
  }
)
