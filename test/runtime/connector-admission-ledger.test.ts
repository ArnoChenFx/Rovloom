/** 用真实 Luvus Wire 校验器和合成认证快照验证中性准入；不导入 Herdr 未合代码或打开 Gateway writer。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { createLuvusWireAdapter } from '../../src/integration/luvus-wire.js'
import type { LedgerInvalidation } from '../../src/storage/model.js'
import type { AdmissionContextReader, Connection, TrustedAdmissionSnapshot } from '../../src/transport/index.js'
import { ConnectorAdmissionReceipts } from '../../src/transport/index.js'
import { authenticateAdmissionReceipt } from '../../src/transport/admission-proof.js'
import { admissionRequestDigest, assertBinding, boundedJson, registeredRequestDigest } from '../../src/wire/index.js'
import type { WireEnvelope } from '../../src/wire/types.js'
import { ConnectorAttemptBook, createConnectorAdmissionLedger } from '../../src/runtime/connector-attempts.js'
import { fixture } from '../connector/luvus/helpers.js'

/** 合成快照只提供独立原登记事实，真正的 envelope、原生来源和派发门禁仍由原 Wire 执行。 */
async function admitted() {
  const f = await fixture()
  let snapshot: TrustedAdmissionSnapshot = {
    binding: structuredClone(f.binding),
    principal_id: f.row.principal_id,
    request_sha256: admissionRequestDigest({
      binding: f.binding,
      native_request: f.row.native_request,
      validation: f.row.mode
    }),
    registered_request_sha256: registeredRequestDigest(f.envelope.payload, f.row.principal_id),
    anchor: {
      binding: structuredClone(f.binding),
      method: f.row.method,
      mode: f.row.mode,
      state: 'dispatching',
      content_status: 'available',
      content_expires_at: 60_100,
      dedup_expires_at: 90_100
    },
    sequence: 1,
    fenced: false
  }
  const listeners = new Set<(event: LedgerInvalidation) => void>()
  let readEffect: (() => void) | undefined
  const reader: AdmissionContextReader = {
    /** 模拟独立认证持久 reader；这里从未查询 Gateway Store 或从收到请求生成批准。 */
    snapshot(binding) {
      readEffect?.()
      assertBinding(binding, snapshot.binding)
      return structuredClone(snapshot)
    },
    /** 仅由测试显式提交原快照后发送事件，监听器注销不删除记录。 */
    subscribeInvalidation(listener) {
      listeners.add(listener)
      return /** 只解除本订阅，原快照和时间不变。 */ () => {
        listeners.delete(listener)
      }
    }
  }
  const connection: Connection = {
    ...f.backend.connection(),
    negotiated: {
      major: 2 as const,
      minor: 0,
      capabilities: ['rpc', 'admission_receipt', 'admission_context', 'late_evidence']
    }
  }
  const book = new ConnectorAttemptBook({
    now: /** 独立合成时钟与原 Wire fixture 共用时间基准。 */ () => f.state.now,
    dedupExpires: /** 固定原截止只能由认证 reader 提供。 */ (binding) =>
      reader.snapshot(binding).anchor.dedup_expires_at
  })
  const options = {
    connection,
    routes: [{ target: f.binding.target, principal_id: f.row.principal_id }],
    policies: f.backend.policies,
    receipts: reader,
    book,
    now: /** 单调时间只是检查基准，不能补算原期限。 */ () => f.state.now
  }
  const ledger = createConnectorAdmissionLedger(options)
  const backend = { ...f.backend, ...ledger }
  const wire = createLuvusWireAdapter(backend)
  return {
    f,
    reader,
    book,
    options,
    ledger,
    backend,
    wire,
    /** 只提供独立快照副本，测试改变请求不能间接修改原认证记录。 */ get snapshot() {
      return structuredClone(snapshot)
    },
    /** 测试显式提交新的原账本快照后才发布相应回收事件。 */ update(
      change: Partial<TrustedAdmissionSnapshot>,
      event?: LedgerInvalidation
    ) {
      snapshot = { ...snapshot, ...structuredClone(change) }
      if (event) {
        for (const listener of Array.from(listeners)) {
          listener(structuredClone(event))
        }
      }
    },
    /** 模拟受信 reader 内的同步宿主回调，检查候选暴露范围及关闭 fence。 */ setReadEffect(effect?: () => void) {
      readEffect = effect
    },
    /** 每次都通过原始 Wire decode，不用测试 callback 替代生产 envelope/native gate。 */ decode() {
      return ledger.decode(f.input(), 'gateway_to_connector', wire.decode)
    },
    /** 维护计时器、账本订阅和自建 listener 在本用例结束时统一回收。 */ async close() {
      wire.close()
      ledger.close()
      await f.close()
    }
  }
}

