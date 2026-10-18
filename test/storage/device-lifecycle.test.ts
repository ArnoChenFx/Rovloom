// 用两个隔离磁盘 SQLite 验证受保护设备生命周期桥及跨库失败时持久化阻断身份的边界。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, openSync, closeSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { Store } from '../../src/store.js'
import type { DeviceLifecycleRequest, StoreOptions } from '../../src/store.js'
import { boundedJson } from '../../src/wire/index.js'
import { management, connected, options } from './helpers.js'

// 构造只含合成设备的独立账本与身份库；身份库只模拟已验证证明和持久化 blocked，不签发外部凭据。
function fixture(retention?: StoreOptions['retention']) {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-lifecycle-'))
  const ledgerDirectory = join(root, 'ledger')
  mkdirSync(ledgerDirectory, { mode: 0o700 })
  const path = join(ledgerDirectory, 'state.sqlite')
  const identityPath = join(root, 'identity.sqlite')
  closeSync(openSync(identityPath, 'wx', 0o600))
  const identity = new DatabaseSync(identityPath)
  identity.exec(`PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE;
    CREATE TABLE identities(machine_id TEXT PRIMARY KEY,generation TEXT NOT NULL,
      blocked INTEGER NOT NULL,proof INTEGER NOT NULL,reset_fence TEXT);`)
  const identityInspect = new DatabaseSync(identityPath, { readOnly: true })
  const state = {
    failCommit: false,
    prepareCalls: 0,
    checks: [] as DeviceLifecycleRequest[],
    approval: undefined as { machine: string; fence: string; confirmation: string } | undefined
  }
  const settings: StoreOptions = {
    retention,
    maintenanceIntervalMs: 60_000,
    // 模拟独立管理确认，并严格核对本次重配的设备及 generation/epoch fence。
    management(request) {
      if (request.action !== 'device_enrollment_reset') {
        return management!(request)
      }
      const approval = state.approval
      if (!approval || request.target !== approval.machine || request.fence !== approval.fence) {
        return { actor: '', confirmation_id: '' }
      }
      return { actor: 'synthetic_admin', confirmation_id: approval.confirmation }
    },
    // 从独立 SQLite 消费一次性连接证明，或核对已提交的阻断状态及精确重配 fence。
    deviceLifecycle(request) {
      assert(Object.isFrozen(request))
      state.checks.push(request)
      if (request.action === 'connect') {
        return (
          identity
            .prepare('UPDATE identities SET proof=0 WHERE machine_id=? AND generation=? AND blocked=0 AND proof=1')
            .run(request.machine_id, request.recovery_generation).changes === 1
        )
      }
      // 用独立连接只观察已提交状态，不能把 prepare 当前未提交事务中的 blocked 当成 durable。
      const row = identityInspect.prepare('SELECT * FROM identities WHERE machine_id=?').get(request.machine_id)
      return (
        row?.blocked === 1 &&
        row.generation === request.recovery_generation &&
        row.reset_fence ===
          boundedJson({ recovery_generation: request.recovery_generation, connection_epoch: request.expected_epoch })
      )
    },
    // 只在业务事务的最终提交前注入故障，不修改独立身份库的既有提交。
    fault(point) {
      if (state.failCommit && point === 'before_commit') {
        throw Error('synthetic Store commit failure')
      }
    }
  }
  const store = new Store(path, Date.now, settings)
  const device = connected(store, 'synthetic')
  identity.prepare('INSERT INTO identities VALUES(?,?,0,0,NULL)').run(device.machine_id, store.generation())
  const inspect = new DatabaseSync(path)
  return {
    root,
    path,
    identityPath,
    identity,
    inspect,
    store,
    device,
    state,
    settings,
    // 在独立库登记本次已完成凭据校验的证明，不能为 blocked 身份重新授予证明。
    prove(machine = device.machine_id) {
      identity.prepare('UPDATE identities SET proof=1 WHERE machine_id=? AND blocked=0').run(machine)
    },
    // 模拟管理面确认精确设备和 epoch；同一确认 ID 是否已消费由 Store 事务防重放。
    approve(epoch: string | null, confirmation = randomUUID()) {
      state.approval = {
        machine: device.machine_id,
        fence: boundedJson({ recovery_generation: store.generation(), connection_epoch: epoch }),
        confirmation
      }
    },
    // 只持久化阻断，不签发凭据或清除 blocked；此提交不随随后 Store 失败撤销。
    block(epoch: string | null) {
      state.prepareCalls++
      identity
        .prepare('UPDATE identities SET blocked=1,proof=0,reset_fence=? WHERE machine_id=?')
        .run(boundedJson({ recovery_generation: store.generation(), connection_epoch: epoch }), device.machine_id)
    },
    // 返回独立身份库的落盘状态供断言，不从 Store 内存状态猜测跨库提交结论。
    identityRow() {
      return identity.prepare('SELECT * FROM identities WHERE machine_id=?').get(device.machine_id)!
    },
    // 读取完整设备内部行，只供测试核对凭据摘要与 epoch 是否随事务回滚。
    machineRow() {
      return inspect.prepare('SELECT * FROM machines WHERE machine_id=?').get(device.machine_id)!
    },
    // 按真实计量把审计子额留到指定余量，测试预算必须在外部 prepare 前拒绝。
    fillAudit(spare: number) {
      const rows = inspect.prepare('SELECT * FROM audit ORDER BY event_id').all()
      const first = rows[0]!
      let others = 0
      for (const row of rows.slice(1)) {
        others += Buffer.byteLength(JSON.stringify(row))
      }
      const empty = Buffer.byteLength(JSON.stringify({ ...first, details: '' }))
      const bytes = store.limits.audit_bytes - spare - others - empty
      assert(bytes > 0)
      inspect.prepare('UPDATE audit SET details=? WHERE event_id=?').run('x'.repeat(bytes), first.event_id!)
    },
    // 关闭两库和检查连接并删除临时目录，测试不接触任何真实设备或身份文件。
    close() {
      inspect.close()
      store.close()
      identityInspect.close()
      identity.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

test(
  'verified 入口缺少受保护宿主校验时拒绝，普通参数不能自称已验证',
  // 即使设备已在 Store 配对离线，未注入独立校验回调也不能建立 epoch。
  () => {
    const store = new Store(':memory:')
    try {
      const machine = store.register('synthetic')
      store.redeem(store.issueEnrollment(machine.machine_id))
      assert.throws(
        // 只有设备 ID 与当前 generation 不构成独立凭据校验证明。
        () => store.connectVerifiedDevice(machine.machine_id, store.generation()),
        /device_verification_required/
      )
      assert.equal(store.machine(machine.machine_id).status, 'offline')
    } finally {
      store.close()
    }
  }
)

test(
  '独立一次性凭据证明建立已提交 epoch，不依赖 Store 旧 credential hash',
  // 移除测试旧摘要后使用独立证明连接，核对磁盘 epoch、审计及重复在线拒绝。
  () => {
    const f = fixture()
    try {
      f.store.disconnect(f.device.machine_id, f.device.epoch)
      f.inspect.prepare('UPDATE machines SET credential_hash=NULL WHERE machine_id=?').run(f.device.machine_id)
      f.prove()
      const epoch = f.store.connectVerifiedDevice(f.device.machine_id, f.store.generation())
      assert.notEqual(epoch, f.device.epoch)
      assert.equal(f.machineRow().epoch, epoch)
      assert.equal(f.machineRow().status, 'online')
      assert.equal(f.identityRow().proof, 0)
      const audit = f.inspect.prepare("SELECT details FROM audit WHERE action='connected' ORDER BY rowid DESC").get()!
      assert.equal(JSON.parse(String(audit.details)).identity_source, 'protected_host')
      assert.throws(
        // 在线设备不能凭另一次证明抢占已有连接。
        () => f.store.connectVerifiedDevice(f.device.machine_id, f.store.generation()),
        /duplicate_device_connection/
      )
      assert.equal(f.state.checks.length, 1)
    } finally {
      f.close()
    }
  }
)

test(
  '旧 generation、pending、撤销和未完成恢复确认均在消费证明前拒绝',
  // 分别设置非法设备状态，证明宿主回调不会先消费证明再发现本库 fence 错误。
  () => {
    const f = fixture()
    try {
      f.store.disconnect(f.device.machine_id, f.device.epoch)
      f.prove()
      assert.throws(
        // 旧恢复 generation 不能获得当前连接 epoch。
        () => f.store.connectVerifiedDevice(f.device.machine_id, 'old-generation'),
        /recovery_generation_mismatch/
      )
      const pending = f.store.register('pending')
      assert.throws(
        // 尚未配对的 pending 设备不能跳过 enrollment。
        () => f.store.connectVerifiedDevice(pending.machine_id, f.store.generation()),
        /invalid_device_state/
      )
      f.inspect.prepare('UPDATE machines SET needs_confirmation=1 WHERE machine_id=?').run(f.device.machine_id)
      assert.throws(
        // 恢复后尚未独立确认的设备不能借原证明恢复上线。
        () => f.store.connectVerifiedDevice(f.device.machine_id, f.store.generation()),
        /invalid_device_state/
      )
      f.store.revoke(f.device.machine_id)
      assert.throws(
        // 撤销设备必须走受保护的重新配对流程。
        () => f.store.connectVerifiedDevice(f.device.machine_id, f.store.generation()),
        /invalid_device_state/
      )
      assert.equal(f.state.checks.length, 0)
      assert.equal(f.identityRow().proof, 1)
    } finally {
      f.close()
    }
  }
)

test(
  '连接提交失败不返回 epoch，不留下在线状态或审计，独立证明保持已消费',
  // 在证明消费后让 Store 真事务回滚，证明两个库不会被假报为原子提交。
  () => {
    const f = fixture()
    try {
      f.store.disconnect(f.device.machine_id, f.device.epoch)
      f.prove()
      f.state.failCommit = true
      assert.throws(
        // 已消费凭据证明不能让失败的 Store 提交返回可用 epoch。
        () => f.store.connectVerifiedDevice(f.device.machine_id, f.store.generation()),
        /storage_degraded/
      )
      assert.equal(f.machineRow().epoch, null)
      assert.equal(f.machineRow().status, 'offline')
      assert.equal(f.identityRow().proof, 0)
      assert.equal(f.store.health().mode, 'storage_degraded')
      assert.equal(f.inspect.prepare("SELECT COUNT(*) n FROM audit WHERE action='connected'").get()!.n, 1)
    } finally {
      f.close()
    }
  }
)

test(
  '同 ID 重配提交 pending，清凭据和 enrollment，已派发 unknown、未派发 not_dispatched',
  // 为同设备布置已派发及未派发调用，阻断身份后核对 Store 提交的全部生命周期变化。
  () => {
    const f = fixture()
    try {
      const sent = f.store.createCall('alice', f.device.target, { method: 'ping' }, options())
      const unsent = f.store.createCall('alice', f.device.target, { method: 'ping' }, options())
      const binding = f.store.dispatch('alice', sent.call_id, f.device.epoch)
      f.approve(f.device.epoch)
      f.store.resetDeviceEnrollment(
        f.device.machine_id,
        f.store.generation(),
        f.device.epoch,
        // 只提交独立身份库的 blocked 及精确旧连接 fence。
        () => f.block(f.device.epoch)
      )
      assert.equal(f.state.prepareCalls, 1)
      assert.equal(f.machineRow().machine_id, f.device.machine_id)
      assert.equal(f.machineRow().status, 'pending')
      assert.equal(f.machineRow().epoch, null)
      assert.equal(f.machineRow().credential_hash, null)
      assert.equal(
        f.inspect.prepare('SELECT COUNT(*) n FROM enrollments WHERE machine_id=?').get(f.device.machine_id)!.n,
        0
      )
      assert.equal(f.store.call('alice', sent.call_id).state, 'outcome_unknown')
      assert.equal(f.store.call('alice', unsent.call_id).state, 'not_dispatched')
      assert.equal(f.identityRow().blocked, 1)
      assert.throws(
        // 同 ID pending 不复用旧连接或补写旧响应证据。
        () => f.store.responseAnchor(binding),
        /stale_response/
      )
      assert.throws(
        // 已清除的旧 Store 凭据摘要不能认证。
        () => f.store.connect(f.device.machine_id, f.device.credential),
        /invalid_device_credential/
      )
      assert.throws(
        // 已删除的 enrollment 不能再次兑换。
        () => f.store.redeem(f.device.enrollment),
        /invalid_enrollment/
      )
    } finally {
      f.close()
    }
  }
)

test(
  '重配的 generation 和 epoch fence 错误不执行 prepare 或消费管理确认',
  // 在线、离线期望不可互换；旧 generation 与旧 epoch 都在任何外部提交前拒绝。
  () => {
    const f = fixture()
    let calls = 0
    // 统计不应执行的外部准备，不能在失败 fence 后修改独立身份库。
    const prepare = () => {
      calls++
    }
    try {
      f.approve(f.device.epoch)
      assert.throws(
        // 旧恢复 generation 不能重置当前设备身份。
        () => f.store.resetDeviceEnrollment(f.device.machine_id, 'old-generation', f.device.epoch, prepare),
        /recovery_generation_mismatch/
      )
      for (const epoch of [null, 'old-epoch']) {
        assert.throws(
          // 非当前 epoch 或 null 都不能抢占现有在线设备。
          () => f.store.resetDeviceEnrollment(f.device.machine_id, f.store.generation(), epoch, prepare),
          /device_epoch_mismatch/
        )
      }
      assert.equal(calls, 0)
      assert.equal(f.machineRow().epoch, f.device.epoch)
      assert.equal(f.identityRow().blocked, 0)
      assert.equal(
        f.inspect.prepare("SELECT COUNT(*) n FROM management WHERE action='device_enrollment_reset'").get()!.n,
        0
      )
    } finally {
      f.close()
    }
  }
)

test(
  '缺少独立管理确认或审计预算不足时不执行外部 prepare',
  // 先拒绝未确认操作，再耗尽真实审计子额验证预算预检早于独立身份提交。
  () => {
    const f = fixture({ audit_bytes: 16_384 })
    try {
      assert.throws(
        // 未经精确管理确认不能重置设备，即使具备宿主身份校验回调。
        () =>
          f.store.resetDeviceEnrollment(
            f.device.machine_id,
            f.store.generation(),
            f.device.epoch,
            // 不应执行的阻断动作可由调用次数检测。
            () => f.block(f.device.epoch)
          ),
        /management_authorization_required/
      )
      assert.equal(f.state.prepareCalls, 0)
      f.approve(f.device.epoch)
      f.fillAudit(1)
      assert.throws(
        // 本库无法保证审计提交时，不能先提交外部身份变化。
        () =>
          f.store.resetDeviceEnrollment(
            f.device.machine_id,
            f.store.generation(),
            f.device.epoch,
            // 此阻断动作应因前置预算失败而完全不执行。
            () => f.block(f.device.epoch)
          ),
        /storage_degraded/
      )
      assert.equal(f.state.prepareCalls, 0)
      assert.equal(f.identityRow().blocked, 0)
      assert.equal(f.machineRow().epoch, f.device.epoch)
    } finally {
      f.close()
    }
  }
)

test(
  '连接证明必须属于当前设备且尚未消费，blocked 身份不能重新授予证明',
  // 在独立库只为另一个已配对设备登记证明，确认机器 ID 不是可自行声明的认证事实。
  () => {
    const f = fixture()
    try {
      f.store.disconnect(f.device.machine_id, f.device.epoch)
      const other = f.store.register('other')
      f.store.redeem(f.store.issueEnrollment(other.machine_id))
      f.identity.prepare('INSERT INTO identities VALUES(?,?,0,1,NULL)').run(other.machine_id, f.store.generation())
      assert.throws(
        // 另一设备的已验证证明不能用于当前设备。
        () => f.store.connectVerifiedDevice(f.device.machine_id, f.store.generation()),
        /device_verification_required/
      )
      assert.equal(
        f.identity.prepare('SELECT proof FROM identities WHERE machine_id=?').get(other.machine_id)!.proof,
        1
      )
      f.prove()
      const epoch = f.store.connectVerifiedDevice(f.device.machine_id, f.store.generation())
      f.store.disconnect(f.device.machine_id, epoch)
      assert.throws(
        // 正常断连也不能复用此前已消费的连接证明。
        () => f.store.connectVerifiedDevice(f.device.machine_id, f.store.generation()),
        /device_verification_required/
      )
      f.block(null)
      f.prove()
      assert.equal(f.identityRow().proof, 0)
      assert.throws(
        // 持久化 blocked 的身份不能重新认证，即使 Store 行仍为 offline。
        () => f.store.connectVerifiedDevice(f.device.machine_id, f.store.generation()),
        /device_verification_required/
      )
    } finally {
      f.close()
    }
  }
)

test(
  'verified 连接的审计预算失败不提交 epoch，隔离、降级和关闭均阻止宿主证明消费',
  // 让真实审计子额不足以提交连接，然后逐一核验运行模式门禁不触发外部回调。
  () => {
    const f = fixture({ audit_bytes: 16_384 })
    try {
      f.store.disconnect(f.device.machine_id, f.device.epoch)
      f.prove()
      f.fillAudit(1)
      assert.throws(
        // 有效证明不代表审计和预算提交必然成功。
        () => f.store.connectVerifiedDevice(f.device.machine_id, f.store.generation()),
        /storage_degraded/
      )
      assert.equal(f.machineRow().status, 'offline')
      assert.equal(f.machineRow().epoch, null)
      const checks = f.state.checks.length
      assert.throws(
        // 已锁存降级的 Store 在调用身份校验前拒绝认证。
        () => f.store.connectVerifiedDevice(f.device.machine_id, f.store.generation()),
        /storage_degraded/
      )
      assert.equal(f.state.checks.length, checks)
      f.inspect.prepare("UPDATE metadata SET mode='recovery_quarantined'").run()
      assert.throws(
        // 恢复隔离不能通过独立身份库认证绕过。
        () => f.store.connectVerifiedDevice(f.device.machine_id, f.store.generation()),
        /recovery_quarantined/
      )
      assert.equal(f.state.checks.length, checks)
      f.store.close()
      assert.throws(
        // 已关闭的 Store 不读取数据库也不消费新证明。
        () => f.store.connectVerifiedDevice(f.device.machine_id, 'current-generation'),
        /storage_closed/
      )
      assert.equal(f.state.checks.length, checks)
    } finally {
      f.close()
    }
  }
)

test(
  'prepare 抛错回滚 Store，同步准备恰好一次，不提交清凭据或消费确认',
  // 在任何外部提交前失败，核对原 Store 行及一次性管理确认仍未提交。
  () => {
    const f = fixture()
    let calls = 0
    try {
      f.approve(f.device.epoch)
      const before = f.machineRow()
      assert.throws(
        // 真实 Store 事务内的准备异常必须使本库全部修改回滚。
        () =>
          f.store.resetDeviceEnrollment(
            f.device.machine_id,
            f.store.generation(),
            f.device.epoch,
            // 只增加调用计数并模拟独立身份写入前失败。
            () => {
              calls++
              throw Error('synthetic prepare failure')
            }
          ),
        /storage_degraded/
      )
      assert.equal(calls, 1)
      assert.deepEqual(f.machineRow(), before)
      assert.equal(f.identityRow().blocked, 0)
      assert.equal(
        f.inspect.prepare("SELECT COUNT(*) n FROM management WHERE action='device_enrollment_reset'").get()!.n,
        0
      )
    } finally {
      f.close()
    }
  }
)

for (const failure of ['prepare_after_block', 'store_commit'] as const) {
  test(
    `独立身份已提交 blocked 后 ${failure} 失败，Store 回滚但身份不能恢复可用`,
    // 分别覆盖外部提交后抛错与本库最终提交失败，两者都不得补偿为解除 blocked。
    () => {
      const f = fixture()
      try {
        f.approve(f.device.epoch)
        const before = f.machineRow()
        assert.throws(
          // 在真实身份库提交阻断后制造后半段失败。
          () =>
            f.store.resetDeviceEnrollment(
              f.device.machine_id,
              f.store.generation(),
              f.device.epoch,
              // 独立提交 blocked，再选择准备返回前抛错或 Store 最终提交故障。
              () => {
                f.block(f.device.epoch)
                if (failure === 'prepare_after_block') {
                  throw Error('synthetic post-block failure')
                }
                f.state.failCommit = true
              }
            ),
          /storage_degraded/
        )
        assert.equal(f.state.prepareCalls, 1)
        assert.deepEqual(f.machineRow(), before)
        const reader = new DatabaseSync(f.identityPath, { readOnly: true })
        try {
          assert.equal(
            reader.prepare('SELECT blocked FROM identities WHERE machine_id=?').get(f.device.machine_id)!.blocked,
            1
          )
        } finally {
          reader.close()
        }
      } finally {
        f.close()
      }
    }
  )
}

test(
  'prepare 未持久化 blocked 或返回 Promise 时拒绝，不能凭 void 回调假报双库成功',
  // no-op 准备必须被独立身份检查拒绝；异步返回值也不能越过同步事务边界。
  () => {
    const f = fixture()
    let calls = 0
    try {
      f.approve(f.device.epoch)
      assert.throws(
        // 没有 durable blocked 事实的准备不能提交 Store pending。
        () =>
          f.store.resetDeviceEnrollment(
            f.device.machine_id,
            f.store.generation(),
            f.device.epoch,
            // 故意只计数而不提交身份库，测试独立 blocked 复核。
            () => {
              calls++
            }
          ),
        /device_block_required/
      )
      assert.throws(
        // Promise 返回不能让事务在外部准备尚未同步完成时提交。
        () =>
          f.store.resetDeviceEnrollment(
            f.device.machine_id,
            f.store.generation(),
            f.device.epoch,
            // 故意返回已决 Promise，仍违反只能返回 undefined 的同步约束。
            () => {
              calls++
              return Promise.resolve()
            }
          ),
        /synchronous_prepare_required/
      )
      assert.equal(calls, 2)
      assert.equal(f.machineRow().status, 'online')
      assert.equal(f.identityRow().blocked, 0)
    } finally {
      f.close()
    }
  }
)

test(
  '独立身份库只写入未提交 blocked 时，保护回调从另一连接拒绝假报 durable',
  // 留下身份库的未提交事务后让 prepare 返回，Store 必须拒绝而不能依据同连接读到的临时状态提交 pending。
  () => {
    const f = fixture()
    try {
      f.approve(f.device.epoch)
      assert.throws(
        // 外部写入尚可回滚，不构成重配所需的持久化阻断。
        () =>
          f.store.resetDeviceEnrollment(
            f.device.machine_id,
            f.store.generation(),
            f.device.epoch,
            // 故意不提交外部事务，验证宿主的独立已提交状态观察。
            () => {
              f.identity.exec('BEGIN IMMEDIATE')
              f.block(f.device.epoch)
            }
          ),
        /device_block_required/
      )
      assert.equal(f.identityRow().blocked, 1)
      f.identity.exec('ROLLBACK')
      assert.equal(f.identityRow().blocked, 0)
      assert.equal(f.machineRow().epoch, f.device.epoch)
      assert.equal(f.machineRow().status, 'online')
      assert.equal(f.state.prepareCalls, 1)
    } finally {
      if (f.identity.isTransaction) {
        f.identity.exec('ROLLBACK')
      }
      f.close()
    }
  }
)

test(
  '重配管理确认只消费一次，prepare 内重入不能修改正在提交的 Store',
  // 在准备中尝试重入连接并确认拒绝，再证明同一管理确认不会第二次执行准备。
  () => {
    const f = fixture()
    try {
      const confirmation = randomUUID()
      f.approve(f.device.epoch, confirmation)
      f.store.resetDeviceEnrollment(
        f.device.machine_id,
        f.store.generation(),
        f.device.epoch,
        // 在原事务中尝试重入，再提交精确 fence 的独立阻断。
        () => {
          assert.throws(
            // 重入调用不能创建嵌套 writer 事务或 epoch。
            () => f.store.connectVerifiedDevice(f.device.machine_id, f.store.generation()),
            /transaction_in_progress/
          )
          f.block(f.device.epoch)
        }
      )
      f.approve(null, confirmation)
      assert.throws(
        // 已消费的确认不能再次重置同 ID，即使设备已处于 pending。
        () =>
          f.store.resetDeviceEnrollment(
            f.device.machine_id,
            f.store.generation(),
            null,
            // 此重复准备不应有机会执行。
            () => f.block(null)
          ),
        /confirmation_replayed/
      )
      assert.equal(f.state.prepareCalls, 1)
    } finally {
      f.close()
    }
  }
)

test(
  '外部 blocked COMMIT 后进程 SIGKILL，重开两库仍拒绝旧身份且不自动完成重配',
  // 真实杀死持有 Store 未提交事务的子进程，验证跨库崩溃窗口中的持久化拒绝。
  () => {
    const f = fixture()
    let reopened: Store | undefined
    try {
      f.store.close()
      const modulePath = fileURLToPath(new URL('../../src/store.ts', import.meta.url))
      const script = `
        import { DatabaseSync } from 'node:sqlite'
        import { Store } from ${JSON.stringify(modulePath)}
        import { randomUUID } from 'node:crypto'
        const input = JSON.parse(await Bun.stdin.text())
        const identity = new DatabaseSync(input.identity)
        const store = new Store(input.ledger, Date.now, {
          // 只对合成隔离设备提供本次管理确认。
          management: () => ({actor:'synthetic_admin',confirmation_id:randomUUID()}),
          // 子进程在准备阶段终止，此入口不会提供任何连接授权。
          deviceLifecycle: () => false
        })
        store.resetDeviceEnrollment(input.machine, store.generation(), null,
          // 外部阻断已经 durable，随即硬终止而不让 Store COMMIT 或补偿。
          () => {
            identity.prepare('UPDATE identities SET blocked=1,proof=0 WHERE machine_id=?').run(input.machine)
            process.kill(process.pid, 'SIGKILL')
          })
      `
      const child = spawnSync(process.execPath, ['--no-env-file', '--eval', script], {
        input: JSON.stringify({ identity: f.identityPath, ledger: f.path, machine: f.device.machine_id }),
        encoding: 'utf8',
        timeout: 10_000
      })
      assert.equal(child.signal, 'SIGKILL', child.stderr)
      assert.equal(f.identityRow().blocked, 1)
      // 仅删除本测试已确认退出子进程留下的隔离锁；产品不会自动删崩溃锁。
      unlinkSync(f.path + '.lock')
      reopened = new Store(f.path, Date.now, f.settings)
      assert.equal(reopened.machine(f.device.machine_id).status, 'offline')
      assert.equal(f.machineRow().epoch, null)
      assert.equal(
        f.inspect.prepare("SELECT COUNT(*) n FROM management WHERE action='device_enrollment_reset'").get()!.n,
        0
      )
      assert.throws(
        // 外部身份仍 blocked，重开 Store 不得恢复旧凭据校验证明。
        () => reopened!.connectVerifiedDevice(f.device.machine_id, reopened!.generation()),
        /device_verification_required/
      )
    } finally {
      reopened?.close()
      f.close()
    }
  }
)
