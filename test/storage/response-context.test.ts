// 用隔离 SQLite 和真实适配器验证内容回收、迟到证据、故障恢复及重启隔离。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Store } from '../../src/store.js'
import type { StoreOptions } from '../../src/store.js'
import { createLuvusWireAdapter } from '../../src/integration/luvus-wire.js'
import { commitLuvusResponse } from '../../src/integration/persistence.js'
import { nativeBackend } from './native-backend.js'
import { management, responseFrame } from './helpers.js'
import { hash, LIMITS } from '../../src/wire/index.js'
import type { AttemptBinding, AuthenticatedEnvelope } from '../../src/wire/types.js'

// 创建临时目录中的独立 SQLite、可控时钟及真实后端，额外连接只用于检查落盘结果。
function fixture(options: StoreOptions = {}, limits?: Parameters<typeof nativeBackend>[1]) {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-response-only-'))
  const path = join(root, 'db')
  const clock = { now: 100 }
  const store = new Store(
    path,
    /* 返回可控时钟当前值，精确重现内容期限、去重期限及重开数据库的时间边界。 */ () => clock.now,
    {
      management,
      ...options,
      retention: { content_ttl: 10, ...options.retention }
    }
  )
  const native = nativeBackend(store, {
    params: { title: 'synthetic', prompt: 'synthetic-raw-request-secret' },
    ...limits
  })
  const inspect = new DatabaseSync(path, { readOnly: true })
  return {
    path,
    clock,
    store,
    native,
    inspect,
    // 关闭适配器、检查连接与 Store 后删除临时目录，避免测试资源残留。
    close() {
      native.adapter.close()
      inspect.close()
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

// 为合成连接声明 objects 能力，并按真实 Wire 字节限额生成可逐片接收的大响应。
function responseChunks(f: ReturnType<typeof fixture>, binding: AttemptBinding, objectId: string, bytes = 150_000) {
  if (!f.native.backend.connection().negotiated.capabilities.includes('objects')) {
    const connection = f.native.backend.connection
    f.native.backend.connection = /* 保留原 Store 连接 fence 检查，在该测试的合成协商结果中追加对象能力。 */ () => {
      const current = connection()
      return {
        ...current,
        negotiated: { ...current.negotiated, capabilities: [...current.negotiated.capabilities, 'objects'] }
      }
    }
  }
  const raw = Buffer.from(JSON.stringify(responseFrame(binding, { result: { text: 'x'.repeat(bytes) } })))
  const count = Math.ceil(raw.length / LIMITS.chunk_bytes)
  return Array.from(
    { length: count },
    // 每片只携带当前对象的有界正文区间；完整响应仍在组装结束后通过真实原生校验。
    (_, index): Extract<AuthenticatedEnvelope, { type: 'object_chunk' }> => ({
      protocol_major: 2,
      protocol_minor: 0,
      type: 'object_chunk',
      message_id: objectId + '_' + index,
      machine_id: binding.machine_id,
      recovery_generation: binding.recovery_generation,
      connection_epoch: binding.connection_epoch,
      payload: {
        object_id: objectId,
        kind: 'envelope',
        total_bytes: raw.length,
        sha256: hash(raw),
        chunk_count: count,
        index,
        data: raw.subarray(index * LIMITS.chunk_bytes, (index + 1) * LIMITS.chunk_bytes).toString('base64')
      }
    })
  )
}

test(
  '仅响应快照只复制已知元数据，不保留宿主 attempt 或来源扩展中的请求缓存',
  // 在真实后端加入不参与授权的合成正文扩展，清理后计量应与无扩展上下文完全相同。
  () => {
    const baseline = fixture()
    const extended = fixture()
    const secret = 'synthetic-extra-request-cache-'.repeat(1000)
    const attempt = extended.native.backend.attempt
    const nativeSource = extended.native.backend.nativeSource
    extended.native.backend.attempt = /* 模拟宿主私有调试扩展，扩展不能进入密封后的已知元数据投影。 */ (call, id) => {
      const found = attempt(call, id)
      return found ? { ...found, cached_request: secret } : undefined
    }
    extended.native.backend.nativeSource = /* 独立证明仍有效，但来源对象附带的无关正文缓存不得被 adapter 保留。 */ (
      call,
      id
    ) => {
      const found = nativeSource(call, id)
      return found ? { ...found, cached_request: secret } : undefined
    }
    try {
      for (const f of [baseline, extended]) {
        const call = f.native.create()
        f.native.dispatch(call.call_id)
        f.store.discardResponse('synthetic', call.call_id)
        assert.equal(f.native.adapter.stats().responses, 1)
      }
      assert.equal(extended.native.adapter.stats().snapshot_bytes, baseline.native.adapter.stats().snapshot_bytes)
    } finally {
      extended.close()
      baseline.close()
    }
  }
)

test(
  '宿主绑定附带未声明字段仍默认拒绝，不以元数据最小化为由放宽 Wire 校验',
  // binding 根部额外字段原本就不属于可信尝试；失败入口不能留下请求缓存或执行许可。
  () => {
    const f = fixture()
    const attempt = f.native.backend.attempt
    f.native.backend.attempt = /* 模拟宿主错误地把合成正文缓存放入固定身份绑定。 */ (call, id) => {
      const found = attempt(call, id)
      return found ? { ...found, binding: { ...found.binding, cached_request: 'synthetic-request-cache' } } : undefined
    }
    try {
      const call = f.native.create()
      assert.throws(
        // 真实编码入口应保持严格拒绝，而非为了建立快照自动丢弃未知身份字段。
        () => f.native.dispatch(call.call_id),
        /invalid_frame_fields/
      )
      assert.equal(f.native.adapter.stats().executions, 0)
      assert.equal(f.native.adapter.stats().snapshot_bytes, 0)
      assert.equal(f.native.state.sends, 0)
    } finally {
      f.close()
    }
  }
)

for (const cleanup of ['ttl', 'discard', 'fence'] as const) {
  test(
    `未完成响应的正文在 ${cleanup} 回收时释放，object ID 墓碑阻止重建原传输`,
    // 先保留真实首片，再提交内容或身份清理；计量清零且剩余片、重发首片均被拒绝。
    () => {
      const f = fixture()
      try {
        const call = f.native.create()
        const binding = f.native.dispatch(call.call_id)
        const chunks = responseChunks(f, binding, 'pending_cleanup')
        f.native.adapter.acceptChunk(JSON.stringify(chunks[0]), 'connector_to_gateway')
        assert.equal(f.native.adapter.stats().active_transfers, 1)
        assert(f.native.adapter.stats().transfer_bytes > 0)
        if (cleanup === 'ttl') {
          f.clock.now = 110
          f.store.expire()
        } else if (cleanup === 'discard') {
          f.store.discardResponse('synthetic', call.call_id)
        } else {
          f.store.setProviderEnabled(binding.machine_id, binding.target.provider_id, 1, false)
        }
        assert.equal(f.native.adapter.stats().active_transfers, 0)
        assert.equal(f.native.adapter.stats().transfer_bytes, 0)
        assert.equal(f.native.adapter.stats().object_tombstones, 1)
        for (const chunk of [chunks[0], chunks[1]]) {
          assert.throws(
            // 内容清理不能通过重建 assembler 放开原 object_id。
            () => f.native.adapter.acceptChunk(JSON.stringify(chunk), 'connector_to_gateway'),
            /object_closed/
          )
        }
      } finally {
        f.close()
      }
    }
  )
}

test(
  '空闲传输按首片期限释放且进度不续期，墓碑到期后才允许新传输',
  // 用真实三片响应检验固定期限、独立传输预算与 ID 墓碑，不依赖后续 push 才回收 Buffer。
  () => {
    const f = fixture({ maintenanceIntervalMs: 60_000, retention: { content_ttl: 100_000 } })
    try {
      const call = f.native.create({ timeoutMs: 100_000 })
      const binding = f.native.dispatch(call.call_id)
      const chunks = responseChunks(f, binding, 'fixed_transfer')
      f.native.adapter.acceptChunk(JSON.stringify(chunks[0]), 'connector_to_gateway')
      const snapshots = f.native.adapter.stats().snapshot_bytes
      f.clock.now += LIMITS.transfer_timeout_ms - 1
      f.native.adapter.acceptChunk(JSON.stringify(chunks[1]), 'connector_to_gateway')
      assert.equal(f.native.adapter.stats().active_transfers, 1)
      f.clock.now++
      f.native.adapter.maintain()
      assert.equal(f.native.adapter.stats().active_transfers, 0)
      assert.equal(f.native.adapter.stats().transfer_bytes, 0)
      assert.equal(f.native.adapter.stats().snapshot_bytes, snapshots)
      assert.equal(f.native.adapter.stats().object_tombstones, 1)
      assert.throws(
        // 到期不能接着交付原响应末片，也不能把进度当作续期。
        () => f.native.adapter.acceptChunk(JSON.stringify(chunks[2]), 'connector_to_gateway'),
        /object_closed/
      )
      f.clock.now += LIMITS.transfer_timeout_ms
      f.native.adapter.maintain()
      assert.equal(f.native.adapter.stats().object_tombstones, 0)
      f.native.adapter.acceptChunk(JSON.stringify(chunks[0]), 'connector_to_gateway')
      assert.equal(f.native.adapter.stats().active_transfers, 1)
      f.native.adapter.close()
      assert.equal(f.native.adapter.stats().transfer_bytes, 0)
      assert.equal(f.native.adapter.stats().object_tombstones, 0)
    } finally {
      f.close()
    }
  }
)

test(
  '逐对象组装器共享连接的传输数量和声明总长预算，不随 object ID 倍增',
  // 多个真实首片分别触发数量及总长上界，证明逐对象回收没有放大原 Wire 资源限额。
  () => {
    const f = fixture()
    try {
      const call = f.native.create()
      const binding = f.native.dispatch(call.call_id)
      for (let n = 0; n < LIMITS.transfers; n++) {
        const chunks = responseChunks(f, binding, 'count_' + n)
        f.native.adapter.acceptChunk(JSON.stringify(chunks[0]), 'connector_to_gateway')
      }
      const excess = responseChunks(f, binding, 'count_excess')[0]
      assert.throws(
        // 第五个 object ID 不能获得一套额外的独立 parser 配额。
        () => f.native.adapter.acceptChunk(JSON.stringify(excess), 'connector_to_gateway'),
        /object_capacity/
      )
      f.store.discardResponse('synthetic', call.call_id)
      assert.equal(f.native.adapter.stats().transfer_bytes, 0)
      for (let n = 0; n < 3; n++) {
        const chunk = responseChunks(f, binding, 'bytes_' + n)[0]!
        chunk.payload.total_bytes = LIMITS.object_bytes
        chunk.payload.chunk_count = LIMITS.object_bytes / LIMITS.chunk_bytes
        if (n < 2) {
          f.native.adapter.acceptChunk(JSON.stringify(chunk), 'connector_to_gateway')
        } else {
          assert.throws(
            // 两个 8 MiB 声明已占 16 MiB，第三个不能越过连接的 20 MiB 总预约。
            () => f.native.adapter.acceptChunk(JSON.stringify(chunk), 'connector_to_gateway'),
            /object_capacity/
          )
        }
      }
      assert.equal(f.native.adapter.stats().active_transfers, 2)
      assert.equal(f.native.adapter.stats().transfer_bytes, 2 * LIMITS.object_bytes)
    } finally {
      f.close()
    }
  }
)

test(
  '密封上下文的可信冲突审计先提交，审计写入故障不覆盖原元数据或释放上下文',
  // 内容清理后提交首份最小证据，再对冲突审计注入真实事务失败并显式恢复重试。
  () => {
    let fail = false
    const f = fixture({
      // 只在冲突审计阶段打开提交故障，观察 SQLite 的回滚结果。
      fault(point) {
        if (fail && point === 'before_commit') {
          throw Error('synthetic conflict audit failure')
        }
      }
    })
    try {
      const call = f.native.create()
      const binding = f.native.dispatch(call.call_id)
      f.store.discardResponse('synthetic', call.call_id)
      f.native.respond(binding, { id: 'original' })
      const original = f.inspect
        .prepare('SELECT response_hash FROM calls WHERE call_id=?')
        .get(call.call_id)!.response_hash
      fail = true
      assert.throws(
        // 未提交的冲突审计只能报告存储降级，不能假报已隔离记录。
        () => f.native.respond(binding, { id: 'conflict' }),
        /storage_degraded/
      )
      assert.equal(f.inspect.prepare("SELECT COUNT(*) n FROM audit WHERE action='response_conflict'").get()!.n, 0)
      assert.equal(f.native.adapter.stats().responses, 1)
      fail = false
      f.store.resumeStorage()
      for (let n = 0; n < 2; n++) {
        assert.throws(
          // 同一可靠冲突重复到达只保留一条脱敏审计，不能覆盖已提交结果。
          () => f.native.respond(binding, { id: 'conflict' }),
          /response_evidence_conflict/
        )
      }
      assert.equal(f.inspect.prepare("SELECT COUNT(*) n FROM audit WHERE action='response_conflict'").get()!.n, 1)
      assert.equal(
        f.inspect.prepare('SELECT response_hash FROM calls WHERE call_id=?').get(call.call_id)!.response_hash,
        original
      )
      assert.equal(f.native.state.sends, 1)
      assert.equal(f.store.call('synthetic', call.call_id).response, null)
    } finally {
      f.close()
    }
  }
)

test(
  '一次编码中途时钟失效仍立即关闭并释放回滚恢复的原请求',
  // 首次维护时间合法，授权阶段才返回 NaN，验证 finally 在回滚之后仍执行不可撤销的关闭通知。
  () => {
    const f = fixture()
    try {
      const call = f.native.create()
      const binding = f.native.dispatch(call.call_id)
      const { machine_id, recovery_generation, connection_epoch, ...attempt } = binding
      let reads = 0
      f.native.backend.now = /* 同一次编码的第二次读取故意失效，复现仅检查维护入口无法覆盖的边界。 */ () =>
        ++reads === 1 ? 100 : Number.NaN
      assert.throws(
        // 使用已派发的真实尝试重新编码，保证失败前已有可被回滚恢复的执行正文。
        () =>
          f.native.adapter.encode(
            {
              protocol_major: 2,
              protocol_minor: 0,
              message_id: 'clock_midflight',
              machine_id,
              recovery_generation,
              connection_epoch,
              type: 'request',
              payload: {
                attempt,
                expected_binding_revision: 1,
                native_request: {
                  method: 'task.add',
                  params: { title: 'synthetic', prompt: 'synthetic-raw-request-secret' }
                },
                validation: 'strict'
              }
            },
            'gateway_to_connector'
          ),
        /clock_untrusted/
      )
      assert.equal(reads, 2)
      assert.equal(f.native.adapter.stats().closed, true)
      assert.equal(f.native.adapter.stats().executions, 0)
      assert.equal(f.native.adapter.stats().responses, 0)
      assert.equal(f.native.adapter.stats().snapshot_bytes, 0)
    } finally {
      f.close()
    }
  }
)

test(
  '缺少 durable anchor 时不保留仅响应上下文，不可信时钟关闭并释放全部私有状态',
  // 验证缺失来源及 NaN 时钟都按默认拒绝收敛，不因无法比较期限而永久保留原请求。
  () => {
    const f = fixture()
    try {
      f.native.backend.responseAnchor = undefined
      const call = f.native.create()
      const binding = f.native.dispatch(call.call_id)
      f.store.discardResponse('synthetic', call.call_id)
      assert.equal(f.native.adapter.stats().executions, 0)
      assert.equal(f.native.adapter.stats().responses, 0)
      assert.throws(
        // 仅凭旧账本绑定不能补造密封响应句柄。
        () => f.native.respond(binding),
        /attempt_anchor_unavailable/
      )
      f.native.backend.now = /* 故意提供 NaN，不能让所有到期比较静默变为 false。 */ () => Number.NaN
      assert.throws(
        // 时钟不可用应在进入 codec 前释放并关闭，而非继续解析数据。
        () => f.native.adapter.decode('{}', 'connector_to_gateway'),
        /adapter_closed/
      )
      assert.equal(f.native.adapter.stats().closed, true)
      assert.equal(f.native.adapter.stats().snapshot_bytes, 0)
    } finally {
      f.close()
    }
  }
)

test(
  'SQLite 清理提交持续失败时空闲 adapter 仍按固定 TTL 回收原文与去重上下文',
  // 让真实清理事务回滚且停止 Store 后台维护，随后只等待 adapter 定时器，核对内存回收与落盘未提交相互独立。
  async () => {
    let fail = false
    const f = fixture(
      {
        maintenanceIntervalMs: 60_000,
        retention: { dedup_ttl: 100, call_metadata_ttl: 100, history_epoch_max_age: 20 },
        // 在清理的提交前持续注入故障，不能依赖成功 COMMIT 发布回收通知。
        fault: (point) => {
          if (fail && point === 'before_commit') {
            throw Error('synthetic cleanup failure')
          }
        }
      },
      { limits: { attempts: 1, maintenance_interval_ms: 1 } }
    )
    try {
      const call = f.native.create()
      const binding = f.native.dispatch(call.call_id)
      fail = true
      f.clock.now = 110
      assert.throws(
        // 拒绝真实 SQLite 清理提交，证明后续内存回收没有借用提交后通知。
        () => f.store.expire(),
        /storage_degraded/
      )
      assert.equal(f.native.adapter.stats().executions, 1)
      assert(f.inspect.prepare('SELECT request_json FROM calls WHERE call_id=?').get(call.call_id)!.request_json)
      await delay(30)
      assert.equal(f.native.adapter.stats().executions, 0)
      assert.equal(f.native.adapter.stats().responses, 1)
      fail = false
      f.store.expire()
      f.store.resumeStorage()
      assert.equal(f.native.respond(binding).response, null)
      assert.equal(f.native.state.sends, 1)
      f.clock.now = call.dedup_expires
      await delay(30)
      assert.equal(f.native.adapter.stats().responses, 0)
      assert.equal(f.native.adapter.stats().snapshot_bytes, 0)
    } finally {
      f.close()
    }
  }
)

test(
  'SQLite TTL 提交回收 RPC 原文上下文，同 epoch 可靠迟到证据只保留 metadata',
  /* 推进可控时钟并提交真实 SQLite TTL 清理，禁止重新读取请求后仍可提交不含原文的迟到证据。 */ () => {
    const f = fixture()
    try {
      const call = f.native.create({ timeoutMs: 5 })
      const binding = f.native.dispatch(call.call_id)
      const bytes = f.native.adapter.stats().snapshot_bytes
      assert.equal(f.native.adapter.stats().executions, 1)
      f.clock.now = 110
      f.store.expire()
      assert.equal(f.native.adapter.stats().executions, 0)
      assert.equal(f.native.adapter.stats().responses, 1)
      assert(f.native.adapter.stats().snapshot_bytes < bytes)
      assert.equal(
        f.inspect.prepare('SELECT request_json FROM calls WHERE call_id=?').get(call.call_id)!.request_json,
        null
      )
      f.native.backend.attempt = /* 一旦旧路径尝试读取原请求就立即失败，证明迟到证据只依赖密封元数据。 */ () => {
        throw Error('raw request resolver must not run')
      }
      const result = f.native.respond(binding, { id: 'finished', text: 'synthetic-response-secret' })
      assert.equal(result.state, 'responded')
      assert.equal(result.response, null)
      assert.equal(result.content_status, 'expired')
      assert.throws(
        /* 原文 TTL 已过，密封响应句柄不能重新取得内容读取许可。 */ () => f.native.adapter.checkResult(binding),
        /content_unavailable/
      )
      assert.throws(
        /* 只含元数据的迟到证据不能生成可读取原文的结果句柄。 */ () => f.store.saveResult('synthetic', call.call_id),
        /result_not_ready/
      )
      const audit = JSON.stringify(f.inspect.prepare('SELECT * FROM audit').all())
      assert(!audit.includes('synthetic-raw-request-secret'))
      assert(!audit.includes('synthetic-response-secret'))
      assert.equal(f.native.state.sends, 1)
      assert.equal(f.inspect.prepare("SELECT COUNT(*) n FROM audit WHERE action='late_evidence'").get()!.n, 1)
    } finally {
      f.close()
    }
  }
)

test(
  'discard 后坏响应不回滚为执行上下文，合法响应不复活内容且旧 request 不能再编码',
  /* 显式删除内容后先提交坏响应，再验证正确响应只写元数据且旧请求无法再次编码或派发。 */ () => {
    const f = fixture()
    try {
      const call = f.native.create()
      const binding = f.native.dispatch(call.call_id)
      f.store.discardResponse('synthetic', call.call_id)
      assert.equal(f.native.adapter.stats().executions, 0)
      assert.equal(f.native.adapter.stats().responses, 1)
      const wrong = responseFrame(binding, { id: 'wrong-id', result: { id: 'done' } })
      assert.throws(
        /* 原生请求编号错配的响应必须被拒绝，不能使密封上下文恢复为可执行状态。 */ () =>
          commitLuvusResponse(f.store, f.native.adapter, wrong),
        /native_id_mismatch/
      )
      assert.equal(f.native.adapter.stats().executions, 0)
      assert.equal(f.native.adapter.stats().responses, 1)
      const { machine_id, recovery_generation, connection_epoch, ...attempt } = binding
      assert.throws(
        // 重新编码已登记的 Wire 请求，要求以 response_context_not_executable 拒绝。
        () =>
          f.native.adapter.encode(
            {
              protocol_major: 2,
              protocol_minor: 0,
              message_id: 'replay',
              machine_id,
              recovery_generation,
              connection_epoch,
              type: 'request',
              payload: {
                attempt,
                expected_binding_revision: 1,
                native_request: { method: 'task.add', params: { title: 'synthetic' } },
                validation: 'strict'
              }
            },
            'gateway_to_connector'
          ),
        /response_context_not_executable/
      )
      assert.equal(f.native.respond(binding).response, null)
      assert.equal(f.store.call('synthetic', call.call_id).content_status, 'discarded')
      assert.throws(
        /* 内容已删除的原调用不能重新登记派发，避免迟到响应触发重放。 */ () =>
          f.store.dispatch('synthetic', call.call_id, f.native.device.epoch),
        /dispatch_rejected/
      )
      assert.equal(f.native.state.sends, 1)
    } finally {
      f.close()
    }
  }
)

test(
  'metadata-only 证据提交失败不丢原密封上下文，受保护恢复后仍只对账不补发',
  /* 在证据提交处注入写入故障，恢复存储后复用原密封句柄对账并核对模拟发送计数不变。 */ () => {
    let fail = false
    const f = fixture({
      // 只在指定证据写入阶段且故障开关打开时抛错，验证 SQLite 回滚与恢复路径。
      fault: (point) => {
        if (fail && point === 'evidence_commit') {
          throw Error('synthetic disk failure')
        }
      }
    })
    try {
      const call = f.native.create({ timeoutMs: 5 })
      const binding = f.native.dispatch(call.call_id)
      f.clock.now = 110
      f.store.expire()
      fail = true
      assert.throws(
        /* 通过真实原生校验提交响应证据，要求以 storage_degraded 拒绝。 */ () => f.native.respond(binding),
        /storage_degraded/
      )
      assert.equal(f.native.adapter.stats().responses, 1)
      assert.equal(
        f.inspect.prepare('SELECT response_hash FROM calls WHERE call_id=?').get(call.call_id)!.response_hash,
        null
      )
      fail = false
      f.store.resumeStorage()
      assert.equal(f.native.respond(binding).state, 'responded')
      assert.equal(f.store.call('synthetic', call.call_id).response, null)
      assert.equal(f.native.state.sends, 1)
    } finally {
      f.close()
    }
  }
)

for (const action of ['provider', 'disconnect', 'revoke'] as const) {
  test(
    `原文回收后的 ${action} fence 释放响应上下文，旧证据不能转绑`,
    /* 分别注入 provider、断连和撤销 fence，核对原密封句柄及快照预算被释放且不能转绑新身份。 */ () => {
      const f = fixture()
      try {
        const call = f.native.create()
        const binding = f.native.dispatch(call.call_id)
        f.store.discardResponse('synthetic', call.call_id)
        if (action === 'provider') {
          f.store.setProviderEnabled(f.native.device.machine_id, 'provider', 1, false)
        } else if (action === 'disconnect') {
          f.store.disconnect(f.native.device.machine_id, f.native.device.epoch)
        } else {
          f.store.revoke(f.native.device.machine_id)
        }
        assert.equal(f.native.adapter.stats().responses, 0)
        assert.throws(
          /* 在已提交 provider、断连或撤销 fence 后提交旧响应，确认不能转绑或补写。 */ () => f.native.respond(binding)
        )
        assert.equal(f.native.state.sends, 1)
        assert.equal(
          f.inspect.prepare('SELECT response_hash FROM calls WHERE call_id=?').get(call.call_id)!.response_hash,
          null
        )
      } finally {
        f.close()
      }
    }
  )
}

test(
  '密封上下文仍占 attempt/字节子额，到去重期限才释放，关闭不能重建许可',
  /* 使密封上下文占满尝试子额，验证到去重期限才返还预算，并且关闭后不能再解码。 */ () => {
    const f = fixture(
      { retention: { dedup_ttl: 100, call_metadata_ttl: 100, history_epoch_max_age: 20 } },
      { limits: { attempts: 1 } }
    )
    try {
      const call = f.native.create()
      f.native.dispatch(call.call_id)
      f.clock.now = 110
      f.store.expire()
      assert.equal(f.native.adapter.stats().responses, 1)
      const other = f.native.create()
      assert.throws(
        /* 密封响应仍占满尝试子额，新调用不能继续编码或增加模拟发送次数。 */ () => f.native.dispatch(other.call_id),
        /adapter_limit/
      )
      assert.equal(f.native.state.sends, 1)
      f.clock.now = 200
      f.store.expire()
      assert.equal(f.native.adapter.stats().responses, 0)
      assert.equal(f.native.adapter.stats().snapshot_bytes, 0)
      f.native.adapter.close()
      assert.equal(f.native.adapter.stats().closed, true)
      assert.throws(
        /* 已关闭的适配器必须在解析消息前拒绝，不能重建旧响应许可。 */ () =>
          f.native.adapter.decode('{}', 'connector_to_gateway'),
        /adapter_closed/
      )
    } finally {
      f.close()
    }
  }
)

test(
  'discard 事务回滚不发布回收事件，成功提交才释放原请求上下文',
  /* 让 discard 在提交前失败，证明事务回滚不通知宿主；恢复并成功提交后才销毁执行状态。 */ () => {
    let fail = false
    const f = fixture({
      // 只在指定提交前阶段且故障开关打开时抛错，验证 SQLite 回滚与恢复路径。
      fault: (point) => {
        if (fail && point === 'before_commit') {
          throw Error('synthetic commit failure')
        }
      }
    })
    try {
      const call = f.native.create()
      const binding = f.native.dispatch(call.call_id)
      fail = true
      assert.throws(
        /* 删除调用正文并提交回收通知，要求以 storage_degraded 拒绝。 */ () =>
          f.store.discardResponse('synthetic', call.call_id),
        /storage_degraded/
      )
      assert.equal(f.native.adapter.stats().executions, 1)
      assert.equal(f.native.adapter.stats().responses, 0)
      assert.notEqual(
        f.inspect.prepare('SELECT request_json FROM calls WHERE call_id=?').get(call.call_id)!.request_json,
        null
      )
      fail = false
      f.store.resumeStorage()
      f.store.discardResponse('synthetic', call.call_id)
      assert.equal(f.native.adapter.stats().executions, 0)
      assert.equal(f.native.respond(binding).response, null)
    } finally {
      f.close()
    }
  }
)

test(
  '冷 adapter 即使同 epoch/契约/锚点也不能重建密封上下文，原活上下文仍可对账',
  /* 为同一账本新建冷适配器，证明持久化锚点不能重建响应句柄，而原活适配器仍能核验迟到证据。 */ () => {
    const f = fixture()
    const cold = createLuvusWireAdapter(f.native.backend)
    try {
      const call = f.native.create()
      const binding = f.native.dispatch(call.call_id)
      f.store.discardResponse('synthetic', call.call_id)
      const frame = responseFrame(binding, { result: { id: 'done' } })
      assert.throws(
        /* 冷适配器没有原活响应句柄，不能只凭持久化锚点接纳迟到响应。 */ () =>
          commitLuvusResponse(f.store, cold, frame),
        /attempt_anchor_unavailable/
      )
      assert.equal(cold.stats().responses, 0)
      assert.equal(f.native.respond(binding).response, null)
      assert.equal(f.native.state.sends, 1)
    } finally {
      cold.close()
      f.close()
    }
  }
)

test(
  '密封期限不能被 resolver 刷新，进程关闭和新 epoch 不能复活旧证据',
  /* 篡改 resolver 中的固定期限后验证拒绝，再关闭重开 SQLite，确认旧 epoch 与旧句柄均不能复活。 */ () => {
    const f = fixture()
    try {
      const call = f.native.create()
      const binding = f.native.dispatch(call.call_id)
      f.store.discardResponse('synthetic', call.call_id)
      const original = f.native.backend.responseAnchor!
      f.native.backend.responseAnchor = /* 故意延长 resolver 的内容期限，验证适配器拒绝改写已经固定的密封期限。 */ (
        input
      ) => ({ ...original(input)!, content_expires_at: 5000 })
      assert.throws(
        /* 通过真实原生校验提交响应证据，要求以 attempt_binding_mismatch 拒绝。 */ () => f.native.respond(binding),
        /attempt_binding_mismatch/
      )
      f.native.backend.responseAnchor = original
      f.store.close()
      assert.equal(f.native.adapter.stats().responses, 0)
      assert.equal(f.native.adapter.stats().closed, true)
      const reopened = new Store(
        f.path,
        /* 返回可控时钟当前值，精确重现内容期限、去重期限及重开数据库的时间边界。 */ () => f.clock.now,
        { management }
      )
      try {
        const next = reopened.connect(f.native.device.machine_id, f.native.device.credential)
        assert.notEqual(next, binding.connection_epoch)
        assert.throws(
          /* 查询旧绑定的持久化响应锚点，要求以 stale_response 拒绝。 */ () => reopened.responseAnchor(binding),
          /stale_response/
        )
        assert.throws(
          /* 为该响应生成持久化证据计划，要求以 adapter_closed 拒绝。 */ () =>
            f.native.adapter.planEvidence(responseFrame(binding, { result: {} })),
          /adapter_closed/
        )
      } finally {
        reopened.close()
      }
    } finally {
      f.close()
    }
  }
)