test(
  'neutral Connector ledger commits only after the real Wire native gate and keeps original retention',
  /** 不能拿 receipt 直接构造执行锚点；原 Wire 准入成功才提交正文和原固定期限。 */ async () => {
    const a = await admitted()
    try {
      assert.equal(a.ledger.attempt('call1', 'attempt1'), undefined)
      assert.equal(a.ledger.responseAnchor(a.f.binding), undefined)
      a.f.state.trusted = false
      assert.throws(/** 真实原生来源拒绝后无正文或去重锚点残留。 */ () => a.decode(), /native_source_untrusted/)
      assert.equal(a.ledger.attempt('call1', 'attempt1'), undefined)
      assert.throws(/** 没有原 Wire 成功提交就不能查询共享固定截止。 */ () => a.book.dedupExpires(a.f.binding))
      a.f.state.trusted = true
      assert.equal(a.decode().type, 'request')
      assert.deepEqual(a.ledger.attempt('call1', 'attempt1'), a.f.row)
      assert.equal(a.ledger.dedupExpires(a.f.binding), 90_100)
      a.f.state.now = a.f.binding.registration.deadline
      assert.equal(a.ledger.contentStatus(a.f.binding), 'available')
      assert.equal(a.ledger.responseAnchor(a.f.binding)?.content_expires_at, 60_100)
    } finally {
      await a.close()
    }
  }
)

test(
  'neutral Connector ledger requires context capability, exact protected routes and the original principal',
  /** legacy receipt、单纯 reader 存在或原 principal 不同都不能建立准入。 */ async () => {
    const a = await admitted()
    try {
      assert.throws(
        /** 没有新能力协商时严格路径不得回退旧元数据。 */ () =>
          createConnectorAdmissionLedger({
            ...a.options,
            connection: {
              ...a.options.connection,
              negotiated: { ...a.options.connection.negotiated, capabilities: ['rpc', 'admission_receipt'] }
            }
          }),
        /admission_context_source_required/
      )
      assert.throws(
        /** 相同完整目标不能配置两个不同来源，不能靠映射覆盖保护路由。 */ () =>
          createConnectorAdmissionLedger({ ...a.options, routes: [...a.options.routes, ...a.options.routes] }),
        /connector_route_invalid/
      )
      assert.throws(
        /** 当前只支持单一受保护读取主体，多个目标不能把 principal 混为最近调用者。 */ () =>
          createConnectorAdmissionLedger({
            ...a.options,
            routes: [
              ...a.options.routes,
              { target: { ...a.f.binding.target, provider_id: 'other' }, principal_id: 'other' }
            ]
          }),
        /connector_principal_ambiguous/
      )
      a.update({ principal_id: 'other' })
      assert.throws(
        /** 设备认证不能把任意原 caller 改为本机受保护路由主体。 */ () => a.decode(),
        /admission_principal_mismatch/
      )
      assert.equal(a.ledger.attempt('call1', 'attempt1'), undefined)
    } finally {
      await a.close()
    }
  }
)

for (const field of ['request_sha256', 'registered_request_sha256'] as const) {
  test(
    `neutral Connector ledger checks the original ${field} before real Wire admission`,
    /** 完整绑定摘要和原 Store 登记摘要各有独立含义，不能以其中一个代替另一个。 */ async () => {
      const a = await admitted()
      try {
        a.update({ [field]: '0'.repeat(64) })
        assert.throws(
          /** 正文或原 caller 绑定不符必须在原生许可前拒绝。 */ () => a.decode(),
          /admission_request_mismatch/
        )
        assert.equal(a.ledger.attempt('call1', 'attempt1'), undefined)
        assert.throws(/** 摘要不符不得提交任何共享固定期限。 */ () => a.book.dedupExpires(a.f.binding))
      } finally {
        await a.close()
      }
    }
  )
}

