// 用真实双 SQLite 和原生适配器验证重配提交后回收、跨设备分片隔离及外部阻断不随账本回滚。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, openSync, closeSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Store } from '../../src/store.js'
import type { StoreOptions } from '../../src/store.js'
import type { LedgerInvalidation } from '../../src/storage/model.js'
import { GatewayError } from '../../src/contracts.js'
import { createLuvusWireAdapter } from '../../src/integration/luvus-wire.js'
import { commitLuvusResponse } from '../../src/integration/persistence.js'
import { boundedJson, fragmentObject } from '../../src/wire/index.js'
import type { AttemptBinding } from '../../src/wire/types.js'
import { nativeBackend } from './native-backend.js'
import { connected, management, responseFrame } from './helpers.js'

// 创建独立磁盘身份库和账本；测试宿主只实现 committed blocked 门禁，不提供 WSS 或真实凭据认证。
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-device-response-'))
  const path = join(root, 'ledger.sqlite')
  const identityPath = join(root, 'identity.sqlite')
  closeSync(openSync(identityPath, 'wx', 0o600))
  const identity = new DatabaseSync(identityPath)
  identity.exec(`PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE;
    CREATE TABLE identities(machine_id TEXT PRIMARY KEY,generation TEXT NOT NULL,blocked INTEGER NOT NULL,fence TEXT);`)
  const observer = new DatabaseSync(identityPath, { readOnly: true })
  const state = {
    failCommit: false,
    prepareCalls: 0,
    closedMachines: [] as string[],
    approval: undefined as { machine: string; fence: string; confirmation: string } | undefined
  }
  const settings: StoreOptions = {
    maintenanceIntervalMs: 60_000,
    // 只对本次明确批准的设备及 generation/epoch fence 返回管理确认，其它测试管理动作仍使用隔离证明。
    management(request) {
      if (request.action !== 'device_enrollment_reset') {
        return management!(request)
      }
      const approval = state.approval
      return approval && request.target === approval.machine && request.fence === approval.fence
        ? { actor: 'synthetic_admin', confirmation_id: approval.confirmation }
        : { actor: '', confirmation_id: '' }
    },
    // 桥接测试仅接受从独立连接可见的精确 blocked fence；不以回调执行过替代提交事实。
    deviceLifecycle(request) {
      if (request.action !== 'reset_enrollment') {
        return false
      }
      const row = observer.prepare('SELECT * FROM identities WHERE machine_id=?').get(request.machine_id)
      return (
        row?.generation === request.recovery_generation &&
        row.blocked === 1 &&
        row.fence ===
          boundedJson({
            recovery_generation: request.recovery_generation,
            connection_epoch: request.expected_epoch
          })
      )
    },
    // 在外部阻断提交以后注入本库最终提交失败，覆盖两个数据库不能共同回滚的窗口。
    fault(point) {
      if (state.failCommit && point === 'before_commit') {
        throw Error('synthetic ledger commit failure')
      }
    }
  }
  const store = new Store(path, /* 固定可信时间，避免真实时长干扰提交和身份 fence 的断言。 */ () => 100, settings)
  const primary = nativeBackend(store)
  store.defineProvider({ ...store.provider(primary.device.machine_id, 'provider')!, provider_id: 'second' })
  const sameDevice = nativeBackend(store, { device: primary.device, provider_id: 'second' })
  const otherDevice = nativeBackend(store, { device: connected(store, 'other') })
  const natives = [primary, sameDevice, otherDevice]
  for (const native of [primary, otherDevice]) {
    identity.prepare('INSERT INTO identities VALUES(?,?,0,NULL)').run(native.device.machine_id, store.generation())
  }
  const inspect = new DatabaseSync(path, { readOnly: true })

  // 每次独立读取身份库已提交状态；故意不依赖 Store 的 mode 或旧 epoch 是否仍可见。
  function assertIdentity(machine: string): void {
    const row = observer.prepare('SELECT generation,blocked FROM identities WHERE machine_id=?').get(machine)
    if (row?.generation !== store.generation() || row.blocked !== 0) {
      throw new GatewayError('authentication_required')
    }
  }
  for (const native of natives) {
    const connection = native.backend.connection
    const nativeSource = native.backend.nativeSource
    native.backend.connection =
      /* 在真实 persistentBackend 之前核验独立 committed 身份，恢复 Store 也不能解除外部阻断。 */ () => {
        assertIdentity(native.device.machine_id)
        return connection()
      }
    native.backend.nativeSource = /* 在独立原生来源查询前后核验身份，不把旧 Store epoch 解释为外部身份仍有效。 */ (
      call,
      attempt
    ) => {
      assertIdentity(native.device.machine_id)
      const source = nativeSource(call, attempt)
      assertIdentity(native.device.machine_id)
      return source
    }
  }
  return {
    path,
    store,
    primary,
    sameDevice,
    otherDevice,
    natives,
    state,
    inspect,
    identity,
    observer,
    // 为一次受保护重配登记精确管理确认；不允许其它设备或 epoch 借用。
    approve(machine: string, epoch: string | null) {
      state.approval = {
        machine,
        fence: boundedJson({ recovery_generation: store.generation(), connection_epoch: epoch }),
        confirmation: randomUUID()
      }
    },
    // 在独立事务中只提交 blocked，不随随后 Store 的失败作解除补偿。
    block(machine: string, epoch: string | null) {
      state.prepareCalls++
      identity.exec('BEGIN IMMEDIATE')
      identity
        .prepare('UPDATE identities SET blocked=1,fence=? WHERE machine_id=?')
        .run(boundedJson({ recovery_generation: store.generation(), connection_epoch: epoch }), machine)
      identity.exec('COMMIT')
    },
    // 模拟受保护宿主同步停止该设备业务与 adapter；没有制造或测试真实网络关闭。
    closeChannels(machine: string) {
      state.closedMachines.push(machine)
      for (const native of natives) {
        if (native.device.machine_id === machine) {
          native.adapter.close()
        }
      }
    },
    // 关闭本测试创建的适配器和全部 SQLite 连接，再删除隔离目录。
    close() {
      for (const native of natives) {
        native.adapter.close()
      }
      store.close()
      inspect.close()
      observer.close()
      identity.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

// 创建真实 Wire schema 对象分片；首片尚不能归属调用，用于覆盖零调用和跨设备缓存清理。
function chunks(native: ReturnType<typeof nativeBackend>, objectId: string) {
  const connection = native.backend.connection
  native.backend.connection = /* 保留身份及 Store fence 检查，仅在这个隔离连接显式协商 objects。 */ () => {
    const current = connection()
    return {
      ...current,
      negotiated: {
        ...current.negotiated,
        capabilities: [...new Set([...current.negotiated.capabilities, 'objects' as const])]
      }
    }
  }
  return fragmentObject({ synthetic_payload: 'x'.repeat(150_000) }, 'schema_bundle', objectId, {
    phase: 'authenticated',
    direction: 'connector_to_gateway',
    connection: native.backend.connection()
  })
}

// 用原已派发的绑定生成实际请求帧，验证旧业务在进入 native permit 构造前就被受保护身份门禁拒绝。
function requestFrame(binding: AttemptBinding) {
  const { machine_id, recovery_generation, connection_epoch, ...attempt } = binding
  return {
    protocol_major: 2 as const,
    protocol_minor: 0,
    message_id: 'old_request',
    machine_id,
    recovery_generation,
    connection_epoch,
    type: 'request' as const,
    payload: {
      attempt,
      expected_binding_revision: 1,
      native_request: { method: 'task.add', params: { title: 'synthetic' } },
      validation: 'strict' as const
    }
  }
}

test(
  '重配仅在 COMMIT 后失效同设备全部 provider、已完成/未知/仅响应上下文及未完成分片',
  // 独立观察连接在通知时必须已看见 pending；其它设备仍能完成原在途传输。
  () => {
    const f = fixture()
    const events: LedgerInvalidation[] = []
    const observed: unknown[] = []
    try {
      const execution = f.primary.create()
      const binding = f.primary.dispatch(execution.call_id)
      const sealed = f.primary.create()
      f.primary.dispatch(sealed.call_id)
      f.store.discardResponse('synthetic', sealed.call_id)
      const responded = f.primary.create()
      const respondedBinding = f.primary.dispatch(responded.call_id)
      f.primary.respond(respondedBinding)
      const unknown = f.primary.create()
      f.primary.dispatch(unknown.call_id)
      f.store.stop('synthetic', unknown.call_id)
      const pending = f.primary.create()
      const second = f.sameDevice.create()
      f.sameDevice.dispatch(second.call_id)
      f.store.discardResponse('synthetic', second.call_id)
      const unrelated = f.otherDevice.create()
      const unrelatedBinding = f.otherDevice.dispatch(unrelated.call_id)
      const originalEvidence = f.inspect
        .prepare('SELECT response_hash FROM calls WHERE call_id=?')
        .get(responded.call_id)
      const first = chunks(f.primary, 'reset_target')
      const other = chunks(f.otherDevice, 'unrelated_transfer')
      f.primary.adapter.acceptChunk(JSON.stringify(first[0]), 'connector_to_gateway')
      f.otherDevice.adapter.acceptChunk(JSON.stringify(other[0]), 'connector_to_gateway')
      const otherBefore = f.otherDevice.adapter.stats()
      f.store.subscribeInvalidation(
        // 只记录观察值，断言放回调外，避免监听异常被 Store 隔离后导致测试假通过。
        (event) => {
          events.push(event)
          observed.push({
            ...f.inspect
              .prepare('SELECT status,epoch FROM machines WHERE machine_id=?')
              .get(f.primary.device.machine_id)
          })
        }
      )
      f.approve(f.primary.device.machine_id, binding.connection_epoch)
      f.store.resetDeviceEnrollment(
        f.primary.device.machine_id,
        f.store.generation(),
        binding.connection_epoch,
        // 准备阶段独立读者仍看见旧状态且尚无通知；只提交精确 fence 的外部 blocked。
        () => {
          assert.equal(events.length, 0)
          assert.equal(
            f.inspect.prepare('SELECT status FROM machines WHERE machine_id=?').get(f.primary.device.machine_id)!
              .status,
            'online'
          )
          f.block(f.primary.device.machine_id, binding.connection_epoch)
        }
      )
      assert.deepEqual(events, [{ kind: 'device_fence', machine_id: f.primary.device.machine_id }])
      assert.deepEqual(observed, [{ status: 'pending', epoch: null }])
      for (const native of [f.primary, f.sameDevice]) {
        assert.equal(native.adapter.stats().executions, 0)
        assert.equal(native.adapter.stats().responses, 0)
        assert.equal(native.adapter.stats().snapshot_bytes, 0)
        assert.equal(native.adapter.stats().active_transfers, 0)
        assert.equal(native.adapter.stats().transfer_bytes, 0)
      }
      assert.deepEqual(f.otherDevice.adapter.stats(), otherBefore)
      let completed: ReturnType<typeof f.otherDevice.adapter.acceptChunk>
      for (const frame of other.slice(1)) {
        completed = f.otherDevice.adapter.acceptChunk(JSON.stringify(frame), 'connector_to_gateway')
      }
      assert.equal(completed!.kind, 'schema_bundle')
      assert.equal(f.store.call('synthetic', execution.call_id).state, 'outcome_unknown')
      assert.equal(f.store.call('synthetic', pending.call_id).state, 'not_dispatched')
      assert.equal(f.store.call('synthetic', responded.call_id).state, 'responded')
      assert.deepEqual(
        f.inspect.prepare('SELECT response_hash FROM calls WHERE call_id=?').get(responded.call_id),
        originalEvidence
      )
      assert.equal(f.store.call('synthetic', unrelated.call_id).state, 'dispatching')
      assert.equal(f.primary.state.sends, 4)
      assert.equal(f.sameDevice.state.sends, 1)
      f.otherDevice.respond(unrelatedBinding)
      assert.throws(
        // 即使是原绑定上的可靠响应，也不能在重配后重新建立旧上下文。
        () => f.primary.respond(binding),
        /stale_response/
      )
    } finally {
      f.close()
    }
  }
)

for (const event of ['discard', 'ttl'] as const) {
  test(
    `设备 A 的 ${event} 内容回收不清理设备 B 的活动分片`,
    // 用同一个 Store 的真实广播复现旧实现的跨设备干扰，而不是模拟通知对象。
    () => {
      const f = fixture()
      try {
        const call = f.primary.create()
        f.primary.dispatch(call.call_id)
        const other = chunks(f.otherDevice, 'cross_device_' + event)
        f.otherDevice.adapter.acceptChunk(JSON.stringify(other[0]), 'connector_to_gateway')
        const before = f.otherDevice.adapter.stats()
        if (event === 'discard') {
          f.store.discardResponse('synthetic', call.call_id)
        } else {
          // 只在隔离数据库缩短该行内容期限，Store 的 expire 仍执行真实回收与提交后广播。
          const write = new DatabaseSync(f.path)
          try {
            write.prepare('UPDATE calls SET content_expires=100 WHERE call_id=?').run(call.call_id)
          } finally {
            write.close()
          }
          f.store.expire()
        }
        assert.deepEqual(f.otherDevice.adapter.stats(), before)
        let completed: ReturnType<typeof f.otherDevice.adapter.acceptChunk>
        for (const frame of other.slice(1)) {
          completed = f.otherDevice.adapter.acceptChunk(JSON.stringify(frame), 'connector_to_gateway')
        }
        assert.equal(completed!.kind, 'schema_bundle')
      } finally {
        f.close()
      }
    }
  )
}

test(
  '设备没有任何调用行时，重配仍发布设备 fence 并释放已接收的无归属分片',
  // 回收通知不能依赖 SELECT call_id 有结果，否则零调用的 schema bundle 会继续持有正文。
  () => {
    const f = fixture()
    try {
      const frames = chunks(f.primary, 'no_call_transfer')
      f.primary.adapter.acceptChunk(JSON.stringify(frames[0]), 'connector_to_gateway')
      assert.equal(f.primary.adapter.stats().active_transfers, 1)
      const events: LedgerInvalidation[] = []
      f.store.subscribeInvalidation(/* 保存本次重配发布的实际内部事件。 */ (event) => events.push(event))
      f.approve(f.primary.device.machine_id, f.primary.device.epoch)
      f.store.resetDeviceEnrollment(
        f.primary.device.machine_id,
        f.store.generation(),
        f.primary.device.epoch,
        /* 只提交独立身份库的 blocked，自动回收责任由本库提交后的设备事件验证。 */ () =>
          f.block(f.primary.device.machine_id, f.primary.device.epoch)
      )
      assert.deepEqual(events, [{ kind: 'device_fence', machine_id: f.primary.device.machine_id }])
      assert.equal(f.primary.adapter.stats().active_transfers, 0)
      assert.equal(f.primary.adapter.stats().transfer_bytes, 0)
      assert.equal(f.primary.adapter.stats().object_tombstones, 1)
    } finally {
      f.close()
    }
  }
)

for (const failure of ['prepare_after_block', 'store_commit'] as const) {
  test(
    `外部 blocked 提交后 ${failure} 失败：Store 不发 fence，恢复 active 后旧业务仍由独立身份拒绝`,
    // 验证宿主关闭与 committed 身份门禁，而非借用 storage_degraded 或假造跨库事务保护。
    () => {
      const f = fixture()
      let cold: ReturnType<typeof createLuvusWireAdapter> | undefined
      try {
        const call = f.primary.create()
        const binding = f.primary.dispatch(call.call_id)
        const sealed = f.sameDevice.create()
        f.sameDevice.dispatch(sealed.call_id)
        f.store.discardResponse('synthetic', sealed.call_id)
        const beforeMachine = f.inspect
          .prepare('SELECT * FROM machines WHERE machine_id=?')
          .get(f.primary.device.machine_id)
        const beforeCall = f.inspect.prepare('SELECT * FROM calls WHERE call_id=?').get(call.call_id)
        const events: LedgerInvalidation[] = []
        f.store.subscribeInvalidation(/* 回滚不得发布假报已完成重配的 Store 通知。 */ (event) => events.push(event))
        f.approve(f.primary.device.machine_id, f.primary.device.epoch)
        assert.throws(
          // 外部身份成功提交后才让准备或本库最终 COMMIT 失败。
          () =>
            f.store.resetDeviceEnrollment(
              f.primary.device.machine_id,
              f.store.generation(),
              f.primary.device.epoch,
              // 宿主必须先同步关闭旧业务；Store 回滚不会自动重新打开这些 adapter 或解除 blocked。
              () => {
                f.closeChannels(f.primary.device.machine_id)
                f.block(f.primary.device.machine_id, f.primary.device.epoch)
                if (failure === 'prepare_after_block') {
                  throw Error('synthetic post-block failure')
                }
                f.state.failCommit = true
              }
            ),
          /storage_degraded/
        )
        assert.equal(
          f.observer.prepare('SELECT blocked FROM identities WHERE machine_id=?').get(f.primary.device.machine_id)!
            .blocked,
          1
        )
        assert.deepEqual(
          f.inspect.prepare('SELECT * FROM machines WHERE machine_id=?').get(f.primary.device.machine_id),
          beforeMachine
        )
        assert.deepEqual(f.inspect.prepare('SELECT * FROM calls WHERE call_id=?').get(call.call_id), beforeCall)
        assert.deepEqual(events, [])
        assert.deepEqual(f.state.closedMachines, [f.primary.device.machine_id])
        for (const native of [f.primary, f.sameDevice]) {
          assert.equal(native.adapter.stats().closed, true)
          assert.equal(native.adapter.stats().snapshot_bytes, 0)
        }
        f.state.failCommit = false
        f.store.resumeStorage()
        assert.equal(f.store.health().mode, 'active')
        // 反证：单独的 Store fence 确实仍接受回滚后的旧 epoch，所以拒绝不能归功于本库状态变化。
        f.store.assertConnection(binding)
        assert.throws(
          /* 独立 committed blocked 在 Store 恢复后继续拒绝连接。 */ () => f.primary.backend.connection(),
          /authentication_required/
        )
        assert.throws(
          /* 原生来源解析也必须独立拒绝，不能只核对旧 Store epoch。 */ () =>
            f.primary.backend.nativeSource(binding.call_id, binding.attempt_id),
          /authentication_required/
        )
        cold = createLuvusWireAdapter(f.primary.backend)
        assert.throws(
          /* 新 adapter 也不能利用仍存的原锚点重新生成旧执行许可。 */ () =>
            cold!.encode(requestFrame(binding), 'gateway_to_connector'),
          /native_adapter_unavailable/
        )
        assert.equal(cold.stats().snapshot_bytes, 0)
        assert.throws(
          /* 迟到响应同样在实际 planner 的独立身份门禁处拒绝。 */ () =>
            cold!.planEvidence(responseFrame(binding, { result: { id: 'task-created' } })),
          /native_adapter_unavailable/
        )
        assert.throws(
          /* 经真实响应提交入口也不能补写旧结果或假报 responded。 */ () =>
            commitLuvusResponse(f.store, cold!, responseFrame(binding, { result: { id: 'task-created' } }))
        )
        assert.equal(
          f.inspect.prepare('SELECT response_hash FROM calls WHERE call_id=?').get(call.call_id)!.response_hash,
          null
        )
        assert.equal(f.primary.state.sends, 1)
        assert.equal(f.sameDevice.state.sends, 1)
        assert.deepEqual(events, [])
      } finally {
        cold?.close()
        f.close()
      }
    }
  )
}

test(
  '离线 null epoch 重配会销毁该设备残留的旧 epoch 上下文，不影响其它设备',
  // 用真实提交先离线，再刻意从仅 Store 断连通知中隔离一个 adapter，覆盖设备级 fence 对旧状态的完整作用域。
  () => {
    const f = fixture()
    let detached: ReturnType<typeof createLuvusWireAdapter> | undefined
    try {
      let forward = false
      const backend = {
        ...f.primary.backend,
        // 仅故障注入漏掉断连通知，重配时重新转发真实 Store 事件到 adapter 自己的失效处理。
        subscribeInvalidation(listener: (event: LedgerInvalidation) => void) {
          return f.store.subscribeInvalidation(
            // 漏通知阶段不替 adapter 手动清状态；后续必须靠设备 fence 的真实处理完成回收。
            (event) => {
              if (forward) {
                listener(event)
              }
            }
          )
        }
      }
      detached = createLuvusWireAdapter(backend)
      const call = f.primary.create()
      const binding = f.primary.dispatch(call.call_id)
      detached.encode(requestFrame(binding), 'gateway_to_connector')
      assert.equal(detached.stats().executions, 1)
      f.store.disconnect(f.primary.device.machine_id, f.primary.device.epoch)
      assert.equal(detached.stats().executions, 1)
      forward = true
      f.approve(f.primary.device.machine_id, null)
      f.store.resetDeviceEnrollment(
        f.primary.device.machine_id,
        f.store.generation(),
        null,
        /* 离线重配仍提交独立身份库的精确 null fence。 */ () => f.block(f.primary.device.machine_id, null)
      )
      assert.equal(detached.stats().executions, 0)
      assert.equal(f.otherDevice.adapter.stats().closed, false)
    } finally {
      detached?.close()
      f.close()
    }
  }
)

for (const failure of ['management', 'epoch', 'prepare'] as const) {
  test(
    `重配在 ${failure} 阶段拒绝时不发布 fence 或销毁仍有效的上下文`,
    // 独立管理/fence/准备失败都只回滚本库，不能假报已提交重配而误清原上下文。
    () => {
      const f = fixture()
      try {
        const call = f.primary.create()
        f.primary.dispatch(call.call_id)
        const sealed = f.sameDevice.create()
        f.sameDevice.dispatch(sealed.call_id)
        f.store.discardResponse('synthetic', sealed.call_id)
        const frames = chunks(f.primary, 'rejected_' + failure)
        f.primary.adapter.acceptChunk(JSON.stringify(frames[0]), 'connector_to_gateway')
        const before = f.natives.map(
          /* 保存各 adapter 的真实正文和元数据计量供回滚后核对。 */ (native) => native.adapter.stats()
        )
        const events: LedgerInvalidation[] = []
        f.store.subscribeInvalidation(/* 记录真实提交后通知，拒绝路径应保持为空。 */ (event) => events.push(event))
        if (failure !== 'management') {
          f.approve(f.primary.device.machine_id, f.primary.device.epoch)
        }
        assert.throws(
          // 旧 epoch 或管理未授权会在 prepare 前拒绝；准备阶段故意抛出固定宿主错误。
          () =>
            f.store.resetDeviceEnrollment(
              f.primary.device.machine_id,
              f.store.generation(),
              failure === 'epoch' ? 'epoch_stale' : f.primary.device.epoch,
              // 此故障发生在外部副作用之前，不关闭通道、不提交 blocked。
              () => {
                throw new GatewayError('synthetic_prepare_rejected')
              }
            ),
          failure === 'management'
            ? /management_authorization_required/
            : failure === 'epoch'
              ? /device_epoch_mismatch/
              : /synthetic_prepare_rejected/
        )
        assert.deepEqual(events, [])
        assert.deepEqual(
          f.natives.map(
            /* 从运行中的 adapter 重新读取计量，不能用预先缓存值冒充未回收。 */ (native) => native.adapter.stats()
          ),
          before
        )
        assert.equal(f.state.prepareCalls, 0)
        assert.equal(
          f.observer.prepare('SELECT blocked FROM identities WHERE machine_id=?').get(f.primary.device.machine_id)!
            .blocked,
          0
        )
        assert.equal(f.store.health().mode, 'active')
      } finally {
        f.close()
      }
    }
  )
}
