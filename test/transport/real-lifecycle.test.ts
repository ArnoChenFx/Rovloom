// 验证合并后真实 Store 桥、同一持久身份库、真实双端 socket 及 adapter 回收的完整组合。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { IdentityStore, PersistentProofIdentity } from '../../src/transport/index.js'
import { createStoreIdentityFacts } from '../../src/transport/store-identity.js'
import { Store } from '../../src/store.js'
import { randomUUID } from 'node:crypto'
import type { JsonObject } from '../../src/wire/types.js'
import { realFixture } from './real-helpers.js'
import { until } from './helpers.js'
import { management } from '../storage/helpers.js'

test(
  '真实 WSS 双 Connector：持久证明消费、独立 provider 与响应账本，复制凭据不能抢占',
  { timeout: 15_000 },
  /** TLS 只信任本次一日 mock CA；真实 Store 方法消费进程内证明，整个路径没有 mock 桥。 */
  async () => {
    const f = realFixture({ tls: true })
    try {
      const a = f.pair('mock_real_a')
      const b = f.pair('mock_real_b')
      const ca = f.connector(a)
      const cb = f.connector(b)
      await f.ready(ca, cb)
      assert.equal(f.f.gateway.url.startsWith('wss://127.0.0.1:'), true)
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
        const rows = inspect.prepare("SELECT details FROM audit WHERE action='connected'").all()
        assert.equal(rows.length, 2)
        for (const row of rows) {
          assert.equal(JSON.parse(String(row.details)).identity_source, 'protected_host')
        }
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
      const count = f.identityChanges
      const record = f.records[0]!.connection.machine_id === a.machine_id ? f.records[0]! : f.records[1]!
      assert.throws(
        /** 精确旧 epoch 不匹配，必须在任何外部关闭和身份提交之前拒绝。 */
        () => f.reset(a.machine_id, 'stale_epoch'),
        /device_epoch_mismatch/
      )
      assert.throws(
        /** 当前 epoch 也不能省略独立管理员确认。 */
        () => f.reset(a.machine_id, epoch),
        /management_authorization_required/
      )
      assert.equal(f.identityChanges, count)
      assert.equal(record.native.adapter.stats().closed, false)
      assert.equal(ca.status().connection_epoch, epoch)
      f.approve(a.machine_id, epoch)
      f.reset(a.machine_id, epoch)
      assert.equal(f.f.store.machine(a.machine_id).status, 'pending')
      assert.equal(f.db.read(a.machine_id)!.status, 'pending')
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
      f.manager.install(a.credential)
      const fresh = f.connector(a)
      await f.ready(fresh, cb)
      assert.equal(fresh.status().machine_id, a.machine_id)
      assert.notEqual(fresh.status().connection_epoch, epoch)
      assert.throws(
        /** 同 ID 重配也不允许旧凭据重新签发认证证明。 */
        () => f.identity.verifyCredential(a.machine_id, a.credential.recovery_generation, Buffer.from(old)),
        /invalid_device_credential/
      )
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
  '真实双库 rollback：外部 blocked 不回滚，恢复 Store active 后旧 backend 与重连仍拒绝',
  { timeout: 15_000 },
  /** 在真实 Store COMMIT 点故障，随后走公开受保护 resumeStorage；不用私有 SQL 修复模式。 */
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
        /** prepare 已关闭 socket 并提交 blocked，主库故障只回滚本库。 */
        () => f.reset(a.machine_id, epoch),
        /storage_degraded/
      )
      f.failStore = false
      f.f.store.resumeStorage()
      assert.equal(f.f.store.health().mode, 'active')
      f.f.store.assertConnection(record.connection)
      assert.equal(f.identity.blockedCommitted(a.machine_id, a.credential.recovery_generation, epoch), true)
      assert.equal(f.db.read(a.machine_id)!.status, 'blocked')
      assert.equal(record.native.adapter.stats().closed, true)
      assert.equal(
        f.events.some(
          /** 回滚不能发布 device_fence 成功通知，外部关闭不依赖这种通知。 */
          (event) => event.kind === 'device_fence'
        ),
        false
      )
      assert.throws(
        /** 即使原 Store epoch 恢复 active，旧作用域也已经同步封锁。 */
        () => record.native.backend.connection(),
        /authentication_required/
      )
      assert.throws(
        /** 原生来源路径也必须独立观察同一 socket 和已提交身份拒绝。 */
        () => record.native.backend.nativeSource('mock_call', 'mock_attempt'),
        /authentication_required/
      )
      assert.throws(
        /** 关闭后的旧密钥不能用自动重连恢复外部 blocked。 */
        () =>
          f.lifecycle.authenticate(
            a.machine_id,
            a.credential.recovery_generation,
            Buffer.from(a.credential.credential)
          ),
        /invalid_device_credential/
      )
      assert.equal(f.f.gateway.status().devices.length, 0)
    } finally {
      f.close()
    }
  }
)