test(
  'neutral Connector ledger hides candidates from receipt callbacks and fences changes inside Wire verification',
  /** reader 回调不能借候选证明自己；原验证期间原快照变化也不能留下准入记录。 */ async () => {
    const a = await admitted()
    try {
      let reads = 0
      a.setReadEffect(
        /** 即使 reader 在原 Wire 调用范围内执行，也不能观察尚未提交的请求。 */ () => {
          reads++
          assert.equal(a.ledger.attempt('call1', 'attempt1'), undefined)
        }
      )
      a.decode()
      assert(reads > 0)
      a.setReadEffect()
      a.ledger.release(a.f.binding)
      assert.equal(a.ledger.attempt('call1', 'attempt1'), undefined)
      assert.equal(a.ledger.dedupExpires(a.f.binding), 90_100)
    } finally {
      await a.close()
    }
  }
)

for (const damage of ['sequence', 'same-sequence-content', 'expiry', 'fence'] as const) {
  test(
    `neutral Connector ledger rejects a committed snapshot ${damage} change`,
    /** 已提交原身份、固定截止和单调序列均不能被后续快照覆盖或恢复。 */ async () => {
      const a = await admitted()
      try {
        a.decode()
        const original = a.snapshot
        if (damage === 'sequence') {
          a.update({ sequence: 0 })
        } else if (damage === 'same-sequence-content') {
          a.update({ anchor: { ...a.snapshot.anchor, state: 'connector_accepted' } })
        } else if (damage === 'expiry') {
          a.update({ sequence: 2, anchor: { ...a.snapshot.anchor, dedup_expires_at: 90_101 } })
        } else {
          a.update({ sequence: 2, fenced: true })
        }
        assert.throws(/** 受保护 reader 的不一致也必须被消费端拒绝。 */ () => a.ledger.attempt('call1', 'attempt1'))
        assert.equal(a.book.dedupExpires(a.f.binding), 90_100)
        a.update(original)
        assert.throws(
          /** 同一失效 epoch 内恢复旧快照不能复活已经丢弃的许可。 */ () => a.ledger.attempt('call1', 'attempt1'),
          /attempt_anchor_unavailable/
        )
      } finally {
        await a.close()
      }
    }
  )
}

test(
  'neutral Connector ledger applies committed content reclamation before notifying backend subscribers',
  /** 回收通知到达后原文已经不可取，最小响应锚点仍沿用原 content/dedup 截止。 */ async () => {
    const a = await admitted()
    try {
      a.decode()
      let contentEvents = 0
      let visible: unknown = 'unobserved'
      let status: unknown = 'unobserved'
      const stop = a.ledger.subscribeInvalidation(
        /** 通知回调本身读取账本也只能看到已提交的回收结果。 */ (event) => {
          if (event.kind === 'content') {
            contentEvents++
            visible = a.ledger.attempt('call1', 'attempt1')
            status = a.ledger.contentStatus(a.f.binding)
          }
        }
      )
      a.update(
        { sequence: 2, anchor: { ...a.snapshot.anchor, content_status: 'discarded' } },
        { kind: 'content', machine_id: 'm1', call_id: 'call1' }
      )
      assert.equal(contentEvents, 1)
      assert.equal(visible, undefined)
      assert.equal(status, 'discarded')
      assert.equal(a.ledger.responseAnchor(a.f.binding)?.dedup_expires_at, 90_100)
      assert.throws(/** 真实 Wire 也不得从已释放正文恢复新派发。 */ () => a.decode(), /attempt_anchor_unavailable/)
      stop()
    } finally {
      await a.close()
    }
  }
)

test(
  'neutral Connector ledger expires by original content TTL and closes only its epoch',
  /** 执行 deadline 与正文 TTL 不混用，关闭不清共享去重簿，重连不能改写旧 epoch。 */ async () => {
    const a = await admitted()
    try {
      a.decode()
      a.f.state.now = 60_100
      assert.equal(a.ledger.contentStatus(a.f.binding), 'expired')
      assert.equal(a.ledger.attempt('call1', 'attempt1'), undefined)
      assert.equal(a.ledger.dedupExpires(a.f.binding), 90_100)
      a.ledger.close()
      assert.equal(a.ledger.currentPrincipal(), undefined)
      assert.equal(a.ledger.connection().active, false)
      assert.equal(a.book.dedupExpires(a.f.binding), 90_100)
      const next = createConnectorAdmissionLedger({
        ...a.options,
        connection: { ...a.options.connection, connection_epoch: 'e2' }
      })
      try {
        const changed = { ...a.f.envelope, connection_epoch: 'e2' }
        assert.throws(
          /** 旧 receipt 原 binding 不得借新认证连接迁移。 */ () =>
            next.decode(boundedJson(changed), 'gateway_to_connector', a.wire.decode)
        )
      } finally {
        next.close()
      }
    } finally {
      await a.close()
    }
  }
)

