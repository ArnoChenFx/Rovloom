// 通过真实认证 WSS 兼容路径和独立 Bun 进程验证原截止交付；不共享 Gateway writer 或原生凭据。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { ConnectorAdmissionReceipts, createConnector } from '../../src/transport/index.js'
import type { AuthenticatedAdmissionReceipt } from '../../src/transport/index.js'
import { authenticateAdmissionReceipt } from '../../src/transport/admission-proof.js'
import { admissionRequestDigest, boundedJson } from '../../src/wire/index.js'
import { createLuvusWireAdapter } from '../../src/integration/luvus-wire.js'
import { persistentBackend } from '../../src/integration/persistence.js'
import { fixture, until } from './helpers.js'
import { binding } from '../wire/helpers.js'
import type { AdmissionRequest, AdmissionReceiptRecord } from '../../src/wire/index.js'

/** 在受保护 workspace 下创建临时私有目录；世界可写 /tmp 祖先不是生产存储来源。 */
function directory(): string {
  return mkdtempSync(
    join(process.env.LUVUS_TEST_ROOT ?? fileURLToPath(new URL('../../', import.meta.url)), '.receipt-test-')
  )
}

/** 只在本存储单元回归里签发明确 synthetic 证明，真实跨进程测试必须经 transport 私有接收路径。 */
function proof(record: AdmissionReceiptRecord): AuthenticatedAdmissionReceipt {
  return authenticateAdmissionReceipt(record, /** 本同步单元夹具没有外部通道，不代表真实认证。 */ () => true)
}

/** 从既有 Wire 夹具取完整绑定并固定原无 auth/id 请求，供持久边界负例使用。 */
function request(): AdmissionRequest {
  return {
    binding: structuredClone(binding),
    native_request: { method: 'task.add', params: { title: 'synthetic', nested: { b: 2, a: 1 } } },
    validation: 'strict'
  }
}

