// 用真实 loopback、Store 与 Wire 检查轮询批观察；执行和接收端均为本测试合成夹具，不启动原生程序。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DatabaseSync } from 'node:sqlite'
import { Store } from '../../src/store.js'
import { createLuvusWireAdapter } from '../../src/integration/luvus-wire.js'
import { persistentBackend } from '../../src/integration/persistence.js'
import { consumeAuthenticatedAdmissionReceipt } from '../../src/transport/admission-proof.js'
import type { AuthenticatedAdmissionReceipt } from '../../src/transport/admission-proof.js'
import { admissionRequestDigest, assertBinding } from '../../src/wire/index.js'
import type { AdmissionRequest, AdmissionReceiptRecord, WireEnvelope } from '../../src/wire/index.js'
import { fixture, until } from './helpers.js'
import { clockWrites } from '../storage/clock-write-helpers.js'

/** 保留实际 Gateway timer 的同步入口，观察钩子不替换调度、时钟或原 codec 校验。 */
async function prepared(count: number, hold = false) {
  const state: {
    beforeEncode?: (frame: WireEnvelope) => void
    beforeTime?: () => void
    closed: number
  } = { closed: 0 }
  const records = new Map<string, AdmissionReceiptRecord>()
  const offer = {
    major: 2,
    minor: 0,
    capabilities: ['rpc', 'admission_receipt', 'admission_context'],
    required: ['rpc', 'admission_receipt', 'admission_context']
  }
  let timer: (() => void) | undefined
  const schedule = globalThis.setInterval
  globalThis.setInterval = /** 保存 Gateway 原 100ms 回调，并继续建立真实 interval；其它定时器原样透传。 */ ((
    ...args: Parameters<typeof setInterval>
  ) => {
    const handle = schedule(...args)
    if (args[1] === 100) {
      timer = args[0] as () => void
    }
    return handle
  }) as typeof setInterval
  let f: ReturnType<typeof fixture>
  try {
    f = fixture(
      {
        offer,
        retainOriginalRead: true,
        // 测试同步观察 tick 时不混入另一条 heartbeat 编码路径；不改产品默认时限。
        limits: { heartbeat_ms: 30_000, idle_ms: 120_000, handshake_ms: 5000 }
      },
      {},
      {
        /** 时钟回调仅用于重入回归，私有批读开始后不再调用它。 */
        store(now, options) {
          return new Store(
            ':memory:',
            /** 先执行本次一次性测试回调，再返回原 fixture 的同一可信时间。 */ () => {
              state.beforeTime?.()
              return now()
            },
            options
          )
        },
        /** 每个 Gateway 连接仍使用自己的原 Wire，测试只在编码之前观察并可重入宿主。 */
        adapter(_connection, _channel, services) {
          const wire = createLuvusWireAdapter(persistentBackend(f.store, services))
          return {
            ...wire,
            /** 即使测试改变 Store，发送仍经原完整编码和真实通道门禁。 */
            encode(frame, direction) {
              state.beforeEncode?.(frame)
              return wire.encode(frame, direction)
            }
          }
        }
      }
    )
  } finally {
    globalThis.setInterval = schedule
  }
  assert(timer)
  let release!: () => void
  const gate = new Promise<void>(
    /** 保存仅属于本测试的模拟执行等待。 */ (resolve) => {
      release = resolve
    }
  )
  try {
    const device = f.pair(`mock_admission_batch_${count}`)
    const client = f.connector(/** 只交付本测试兑换得到的 mock 凭据。 */ () => device.credential, {
      offer,
      limits: { heartbeat_ms: 30_000, idle_ms: 120_000, handshake_ms: 5000, reconnect_ms: 20, reconnect_max_ms: 200 },
      /** 接收器只收集真实通道交付的 opaque proof；它没有生产持久或执行权限。 */
      session(connection) {
        return {
          ...f.session(connection),
          admissions: {
            /** 一次性消费实际通道证明后保存纯测试元数据。 */
            accept(proof: AuthenticatedAdmissionReceipt) {
              const record = consumeAuthenticatedAdmissionReceipt(proof)
              records.set(record.binding.call_id, record)
            },
            /** 请求仍须与该连接原 receipt 的完整绑定及摘要一致。 */
            assertRequest(request: AdmissionRequest) {
              const record = records.get(request.binding.call_id)
              assert(record)
              assertBinding(request.binding, record.binding)
              assert.equal(record.request_sha256, admissionRequestDigest(request))
            },
            /** 测试只计量会话关闭，绝不把它当作原生动作终止。 */
            closeEpoch() {
              state.closed++
            }
          }
        }
      },
      /** 只返回与实际 mock 请求 ID 一致的合成响应，可阻塞以检查 Store.stop。 */
      async execute(raw) {
        if (hold) {
          await gate
        }
        return { id: JSON.parse(raw).id, result: { id: 'mock_task' } }
      }
    })
    await until(/** 必须实际完成认证和双方 readiness。 */ () => client.status().phase === 'ready')
    const bindings = []
    for (let index = 0; index < count; index++) {
      const call = f.call(device.target)
      const binding = f.gateway.dispatch(call.call_id)
      bindings.push(binding)
      await until(
        /** 保存原 admission 更新与 Store 提交一致的状态，避免把未到达帧当作测试起点。 */ () =>
          f.store.call(f.principal.id, call.call_id).state === (hold ? 'connector_accepted' : 'responded') &&
          records.get(call.call_id)?.context?.anchor.state === (hold ? 'connector_accepted' : 'responded')
      )
    }
    return {
      f,
      client,
      state,
      records,
      bindings,
      tick: timer,
      db: (f.store as unknown as { db: DatabaseSync }).db,
      /** 先停所属通道再释放模拟等待，迟到合成响应不会重建原连接。 */
      close() {
        f.stop()
        release()
      }
    }
  } catch (error) {
    f.stop()
    release()
    throw error
  }
}