test(
  'neutral Connector ledger refuses a local retention book that differs from the original dedup expiry',
  /** 旧兼容配置仍可存在，但严格路径不会让本机 retention 覆盖已认证的原固定截止。 */ async () => {
    const a = await admitted()
    const wrongBook = new ConnectorAttemptBook({
      retention_ms: 60_000,
      now: /** 独立时间相同仍不足以证明相对 TTL 等于 Gateway 原记录。 */ () => a.f.state.now
    })
    const ledger = createConnectorAdmissionLedger({ ...a.options, book: wrongBook })
    try {
      let called = false
      assert.throws(
        /** 不同原期限在调用实际 Wire 校验器之前就拒绝。 */ () =>
          ledger.decode(
            a.f.input(),
            'gateway_to_connector',
            /** 观察是否到达下游，失败时此回调不能被调用。 */ (input, direction) => {
              called = true
              return a.wire.decode(input, direction)
            }
          ),
        /attempt_request_mismatch/
      )
      assert.equal(called, false)
      assert.equal(ledger.attempt('call1', 'attempt1'), undefined)
    } finally {
      ledger.close()
      await a.close()
    }
  }
)

test(
  'neutral Connector ledger rejects policy revision drift for admission but preserves original response metadata',
  /** dispatch 的原修订不能复用，但政策变更不应在元数据层误阻止真实 Wire 的最小晚到补证。 */ async () => {
    const a = await admitted()
    try {
      const policies = a.f.backend.policies('synthetic')
      policies.caller.revision = 'caller2'
      assert.throws(/** 新准入必须匹配原登记 caller 政策。 */ () => a.decode(), /policy_revision_stale/)
      assert.equal(a.ledger.attempt('call1', 'attempt1'), undefined)
      policies.caller.revision = 'caller1'
      a.decode()
      policies.caller.revision = 'caller2'
      policies.local.revision = 'local2'
      policies.caller.grants = []
      policies.local.grants = []
      assert.equal(a.ledger.responseAnchor(a.f.binding)?.state, 'dispatching')
      assert.equal(a.ledger.contentStatus(a.f.binding), 'available')
      assert.equal(a.ledger.attempt('call1', 'attempt1')?.principal_id, 'synthetic')
      assert.throws(
        /** 再准入仍核新的当前政策，旧元数据并未变成执行或读取权限。 */ () => a.decode(),
        /policy_revision_stale/
      )
    } finally {
      await a.close()
    }
  }
)

test(
  'neutral Connector ledger rejects receipt changes made inside the actual native Wire gate',
  /** 原 native gate 已执行仍不足以提交；同次准入中的原账本变化必须由最终 fence 捕获。 */ async () => {
    const a = await admitted()
    try {
      a.backend.authority = /** 在真实 Wire 分类门禁里提交新的原状态，未调用任何自制 decoder。 */ (
        attempt,
        binding
      ) => {
        a.update({ sequence: 2, anchor: { ...a.snapshot.anchor, state: 'connector_accepted' } })
        return a.f.backend.authority(attempt, binding)
      }
      assert.throws(/** 前后快照不同不能提交正文和去重摘要。 */ () => a.decode(), /admission_context_conflict/)
      assert.equal(a.ledger.attempt('call1', 'attempt1'), undefined)
      assert.throws(/** 实际门禁之后失败也不建立共享固定期限。 */ () => a.book.dedupExpires(a.f.binding))
    } finally {
      await a.close()
    }
  }
)