test(
  'receipt persistence requires an opaque delivery and pins request, binding and original expiry across reopen',
  /** JSON、重放 proof、截止漂移和旧连接都不能替换原持久记录。 */ () => {
    const root = directory()
    let now = 100
    const options = {
      path: join(root, 'receipts.json'),
      mode: 'create' as const,
      ledger_id: 'isolated_receipts',
      limits: { entries: 8, bytes: 262_144 },
      now: /** 控制持久高水位，不按查找时间续期。 */ () => now
    }
    let receipts = new ConnectorAdmissionReceipts(options)
    const input = request()
    input.binding.registration.deadline = 1000
    const record = { binding: input.binding, request_sha256: admissionRequestDigest(input), dedup_expires_at: 2000 }
    try {
      assert.throws(
        /** 同形 JSON 不是进程内认证交付证明。 */ () =>
          receipts.accept(record as unknown as AuthenticatedAdmissionReceipt),
        /admission_receipt_proof_required/
      )
      const delivered = proof(record)
      receipts.accept(delivered)
      assert.throws(
        /** 一次性对象在消费后不能重复使用。 */ () => receipts.accept(delivered),
        /admission_receipt_proof_required/
      )
      receipts.accept(proof(record))
      now = 200
      receipts.assertRequest(input)
      assert.equal(receipts.dedupExpires(input.binding), 2000)
      const reordered = {
        ...input,
        native_request: { params: { nested: { a: 1, b: 2 }, title: 'synthetic' }, method: 'task.add' }
      }
      receipts.assertRequest(reordered)
      assert.throws(
        /** 消息正文改变即使 schema 允许也必须拒绝。 */ () =>
          receipts.assertRequest({ ...input, native_request: { method: 'task.add', params: { title: 'changed' } } }),
        /admission_request_mismatch/
      )
      assert.throws(
        /** 原截止变化不能覆盖第一次交付。 */ () => receipts.accept(proof({ ...record, dedup_expires_at: 3000 })),
        /admission_receipt_conflict/
      )
      receipts.close()
      receipts = new ConnectorAdmissionReceipts({ ...options, mode: 'open' })
      assert.equal(receipts.dedupExpires(input.binding), 2000)
      assert.throws(
        /** 重连不能把旧 receipt 换到新 epoch。 */ () =>
          receipts.dedupExpires({ ...input.binding, connection_epoch: 'other_epoch' }),
        /attempt_binding_mismatch/
      )
      const before = readFileSync(options.path)
      receipts.close()
      now = 199
      assert.throws(
        /** 高水位已随查询持久提交，重启回拨不能复活有效期。 */ () =>
          new ConnectorAdmissionReceipts({ ...options, mode: 'open' }),
        /clock_untrusted/
      )
      assert.deepEqual(readFileSync(options.path), before)
    } finally {
      receipts.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  'receipt ledger rejects absent history, expired proof and unavailable storage without creating new deadlines',
  /** 缺交付和坏持久状态只能拒绝，不创建替代记录或固定 true。 */ () => {
    const root = directory()
    let now = 100
    const options = {
      path: join(root, 'receipts.json'),
      mode: 'create' as const,
      ledger_id: 'isolated_missing_receipts',
      limits: { entries: 1, bytes: 262_144 },
      now: /** 显式推进固定截止，不为请求生成 TTL。 */ () => now
    }
    const receipts = new ConnectorAdmissionReceipts(options)
    const input = request()
    input.binding.registration.deadline = 1000
    try {
      assert.throws(
        /** 没有认证交付时不能查询 Gateway 原截止。 */ () => receipts.dedupExpires(input.binding),
        /admission_receipt_unavailable/
      )
      assert.throws(
        /** 独占 writer 不允许第二个同时打开。 */ () => new ConnectorAdmissionReceipts({ ...options, mode: 'open' }),
        /receipt_storage_unavailable/
      )
      receipts.accept(
        proof({ binding: input.binding, request_sha256: admissionRequestDigest(input), dedup_expires_at: 2000 })
      )
      now = 2000
      assert.throws(
        /** 原固定截止后不能继续使用。 */ () => receipts.dedupExpires(input.binding),
        /admission_receipt_unavailable/
      )
      assert.throws(
        /** 过期交付不能重新登记。 */ () =>
          receipts.accept(
            proof({ binding: input.binding, request_sha256: admissionRequestDigest(input), dedup_expires_at: 2000 })
          ),
        /admission_receipt_expired/
      )
    } finally {
      receipts.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
)

for (const corrupt of [false, true]) {
  test(
    'Gateway original receipt crosses a real independent Connector process' +
      (corrupt ? ' and blocks a changed request' : ' before execution'),
    { timeout: 20_000 },
    /** 子进程无 Gateway Store 引用；只有持久且摘要匹配的真实认证交付才能进入执行 hook。 */ async () => {
      const root = directory()
      const f = fixture(
        { offer: { major: 2, minor: 0, capabilities: ['rpc', 'admission_receipt'], required: ['rpc'] } },
        {},
        {
          /** 原 Gateway codec 先核验请求，故障注入只改实际发送后的合成请求正文。 */
          adapter(connection, _channel, services) {
            const original = createLuvusWireAdapter(persistentBackend(f.store, services))
            return {
              ...original,
              /** 接收端必须独立比较 receipt，不能因发送端曾合法编码就接受被替换的正文。 */
              encode(frame, direction) {
                const raw = original.encode(frame, direction)
                if (corrupt && frame.type === 'request') {
                  const changed = JSON.parse(raw)
                  changed.payload.native_request.params.title = 'changed_after_receipt'
                  return boundedJson(changed)
                }
                return raw
              }
            }
          }
        }
      )
      const child = spawn(
        process.execPath,
        ['--no-env-file', fileURLToPath(new URL('./admission-receipt-child.ts', import.meta.url))],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      )
      const events: { type: string; expires?: number; executions?: number }[] = []
      let output = ''
      let stderrBytes = 0
      child.stdout.on(
        'data',
        /** 只解析子进程约定的合成状态事件。 */ (chunk) => {
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
        /** 只计量诊断字节，绝不转发配置或凭据。 */ (chunk) => {
          stderrBytes += chunk.length
        }
      )
      const exited = new Promise<number | null>(
        /** 保存独立进程唯一退出状态。 */ (resolve) => child.once('exit', resolve)
      )
      try {
        const device = f.pair('isolated_receipt_child')
        const provider = structuredClone(f.store.provider(device.machine_id, device.target.provider_id)!)
        const path = join(root, 'child-receipts.json')
        child.stdin.write(
          JSON.stringify({
            type: 'start',
            config: {
              url: f.gateway.url,
              credential: device.credential,
              target: device.target,
              provider,
              path,
              clock: f.now
            }
          }) + '\n'
        )
        await until(
          /** 子进程必须实际收到 welcome 且独立 ready。 */ () =>
            events.some(/** 找到唯一就绪事件。 */ (event) => event.type === 'ready'),
          10_000
        )
        const call = f.call(device.target)
        const binding = f.gateway.dispatch(call.call_id)
        const expires = f.store.responseAnchor(binding).dedup_expires_at
        await until(
          /** 等待真实 Gateway 事务收敛，拒绝路径不能进入 child hook。 */ () => {
            const state = f.store.call('synthetic', call.call_id).state
            return corrupt ? state === 'outcome_unknown' : state === 'responded'
          },
          10_000
        )
        const executed = events.filter(/** 只计量 child 实际进入 hook 的事件。 */ (event) => event.type === 'executed')
        assert.equal(executed.length, corrupt ? 0 : 1)
        if (!corrupt) {
          assert.equal(executed[0]!.expires, expires)
        }
        child.stdin.end(JSON.stringify({ type: 'close' }) + '\n')
        assert.equal(await exited, 0)
        assert.equal(stderrBytes, 0)
        const reopened = new ConnectorAdmissionReceipts({
          path,
          mode: 'open',
          ledger_id: 'isolated_child_receipts',
          limits: { entries: 128, bytes: 1_048_576 },
          now: /** 父进程只打开 Connector 自己的元数据验证正常重启。 */ () => f.now
        })
        try {
          assert.equal(reopened.dedupExpires(binding), expires)
        } finally {
          reopened.close()
        }
      } finally {
        if (child.exitCode === null) {
          child.kill('SIGTERM')
          await exited
        }
        f.stop()
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
}

test(
  'negotiated receipt capability refuses a missing sink before any request can execute',
  { timeout: 5000 },
  /** 真实 welcome 已成功认证仍不能以旧会话接口静默降级，停止后不重连或执行。 */ async () => {
    const f = fixture({ offer: { major: 2, minor: 0, capabilities: ['rpc', 'admission_receipt'], required: ['rpc'] } })
    const device = f.pair('isolated_missing_receipt_sink')
    let sessions = 0
    let executions = 0
    let closeObserved = false
    let connectorClosed!: () => void
    const closed = new Promise<void>(
      /** 从真实 Connector 会话关闭 hook 观察本端回收，不假定服务端 close 事件已完成。 */ (resolve) => {
        connectorClosed = resolve
      }
    )
    const client = createConnector({
      url: f.gateway.url,
      developmentLoopback: true,
      credential: /** 使用真实隔离设备凭据完成 welcome。 */ () => device.credential,
      offer: { major: 2, minor: 0, capabilities: ['rpc', 'admission_receipt'], required: ['rpc', 'admission_receipt'] },
      limits: { reconnect_ms: 10_000 },
      random: /** 固定退避超过本测试的有界清理窗口，避免随机重连引入第二个 epoch。 */ () => 1,
      /** 此负例刻意交付原接口，协商 receipt 的连接必须拒绝。 */
      session(connection) {
        sessions++
        const original = f.session(connection)
        return {
          ...original,
          /** 保留原会话清理并通知本端已关闭，服务端仍由实际 socket close 事件回收。 */
          close() {
            original.close()
            closeObserved = true
            connectorClosed()
          },
          executeWire: /** 缺 sink 的会话不能抵达执行。 */ async () => {
            executions++
            throw new Error('unexpected_execution')
          }
        }
      }
    })
    try {
      await Promise.race([
        closed,
        until(/** 缺本端关闭 hook 必须有界失败，并进入 finally 释放实际 socket。 */ () => closeObserved)
      ])
      assert.equal(sessions, 1)
      assert.equal(client.status().phase, 'disconnected')
      await until(
        /** 本端断开先于 Gateway 收到关闭事件；有界等待两端真实清理完成，不能删除成对回收断言。 */ () =>
          f.sessions.opened === f.sessions.closed && f.gateway.status().connections === 0
      )
      assert.equal(sessions, 1)
      assert.equal(executions, 0)
      assert.equal(f.sessions.opened, 2)
      assert.equal(f.sessions.opened, f.sessions.closed)
    } finally {
      client.stop()
      f.stop()
    }
  }
)

test(
  'receipt storage refuses a changed file, incomplete commit and stale owner lock',
  /** 手工破坏只发生在测试独占文件；每次拒绝均保持源字节，不自动恢复或新建截止。 */ () => {
    const root = directory()
    const options = {
      path: join(root, 'receipts.json'),
      mode: 'create' as const,
      ledger_id: 'isolated_receipt_integrity',
      limits: { entries: 1, bytes: 262_144 },
      now: /** 固定独立时钟使文件边界测试无时间漂移。 */ () => 100
    }
    const receipts = new ConnectorAdmissionReceipts(options)
    try {
      const input = request()
      input.binding.registration.deadline = 1000
      const original = readFileSync(options.path)
      writeFileSync(options.path, '{}')
      assert.throws(
        /** 原对象逐次核对提交摘要，文件内容被换就拒绝。 */ () => receipts.dedupExpires(input.binding),
        /receipt_ledger_identity_changed/
      )
      writeFileSync(options.path, original)
      receipts.close()
      writeFileSync(options.path + '.pending', 'incomplete', { mode: 0o600 })
      assert.throws(
        /** 原子替换留下的暂存不能被当成新状态自动接管。 */ () =>
          new ConnectorAdmissionReceipts({ ...options, mode: 'open' }),
        /receipt_recovery_required/
      )
      assert.deepEqual(readFileSync(options.path), original)
      rmSync(options.path + '.pending')
      writeFileSync(options.path + '.lock', '', { mode: 0o600 })
      assert.throws(
        /** 崩溃独占锁必须由受保护恢复解决。 */ () => new ConnectorAdmissionReceipts({ ...options, mode: 'open' }),
        /receipt_storage_unavailable/
      )
      assert.deepEqual(readFileSync(options.path), original)
    } finally {
      receipts.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  'asynchronous receipt hooks close the channel without accepted, execution or unhandled rejection',
  /** 两个同步 hook 误返回拒绝 Promise 时都必须消费晚到拒绝，且不能继续进入派发。 */ async () => {
    const unhandled: unknown[] = []
    /** 只记录测试期间是否出现未消费拒绝，不输出可能包含私有上下文的错误。 */
    function rejection(error: unknown): void {
      unhandled.push(error)
    }
    process.on('unhandledRejection', rejection)
    try {
      for (const faulty of ['accept', 'assertRequest'] as const) {
        const f = fixture({
          offer: { major: 2, minor: 0, capabilities: ['rpc', 'admission_receipt'], required: ['rpc'] }
        })
        const device = f.pair('isolated_async_receipt_' + faulty)
        let accepts = 0
        let checks = 0
        let accepted = 0
        let executions = 0
        const client = createConnector({
          url: f.gateway.url,
          developmentLoopback: true,
          credential: /** 使用真实隔离配对完成认证，不直接调用接收 hook。 */ () => device.credential,
          offer: {
            major: 2,
            minor: 0,
            capabilities: ['rpc', 'admission_receipt'],
            required: ['rpc', 'admission_receipt']
          },
          limits: { heartbeat_ms: 30, idle_ms: 1500, reconnect_ms: 10_000 },
          /** 每次实际 welcome 交付真实 Wire，只在指定同步端口注入错误返回类型。 */
          session(connection) {
            const session = f.session(connection)
            return {
              ...session,
              adapter: {
                ...session.adapter,
                /** accepted 仍经原 codec 编码；计量能证明错误端口没有越过派发边界。 */
                encode(frame, direction) {
                  if (frame.type === 'accepted') {
                    accepted++
                  }
                  return session.adapter.encode(frame, direction)
                }
              },
              admissions: {
                /** 本回归仅故障注入同步契约，不伪造任何持久接收成功。 */
                accept() {
                  accepts++
                  if (faulty === 'accept') {
                    return Promise.reject(new Error('isolated_async_accept_failure'))
                  }
                },
                /** 原 Wire 请求校验之后的异步错误也不能被当成授权完成。 */
                assertRequest() {
                  checks++
                  if (faulty === 'assertRequest') {
                    return Promise.reject(new Error('isolated_async_check_failure'))
                  }
                }
              },
              executeWire: /** 任何执行都会表明异步门禁错误后仍继续派发。 */ async () => {
                executions++
                throw new Error('unexpected_receipt_execution')
              }
            }
          }
        })
        try {
          await until(/** 等实际认证通道进入 ready 才派发。 */ () => client.status().phase === 'ready')
          const call = f.call(device.target)
          f.gateway.dispatch(call.call_id)
          await until(
            /** 错误 hook 必须关闭当前连接并把原派发保守收敛 unknown。 */ () =>
              client.status().phase === 'disconnected' &&
              f.store.call('synthetic', call.call_id).state === 'outcome_unknown'
          )
          await new Promise<void>(
            /** 让晚到 rejection 完成一个事件循环，避免只检查同步计数。 */ (resolve) => setImmediate(resolve)
          )
          assert.equal(accepts, 1)
          assert.equal(checks, faulty === 'accept' ? 0 : 1)
          assert.equal(accepted, 0)
          assert.equal(executions, 0)
          assert.deepEqual(unhandled, [])
        } finally {
          client.stop()
          f.stop()
        }
      }
    } finally {
      process.removeListener('unhandledRejection', rejection)
    }
  }
)