for (const count of [1, 8, 16]) {
  test(
    `${count} 条未变化 admission 的实际 timer tick 不写时钟且不调用逐项刷新`,
    { timeout: 15_000 },
    /** 每轮认证检查与批观察仍独立执行，仅复用已持久的同毫秒时间，不缓存广播许可。 */ async () => {
      const p = await prepared(count)
      try {
        let anchors = 0
        let identityChecks = 0
        let batches = 0
        const original = p.f.store.responseAnchor.bind(p.f.store)
        p.f.store.responseAnchor = /** 批内部不经此公开入口，任何原逐项刷新都必须留下计数。 */ (binding) => {
          anchors++
          return original(binding)
        }
        const assertIdentity = p.f.credentials.assert.bind(p.f.credentials)
        p.f.credentials.assert = /** 每个 tick 都执行原身份租期与 Store fence 校验。 */ (...args) => {
          identityChecks++
          return assertIdentity(...args)
        }
        const observe = p.f.store.responseAnchors.bind(p.f.store)
        p.f.store.responseAnchors = /** 只计量原批观察入口，不用缓存结果代替数据库核对。 */ (bindings) => {
          batches++
          return observe(bindings)
        }
        const frames = p.f.encoded.length
        p.f.now++
        const measured = clockWrites(p.f.store, /** 同步触发原 timer 回调，不改变其判断。 */ () => p.tick())
        assert.equal(measured.updates, 0)
        assert.equal(identityChecks, 1)
        assert.equal(batches, 1)
        const repeated = clockWrites(p.f.store, /** 同毫秒再次触发仍执行完整身份检查和批观察。 */ () => p.tick())
        assert.equal(repeated.updates, 0)
        assert.equal(identityChecks, 2)
        assert.equal(batches, 2)
        assert.equal(anchors, 0)
        assert.equal(p.f.encoded.length, frames)
        assert.equal(p.f.gateway.status().connections, 1)
      } finally {
        p.close()
      }
    }
  )
}

test(
  '直接 Store.stop 没有通知时仍由下一次批观察广播 outcome_unknown',
  /** 不把已接收或未知误当最终响应；绕开 Gateway.cancel 也不能丢失原停止状态。 */ async () => {
    const p = await prepared(1, true)
    try {
      const binding = p.bindings[0]!
      let notifications = 0
      const unsubscribe = p.f.store.subscribeInvalidation(
        /** 只记录真实提交后通知数量。 */ () => {
          notifications++
        }
      )
      p.f.store.stop(p.f.principal.id, binding.call_id)
      assert.equal(notifications, 0)
      p.tick()
      await until(
        /** 等待同原通道送达新 source sequence。 */ () =>
          p.records.get(binding.call_id)?.context?.anchor.state === 'outcome_unknown'
      )
      unsubscribe()
      assert.equal(p.f.store.call(p.f.principal.id, binding.call_id).state, 'outcome_unknown')
    } finally {
      p.close()
    }
  }
)