test(
  'neutral Connector ledger fences a close in the final book source lookup before committing metadata',
  /** book 复核 reader 时也可能同步关闭 epoch，最终提交 fence 不能只放在原 Wire 回调内。 */ async () => {
    const a = await admitted()
    let lookups = 0
    const book = new ConnectorAttemptBook({
      now: /** 使用同一独立时间，只对第二次来源查询注入关闭。 */ () => a.f.state.now,
      dedupExpires: /** 首次预查成功，真正提交前的再次查询触发关闭。 */ (binding) => {
        lookups++
        if (lookups === 2) {
          ledger.close()
        }
        return a.reader.snapshot(binding).anchor.dedup_expires_at
      }
    })
    const ledger = createConnectorAdmissionLedger({ ...a.options, book })
    const wire = createLuvusWireAdapter({ ...a.f.backend, ...ledger })
    try {
      assert.throws(
        /** 真实原 Wire 已返回后发生关闭也不能留下已提交的摘要。 */ () =>
          ledger.decode(a.f.input(), 'gateway_to_connector', wire.decode),
        /adapter_closed/
      )
      assert.equal(lookups, 2)
      assert.throws(/** 后置关闭拒绝时不能留本地准入记录。 */ () => book.dedupExpires(a.f.binding))
      assert.equal(ledger.attempt('call1', 'attempt1'), undefined)
    } finally {
      wire.close()
      ledger.close()
      await a.close()
    }
  }
)

test(
  'neutral Connector ledger accepts same-sequence irreversible local expiry and epoch fences',
  /** 真实 reader 本机 floor 不改原序列；消费端允许收紧而不能把它误判为原状态重写。 */ async () => {
    const a = await admitted()
    try {
      a.decode()
      a.f.state.now = 60_100
      a.update({ anchor: { ...a.snapshot.anchor, content_status: 'expired' } })
      assert.equal(a.ledger.contentStatus(a.f.binding), 'expired')
      a.update({ fenced: true })
      let fences = 0
      a.ledger.subscribeInvalidation(
        /** 只计数已应用的 fence，不读取或输出任何原文。 */ (event) => {
          if (event.kind === 'fence') {
            fences++
          }
        }
      )
      assert.throws(
        /** 同序列本机 epoch fence 仍永久拒绝旧许可。 */ () => a.ledger.responseAnchor(a.f.binding),
        /attempt_anchor_unavailable/
      )
      assert.equal(fences, 1)
      assert.equal(a.book.dedupExpires(a.f.binding), 90_100)
    } finally {
      await a.close()
    }
  }
)

