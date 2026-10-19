// 以真实SQLite验证受保护签发与精确申请绑定；全部secret/策略/身份只属于隔离测试。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../../src/store.js'
import { StoreManagementWriteService } from '../../src/admin/write-service.js'
import type { ManagementIntent } from '../../src/mcp/management.js'
import { management } from '../storage/helpers.js'
import { confirmed, context, setup } from './write-helpers.js'

/** 当前时钟、SQLite及独立签发确认均属本fixture，不构造生产身份来源。 */
function owned(approved = true) {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-owned-pairing-custody-'))
  const path = join(root, 'gateway.sqlite')
  let now = 1000
  let fault = false
  const store = new Store(path, /** 受控短期材料只使用fixture时钟。 */ () => now, {
    ...(approved ? { management } : {}),
    /** 在本fixture实际COMMIT前触发故障，观察同库回滚。 */ fault() {
      if (fault) {
        throw new Error('SYNTHETIC_CUSTODY_COMMIT_FAILURE')
      }
    }
  })
  const f = setup(store)
  const service = new StoreManagementWriteService({
    store,
    identities: f.identities,
    /** 只批准本测试的固定非秘密策略引用。 */ pairingPolicy: (ref) => ref === 'policy_a' || ref === 'policy_b'
  })
  return {
    path,
    store,
    f,
    service,
    /** 精确推进申请和enrollment的可信截止时间。 */ advance(delta: number) {
      now += delta
    },
    /** 仅影响本fixture的下一次Store事务。 */ set fault(value: boolean) {
      fault = value
    },
    /** 回收本测试拥有的数据库和短期秘密材料。 */ close() {
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}
/** 通过真实管理确认事务创建申请；现存机器必须有精确设备授权。 */
async function application(
  o: ReturnType<typeof owned>,
  target: { name: string; labels: string[]; policy_ref: string } | { machine_id: string; policy_ref: string }
) {
  const revision =
    'machine_id' in target
      ? (await o.service.execute('write_state_get', { machine_id: target.machine_id }, context())).resource_revision
      : 0
  const operation: ManagementIntent =
    'name' in target ? { action: 'pairing_create', target } : { action: 'pairing_create', target }
  const c = await confirmed(o.service, operation, revision)
  const receipt = await o.service.execute('pairings_create', { ...c.write, ...target }, context())
  if ('name' in target) {
    o.f.grant(
      { action: 'devices_read', machine_id: receipt.machine_id },
      { action: 'devices_revoke', machine_id: receipt.machine_id }
    )
  }
  return receipt
}

/** 打开与writer独立的只读快照，只检查元数据，不输出任何token或credential。 */
function inspect<T>(path: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return read(db)
  } finally {
    db.close()
  }
}

test(
  'A过期后B新建，A旧token不能跨申请/策略兑换；B只由自身材料一次完成',
  /** 覆盖父独审的500000+110000ms真实SQLite复现，旧材料不再给B补造成功。 */ async () => {
    const o = owned()
    try {
      const a = await application(o, { name: 'owned_pairing_a', labels: [], policy_ref: 'policy_a' })
      o.advance(500_000)
      const tokenA = o.store.issuePairingEnrollment(a.machine_id, a.pairing_id, 'policy_a')
      const expiry = inspect(
        o.path,
        /** 签发即被原申请期限截断，不能再获得新的十分钟。 */ (db) =>
          db.prepare('SELECT expires FROM enrollments WHERE pairing_id=?').get(a.pairing_id)!.expires
      )
      assert.equal(expiry, a.expires_at)
      o.advance(110_000)
      const b = await application(o, { machine_id: a.machine_id, policy_ref: 'policy_b' })
      assert.throws(
        /** 旧申请材料既不能认证设备，也不能改变新申请状态。 */ () => o.store.redeem(tokenA),
        /invalid_enrollment/
      )
      assert.equal(o.store.machine(a.machine_id).status, 'pending')
      const stateA = await o.service.execute(
        'pairings_get',
        { machine_id: a.machine_id, pairing_id: a.pairing_id },
        context()
      )
      const stateB = await o.service.execute(
        'pairings_get',
        { machine_id: b.machine_id, pairing_id: b.pairing_id },
        context()
      )
      assert.equal(stateA.status, 'expired')
      assert.equal(stateB.status, 'pending')
      assert.equal(stateB.issuance, 'unverified')
      assert.throws(
        /** 旧策略引用不能为新申请签发材料。 */ () =>
          o.store.issuePairingEnrollment(b.machine_id, b.pairing_id, 'policy_a'),
        /invalid_pairing_issuance/
      )
      assert.throws(
        /** legacy设备签发不能绕过已存在的管理申请。 */ () => o.store.issueEnrollment(b.machine_id),
        /protected_pairing_issuance_required/
      )
      const tokenB = o.store.issuePairingEnrollment(b.machine_id, b.pairing_id, 'policy_b')
      const device = o.store.redeem(tokenB)
      assert.equal(device.machine_id, b.machine_id)
      assert.throws(/** 同一材料原子消费后不能重复兑换。 */ () => o.store.redeem(tokenB), /invalid_enrollment/)
      const pairedB = await o.service.execute(
        'pairings_get',
        { machine_id: b.machine_id, pairing_id: b.pairing_id },
        context()
      )
      assert.equal(pairedB.status, 'paired')
      assert.equal(
        (await o.service.execute('pairings_get', { machine_id: a.machine_id, pairing_id: a.pairing_id }, context()))
          .status,
        'expired'
      )
      const output = JSON.stringify([
        a,
        b,
        stateA,
        stateB,
        pairedB,
        inspect(
          o.path,
          /** 审计只能含关联元数据，不含token/credential。 */ (db) => db.prepare('SELECT * FROM audit').all()
        )
      ])
      for (const secret of [tokenA, tokenB, device.credential]) {
        assert(!output.includes(secret))
      }
      assert.equal(o.store.health().mode, 'active')
    } finally {
      o.close()
    }
  }
)

test(
  '同machine多申请/重复签发和错误目标均拒绝，不创建多余秘密',
  /** 同一申请最多签发一次，丢响应只能走独立取消/新申请流程。 */ async () => {
    const o = owned()
    try {
      const a = await application(o, { name: 'owned_pairing_unique', labels: [], policy_ref: 'policy_a' })
      await assert.rejects(application(o, { machine_id: a.machine_id, policy_ref: 'policy_b' }), /pairing_conflict/)
      const other = o.store.register('owned_pairing_other').machine_id
      assert.throws(
        /** 精确pairing_id不能拿到另一设备签发。 */ () =>
          o.store.issuePairingEnrollment(other, a.pairing_id, 'policy_a'),
        /invalid_pairing_issuance/
      )
      o.store.issuePairingEnrollment(a.machine_id, a.pairing_id, 'policy_a')
      assert.throws(
        /** 重复签发不得生成第二份材料或延长原申请。 */ () =>
          o.store.issuePairingEnrollment(a.machine_id, a.pairing_id, 'policy_a'),
        /invalid_pairing_issuance/
      )
      inspect(
        o.path,
        /** 只允许一份申请、一份hash；不读取secret原文。 */ (db) => {
          assert.equal(db.prepare('SELECT COUNT(*) n FROM admin_pairings').get()!.n, 1)
          assert.equal(db.prepare('SELECT COUNT(*) n FROM enrollments').get()!.n, 1)
        }
      )
      assert.equal(o.store.health().mode, 'active')
    } finally {
      o.close()
    }
  }
)

test(
  '缺受保护签发确认保持拒绝，不以合成管理session代替custody授权',
  /** 普通管理确认与独立秘密签发批准不能互相代替。 */ async () => {
    const o = owned(false)
    try {
      const a = await application(o, { name: 'owned_no_custody', labels: [], policy_ref: 'policy_a' })
      assert.throws(
        /** Store没有独立签发授权来源时不得生成材料。 */ () =>
          o.store.issuePairingEnrollment(a.machine_id, a.pairing_id, 'policy_a'),
        /management_authorization_required/
      )
      inspect(
        o.path,
        /** 拒绝不会把申请标为issued或留下hash。 */ (db) => {
          assert.equal(db.prepare('SELECT issued FROM admin_pairings').get()!.issued, 0)
          assert.equal(db.prepare('SELECT COUNT(*) n FROM enrollments').get()!.n, 0)
        }
      )
      assert.equal(o.store.health().mode, 'active')
    } finally {
      o.close()
    }
  }
)

for (const stage of ['issue', 'redeem'] as const) {
  test(
    `${stage}提交故障回滚精确申请/消费/授权/审计，保持原存储降级语义`,
    /** 同一writer故障不会交付未提交秘密或把申请标为paired。 */ async () => {
      const o = owned()
      try {
        const a = await application(o, { name: 'owned_custody_rollback', labels: [], policy_ref: 'policy_a' })
        const token =
          stage === 'redeem' ? o.store.issuePairingEnrollment(a.machine_id, a.pairing_id, 'policy_a') : undefined
        o.fault = true
        assert.throws(
          /** 在所选真实Store事务的COMMIT前触发故障，结果不得交付。 */ () =>
            token ? o.store.redeem(token) : o.store.issuePairingEnrollment(a.machine_id, a.pairing_id, 'policy_a'),
          /storage_degraded/
        )
        assert.equal(o.store.health().mode, 'storage_degraded')
        inspect(
          o.path,
          /** 读取已提交状态验证申请/凭据/消费均没有部分成功。 */ (db) => {
            const pairing = db.prepare('SELECT status,issued FROM admin_pairings').get()!
            assert.equal(pairing.status, 'pending')
            assert.equal(pairing.issued, stage === 'redeem' ? 1 : 0)
            const machine = db.prepare('SELECT status,credential_hash FROM machines').get()!
            assert.equal(machine.status, 'pending')
            assert.equal(machine.credential_hash, null)
            assert.equal(db.prepare('SELECT COUNT(*) n FROM enrollments WHERE consumed=1').get()!.n, 0)
            assert.equal(
              db
                .prepare('SELECT COUNT(*) n FROM audit WHERE action=?')
                .get(stage === 'issue' ? 'enrollment_issued' : 'enrollment_consumed')!.n,
              0
            )
          }
        )
      } finally {
        o.close()
      }
    }
  )
}
