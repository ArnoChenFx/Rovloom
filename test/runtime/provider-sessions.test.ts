// 组合端口组件回归：治理帧使用真实Wire/receipt writer，native端口是明确拒绝执行的stub。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { composeConnectorSessions, composeGatewaySessions } from '../../src/runtime/provider-sessions.js'
import type { ProviderSessionGroup } from '../../src/runtime/provider-sessions.js'
import { ConnectorAdmissionReceipts } from '../../src/transport/index.js'
import type { Adapter, Connection, ConnectorWireSession } from '../../src/transport/index.js'
import { authenticateAdmissionReceipt } from '../../src/transport/admission-proof.js'
import { boundedJson, decodeWireFrame, encodeWireFrame, MessageWindow } from '../../src/wire/index.js'
import type { AdmissionReceiptRecord } from '../../src/wire/admission.js'
import type { AttemptBinding, AuthenticatedEnvelope, Direction, ProviderKind, V2Target } from '../../src/wire/types.js'

const connection: Connection = {
  machine_id: 'component_machine',
  recovery_generation: 'component_generation',
  connection_epoch: 'component_epoch',
  authenticated: true,
  active: true,
  negotiated: { major: 2, minor: 0, capabilities: ['rpc', 'admission_receipt', 'admission_context'] }
}

/** 两个明确synthetic provider的路由描述；native执行端口始终抛固定错误，不能充当CLI成功后端。 */
function group(kind: ProviderKind) {
  const target = {
    machine_id: connection.machine_id,
    provider_id: kind + '_component',
    profile: 'session' as const,
    session: 'component'
  }
  const binding = {
    machine_id: connection.machine_id,
    provider_id: target.provider_id,
    kind,
    config_ref: kind + '_config',
    binding_revision: 1,
    enabled: true
  }
  const state = {
    closed: false,
    adapters: 0,
    owners: 0,
    calls: 0,
    contexts: 0,
    bytes: 0,
    failing: false,
    reenter: undefined as undefined | (() => void)
  }
  const windows = new Map<Direction, MessageWindow>()
  const context = /** 真实治理codec只读取本测试固定连接和canonical provider，不提供native validator。 */ (
    direction: Direction
  ) => ({
    phase: 'authenticated' as const,
    connection,
    direction,
    resolveProvider: /** 精确目标匹配后才返回同一配置。 */ (selected: V2Target) =>
      boundedJson(selected) === boundedJson(target) ? binding : undefined
  })
  const native = /** 显式缺原生后端的测试stub，不返回执行或结果成功。 */ () => {
    state.calls++
    state.reenter?.()
    throw new Error('stub_native_unavailable_' + kind)
  }
  const adapter: Adapter = {
    encode: /** 保留真实治理帧codec及当前连接验证。 */ (frame, direction) => encodeWireFrame(frame, context(direction)),
    decode: /** 完整解码receipt/heartbeat，缺native上下文时request仍会拒绝。 */ (raw, direction) =>
      decodeWireFrame(raw, context(direction)),
    observeMessage: /** 原组使用真实MessageWindow，组合层另验跨组冲突。 */ (frame, direction) => {
      let window = windows.get(direction)
      if (!window) {
        window = new MessageWindow()
        windows.set(direction, window)
      }
      return window.observe(frame, context(direction), 100)
    },
    checkResult: native,
    checkResultRetention: native,
    encodeResponseObject: native,
    acceptChunk: native,
    planEvidence: native,
    release: native,
    stats: /** 只返回可控制的组件计数，不代表原生上下文存在。 */ () => ({
      closed: state.closed,
      executions: state.contexts,
      responses: 0,
      snapshot_bytes: state.bytes
    }),
    close: /** 记录原端口真实被调用次数，故意不替组合层隐藏重复关闭。 */ () => {
      state.closed = true
      state.adapters++
      if (state.failing) {
        throw new Error('stub_close_failed')
      }
    }
  }
  const session: ConnectorWireSession = {
    adapter,
    readiness: /** 只报告本synthetic组件的固定配置。 */ () => ({
      policy_revision: 'local1',
      peer_policy_revision: 'local1',
      providers: [{ expected: binding, local: binding, native_ready: true }]
    }),
    executeWire: /** 无原生后端，意外执行始终失败。 */ async () => native(),
    close: /** 原owner同样记录调用次数，验证不会因adapter失败而被跳过。 */ () => {
      state.owners++
    }
  }
  const descriptor: ProviderSessionGroup<ConnectorWireSession> = { providers: [{ target, binding }], session }
  const attempt: AttemptBinding = {
    machine_id: connection.machine_id,
    recovery_generation: connection.recovery_generation,
    connection_epoch: connection.connection_epoch,
    call_id: kind + '_call',
    attempt_id: kind + '_attempt',
    native_request_id: kind + '_request',
    target,
    provider_kind: kind,
    binding_revision: 1,
    contract_ref: (kind === 'luvus' ? 'a' : 'b').repeat(64),
    registration: { deadline: 1000, history: null, caller_policy_revision: 'caller1', local_policy_revision: 'local1' }
  }
  return { descriptor, state, target, binding, session, attempt }
}