test(
  'neutral Connector ledger uses real durable receipt snapshots for local TTL and epoch fences',
  /** 真实持久 reader 与原 Wire 组合验证同序列 floor，不用测试 snapshot 重写代替正式读取路径。 */ async () => {
    const a = await admitted()
    const receipts = new ConnectorAdmissionReceipts({
      path: join(a.f.root, 'neutral-admission.json'),
      mode: 'create',
      ledger_id: 'neutral_admission_fixture',
      routes: a.options.routes,
      limits: { entries: 8, bytes: 262_144 },
      now: /** 真实 reader 的持久高水位使用本用例独立合成时间。 */ () => a.f.state.now
    })
    const initial = a.snapshot
    receipts.accept(
      authenticateAdmissionReceipt(
        {
          binding: initial.binding,
          request_sha256: initial.request_sha256,
          dedup_expires_at: initial.anchor.dedup_expires_at,
          context: {
            principal_id: initial.principal_id,
            registered_request_sha256: initial.registered_request_sha256,
            anchor: initial.anchor,
            sequence: initial.sequence,
            fenced: initial.fenced
          }
        },
        /** 仅认证层单元夹具证明交付；生产只能由实际 transport socket 提供 opaque proof。 */ () => true
      )
    )
    const book = new ConnectorAttemptBook({
      now: /** 固定持久 receipt 与 book 采用同一独立时间基准。 */ () => a.f.state.now,
      dedupExpires: /** 只查本机独立接收账本，不打开 Gateway writer。 */ (binding) => receipts.dedupExpires(binding)
    })
    const ledger = createConnectorAdmissionLedger({ ...a.options, receipts, book })
    const wire = createLuvusWireAdapter({ ...a.f.backend, ...ledger })
    try {
      const legacy = structuredClone(a.f.envelope)
      legacy.payload.attempt.call_id = 'legacycall'
      legacy.payload.attempt.attempt_id = 'legacyattempt'
      const legacyBinding = { ...a.f.binding, call_id: 'legacycall', attempt_id: 'legacyattempt' }
      receipts.accept(
        authenticateAdmissionReceipt(
          {
            binding: legacyBinding,
            request_sha256: admissionRequestDigest({
              binding: legacyBinding,
              native_request: a.f.row.native_request,
              validation: a.f.row.mode
            }),
            dedup_expires_at: 90_100
          },
          /** 旧协议证明虽可持久接收，但不会因此拥有新的完整原上下文。 */ () => true
        )
      )
      assert.throws(
        /** 新能力协商不能把旧 receipt 自动升级为严格 H1 准入。 */ () =>
          ledger.decode(boundedJson(legacy), 'gateway_to_connector', wire.decode),
        /admission_context_required/
      )
      assert.equal(ledger.decode(a.f.input(), 'gateway_to_connector', wire.decode).type, 'request')
      assert.equal(ledger.attempt('call1', 'attempt1')?.principal_id, 'synthetic')
      a.f.state.now = 60_100
      assert.equal(ledger.contentStatus(a.f.binding), 'expired')
      assert.equal(ledger.attempt('call1', 'attempt1'), undefined)
      assert.equal(receipts.snapshot(a.f.binding).sequence, 1)
      assert.equal(ledger.responseAnchor(a.f.binding)?.dedup_expires_at, 90_100)
      receipts.closeEpoch(a.options.connection)
      assert.equal(receipts.snapshot(a.f.binding).sequence, 1)
      assert.equal(receipts.snapshot(a.f.binding).fenced, true)
      assert.throws(
        /** 同序列 epoch floor 也不能恢复旧来源。 */ () => ledger.responseAnchor(a.f.binding),
        /attempt_anchor_unavailable/
      )
      assert.equal(book.dedupExpires(a.f.binding), 90_100)
    } finally {
      wire.close()
      ledger.close()
      receipts.close()
      await a.close()
    }
  }
)

for (const effect of ['reader-close', 'release-during-wire', 'clock-rollback'] as const) {
  test(
    `neutral Connector ledger fences ${effect} without committing or clearing shared records`,
    /** 宿主回调内的关闭、释放或时钟异常不能越过最后一次提交边界，也不能清除已有墓碑。 */ async () => {
      const a = await admitted()
      try {
        if (effect === 'reader-close') {
          a.setReadEffect(/** reader 回调同步关闭本 epoch，返回的旧快照不得继续提交。 */ () => a.ledger.close())
          assert.throws(/** 回调关闭后的数据不能成为原请求来源。 */ () => a.decode(), /adapter_closed/)
          assert.throws(/** 关闭发生在准入前，不得保存去重记录。 */ () => a.book.dedupExpires(a.f.binding))
        } else if (effect === 'release-during-wire') {
          a.backend.authority = /** 实际原 Wire 门禁内部释放候选，不能在门禁结束后重新登记。 */ (attempt, binding) => {
            a.ledger.release(a.f.binding)
            return a.f.backend.authority(attempt, binding)
          }
          assert.throws(/** 已释放候选不能在外层成功提交。 */ () => a.decode())
          assert.throws(/** 失败释放边界不留下新的固定期限。 */ () => a.book.dedupExpires(a.f.binding))
        } else {
          a.decode()
          a.f.state.now = 99
          assert.throws(/** 先拒绝不可信时钟并关闭来源。 */ () => a.ledger.now(), /clock_untrusted/)
          a.f.state.now = 100
          assert.equal(a.book.dedupExpires(a.f.binding), 90_100)
          assert.equal(a.ledger.connection().active, false)
        }
        assert.equal(a.ledger.attempt('call1', 'attempt1'), undefined)
      } finally {
        await a.close()
      }
    }
  )
}