test(
  '真实轮换结束与撤销：原 socket hash 租期失效，fresh epoch 可重连且不影响其它设备',
  { timeout: 15_000 },
  /** 验证管理提交后的正常断连与 prepare-only 封锁分离，避免轮换后主 Store 永久残留 online。 */
  async () => {
    const f = realFixture()
    try {
      const a = f.pair('mock_rotate_a')
      const b = f.pair('mock_rotate_b')
      const ca = f.connector(a)
      const cb = f.connector(b)
      await f.ready(ca, cb)
      const originalEpoch = ca.status().connection_epoch!
      const old = a.credential.credential
      a.credential = f.manager.rotate(a.machine_id, 1000)
      assert.equal(f.f.store.machine(a.machine_id).status, 'offline')
      f.manager.finishRotation(a.machine_id)
      await until(
        /** 原 socket 的 close 是异步事件，必须等到实际 fresh epoch，不能复用旧 ready 状态。 */
        () => ca.status().phase === 'ready' && ca.status().connection_epoch !== originalEpoch
      )
      assert.notEqual(ca.status().connection_epoch, originalEpoch)
      assert.throws(
        /** 轮换完成后旧 hash 不得利用新凭据存在继续认证。 */
        () => f.identity.verifyCredential(a.machine_id, a.credential.recovery_generation, Buffer.from(old)),
        /invalid_device_credential/
      )
      f.manager.revoke(a.machine_id)
      assert.equal(f.f.store.machine(a.machine_id).status, 'revoked')
      assert.equal(f.db.read(a.machine_id)!.status, 'revoked')
      assert.equal(f.f.gateway.status().devices.length, 1)
      assert.equal(cb.status().phase, 'ready')
      const call = f.f.call(b.target)
      f.f.gateway.dispatch(call.call_id)
      await until(
        /** B 的新调用仍经真实 Store 提交，不受 A 凭据管理动作影响。 */
        () => f.f.store.call(f.f.principal.id, call.call_id).state === 'responded'
      )
    } finally {
      f.close()
    }
  }
)

