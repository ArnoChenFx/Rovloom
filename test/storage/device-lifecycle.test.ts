// 验证设备重配与凭据交付拒绝都是单个 Store 事务：确认缺失、fence 错误或提交失败整体回滚，成功后旧凭据与旧 epoch 失效。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/store.js'
import type { StoreOptions } from '../../src/store.js'
import { boundedJson } from '../../src/wire/index.js'
import { connected, management, options } from './helpers.js'

// 构造含一个已连接合成设备的磁盘账本，并让重配动作只在指定设备与 fence 上获得管理确认。
function fixture(retention?: StoreOptions['retention']) {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-lifecycle-'))
  const directory = join(root, 'ledger')
  mkdirSync(directory, { mode: 0o700 })
  const path = join(directory, 'state.sqlite')
  const state = {
    failCommit: false,
    approval: undefined as { machine: string; fence: string; confirmation: string } | undefined
  }
  const settings: StoreOptions = {
    retention,
    maintenanceIntervalMs: 60_000,
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
    fault(point) {
      if (state.failCommit && point === 'before_commit') {
        throw Error('synthetic Store commit failure')
      }
    }
  }
  const store = new Store(path, Date.now, settings)
  const device = connected(store, 'synthetic')
  const inspect = new DatabaseSync(path)
  return {
    root,
    store,
    device,
    state,
    inspect,
    /** 模拟管理面确认精确设备与 epoch；同一确认 ID 是否已消费由 Store 事务防重放。 */
    approve(epoch: string | null, confirmation: string = randomUUID()) {
      state.approval = {
        machine: device.machine_id,
        fence: boundedJson({ recovery_generation: store.generation(), connection_epoch: epoch }),
        confirmation
      }
    },
    /** 读取完整设备行，核对凭据摘要与 epoch 是否随事务回滚。 */
    machineRow() {
      return inspect.prepare('SELECT * FROM machines WHERE machine_id=?').get(device.machine_id)!
    },
    /** 按真实计量把审计子额留到指定余量，使重配事务提交时因预算失败。 */
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
    close() {
      inspect.close()
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

test(
  '同 ID 重配提交 pending，清凭据和 enrollment，已派发 unknown、未派发 not_dispatched',
  /** 为同设备布置已派发及未派发调用，重配提交后核对全部生命周期变化。 */ () => {
    const f = fixture()
    try {
      const sent = f.store.createCall('alice', f.device.target, { method: 'ping' }, options())
      const unsent = f.store.createCall('alice', f.device.target, { method: 'ping' }, options())
      const binding = f.store.dispatch('alice', sent.call_id, f.device.epoch)
      f.approve(f.device.epoch)
      f.store.resetDeviceEnrollment(f.device.machine_id, f.store.generation(), f.device.epoch)
      assert.equal(f.machineRow().status, 'pending')
      assert.equal(f.machineRow().epoch, null)
      assert.equal(f.machineRow().credential_hash, null)
      assert.equal(
        f.inspect.prepare('SELECT COUNT(*) n FROM enrollments WHERE machine_id=?').get(f.device.machine_id)!.n,
        0
      )
      assert.equal(f.store.call('alice', sent.call_id).state, 'outcome_unknown')
      assert.equal(f.store.call('alice', unsent.call_id).state, 'not_dispatched')
      assert.throws(
        /** 同 ID pending 不复用旧连接或补写旧响应证据。 */ () => f.store.responseAnchor(binding),
        /stale_response/
      )
      assert.throws(
        /** 已清除的旧凭据摘要不能认证。 */ () => f.store.connect(f.device.machine_id, f.device.credential),
        /invalid_device_credential/
      )
      assert.throws(
        /** 已删除的 enrollment 不能再次兑换。 */ () => f.store.redeem(f.device.enrollment),
        /invalid_enrollment/
      )
    } finally {
      f.close()
    }
  }
)

test(
  '重配缺少管理确认、fence 错误或确认重放时不改变设备',
  /** 失败必须发生在任何状态变化之前，且错误 fence 不消费确认。 */ () => {
    const f = fixture()
    try {
      assert.throws(
        () => f.store.resetDeviceEnrollment(f.device.machine_id, f.store.generation(), f.device.epoch),
        /management_authorization_required/
      )
      f.approve(f.device.epoch)
      assert.throws(
        /** 旧代次拒绝。 */ () =>
          f.store.resetDeviceEnrollment(f.device.machine_id, 'other_generation', f.device.epoch),
        /recovery_generation_mismatch/
      )
      assert.throws(
        /** 错误 epoch 拒绝。 */ () =>
          f.store.resetDeviceEnrollment(f.device.machine_id, f.store.generation(), 'other_epoch'),
        /device_epoch_mismatch/
      )
      assert.equal(f.machineRow().epoch, f.device.epoch)
      assert.equal(f.machineRow().status, 'online')
      // 同一确认只能使用一次：先成功，再让第二次重配使用同一确认。
      f.approve(f.device.epoch, 'single_use_confirmation')
      f.store.resetDeviceEnrollment(f.device.machine_id, f.store.generation(), f.device.epoch)
      assert.throws(
        /** 重放同一确认 ID 被拒绝。 */ () =>
          f.store.resetDeviceEnrollment(f.device.machine_id, f.store.generation(), null),
        /management_authorization_required|confirmation_replayed/
      )
    } finally {
      f.close()
    }
  }
)

test(
  '提交失败或审计预算不足时重配整体回滚',
  /** 单事务保证凭据、epoch、enrollment 与管理确认要么全部生效，要么全部不变。 */ () => {
    const f = fixture({ audit_bytes: 16_384 })
    try {
      f.approve(f.device.epoch)
      f.state.failCommit = true
      assert.throws(() => f.store.resetDeviceEnrollment(f.device.machine_id, f.store.generation(), f.device.epoch))
      f.state.failCommit = false
      assert.equal(f.machineRow().status, 'online')
      assert.equal(f.machineRow().epoch, f.device.epoch)
      assert.notEqual(f.machineRow().credential_hash, null)
    } finally {
      f.close()
    }
    const g = fixture({ audit_bytes: 16_384 })
    try {
      g.approve(g.device.epoch)
      g.fillAudit(1)
      assert.throws(
        () => g.store.resetDeviceEnrollment(g.device.machine_id, g.store.generation(), g.device.epoch),
        /storage_degraded/
      )
      assert.equal(g.machineRow().epoch, g.device.epoch)
      assert.notEqual(g.machineRow().credential_hash, null)
    } finally {
      g.close()
    }
  }
)

test(
  '凭据交付拒绝只对精确摘要生效：清凭据、断开在线 epoch、要求经确认重新配对',
  /** 不匹配的摘要不改变任何状态；匹配后旧凭据立即失效且调用状态收敛。 */ () => {
    const f = fixture()
    try {
      const sent = f.store.createCall('alice', f.device.target, { method: 'ping' }, options())
      f.store.dispatch('alice', sent.call_id, f.device.epoch)
      f.store.denyDelivery(f.device.machine_id, 'a'.repeat(64))
      assert.equal(f.machineRow().status, 'online')
      assert.equal(f.machineRow().epoch, f.device.epoch)
      f.store.denyDelivery(f.device.machine_id, createHash('sha256').update(f.device.credential).digest('hex'))
      assert.equal(f.machineRow().status, 'pending')
      assert.equal(f.machineRow().epoch, null)
      assert.equal(f.machineRow().credential_hash, null)
      assert.equal(f.machineRow().needs_confirmation, 1)
      assert.equal(f.store.call('alice', sent.call_id).state, 'outcome_unknown')
      assert.throws(() => f.store.connect(f.device.machine_id, f.device.credential), /invalid_device_credential/)
    } finally {
      f.close()
    }
  }
)