test(
  'neutral Connector ledger accepts late response metadata but cannot re-admit unknown or responded work',
  /** 已派发后的最小锚点可服务真实响应证据，不能重新成为原请求的执行准入。 */ async () => {
    const a = await admitted()
    try {
      const initial = a.snapshot
      a.update({ sequence: 2, anchor: { ...initial.anchor, state: 'outcome_unknown' } })
      assert.throws(/** 首次看到的 unknown 也不能先污染准入簿。 */ () => a.decode(), /attempt_anchor_unavailable/)
      assert.throws(/** 未准入记录不会因为已有原响应元数据而登记本地摘要。 */ () => a.book.dedupExpires(a.f.binding))
      // 只重置本测试的合成 reader 以开始另一独立场景，生产 reader 不允许状态回退。
      a.update(initial)
      a.decode()
      a.update({ sequence: 2, anchor: { ...a.snapshot.anchor, state: 'outcome_unknown' } })
      assert.equal(a.ledger.responseAnchor(a.f.binding)?.state, 'outcome_unknown')
      assert.throws(/** unknown 只允许补证，不能重新进入候选。 */ () => a.decode(), /attempt_anchor_unavailable/)
      a.update({
        sequence: 3,
        anchor: {
          ...a.snapshot.anchor,
          state: 'responded',
          evidence: { response_hash: 'a'.repeat(64), response_bytes: 128 }
        }
      })
      assert.equal(a.ledger.responseAnchor(a.f.binding)?.state, 'responded')
      assert.throws(/** 已响应记录也不能建立新的派发准入。 */ () => a.decode(), /attempt_anchor_unavailable/)
      assert.equal(a.book.dedupExpires(a.f.binding), 90_100)
    } finally {
      await a.close()
    }
  }
)

test(
  'neutral Connector ledger rechecks close after content notifications before returning response metadata',
  /** 真实后端监听器可同步关闭 epoch，回收通知结束后不能再交付旧来源元数据。 */ async () => {
    const a = await admitted()
    try {
      a.decode()
      a.ledger.subscribeInvalidation(
        /** 模拟后端在收到回收通知后同步关闭所属会话。 */ (event) => {
          if (event.kind === 'content') {
            a.ledger.close()
          }
        }
      )
      a.f.state.now = 60_100
      assert.throws(
        /** 事件回调关闭必须在 getter 返回前生效。 */ () => a.ledger.responseAnchor(a.f.binding),
        /adapter_closed/
      )
      assert.equal(a.ledger.currentPrincipal(), undefined)
      assert.equal(a.book.dedupExpires(a.f.binding), 90_100)
    } finally {
      await a.close()
    }
  }
)

test(
  'neutral Connector ledger fences a close inside a shared book lookup before returning dedup expiry',
  /** 独立 book 回调与 reader 一样受最终 epoch fence 约束，不能在关闭后继续派发 claim。 */ async () => {
    const a = await admitted()
    let stopOnLookup = false
    const book = new ConnectorAttemptBook({
      now: /** 只在明确测试阶段关闭 ledger，首次真实准入仍通过原 Wire。 */ () => {
        if (stopOnLookup) {
          ledger.close()
        }
        return a.f.state.now
      },
      dedupExpires: /** 固定原期限仍只来自独立认证快照。 */ (binding) =>
        a.reader.snapshot(binding).anchor.dedup_expires_at
    })
    const ledger = createConnectorAdmissionLedger({ ...a.options, book })
    const wire = createLuvusWireAdapter({ ...a.f.backend, ...ledger })
    try {
      ledger.decode(a.f.input(), 'gateway_to_connector', wire.decode)
      stopOnLookup = true
      assert.throws(
        /** 回调虽然返回数值，旧 epoch 的 getter 也必须拒绝。 */ () => ledger.dedupExpires(a.f.binding),
        /adapter_closed/
      )
      stopOnLookup = false
      assert.equal(book.dedupExpires(a.f.binding), 90_100)
      assert.equal(ledger.connection().active, false)
    } finally {
      wire.close()
      ledger.close()
      await a.close()
    }
  }
)