test(
  '真实管理 rePair 的 prepare-only 关闭不重入 Store，takeover 另行签发且旧凭据不能夺回',
  { timeout: 15_000 },
  /** 同时覆盖 PersistentIdentity 的两类管理回调，并用真实桥验证凭据复制者无法抢占。 */
  async () => {
    const f = realFixture()
    try {
      const a = f.pair('mock_manager_reset')
      const b = f.pair('mock_manager_takeover')
      const ca = f.connector(a)
      const cb = f.connector(b)
      await f.ready(ca, cb)
      const epoch = ca.status().connection_epoch!
      f.approve(a.machine_id, epoch)
      f.manager.rePair(a.machine_id, epoch)
      assert.equal(f.f.store.machine(a.machine_id).status, 'pending')
      assert.equal(f.db.read(a.machine_id)!.status, 'pending')
      const record = f.records.find(
        /** 从实际 B socket 的受信记录取得完整 fence，不能用消息自报身份接管。 */
        (item) => item.connection.machine_id === b.machine_id
      )!
      const original = b.credential.credential
      const fresh = f.manager.takeover(record.connection)
      cb.stop()
      b.credential = fresh
      const next = f.connector(b)
      await f.ready(next)
      assert.notEqual(next.status().connection_epoch, record.connection.connection_epoch)
      assert.equal(record.native.adapter.stats().closed, true)
      assert.throws(
        /** takeover 使用独立新凭据；原 Connector 即使持有复制旧秘密也无法重新认证。 */
        () => f.identity.verifyCredential(b.machine_id, b.credential.recovery_generation, Buffer.from(original)),
        /invalid_device_credential/
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
  '真实身份提交失败不产生认证 epoch 或 ready，凭据缓冲区仍完整清零',
  { timeout: 15_000 },
  /** 身份库发生故障时不能靠已有 Store 配对状态认证，也不能在失败前注册 socket session。 */
  () => {
    const f = realFixture()
    try {
      const a = f.pair('mock_identity_failure')
      const bytes = Buffer.from(a.credential.credential)
      f.failIdentity = true
      assert.throws(
        /** 独立凭据校验的事务故障在真实 Store connectVerifiedDevice 之前拒绝。 */
        () => f.lifecycle.authenticate(a.machine_id, a.credential.recovery_generation, bytes),
        /invalid_device_credential/
      )
      assert.equal(
        bytes.every(
          /** 失败路径也必须清空原始凭据字节。 */
          (byte) => byte === 0
        ),
        true
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
  '真实双库重开保留 blocked fence，证明不跨进程实例恢复，未验凭据不能建立 Store epoch',
  { timeout: 15_000 },
  /** 正常重开两个真实 SQLite，不使用独立模拟身份表或恢复已失效的证明对象。 */
  async () => {
    const f = realFixture()
    try {
      const a = f.pair('mock_restart')
      const proof = f.identity.verifyCredential(
        a.machine_id,
        a.credential.recovery_generation,
        Buffer.from(a.credential.credential)
      )
      const ca = f.connector(a)
      await f.ready(ca)
      const epoch = ca.status().connection_epoch!
      f.approve(a.machine_id, epoch)
      f.failStore = true
      assert.throws(
        /** 在主提交失败前真实身份已封锁，后续重启不能重新放行。 */
        () => f.reset(a.machine_id, epoch),
        /storage_degraded/
      )
      f.failStore = false
      f.f.store.resumeStorage()
      f.f.gateway.stop()
      f.f.store.close()
      f.db.close()
      const store = new Store(
        f.storePath,
        /** 重开继续同一可信测试时间，不允许回拨恢复权限。 */
        () => f.f.now,
        { management }
      )
      const facts = createStoreIdentityFacts(store)
      const db = new IdentityStore(f.identityPath, {
        generation: store.generation(),
        guard: facts.guard,
        /** 与重开的 Store 使用完全一致的可信时间。 */
        now: () => f.f.now,
        /** 本次重开仍明确承担同一身份库的预算，而不是复制新的身份状态。 */
        checkBudget() {}
      })
      try {
        const identity = new PersistentProofIdentity(
          db,
          /** 仅为检查对象恢复禁令提供 mock 确认，不实际进行管理操作。 */
          () => ({ actor: 'mock_admin', confirmation_id: randomUUID(), expires_at: f.f.now + 1000 })
        )
        assert.equal(identity.blockedCommitted(a.machine_id, a.credential.recovery_generation, epoch), true)
        assert.equal(identity.consumeProof(proof, a.machine_id, a.credential.recovery_generation), false)
        assert.throws(
          /** 重启后的真实桥没有受保护证明回调，不能从设备 ID 自行恢复连接。 */
          () => store.connectVerifiedDevice(a.machine_id, a.credential.recovery_generation),
          /duplicate_device_connection|device_verification_required|invalid_device_state/
        )
      } finally {
        db.close()
        store.close()
      }
    } finally {
      f.close()
    }
  }
)