/** 治理receipt显式fenced，无法授权执行；完整上下文和proof只用于认证边界组件测试，不签发身份。 */
function receipt(binding: AttemptBinding): AdmissionReceiptRecord {
  return {
    binding,
    request_sha256: 'c'.repeat(64),
    dedup_expires_at: 2000,
    context: {
      principal_id: 'component_principal',
      registered_request_sha256: 'd'.repeat(64),
      sequence: 1,
      fenced: true,
      anchor: {
        binding,
        method: 'ping',
        mode: 'strict',
        state: 'dispatching',
        content_status: 'available',
        content_expires_at: 1500,
        dedup_expires_at: 2000
      }
    }
  }
}

/** 只按原record构造标准治理envelope，不创建新的业务ID或原生权限。 */
function frame(
  record: AdmissionReceiptRecord,
  message = record.binding.call_id
): Extract<AuthenticatedEnvelope, { type: 'admission_receipt' }> {
  const { machine_id, recovery_generation, connection_epoch, ...attempt } = record.binding
  return {
    protocol_major: 2,
    protocol_minor: 0,
    message_id: message,
    type: 'admission_receipt',
    machine_id,
    recovery_generation,
    connection_epoch,
    payload: {
      attempt,
      request_sha256: record.request_sha256,
      dedup_expires_at: record.dedup_expires_at,
      context: record.context
    }
  }
}

test(
  '完整target/kind选择原端口，治理codec仍拒绝错epoch，stub不会变成执行成功',
  /** 不启动设备或native进程。 */ () => {
    const a = group('luvus')
    const b = group('herdr')
    const combined = composeGatewaySessions(
      connection,
      [a.descriptor, b.descriptor],
      /** 固定隔离时钟，不访问产品或用户会话。 */ () => 100
    )
    try {
      assert.throws(
        /** 确认Luvus端口收到原binding且明确拒绝执行。 */ () => combined.adapter.checkResult(a.attempt),
        /stub_native_unavailable_luvus/
      )
      assert.throws(
        /** 确认Herdr端口收到原binding且明确拒绝执行。 */ () => combined.adapter.checkResult(b.attempt),
        /stub_native_unavailable_herdr/
      )
      assert.throws(
        /** 另一session不能借相同provider取得原端口。 */ () =>
          combined.adapter.checkResult({ ...a.attempt, target: { ...a.target, session: 'other' } }),
        /provider_binding_mismatch/
      )
      assert.throws(
        /** 篡改provider kind不能切换另一原会话。 */ () =>
          combined.adapter.checkResult({ ...a.attempt, provider_kind: 'herdr' }),
        /provider_binding_mismatch/
      )
      assert.deepEqual([a.state.calls, b.state.calls], [1, 1])
      const raw = boundedJson(frame(receipt(b.attempt)))
      assert.equal(combined.adapter.decode(raw, 'gateway_to_connector').type, 'admission_receipt')
      assert.throws(
        /** 错epoch必须由原治理codec拒绝。 */ () =>
          combined.adapter.decode(raw.replace(connection.connection_epoch, 'other_epoch'), 'gateway_to_connector'),
        /connection_binding_mismatch/
      )
      assert.equal(combined.readiness().providers.length, 2)
    } finally {
      combined.close()
    }
  }
)

test(
  '跨provider共享消息窗口，保留原组去重且拒绝相同ID不同载荷',
  /** 使用真实原MessageWindow。 */ () => {
    const a = group('luvus')
    const b = group('herdr')
    const combined = composeGatewaySessions(
      connection,
      [a.descriptor, b.descriptor],
      /** 固定隔离时钟，不刷新业务期限。 */ () => 100
    )
    try {
      const first = frame(receipt(a.attempt), 'shared_message')
      assert.equal(combined.adapter.observeMessage(first, 'gateway_to_connector'), 'new')
      assert.equal(combined.adapter.observeMessage(first, 'gateway_to_connector'), 'duplicate')
      assert.throws(
        /** 跨provider复用同一消息ID但改变内容必须拒绝。 */ () =>
          combined.adapter.observeMessage(frame(receipt(b.attempt), 'shared_message'), 'gateway_to_connector'),
        /message_id_conflict/
      )
    } finally {
      combined.close()
    }
  }
)