test(
  'neutral Connector ledger admits B when its snapshot expires unrelated A through the real receipt clock',
  /** B 的 receipt 先到、request 跨过 A 的正文截止时，仅回收 A，不能把 B 误判成上下文失效。 */ async () => {
    const a = await admitted()
    const receipts = new ConnectorAdmissionReceipts({
      path: join(a.f.root, 'two-call-admission.json'),
      mode: 'create',
      ledger_id: 'two_call_admission_fixture',
      routes: a.options.routes,
      limits: { entries: 8, bytes: 262_144 },
      now: /** 原 receipt 的实际持久时钟在两条调用之间推进。 */ () => a.f.state.now
    })
    const first = a.snapshot
    /** 只在合成认证端构造独立交付，不从 Wire request 自建 Connector 权限。 */
    function accept(snapshot: TrustedAdmissionSnapshot): void {
      receipts.accept(
        authenticateAdmissionReceipt(
          {
            binding: snapshot.binding,
            request_sha256: snapshot.request_sha256,
            dedup_expires_at: snapshot.anchor.dedup_expires_at,
            context: {
              principal_id: snapshot.principal_id,
              registered_request_sha256: snapshot.registered_request_sha256,
              anchor: snapshot.anchor,
              sequence: snapshot.sequence,
              fenced: snapshot.fenced
            }
          },
          /** 本测试认证夹具只接受自己建立的短期交付。 */ () => true
        )
      )
    }
    accept(first)
    const book = new ConnectorAttemptBook({
      now: /** book 与 reader 使用同一独立时间，但不能自算原截止。 */ () => a.f.state.now,
      dedupExpires: /** 完整原绑定与去重截止继续取真实持久 reader。 */ (binding) => receipts.dedupExpires(binding)
    })
    const ledger = createConnectorAdmissionLedger({ ...a.options, receipts, book })
    const wire = createLuvusWireAdapter({ ...a.f.backend, ...ledger })
    try {
      ledger.decode(a.f.input(), 'gateway_to_connector', wire.decode)
      const binding = structuredClone(a.f.binding)
      binding.call_id = 'call2'
      binding.attempt_id = 'attempt2'
      binding.native_request_id = 'native_2'
      binding.registration.deadline = 110_000
      const { machine_id: _machine, recovery_generation: _generation, connection_epoch: _epoch, ...identity } = binding
      const payload = { ...structuredClone(a.f.envelope.payload), attempt: identity }
      const second: TrustedAdmissionSnapshot = {
        ...first,
        binding,
        request_sha256: admissionRequestDigest({
          binding,
          native_request: a.f.row.native_request,
          validation: 'strict'
        }),
        registered_request_sha256: registeredRequestDigest(payload, first.principal_id),
        anchor: { ...first.anchor, binding, content_expires_at: 120_000, dedup_expires_at: 150_000 }
      }
      a.f.state.now = 60_099
      accept(second)
      const events: LedgerInvalidation[] = []
      ledger.subscribeInvalidation(/** 只记录已提交的回收身份，不保留业务正文。 */ (event) => events.push(event))
      a.f.state.now = 60_100
      const frame = { ...structuredClone(a.f.envelope), message_id: 'message2', payload }
      assert.equal(ledger.decode(boundedJson(frame), 'gateway_to_connector', wire.decode).type, 'request')
      assert.equal(ledger.attempt('call2', 'attempt2')?.binding.call_id, 'call2')
      assert.equal(ledger.attempt('call1', 'attempt1'), undefined)
      assert.equal(ledger.contentStatus(a.f.binding), 'expired')
      assert(
        events.some(
          /** A 的真实本机 TTL 回收必须实际发生，不能通过关闭维护掩盖竞态。 */ (event) =>
            event.kind === 'content' && event.call_id === 'call1'
        )
      )
      assert.equal(book.dedupExpires(a.f.binding), 90_100)
      assert.equal(ledger.dedupExpires(binding), 150_000)
    } finally {
      wire.close()
      ledger.close()
      receipts.close()
      await a.close()
    }
  }
)

test(
  'neutral Connector ledger rejects asynchronous verification without committing an attempt',
  /** 同步 Wire 提交不能把 Promise 返回误作完成，候选句柄在拒绝后不可见。 */ async () => {
    const a = await admitted()
    try {
      assert.throws(
        /** 显式破坏可信接口约定，消费端仍不能交付异步准入成功。 */ () =>
          a.ledger.decode(
            a.f.input(),
            'gateway_to_connector',
            /** 合成非法异步 decoder 不替代实际成功门禁。 */ (() => Promise.resolve(a.f.envelope)) as unknown as (
              input: string | Uint8Array,
              direction: 'gateway_to_connector' | 'connector_to_gateway'
            ) => WireEnvelope
          ),
        /synchronous_connector_admission_required/
      )
      assert.equal(a.ledger.attempt('call1', 'attempt1'), undefined)
    } finally {
      await a.close()
    }
  }
)
