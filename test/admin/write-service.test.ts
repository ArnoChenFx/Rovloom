// 验证真实 Store 管理事务、精确权限与幂等；所有身份/设备只存在于隔离 fixture。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/store.js'
import { StoreManagementWriteService } from '../../src/admin/write-service.js'
import type { ManagementIntent } from '../../src/mcp/management.js'
import { management } from '../storage/helpers.js'
import { confirmed, context, setup } from './write-helpers.js'

/** 取得当前服务提供的真实设备 revision，不从旧页面或名称推断目标。 */
async function revision(f: ReturnType<typeof setup>, machine: string) {
  return (await f.service.execute('write_state_get', { machine_id: machine }, context())).resource_revision
}
/** 生成受控新设备配对申请，不签发或交付 enrollment。 */
async function register(f: ReturnType<typeof setup>, name: string) {
  const operation: ManagementIntent = {
    action: 'pairing_create',
    target: { name, policy_ref: 'fixture_policy', labels: ['isolated'] }
  }
  const c = await confirmed(f.service, operation, 0)
  const receipt = await f.service.execute('pairings_create', { ...c.write, ...operation.target }, context())
  f.grant(
    { action: 'devices_read', machine_id: receipt.machine_id },
    { action: 'devices_rename', machine_id: receipt.machine_id },
    { action: 'devices_disconnect', machine_id: receipt.machine_id },
    { action: 'devices_revoke', machine_id: receipt.machine_id }
  )
  return { receipt, c, operation }
}

