// 以真实 SQLite 验证在线配对认领的完整生命周期；秘密原文只属于隔离测试，账本只保存摘要。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { digest } from '../../src/contracts.js'
import { Store } from '../../src/store.js'
import { StoreManagementWriteService } from '../../src/admin/write-service.js'
import type { ManagementIntent } from '../../src/mcp/management.js'
import { management } from '../storage/helpers.js'
import { confirmed, context, setup } from './write-helpers.js'

const CLAIM_SECRET = 'test-claim-secret-0123456789abcdef'
const USER_CODE = 'K7M4Q9XD'

/** 当前时钟、SQLite 与管理服务均属本 fixture，不构造生产身份来源。 */
function owned(custody?: { machine_id: string; claim_id: string; credential: string }[]) {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-pairing-claims-'))
  const path = join(root, 'gateway.sqlite')
  let now = 1000
  const store = new Store(path, /** 受控短期材料只使用 fixture 时钟。 */ () => now, {
    management,
    ...(custody
      ? {
          /** 批准凭据只暂存进本 fixture 的内存 custody，断言其不进入回执。 */ pairingClaimCustody: (event: {
            machine_id: string
            claim_id: string
            credential: string
          }) => custody.push(event)
        }
      : {})
  })
  const f = setup(store)
  const service = new StoreManagementWriteService({
    store,
    identities: f.identities,
    /** 只批准本测试的固定非秘密策略引用。 */ pairingPolicy: (ref) => ref === 'policy_a'
  })
  return {
    store,
    service,
    f,
    /** 精确推进申请与认领的可信截止时间。 */ advance(delta: number) {
      now += delta
    },
    /** 回收本测试拥有的数据库。 */ close() {
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

/** 通过真实管理确认事务创建一份配对申请。 */
async function application(o: ReturnType<typeof owned>, name: string) {
  const operation: ManagementIntent = {
    action: 'pairing_create',
    target: { name, labels: [], policy_ref: 'policy_a' }
  }
  const c = await confirmed(o.service, operation, 0)
  const receipt = await o.service.execute('pairings_create', { ...c.write, ...operation.target }, context())
  o.f.grant(
    { action: 'devices_read', machine_id: receipt.machine_id },
    { action: 'devices_revoke', machine_id: receipt.machine_id }
  )
  return receipt
}

/** 断言调用以指定 Gateway 错误码拒绝。 */
function fails(fn: () => unknown, code: string) {
  assert.throws(fn, (error: unknown) => error instanceof Error && error.message === code)
}

test(
  'claim lifecycle: start, code-checked approve issues and redeems atomically, complete delivers',
  /* 认领从发起到批准在同一事务内完成签发与兑换，核对码错误时不签发，完成后状态如实流转。 */ async () => {
    const o = owned()
    try {
      const a = await application(o, 'claim_happy')
      const claim = o.store.startPairingClaim(a.machine_id, a.pairing_id, digest(CLAIM_SECRET), USER_CODE)
      assert.equal(claim.status, 'pending')
      assert.equal(claim.machine_id, a.machine_id)
      assert.equal(o.store.activePairingClaim(a.pairing_id)?.claim_id, claim.claim_id)
      assert.equal(o.store.verifyPairingClaimSecret(claim.claim_id, CLAIM_SECRET).claim_id, claim.claim_id)
      fails(
        /* 核对码错误时不能批准，也不消费申请的一次签发机会。 */ () =>
          o.store.approvePairingClaim(claim.claim_id, 'WRONG123', 'admin_a'),
        'pairing_claim_code_mismatch'
      )
      const result = o.store.approvePairingClaim(claim.claim_id, USER_CODE, 'admin_a')
      assert.equal(result.machine_id, a.machine_id)
      assert.equal(typeof result.credential, 'string')
      assert.equal(o.store.machine(a.machine_id).status, 'offline')
      assert.equal(o.store.pairingClaim(claim.claim_id).status, 'approved')
      fails(
        /* 已批准的认领不能再次批准重复签发。 */ () =>
          o.store.approvePairingClaim(claim.claim_id, USER_CODE, 'admin_a'),
        'invalid_pairing_claim'
      )
      o.store.completePairingClaim(claim.claim_id)
      assert.equal(o.store.pairingClaim(claim.claim_id).status, 'delivered')
    } finally {
      o.close()
    }
  }
)

test(
  'claim conflicts, secret verification and issued applications are refused',
  /* 同一申请只允许一个活动认领；秘密不匹配与不存在同错；已签发的申请不能再走认领。 */ async () => {
    const o = owned()
    try {
      const a = await application(o, 'claim_guards')
      const claim = o.store.startPairingClaim(a.machine_id, a.pairing_id, digest(CLAIM_SECRET), USER_CODE)
      fails(
        /* 第二个并发认领被拒绝，避免两个设备抢同一申请。 */ () =>
          o.store.startPairingClaim(a.machine_id, a.pairing_id, digest('other-secret'), 'OTHER123'),
        'pairing_claim_conflict'
      )
      fails(
        /* 出示错误的认领秘密原文时按无效认领处理。 */ () =>
          o.store.verifyPairingClaimSecret(claim.claim_id, 'not-the-secret'),
        'invalid_pairing_claim'
      )
      const b = await application(o, 'claim_issued')
      o.store.issuePairingEnrollment(b.machine_id, b.pairing_id, 'policy_a')
      fails(
        /* 申请已由受保护 custody 签发后，认领通道不能再签发一次。 */ () =>
          o.store.startPairingClaim(b.machine_id, b.pairing_id, digest(CLAIM_SECRET), USER_CODE),
        'invalid_pairing_issuance'
      )
    } finally {
      o.close()
    }
  }
)

test(
  'claim expiry blocks approval and expire() sweeps pending claims',
  /* 认领到期取申请与自身期限较小者；到期后不能批准，维护清理删除未批准认领行。 */ async () => {
    const o = owned()
    try {
      const a = await application(o, 'claim_expiry')
      const claim = o.store.startPairingClaim(a.machine_id, a.pairing_id, digest(CLAIM_SECRET), USER_CODE, 60_000)
      assert.equal(claim.expires, 61_000)
      o.advance(61_000)
      fails(
        /* 认领已过期，批准必须拒绝且不签发。 */ () =>
          o.store.approvePairingClaim(claim.claim_id, USER_CODE, 'admin_a'),
        'invalid_pairing_claim'
      )
      o.store.expire()
      fails(/* 过期未批准认领已被维护清理。 */ () => o.store.pairingClaim(claim.claim_id), 'pairing_claim_not_found')
    } finally {
      o.close()
    }
  }
)

test(
  'admin service approval delivers the credential only to custody and pairings_get reports the claim',
  /* 经真实确认流程批准：回执不含凭据、custody 恰收到一次、进度如实显示已签发与认领状态。 */ async () => {
    const custody: { machine_id: string; claim_id: string; credential: string }[] = []
    const o = owned(custody)
    try {
      const a = await application(o, 'claim_service')
      const claim = o.store.startPairingClaim(a.machine_id, a.pairing_id, digest(CLAIM_SECRET), USER_CODE)
      const revision = (await o.service.execute('write_state_get', { machine_id: a.machine_id }, context()))
        .resource_revision
      const approve: ManagementIntent = {
        action: 'pairing_claim_approve',
        target: { machine_id: a.machine_id, pairing_id: a.pairing_id, claim_id: claim.claim_id, user_code: USER_CODE }
      }
      const c = await confirmed(o.service, approve, revision)
      const receipt = await o.service.execute('pairings_claim_approve', { ...c.write, ...approve.target }, context())
      assert.equal(receipt.status, 'approved')
      assert.equal(receipt.claim_id, claim.claim_id)
      assert.equal(custody.length, 1)
      assert.equal(custody[0]!.claim_id, claim.claim_id)
      assert.equal(custody[0]!.machine_id, a.machine_id)
      assert.ok(!JSON.stringify(receipt).includes(custody[0]!.credential))
      const progress = await o.service.execute(
        'pairings_get',
        { machine_id: a.machine_id, pairing_id: a.pairing_id },
        context()
      )
      assert.equal(progress.issuance, 'issued')
      assert.equal(progress.requires_local_issuance, false)
      assert.equal(progress.claim?.claim_id, claim.claim_id)
      assert.equal(progress.claim?.status, 'approved')
      assert.equal(progress.claim?.user_code, USER_CODE)
    } finally {
      o.close()
    }
  }
)

test(
  'admin approval with a wrong code or without custody fails closed and changes nothing',
  /* 核对码错误以公开错误码拒绝；未注入在线 custody 时批准整事务回滚，认领与申请保持原状。 */ async () => {
    const custody: { machine_id: string; claim_id: string; credential: string }[] = []
    const o = owned(custody)
    const bare = owned()
    try {
      const a = await application(o, 'claim_wrong_code')
      const claim = o.store.startPairingClaim(a.machine_id, a.pairing_id, digest(CLAIM_SECRET), USER_CODE)
      const revision = (await o.service.execute('write_state_get', { machine_id: a.machine_id }, context()))
        .resource_revision
      const wrong: ManagementIntent = {
        action: 'pairing_claim_approve',
        target: { machine_id: a.machine_id, pairing_id: a.pairing_id, claim_id: claim.claim_id, user_code: 'WRONG123' }
      }
      const cw = await confirmed(o.service, wrong, revision)
      await assert.rejects(
        o.service.execute('pairings_claim_approve', { ...cw.write, ...wrong.target }, context()),
        /pairing_claim_code_mismatch/
      )
      assert.equal(custody.length, 0)
      assert.equal(o.store.pairingClaim(claim.claim_id).status, 'pending')

      const b = await application(bare, 'claim_no_custody')
      const claimB = bare.store.startPairingClaim(b.machine_id, b.pairing_id, digest(CLAIM_SECRET), USER_CODE)
      const revisionB = (await bare.service.execute('write_state_get', { machine_id: b.machine_id }, context()))
        .resource_revision
      const approveB: ManagementIntent = {
        action: 'pairing_claim_approve',
        target: { machine_id: b.machine_id, pairing_id: b.pairing_id, claim_id: claimB.claim_id, user_code: USER_CODE }
      }
      const cb = await confirmed(bare.service, approveB, revisionB)
      await assert.rejects(
        bare.service.execute('pairings_claim_approve', { ...cb.write, ...approveB.target }, context()),
        /backend_unavailable/
      )
      assert.equal(bare.store.pairingClaim(claimB.claim_id).status, 'pending')
      assert.equal(bare.store.machine(b.machine_id).status, 'pending')
    } finally {
      o.close()
      bare.close()
    }
  }
)

test(
  'pairing cancel cascades to the active claim and failure convergence is idempotent',
  /* 取消申请同事务把活动认领置为 cancelled；已批准认领交付失败后收敛为 failed 且不能再完成。 */ async () => {
    const o = owned()
    try {
      const a = await application(o, 'claim_cancel')
      const claim = o.store.startPairingClaim(a.machine_id, a.pairing_id, digest(CLAIM_SECRET), USER_CODE)
      const revision = (await o.service.execute('write_state_get', { machine_id: a.machine_id }, context()))
        .resource_revision
      const cancel: ManagementIntent = {
        action: 'pairing_cancel',
        target: { machine_id: a.machine_id, pairing_id: a.pairing_id }
      }
      const c = await confirmed(o.service, cancel, revision)
      await o.service.execute('pairings_cancel', { ...c.write, ...cancel.target }, context())
      assert.equal(o.store.pairingClaim(claim.claim_id).status, 'cancelled')
      fails(
        /* 已取消的认领不能再批准。 */ () => o.store.approvePairingClaim(claim.claim_id, USER_CODE, 'admin_a'),
        'invalid_pairing_claim'
      )

      const b = await application(o, 'claim_fail')
      const claimB = o.store.startPairingClaim(b.machine_id, b.pairing_id, digest(CLAIM_SECRET), USER_CODE)
      o.store.approvePairingClaim(claimB.claim_id, USER_CODE, 'admin_a')
      o.store.failPairingClaim(claimB.claim_id)
      assert.equal(o.store.pairingClaim(claimB.claim_id).status, 'failed')
      o.store.failPairingClaim(/* 重复收敛不抛错，保持运行时重试安全。 */ claimB.claim_id)
      fails(
        /* 已失败的认领不能再被标记为已交付。 */ () => o.store.completePairingClaim(claimB.claim_id),
        'invalid_pairing_claim'
      )
    } finally {
      o.close()
    }
  }
)

test(
  'approval records the approving principal; activation requires delivered and one fingerprint',
  /* 批准人是后续在线激活的授权主体，必须落账；激活只在交付后发生，指纹一致可重入、不同则冲突，终态不再被失败收敛改写。 */ async () => {
    const o = owned()
    try {
      const a = await application(o, 'claim_activation')
      const claim = o.store.startPairingClaim(a.machine_id, a.pairing_id, digest(CLAIM_SECRET), USER_CODE)
      assert.equal(claim.approved_by, null)
      assert.equal(claim.native_fingerprint, null)
      fails(
        /* 未交付的认领不能激活。 */ () => o.store.activatePairingClaim(claim.claim_id, 'a'.repeat(64)),
        'invalid_pairing_claim'
      )
      o.store.approvePairingClaim(claim.claim_id, USER_CODE, 'admin_a')
      assert.equal(o.store.pairingClaim(claim.claim_id).approved_by, 'admin_a')
      fails(
        /* 已批准未交付同样不能激活。 */ () => o.store.activatePairingClaim(claim.claim_id, 'a'.repeat(64)),
        'invalid_pairing_claim'
      )
      o.store.completePairingClaim(claim.claim_id)
      const activated = o.store.activatePairingClaim(claim.claim_id, 'a'.repeat(64))
      assert.equal(activated.status, 'activated')
      assert.equal(activated.native_fingerprint, 'a'.repeat(64))
      const again = o.store.activatePairingClaim(claim.claim_id, 'a'.repeat(64))
      assert.equal(again.status, 'activated')
      fails(
        /* 同一认领不能以另一份清单重复激活。 */ () => o.store.activatePairingClaim(claim.claim_id, 'b'.repeat(64)),
        'pairing_claim_conflict'
      )
      o.store.failPairingClaim(claim.claim_id)
      assert.equal(o.store.pairingClaim(claim.claim_id).status, 'activated')
    } finally {
      o.close()
    }
  }
)
