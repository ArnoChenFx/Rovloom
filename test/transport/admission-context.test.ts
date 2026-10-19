// 验证认证上下文的原始登记事实、提交后跨进程失效与不可逆持久收紧，夹具不构成生产许可。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConnectorAdmissionReceipts, createConnector } from '../../src/transport/index.js'
import { GatewayError } from '../../src/contracts.js'
import { authenticateAdmissionReceipt } from '../../src/transport/admission-proof.js'
import {
  admissionRequestDigest,
  admissionRegisteredRequestDigest,
  registeredRequestDigest,
  boundedJson
} from '../../src/wire/index.js'
import type { AdmissionRequest, AdmissionReceiptRecord, TrustedAdmissionSnapshot } from '../../src/wire/index.js'
import { binding } from '../wire/helpers.js'
import { fixture, until } from './helpers.js'

/** workspace 私有祖先满足真实持久文件边界，不把世界可写目录当受保护路由来源。 */
function directory(): string {
  return mkdtempSync(join(fileURLToPath(new URL('../../', import.meta.url)), '.context-test-'))
}

/** 单元夹具明确合成通道证明；跨进程用例必须经过真实 transport 私有接收路径。 */
function deliver(receipts: ConnectorAdmissionReceipts, record: AdmissionReceiptRecord): void {
  receipts.accept(authenticateAdmissionReceipt(record, /** 单元同步合成 proof 没有生产效力。 */ () => true))
}

/** 同一完整绑定同时登记自定义原帧摘要与 Store 原算法摘要，三类截止各自固定。 */
function contextRecord(): { request: AdmissionRequest; record: AdmissionReceiptRecord } {
  const request: AdmissionRequest = {
    binding: structuredClone(binding),
    native_request: { method: 'task.add', params: { title: 'synthetic' } },
    validation: 'strict'
  }
  return {
    request,
    record: {
      binding: request.binding,
      request_sha256: admissionRequestDigest(request),
      dedup_expires_at: 3000,
      context: {
        principal_id: 'synthetic',
        registered_request_sha256: admissionRegisteredRequestDigest(request, 'synthetic'),
        sequence: 1,
        fenced: false,
        anchor: {
          binding: structuredClone(request.binding),
          method: 'task.add',
          mode: 'strict',
          state: 'dispatching',
          content_status: 'available',
          content_expires_at: 1500,
          dedup_expires_at: 3000
        }
      }
    }
  }
}