test(
  '注册只创建pending申请，重复/丢响应只读原回执，确认和审计原子持久化',
  /** 检查实际磁盘数据库与服务重建，不使用内存回执缓存。 */ async () => {
    const root = mkdtempSync(join(tmpdir(), 'rovloom-management-owned-'))
    const path = join(root, 'gateway.sqlite')
    let store = new Store(path)
    let f = setup(store)
    try {
      const created = await register(f, 'owned_registration')
      assert.equal(f.store.machine(created.receipt.machine_id).status, 'pending')
      assert.equal(created.receipt.requires_local_issuance, true)
      assert.equal(created.receipt.effects.native_work, 'may_continue')
      // 原会话获得新增目标 grant 后政策变化不续发或复制已提交申请。
      const again = await f.service.execute(
        'pairings_create',
        { ...created.c.write, ...created.operation.target } as never,
        context()
      )
      assert.deepEqual(again, created.receipt)
      const progress = await f.service.execute(
        'pairings_get',
        { machine_id: again.machine_id, pairing_id: again.pairing_id },
        context()
      )
      assert.equal(progress.status, 'pending')
      assert.equal(progress.issuance, 'unverified')
      store.close()
      store = new Store(path)
      f = setup(store)
      const recovered = await f.service.execute(
        'operations_get',
        {
          request_id: created.c.write.request_id,
          history_epoch: created.c.write.history_epoch,
          recovery_generation: created.c.write.recovery_generation
        },
        context()
      )
      assert.deepEqual(recovered, created.receipt)
      assert.deepEqual(
        await f.service.execute(
          'pairings_create',
          { ...created.c.write, ...created.operation.target } as never,
          context()
        ),
        created.receipt
      )
      store.close()
      const db = new DatabaseSync(path)
      try {
        const audit = db
          .prepare('SELECT actor,action,details FROM audit WHERE event_id=?')
          .get(created.receipt.audit_event_ids[0]!)!
        assert.equal(audit.actor, 'fixture_admin')
        assert.equal(audit.action, 'pairing_create')
        assert.equal(db.prepare('SELECT COUNT(*) n FROM machines').get()!.n, 1)
        assert.equal(db.prepare('SELECT COUNT(*) n FROM enrollments').get()!.n, 0)
        assert.equal(
          db
            .prepare('SELECT state FROM admin_confirmations WHERE confirmation_id=?')
            .get(created.c.write.confirmation_id)!.state,
          'consumed'
        )
        assert(!JSON.stringify(audit).includes('fixture_session'))
      } finally {
        db.close()
      }
    } finally {
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  '改名的真实确认不能换目标/请求/摘要，stale revision和会话撤权拒绝',
  /** 直接调用共享服务也必须复验独立权限，不能依赖浏览器按钮。 */ async () => {
    const f = setup()
    try {
      const { receipt } = await register(f, 'owned_rename')
      const machine = receipt.machine_id
      const other = f.store.register('owned_other').machine_id
      const op: ManagementIntent = { action: 'device_rename', target: { machine_id: machine }, name: 'owned_renamed' }
      const c = await confirmed(f.service, op, await revision(f, machine))
      await assert.rejects(
        f.service.execute('devices_rename', { ...c.write, machine_id: other, name: op.name }, context()),
        /forbidden/
      )
      await assert.rejects(
        f.service.execute('devices_rename', { ...c.write, machine_id: machine, name: 'different' }, context()),
        /confirmation_mismatch/
      )
      await assert.rejects(
        f.service.execute(
          'devices_rename',
          { ...c.write, request_id: 'another_request', machine_id: machine, name: op.name },
          context()
        ),
        /confirmation_required/
      )
      const changed = { ...c.draft, name: 'different' }
      await assert.rejects(f.service.execute('confirmations_create', changed, context()), /idempotency_conflict/)
      f.store.rename(machine, 'changed_elsewhere')
      await assert.rejects(
        f.service.execute('devices_rename', { ...c.write, machine_id: machine, name: op.name }, context()),
        /revision_conflict/
      )
      const fresh = await confirmed(f.service, op, await revision(f, machine))
      f.admin = { ...f.admin!, grants: [{ action: 'devices_register' }], policy_revision: 'withdrawn' }
      await assert.rejects(
        f.service.execute('devices_rename', { ...fresh.write, machine_id: machine, name: op.name }, context()),
        /forbidden/
      )
      f.admin = null
      await assert.rejects(
        f.service.execute('devices_rename', { ...fresh.write, machine_id: machine, name: op.name }, context()),
        /unauthenticated/
      )
      assert.equal(f.store.machine(machine).name, 'changed_elsewhere')
    } finally {
      f.close()
    }
  }
)

test(
  '确认期限、取消申请、已兑换冲突与秘密不进入普通回执',
  /** enrollment仅在本测试受保护内存直接签发，产品管理服务从不接收或返回它。 */ async () => {
    const f = setup(undefined, { management })
    try {
      const { receipt } = await register(f, 'owned_cancel')
      const machine = receipt.machine_id
      const cancel: ManagementIntent = {
        action: 'pairing_cancel',
        target: { machine_id: machine, pairing_id: receipt.pairing_id }
      }
      const expired = await confirmed(f.service, cancel, await revision(f, machine))
      f.advance(120_000)
      await assert.rejects(
        f.service.execute('pairings_cancel', { ...expired.write, ...cancel.target }, context()),
        /confirmation_expired/
      )
      const secret = f.store.issuePairingEnrollment(machine, receipt.pairing_id, 'fixture_policy')
      const c = await confirmed(f.service, cancel, await revision(f, machine))
      const result = await f.service.execute('pairings_cancel', { ...c.write, ...cancel.target }, context())
      assert.equal((await f.service.execute('pairings_get', cancel.target, context())).status, 'cancelled')
      assert.throws(/** 已取消申请不能兑换此前签发的合成 token。 */ () => f.store.redeem(secret), /invalid_enrollment/)
      assert(!JSON.stringify(result).includes(secret))
      const second = await register(f, 'owned_consumed')
      const token = f.store.issuePairingEnrollment(
        second.receipt.machine_id,
        second.receipt.pairing_id,
        'fixture_policy'
      )
      const old = await confirmed(
        f.service,
        {
          action: 'pairing_cancel',
          target: { machine_id: second.receipt.machine_id, pairing_id: second.receipt.pairing_id }
        },
        await revision(f, second.receipt.machine_id)
      )
      const device = f.store.redeem(token)
      await assert.rejects(
        f.service.execute(
          'pairings_cancel',
          { ...old.write, machine_id: device.machine_id, pairing_id: second.receipt.pairing_id },
          context()
        ),
        /revision_conflict/
      )
      const paired = await f.service.execute(
        'pairings_get',
        { machine_id: device.machine_id, pairing_id: second.receipt.pairing_id },
        context()
      )
      assert.equal(paired.status, 'paired')
      assert(!JSON.stringify(paired).includes(device.credential))
    } finally {
      f.close()
    }
  }
)

test(
  '同库提交失败不消费确认/写回执/改名，降级后拒绝再次变更',
  /** 在真实writer COMMIT前注入故障，随后只读SQLite检查原子性。 */ async () => {
    let fail = false
    const root = mkdtempSync(join(tmpdir(), 'rovloom-management-failure-'))
    const path = join(root, 'gateway.sqlite')
    const store = new Store(path, Date.now, {
      /** 本测试仅在最后管理事务触发故障。 */ fault() {
        if (fail) {
          throw new Error('SYNTHETIC_PRIVATE_ERROR')
        }
      }
    })
    const f = setup(store)
    try {
      const { receipt } = await register(f, 'owned_atomic')
      const c = await confirmed(
        f.service,
        { action: 'device_rename', target: { machine_id: receipt.machine_id }, name: 'must_not_commit' },
        await revision(f, receipt.machine_id)
      )
      fail = true
      await assert.rejects(
        f.service.execute(
          'devices_rename',
          { ...c.write, machine_id: receipt.machine_id, name: 'must_not_commit' },
          context()
        ),
        /storage_degraded/
      )
      assert.equal(store.machine(receipt.machine_id).name, 'owned_atomic')
      store.close()
      const db = new DatabaseSync(path)
      try {
        assert.equal(
          db.prepare('SELECT state FROM admin_confirmations WHERE confirmation_id=?').get(c.write.confirmation_id)!
            .state,
          'confirmed'
        )
        assert.equal(
          db.prepare('SELECT COUNT(*) n FROM admin_operations WHERE request_id=?').get(c.write.request_id)!.n,
          0
        )
        assert.equal(db.prepare('SELECT COUNT(*) n FROM audit WHERE action=?').get('device_rename')!.n, 0)
      } finally {
        db.close()
      }
    } finally {
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  '无生产session/策略/transport拒绝，provider启用必须另接可信双端证明',
  /** 缺组件时返回明确拒绝，合成管理员不作为产品默认会话。 */ async () => {
    const f = setup(undefined, { management })
    try {
      const machine = f.store.register('owned_provider').machine_id
      f.grant({ action: 'providers_manage', machine_id: machine, provider_id: 'one' })
      f.store.defineProvider({
        machine_id: machine,
        provider_id: 'one',
        kind: 'luvus',
        config_ref: 'fixture_only',
        binding_revision: 1,
        enabled: true
      })
      f.store.defineProvider({
        machine_id: machine,
        provider_id: 'two',
        kind: 'herdr',
        config_ref: 'fixture_other',
        binding_revision: 1,
        enabled: true
      })
      const c = await confirmed(
        f.service,
        {
          action: 'provider_disable',
          target: { machine_id: machine, provider_id: 'one', kind: 'luvus' },
          expected_binding_revision: 1
        },
        1
      )
      const result = await f.service.execute(
        'providers_disable',
        { ...c.write, machine_id: machine, provider_id: 'one', kind: 'luvus', expected_binding_revision: 1 },
        context()
      )
      assert.equal(result.new_binding_revision, 2)
      assert.equal(f.store.provider(machine, 'two')!.binding_revision, 1)
      await assert.rejects(
        confirmed(
          f.service,
          {
            action: 'provider_enable',
            target: { machine_id: machine, provider_id: 'one', kind: 'luvus' },
            expected_binding_revision: 2
          },
          2
        ),
        /backend_unavailable/
      )
      const unbound = new StoreManagementWriteService({ store: f.store, identities: f.identities })
      await assert.rejects(
        confirmed(
          unbound,
          { action: 'pairing_create', target: { name: 'not_created', labels: [], policy_ref: 'fixture_policy' } },
          0
        ),
        /backend_unavailable/
      )
      f.authenticated = false
      await assert.rejects(f.service.execute('history_open', {}, context()), /unauthenticated/)
      await assert.rejects(f.service.execute('history_open', { approved: true } as never, context()), /unauthenticated/)
    } finally {
      f.close()
    }
  }
)