test(
  'opaque receipt只交原持久sink一次，串组proof由原受保护routes拒绝',
  /** 两个真实writer只使用本测试新目录。 */ () => {
    const root = mkdtempSync(join(process.cwd(), '.component-receipts-'))
    const a = group('luvus')
    const b = group('herdr')
    const readers = [a, b].map(
      /** 为各组件创建独立真实receipt writer，不共享路由授权。 */ (part) =>
        new ConnectorAdmissionReceipts({
          path: join(root, part.binding.kind + '.json'),
          mode: 'create',
          ledger_id: part.binding.kind + '_ledger',
          limits: { entries: 8, bytes: 262144 },
          now: /** 原reader使用本用例固定可信时间。 */ () => 100,
          routes: [{ target: part.target, principal_id: 'component_principal' }]
        })
    )
    a.session.admissions = readers[0]!
    b.session.admissions = readers[1]!
    // 认证边界接缝先给原reader交付seq1；组合端口只测试真实fence更新，不伪造native来源放行。
    for (const [index, part] of [a, b].entries()) {
      const initial = receipt(part.attempt)
      readers[index]!.accept(
        authenticateAdmissionReceipt(
          { ...initial, context: { ...initial.context!, fenced: false } },
          /** 认证层测试接缝仅证明本次对象交付，不签发设备身份。 */ () => true
        )
      )
    }
    const combined = composeConnectorSessions(
      connection,
      [a.descriptor, b.descriptor],
      /** 固定组合层测试时钟。 */ () => 100
    )
    try {
      const initial = receipt(a.attempt)
      const record = { ...initial, context: { ...initial.context!, sequence: 2 } }
      const proof = authenticateAdmissionReceipt(record, /** 认证层测试接缝只允许本次已知proof交付。 */ () => true)
      combined.adapter.observeMessage(frame(record), 'gateway_to_connector')
      combined.admissions!.accept(proof)
      assert.equal(readers[0]!.snapshot(a.attempt).binding.call_id, a.attempt.call_id)
      assert.throws(/** 另一原reader不能读取此provider的receipt。 */ () => readers[1]!.snapshot(a.attempt))
      assert.throws(
        /** 未观察新receipt时不得再次消费原proof。 */ () => combined.admissions!.accept(proof),
        /proof_required/
      )
      const other = receipt({ ...a.attempt, call_id: 'cross_call', attempt_id: 'cross_attempt' })
      combined.adapter.observeMessage(frame(receipt(b.attempt)), 'gateway_to_connector')
      assert.throws(
        /** 串组proof必须由原持久路由授权拒绝。 */ () =>
          combined.admissions!.accept(
            authenticateAdmissionReceipt(other, /** 测试证明当前仍有效，不伪造业务或设备身份。 */ () => true)
          ),
        /principal_mismatch/
      )
      assert.throws(
        /** 失败后不能借旧归属向另一个sink交付proof。 */ () =>
          combined.admissions!.accept(
            authenticateAdmissionReceipt(receipt(b.attempt), /** 本次接缝只证明认证对象的当前交付。 */ () => true)
          ),
        /proof_required/
      )
      combined.admissions!.closeEpoch!(connection)
      assert.equal(readers[1]!.snapshot(b.attempt).fenced, true)
    } finally {
      combined.close()
      for (const reader of readers) {
        reader.close()
      }
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  'adapter失败仍逆序释放全部owner，并发和重入不重复调用原close',
  /** 故意失败只用于关闭计量。 */ () => {
    const a = group('luvus')
    const b = group('herdr')
    const combined = composeGatewaySessions(
      connection,
      [a.descriptor, b.descriptor],
      /** 固定关闭组件的隔离时钟。 */ () => 100
    )
    b.state.failing = true
    assert.throws(/** 原adapter失败必须被观察。 */ () => combined.adapter.close(), /close_failed/)
    assert.throws(/** owner清理仍应尝试且保留原失败结果。 */ () => combined.close(), /close_failed/)
    assert.throws(/** 重复关闭不能把失败改判成功。 */ () => combined.close(), /close_failed/)
    assert.deepEqual([a.state.adapters, b.state.adapters, a.state.owners, b.state.owners], [1, 1, 1, 1])
  }
)

test(
  '共享上下文和快照字节预算不能按provider倍增，重入关闭不返回原端口结果',
  /** 只控制统计stub，无真实native资源。 */ () => {
    const a = group('luvus')
    const b = group('herdr')
    const combined = composeGatewaySessions(
      connection,
      [a.descriptor, b.descriptor],
      /** 固定共享预算测试的可信时间。 */ () => 100
    )
    a.state.contexts = 64
    b.state.contexts = 65
    assert.throws(/** 多个provider的上下文总数超额必须拒绝。 */ () => combined.readiness(), /attempt_capacity/)
    assert.deepEqual([a.state.owners, b.state.owners], [1, 1])
    const c = group('luvus')
    const d = group('herdr')
    const bytes = composeGatewaySessions(
      connection,
      [c.descriptor, d.descriptor],
      /** 固定字节预算测试时间。 */ () => 100
    )
    c.state.bytes = 10_000_000
    d.state.bytes = 10_000_000
    assert.throws(/** 多个provider的原快照总量超额必须拒绝。 */ () => bytes.readiness(), /attempt_capacity/)
    const e = group('luvus')
    const f = group('herdr')
    const reentrant = composeGatewaySessions(
      connection,
      [e.descriptor, f.descriptor],
      /** 固定关闭重入测试时间。 */ () => 100
    )
    e.state.reenter = /** 外部回调吞掉重入错误也不能恢复组合关闭fence。 */ () => {
      try {
        reentrant.readiness()
      } catch {
        /* 外部回调吞掉重入错误也不能恢复关闭fence。 */
      }
    }
    assert.throws(/** 原端口回调重入关闭后不得继续正常返回。 */ () => reentrant.adapter.checkResult(e.attempt))
    assert.equal(reentrant.adapter.stats().closed, true)
    reentrant.close()
  }
)

test(
  'epoch清理异步失败仍尝试另一个原sink，并保留关闭失败',
  /** 只构造会拒绝的清理端口，无执行后端。 */ () => {
    const a = group('luvus')
    const b = group('herdr')
    let other = 0
    for (const part of [a, b]) {
      part.session.admissions = {
        accept: /** 本例不交付receipt，意外接收应立即失败。 */ () => {
          throw new Error('unexpected_receipt')
        },
        assertRequest: /** 本例不派发原生请求，意外调用保持拒绝。 */ () => {
          throw new Error('unexpected_request')
        },
        closeEpoch:
          part === a
            ? /** 非法异步清理故意晚拒绝，组合层必须消费且报告失败。 */ ((async () => {
                throw new Error('component_private_cleanup')
              }) as unknown as () => void)
            : /** 另一原sink必须继续被清理一次。 */ () => {
                other++
              }
      }
    }
    const combined = composeConnectorSessions(
      connection,
      [a.descriptor, b.descriptor],
      /** 固定本用例可信时间。 */ () => 100
    )
    assert.throws(
      /** 同步清理不能把Promise当持久epoch fence完成。 */ () => combined.admissions!.closeEpoch!(connection),
      /close_failed/
    )
    assert.equal(other, 1)
    assert.throws(/** 原epoch清理失败在同一个关闭结果中保留。 */ () => combined.close(), /close_failed/)
    assert.deepEqual([a.state.owners, b.state.owners], [1, 1])
  }
)

test(
  '快照聚合保留稳定原getter并逐次复验，不给Herdr补造广告',
  /** 空元数据fixture不证明任何安装能力。 */ () => {
    const a = group('luvus')
    const b = group('herdr')
    const original = Object.freeze([])
    let current = original
    let reads = 0
    a.session.providerSnapshot = /** 原getter显式计数，每次均重新检查来源引用。 */ () => {
      reads++
      return current
    }
    const combined = composeGatewaySessions(connection, [a.descriptor, b.descriptor], /** 固定隔离时钟。 */ () => 100)
    const first = combined.providerSnapshot!()
    assert.equal(combined.providerSnapshot!(), first)
    assert(Object.isFrozen(first))
    assert.equal(reads, 2)
    current = Object.freeze([])
    assert.throws(
      /** 同内容的新数组也不能刷新原generation或被当作稳定getter。 */ () => combined.providerSnapshot!(),
      /snapshot_changed/
    )
    combined.close()
    assert.throws(/** 关闭后不得继续调用原快照getter。 */ () => combined.providerSnapshot!(), /adapter_closed/)
    assert.equal(reads, 3)
  }
)