/** 为每个用例配置独立受保护路由和文件，保持 principal 与完整 Target 同源。 */
function setup() {
  const root = directory()
  const input = contextRecord()
  let now = 100
  const options = {
    path: join(root, 'receipts.json'),
    mode: 'create' as const,
    ledger_id: 'context_receipts',
    limits: { entries: 16, bytes: 262_144 },
    routes: [{ target: input.request.binding.target, principal_id: 'synthetic' }],
    now: /** 测试明确控制持久高水位，不从 receipt 或本机查询刷新截止。 */ () => now
  }
  const receipts = new ConnectorAdmissionReceipts(options)
  return {
    ...input,
    options,
    receipts,
    /** 精确推进测试时钟，验证原 TTL 而非 sleep。 */ time(value: number) {
      now = value
    },
    /** 释放唯一 writer 后删除隔离元数据。 */ close() {
      receipts.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

test(
  'context principal, full Target route and Store registration digest are independent mandatory facts',
  /** 旧 receipt 仍可使用，但不能升级成 H1；完整上下文缺受保护路由一律拒绝。 */ () => {
    const f = setup()
    const otherRoot = directory()
    const missing = new ConnectorAdmissionReceipts({
      ...f.options,
      path: join(otherRoot, 'receipts.json'),
      routes: undefined
    })
    try {
      const { machine_id: _m, recovery_generation: _g, connection_epoch: _e, ...attempt } = f.request.binding
      assert.equal(
        f.record.context!.registered_request_sha256,
        registeredRequestDigest(
          {
            attempt,
            expected_binding_revision: attempt.binding_revision,
            native_request: f.request.native_request,
            validation: f.request.validation
          },
          'synthetic'
        )
      )
      assert.throws(
        /** 同形 JSON 里的 principal 不是本机路由来源。 */ () => deliver(missing, f.record),
        /admission_principal_mismatch/
      )
      const { context: _legacyContext, ...legacy } = f.record
      deliver(missing, legacy)
      assert.equal(missing.dedupExpires(f.request.binding), 3000)
      assert.throws(
        /** 旧原截止不能被当成完整 H1 原始上下文。 */ () => missing.snapshot(f.request.binding),
        /admission_context_required/
      )
      assert.throws(
        /** 主体必须与完整 Target 本机路由同时相同。 */ () =>
          deliver(f.receipts, { ...f.record, context: { ...f.record.context!, principal_id: 'other' } }),
        /admission_principal_mismatch/
      )
      const wrong = structuredClone(f.record)
      wrong.context!.anchor.binding.connection_epoch = 'wrong_epoch'
      assert.throws(/** 内外 anchor 不能分属两条连接。 */ () => deliver(f.receipts, wrong), /attempt_binding_mismatch/)
      deliver(f.receipts, f.record)
      f.receipts.assertRequest(f.request)
      assert.equal(f.receipts.snapshot(f.request.binding).principal_id, 'synthetic')
      const copy = f.receipts.snapshot(f.request.binding)
      copy.anchor.content_expires_at = 99
      assert.equal(f.receipts.snapshot(f.request.binding).anchor.content_expires_at, 1500)
      const data = readFileSync(f.options.path)
      f.receipts.close()
      assert.throws(
        /** 打开已有完整记录同样要求原受保护路由，不能由文件自证主体。 */ () =>
          new ConnectorAdmissionReceipts({ ...f.options, mode: 'open', routes: undefined }),
        /admission_principal_mismatch/
      )
      assert.deepEqual(readFileSync(f.options.path), data)
    } finally {
      missing.close()
      rmSync(otherRoot, { recursive: true, force: true })
      f.close()
    }
  }
)

test(
  'context capability requires an epoch fence and cleanup continues after a failing fence hook',
  /** 真实 welcome 验证新端口；关闭失败与违规异步拒绝都不能阻止资源回收或导致二次清理。 */ async () => {
    const unhandled: unknown[] = []
    /** 只保存是否发生未处理拒绝，不暴露错误内容。 */
    function rejected(error: unknown): void {
      unhandled.push(error)
    }
    process.on('unhandledRejection', rejected)
    try {
      for (const fault of ['missing', 'throws', 'async'] as const) {
        const offer = {
          major: 2,
          minor: 0,
          capabilities: ['rpc', 'admission_receipt', 'admission_context'],
          required: ['rpc', 'admission_receipt', 'admission_context']
        }
        const f = fixture({ offer })
        const device = f.pair('context_epoch_' + fault)
        const order: string[] = []
        let sessions = 0
        const client = createConnector({
          url: f.gateway.url,
          developmentLoopback: true,
          offer,
          credential: /** 使用真实隔离凭据经过 welcome。 */ () => device.credential,
          limits: { reconnect_ms: 10_000 },
          /** 只有真实 welcome 才交付该故障会话，不直接调用 transport 内部清理函数。 */
          session(connection) {
            sessions++
            const owner = f.session(connection)
            return {
              ...owner,
              admissions: {
                accept: /** 本测试不派发请求，不伪造接收成功。 */ () => {},
                assertRequest: /** 本测试不提供执行许可。 */ () => {},
                ...(fault === 'missing'
                  ? {}
                  : {
                      /** 故障端口必须只调用一次且早于资源清理，异步拒绝也会被消费。 */
                      closeEpoch() {
                        order.push('epoch')
                        if (fault === 'throws') {
                          throw new Error('synthetic_fence_failure')
                        }
                        return Promise.reject(new Error('synthetic_async_fence_failure'))
                      }
                    })
              },
              executeWire: /** 该会话不应执行任何工作。 */ async () => {
                throw new Error('unexpected_execution')
              },
              /** 即使 fence 失败，原资源也必须确定性释放一次。 */
              close() {
                order.push('session')
                owner.close?.()
              }
            }
          }
        })
        try {
          if (fault === 'missing') {
            await until(
              /** 缺 mandatory fence 在真实 welcome 后关闭。 */ () =>
                sessions === 1 && client.status().phase === 'disconnected'
            )
          } else {
            await until(/** 接口齐全的连接可完成握手，失败只在关闭发生。 */ () => client.status().phase === 'ready')
          }
          client.stop()
          client.stop()
          await new Promise<void>(/** 让违规异步 hook 的拒绝结算。 */ (resolve) => setImmediate(resolve))
          assert.deepEqual(order, fault === 'missing' ? ['session'] : ['epoch', 'session'])
          assert.equal(client.status().phase, 'stopped')
          assert.deepEqual(unhandled, [])
        } finally {
          client.stop()
          f.stop()
        }
      }
    } finally {
      process.removeListener('unhandledRejection', rejected)
    }
  }
)

test(
  'context updates preserve original facts, ordered sequence, evidence and irreversible invalidations',
  /** 状态与内容只能单调推进；旧消息、跳号和期限变化均不能复活执行或补造许可。 */ () => {
    const f = setup()
    const events: string[] = []
    f.receipts.subscribeInvalidation(
      /** 只观察持久提交后的最小事件。 */ (event) => {
        events.push(event.kind)
      }
    )
    try {
      for (const candidate of [
        { ...f.record, context: { ...f.record.context!, sequence: 2 } },
        { ...f.record, context: { ...f.record.context!, fenced: true } }
      ]) {
        assert.throws(
          /** fence 或后续 sequence 都不能凭空创建登记。 */ () => deliver(f.receipts, candidate),
          /admission_receipt_expired/
        )
      }
      deliver(f.receipts, f.record)
      const accepted: AdmissionReceiptRecord = {
        ...f.record,
        context: {
          ...f.record.context!,
          sequence: 2,
          anchor: { ...f.record.context!.anchor, state: 'connector_accepted' }
        }
      }
      deliver(f.receipts, accepted)
      assert.throws(
        /** 已收更新后不能回放 sequence1。 */ () => deliver(f.receipts, f.record),
        /admission_context_conflict/
      )
      assert.throws(
        /** 跳号不猜测缺失的状态。 */ () =>
          deliver(f.receipts, { ...accepted, context: { ...accepted.context!, sequence: 4 } }),
        /admission_context_conflict/
      )
      for (const anchor of [
        { ...accepted.context!.anchor, content_expires_at: 1600 },
        { ...accepted.context!.anchor, method: 'task.remove' },
        { ...accepted.context!.anchor, mode: 'raw-contract' as const }
      ]) {
        assert.throws(
          /** 三类截止、模式与方法均不随后续交付变化。 */ () =>
            deliver(f.receipts, { ...accepted, context: { ...accepted.context!, sequence: 3, anchor } }),
          /admission_context_conflict/
        )
      }
      const responded: AdmissionReceiptRecord = {
        ...accepted,
        context: {
          ...accepted.context!,
          sequence: 3,
          anchor: {
            ...accepted.context!.anchor,
            state: 'responded',
            evidence: { response_hash: 'a'.repeat(64), response_bytes: 20 }
          }
        }
      }
      deliver(f.receipts, responded)
      const discarded: AdmissionReceiptRecord = {
        ...responded,
        context: {
          ...responded.context!,
          sequence: 4,
          anchor: { ...responded.context!.anchor, content_status: 'discarded' }
        }
      }
      deliver(f.receipts, discarded)
      assert.deepEqual(events, ['content'])
      assert.throws(
        /** 已追加证据不可替换。 */ () =>
          deliver(f.receipts, {
            ...discarded,
            context: {
              ...discarded.context!,
              sequence: 5,
              anchor: { ...discarded.context!.anchor, evidence: { response_hash: 'b'.repeat(64), response_bytes: 20 } }
            }
          }),
        /admission_context_conflict/
      )
      assert.throws(
        /** discard 不可恢复 available。 */ () =>
          deliver(f.receipts, {
            ...discarded,
            context: {
              ...discarded.context!,
              sequence: 5,
              anchor: { ...discarded.context!.anchor, content_status: 'available' }
            }
          }),
        /admission_context_conflict/
      )
      const fenced: AdmissionReceiptRecord = {
        ...discarded,
        context: { ...discarded.context!, sequence: 5, fenced: true }
      }
      deliver(f.receipts, fenced)
      assert.deepEqual(events, ['content', 'fence'])
      assert.equal(f.receipts.snapshot(f.request.binding).fenced, true)
      assert.equal(f.receipts.dedupExpires(f.request.binding), 3000)
      assert.throws(
        /** 失效快照可观察但不能执行。 */ () => f.receipts.assertRequest(f.request),
        /admission_request_mismatch/
      )
      assert.throws(
        /** 认证 source 也不能撤销已有 fence。 */ () =>
          deliver(f.receipts, { ...fenced, context: { ...fenced.context!, sequence: 6, fenced: false } }),
        /admission_context_conflict/
      )
    } finally {
      f.close()
    }
  }
)

test(
  'local TTL and closed epochs remain fenced across duplicate delivery and a normal reopen',
  /** 本机 floor 不伪造 Gateway sequence；相同 source 重复与新 writer 都不能复活。 */ () => {
    const f = setup()
    let reopened: ConnectorAdmissionReceipts | undefined
    try {
      deliver(f.receipts, f.record)
      f.time(1500)
      assert.equal(f.receipts.snapshot(f.request.binding).anchor.content_status, 'expired')
      assert.equal(f.receipts.snapshot(f.request.binding).sequence, 1)
      deliver(f.receipts, f.record)
      assert.equal(f.receipts.contentStatus(f.request.binding), 'expired')
      f.receipts.closeEpoch(f.request.binding)
      assert.equal(f.receipts.snapshot(f.request.binding).fenced, true)
      deliver(f.receipts, f.record)
      assert.equal(f.receipts.snapshot(f.request.binding).fenced, true)
      f.receipts.close()
      reopened = new ConnectorAdmissionReceipts({ ...f.options, mode: 'open' })
      assert.equal(reopened.snapshot(f.request.binding).fenced, true)
      assert.equal(reopened.snapshot(f.request.binding).anchor.content_status, 'expired')
      assert.equal(reopened.dedupExpires(f.request.binding), 3000)
      assert.throws(
        /** 旧 epoch 不能通过重新打开恢复正文。 */ () => reopened!.responseAnchor(f.request.binding),
        /admission_context_fenced/
      )
    } finally {
      reopened?.close()
      f.close()
    }
  }
)

test(
  'authenticated context crosses an independent Connector process and only committed invalidations persist',
  { timeout: 20_000 },
  /** 子进程不持有 Gateway writer；真实 Store 回滚、discard、TTL 和旧 epoch 均由原认证帧治理。 */ async () => {
    const root = directory()
    let rollback = false
    const f = fixture(
      {
        offer: {
          major: 2,
          minor: 0,
          capabilities: ['rpc', 'admission_receipt', 'admission_context'],
          required: ['rpc']
        }
      },
      {
        retention: { content_ttl: 20_000 },
        fault: /** 只在明确测试时刻模拟事务提交失败。 */ (point) => {
          if (rollback && point === 'before_commit') {
            throw new GatewayError('synthetic_rollback')
          }
        }
      }
    )
    const child = spawn(
      process.execPath,
      ['--no-env-file', fileURLToPath(new URL('./admission-receipt-child.ts', import.meta.url))],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    )
    const events: { type: string; snapshot?: TrustedAdmissionSnapshot; event?: { kind: string } }[] = []
    let output = ''
    let errors = 0
    child.stdout.on(
      'data',
      /** 只解析合成元数据事件，不接收请求或凭据作为测试结果。 */ (chunk) => {
        output += chunk.toString()
        let newline: number
        while ((newline = output.indexOf('\n')) >= 0) {
          events.push(JSON.parse(output.slice(0, newline)))
          output = output.slice(newline + 1)
        }
      }
    )
    child.stderr.on(
      'data',
      /** 不转发潜在运行输入，只记录诊断字节数。 */ (chunk) => {
        errors += chunk.length
      }
    )
    const exited = new Promise<number | null>(/** 保存唯一子进程退出结果。 */ (resolve) => child.once('exit', resolve))
    /** stdin 是测试进程控制管道，不是新增产品入口。 */
    function command(value: unknown): void {
      child.stdin.write(boundedJson(value) + '\n')
    }
    /** 请求独立进程当前持久快照，不读取或共享 Gateway Store 内存。 */
    async function snapshot(binding: AdmissionRequest['binding']): Promise<TrustedAdmissionSnapshot> {
      const count = events.length
      command({ type: 'snapshot', binding })
      await until(
        /** 只等待本轮快照回执。 */ () =>
          events.slice(count).some(/** 快照事件唯一携带此元数据。 */ (event) => event.type === 'snapshot')
      )
      return events.slice(count).find(/** 取当前请求收到的首个快照。 */ (event) => event.type === 'snapshot')!.snapshot!
    }
    let reopened: ConnectorAdmissionReceipts | undefined
    try {
      const device = f.pair('independent_context')
      const path = join(root, 'child-receipts.json')
      command({
        type: 'start',
        config: {
          url: f.gateway.url,
          credential: device.credential,
          target: device.target,
          provider: f.store.provider(device.machine_id, device.target.provider_id),
          path,
          clock: f.now,
          contextual: true
        }
      })
      await until(
        /** 真实 welcome 和 ready 后才登记新调用。 */ () =>
          events.some(/** 子进程报告就绪。 */ (event) => event.type === 'ready')
      )
      const call = f.call(device.target)
      const binding = f.gateway.dispatch(call.call_id)
      await until(
        /** 原 Store 真正提交响应证据后再检查上下文。 */ () =>
          f.store.call('synthetic', call.call_id).state === 'responded'
      )
      const original = f.store.responseAnchor(binding)
      let delivered = await snapshot(binding)
      // 响应和更新沿同一原连接有序送达；若前一轮跨调度，继续询问持久快照。
      for (let attempt = 0; attempt < 20 && delivered.anchor.state !== 'responded'; attempt++) {
        delivered = await snapshot(binding)
      }
      assert.equal(delivered.anchor.state, 'responded')
      assert.equal(delivered.principal_id, 'synthetic')
      assert.deepEqual(delivered.anchor, original)
      assert.equal(delivered.sequence, 3)
      const beforeEvents = events.filter(/** 计量已提交失效通知。 */ (event) => event.type === 'invalidated').length
      rollback = true
      assert.throws(
        /** 回滚事务不能发认证 discard。 */ () => f.store.discardResponse('synthetic', call.call_id),
        /synthetic_rollback/
      )
      rollback = false
      assert.equal((await snapshot(binding)).anchor.content_status, 'available')
      assert.equal(
        events.filter(/** 回滚不得创建新的持久通知。 */ (event) => event.type === 'invalidated').length,
        beforeEvents
      )
      f.store.discardResponse('synthetic', call.call_id)
      await until(
        /** 真正 COMMIT 后 child 独立接收并持久通知。 */ () =>
          events.some(/** 已提交内容失效事件。 */ (event) => event.event?.kind === 'content')
      )
      delivered = await snapshot(binding)
      assert.equal(delivered.anchor.content_status, 'discarded')
      assert.equal(delivered.sequence, 4)
      assert.equal(delivered.anchor.dedup_expires_at, original.dedup_expires_at)
      const second = f.gateway.dispatch(f.call(device.target).call_id)
      await until(
        /** 第二条意图同样只执行一次并提交原响应。 */ () =>
          f.store.call('synthetic', second.call_id).state === 'responded'
      )
      const ttl = f.store.responseAnchor(second).content_expires_at
      f.now = ttl
      command({ type: 'clock', clock: ttl })
      await until(
        /** 先确认 child 明确采用相同测试时钟。 */ () =>
          events.some(/** 时钟同步回执。 */ (event) => event.type === 'clock')
      )
      f.store.expire()
      delivered = await snapshot(second)
      assert.equal(delivered.anchor.content_status, 'expired')
      assert.equal(delivered.anchor.content_expires_at, ttl)
      f.store.setProviderEnabled(device.machine_id, device.target.provider_id, 1, false)
      await until(
        /** 已禁用 provider 的原 codec 仍可交付只收窄能力的认证 fence。 */ () =>
          events.some(/** 不把内容失效误当身份封锁。 */ (event) => event.event?.kind === 'fence')
      )
      assert.equal((await snapshot(second)).fenced, true)
      const persisted = JSON.parse(readFileSync(path, 'utf8')) as { entries: AdmissionReceiptRecord[] }
      assert.equal(
        persisted.entries.find(
          /** 读取独立 Connector 文件验证 source fence，而非只看到本机关闭 floor。 */ (record) =>
            record.binding.call_id === second.call_id
        )!.context!.fenced,
        true
      )
      child.stdin.end(boundedJson({ type: 'close' }) + '\n')
      assert.equal(await exited, 0)
      assert.equal(errors, 0)
      reopened = new ConnectorAdmissionReceipts({
        path,
        mode: 'open',
        ledger_id: 'isolated_child_receipts',
        limits: { entries: 128, bytes: 1_048_576 },
        routes: [{ target: device.target, principal_id: 'synthetic' }],
        now: /** 保留原可信高水位，不刷新任何期限。 */ () => f.now
      })
      assert.equal(reopened.snapshot(binding).fenced, true)
      assert.equal(reopened.snapshot(binding).anchor.content_status, 'discarded')
      assert.equal(reopened.snapshot(second).anchor.content_status, 'expired')
      assert.equal(reopened.dedupExpires(binding), original.dedup_expires_at)
    } finally {
      rollback = false
      child.kill('SIGKILL')
      await exited
      reopened?.close()
      f.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }
)