test(
  '首项 fallback 的编码回调停止后项时，剩余快照不漏掉同步重入的新状态',
  /** 本 tick 必须发送两条 unknown，不依赖下一次自动 timer 修补过时快照。 */ async () => {
    const p = await prepared(2, true)
    try {
      const [first, second] = p.bindings
      p.f.store.stop(p.f.principal.id, first!.call_id)
      p.state.beforeEncode = /** 第一条真正广播时同步修改后一条，没有任何 Store 通知可代为刷新。 */ (frame) => {
        if (frame.type === 'admission_receipt' && frame.payload.attempt.call_id === first!.call_id) {
          p.state.beforeEncode = undefined
          p.f.store.stop(p.f.principal.id, second!.call_id)
        }
      }
      const frames = p.f.encoded.length
      p.tick()
      const updates = p.f.encoded.slice(frames).map(/** 仅解析本测试同步 tick 发出的帧。 */ (raw) => JSON.parse(raw))
      assert.deepEqual(
        updates.map(
          /** 只比较原call与状态，不读取业务正文。 */ (frame) => [
            frame.payload.attempt.call_id,
            frame.payload.context.anchor.state
          ]
        ),
        [
          [first!.call_id, 'outcome_unknown'],
          [second!.call_id, 'outcome_unknown']
        ]
      )
    } finally {
      p.close()
    }
  }
)

test(
  '批时钟回调已更新 tracked record 时不沿用旧候选，后项停止仍在本 tick 广播',
  /** 时钟在 BEGIN 前重入；批内纯读，返回后仍核对原 tracked/record/context 身份。 */ async () => {
    const p = await prepared(2, true)
    try {
      const [first, second] = p.bindings
      const observe = p.f.store.responseAnchors.bind(p.f.store)
      p.f.store.responseAnchors = /** 仅在本批可信时钟采样处安装一次重入，不影响 assertPeer 的先行采样。 */ (
        bindings
      ) => {
        p.state.beforeTime = /** 清理发布通知可替换第一项原record；第二项stop没有通知。 */ () => {
          p.state.beforeTime = undefined
          p.f.store.discardResponse(p.f.principal.id, first!.call_id)
          p.f.store.stop(p.f.principal.id, second!.call_id)
        }
        return observe(bindings)
      }
      const frames = p.f.encoded.length
      p.tick()
      const updates = p.f.encoded.slice(frames).map(/** 只比较同tick原广播元数据。 */ (raw) => JSON.parse(raw))
      assert(
        updates.some(
          /** 第一项通知中的原截止与清理状态必须保留。 */ (frame) =>
            frame.payload.attempt.call_id === first!.call_id &&
            frame.payload.context.anchor.content_status === 'discarded'
        )
      )
      assert(
        updates.some(
          /** 后项状态不能被旧快照跳过。 */ (frame) =>
            frame.payload.attempt.call_id === second!.call_id &&
            frame.payload.context.anchor.state === 'outcome_unknown'
        )
      )
    } finally {
      p.close()
    }
  }
)

test(
  '单项绑定失效只 fence 原调用，不影响同peer其它合法锚点',
  /** 损坏单项持久绑定模拟域失效，仍须通过原 refreshAdmission 生成单调 fence 帧。 */ async () => {
    const p = await prepared(2)
    try {
      const [first, second] = p.bindings
      const changed = { ...first!, native_request_id: 'changed_native_id' }
      p.db.prepare('UPDATE calls SET binding_json=? WHERE call_id=?').run(JSON.stringify(changed), first!.call_id)
      p.tick()
      await until(
        /** 只等待被损坏原调用的实际 fence 交付。 */ () => p.records.get(first!.call_id)?.context?.fenced === true
      )
      assert.equal(p.records.get(second!.call_id)!.context!.fenced, false)
      assert.equal(p.f.gateway.status().connections, 1)
    } finally {
      p.close()
    }
  }
)

test(
  '全局批观察 backend 失败关闭原peer，不广播部分观察或重放已完成调用',
  /** 未知批失败沿原timer catch关闭连接，快路径不把异常变为成功。 */ async () => {
    const p = await prepared(2)
    try {
      p.f.store.responseAnchors = /** 精确模拟受保护批端口不可用，不抛载荷或外部路径。 */ () => {
        throw new Error('synthetic_backend_failure')
      }
      p.tick()
      assert.equal(p.f.gateway.status().connections, 0)
      assert.equal(p.f.store.call(p.f.principal.id, p.bindings[0]!.call_id).state, 'responded')
      assert.equal(p.f.store.call(p.f.principal.id, p.bindings[1]!.call_id).state, 'responded')
    } finally {
      p.close()
    }
  }
)
