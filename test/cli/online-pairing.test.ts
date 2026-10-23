// 以真实 Store 与管理确认链验证在线认领 HTTP 面：秘密只以摘要进入，凭据只经内存 custody 在确认领取后交付一次。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { digest } from '../../src/contracts.js'
import { Store } from '../../src/store.js'
import { StoreManagementWriteService } from '../../src/admin/write-service.js'
import { OnlinePairingHttp } from '../../src/cli/online-pairing-http.js'
import type { ManagementIntent } from '../../src/mcp/management.js'
import { management } from '../storage/helpers.js'
import { confirmed, context, setup } from '../admin/write-helpers.js'

const CLAIM_SECRET = 'online-claim-secret-0123456789abcdef'

/** fixture 时钟同时驱动 Store 与在线 custody，HTTP 请求对象只属于本测试。 */
function owned() {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-online-pairing-'))
  const path = join(root, 'gateway.sqlite')
  let now = 1000
  const custody: { http?: OnlinePairingHttp } = {}
  const store = new Store(path, /** 受控短期材料只使用 fixture 时钟。 */ () => now, {
    management,
    /** 批准凭据只暂存进同一在线 custody 实例，与生产装配同一形状。 */ pairingClaimCustody: (event) => {
      if (!custody.http) {
        throw new Error('online_pairing_unavailable')
      }
      custody.http.hold(event)
    }
  })
  const online = new OnlinePairingHttp(store, () => now)
  custody.http = online
  const f = setup(store)
  const service = new StoreManagementWriteService({
    store,
    identities: f.identities,
    /** 只批准本测试的固定非秘密策略引用。 */ pairingPolicy: (ref) => ref === 'policy_a'
  })
  return {
    store,
    service,
    online,
    f,
    /** 精确推进申请与认领的可信截止时间。 */ advance(delta: number) {
      now += delta
    },
    /** 回收本测试拥有的数据库与交付计时。 */ close() {
      online.close()
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

/** 经真实确认流程批准指定认领，凭据由 custody 暂存而非回执交付。 */
async function approve(
  o: ReturnType<typeof owned>,
  target: { machine_id: string; pairing_id: string },
  claim_id: string,
  user_code: string
) {
  const revision = (await o.service.execute('write_state_get', { machine_id: target.machine_id }, context()))
    .resource_revision
  const intent: ManagementIntent = {
    action: 'pairing_claim_approve',
    target: { machine_id: target.machine_id, pairing_id: target.pairing_id, claim_id, user_code }
  }
  const c = await confirmed(o.service, intent, revision)
  return o.service.execute('pairings_claim_approve', { ...c.write, ...intent.target }, context())
}

/** 构造与设备端同形状的 JSON POST 请求。 */
function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://gateway${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  })
}

test(
  'online claim round trip: claim, pending status, approved delivery, ack completes exactly once',
  /* 认领经 HTTP 发起，批准后凭据只在出示秘密的状态查询里交付，确认后认领完成且不能重复确认。 */ async () => {
    const o = owned()
    try {
      const a = await application(o, 'online_happy')
      const created = await o.online.handle(
        post('/pairing/claim', { pairing_id: a.pairing_id, secret_hash: digest(CLAIM_SECRET) })
      )
      assert.equal(created?.status, 200)
      const claim = (await created!.json()) as { claim_id: string; user_code: string; expires_at: number }
      assert.match(claim.user_code, /^[A-Z0-9]{8}$/)
      const wrong = await o.online.handle(
        post('/pairing/claim/status', { claim_id: claim.claim_id, secret: 'not-the-secret-0123456789' })
      )
      assert.equal(wrong?.status, 400)
      const pending = await o.online.handle(
        post('/pairing/claim/status', { claim_id: claim.claim_id, secret: CLAIM_SECRET })
      )
      assert.deepEqual(await pending!.json(), { status: 'pending' })
      await approve(o, a, claim.claim_id, claim.user_code)
      const approved = await o.online.handle(
        post('/pairing/claim/status', { claim_id: claim.claim_id, secret: CLAIM_SECRET })
      )
      const delivered = (await approved!.json()) as { status: string; credential: string }
      assert.equal(delivered.status, 'approved')
      assert.equal(typeof delivered.credential, 'string')
      const ack = await o.online.handle(post('/pairing/claim/ack', { claim_id: claim.claim_id, secret: CLAIM_SECRET }))
      assert.deepEqual(await ack!.json(), { status: 'delivered' })
      const after = await o.online.handle(
        post('/pairing/claim/status', { claim_id: claim.claim_id, secret: CLAIM_SECRET })
      )
      assert.deepEqual(await after!.json(), { status: 'delivered' })
      const again = await o.online.handle(
        post('/pairing/claim/ack', { claim_id: claim.claim_id, secret: CLAIM_SECRET })
      )
      assert.equal(again?.status, 400)
    } finally {
      o.close()
    }
  }
)

test(
  'online claim guards: unknown paths pass through, browser-shaped requests refused, second claim conflicts',
  /* 非认领路径不拦截；带 Origin 的请求被拒绝；同一申请的第二个认领以 409 冲突返回。 */ async () => {
    const o = owned()
    try {
      assert.equal(o.online.handle(new Request('http://gateway/pairing/redeem', { method: 'POST' })), undefined)
      const a = await application(o, 'online_guards')
      const browser = await o.online.handle(
        post(
          '/pairing/claim',
          { pairing_id: a.pairing_id, secret_hash: digest(CLAIM_SECRET) },
          { origin: 'https://evil.example' }
        )
      )
      assert.equal(browser?.status, 403)
      const first = await o.online.handle(
        post('/pairing/claim', { pairing_id: a.pairing_id, secret_hash: digest(CLAIM_SECRET) })
      )
      assert.equal(first?.status, 200)
      const second = await o.online.handle(
        post('/pairing/claim', { pairing_id: a.pairing_id, secret_hash: digest('another-secret') })
      )
      assert.equal(second?.status, 409)
      assert.deepEqual(await second!.json(), { error: 'pairing_claim_conflict' })
      const unknown = await o.online.handle(
        post('/pairing/claim', { pairing_id: 'pairing_missing', secret_hash: digest(CLAIM_SECRET) })
      )
      assert.equal(unknown?.status, 400)
      assert.deepEqual(await unknown!.json(), { error: 'pairing_not_found' })
    } finally {
      o.close()
    }
  }
)

test(
  'restart reconciliation fails orphaned approvals and rejects the undelivered credential',
  /* 新进程的 custody 为空：已批准未交付的认领被收敛为 failed，设备回到 pending 且凭据摘要被清空。 */ async () => {
    const o = owned()
    try {
      const a = await application(o, 'online_orphan')
      const created = await o.online.handle(
        post('/pairing/claim', { pairing_id: a.pairing_id, secret_hash: digest(CLAIM_SECRET) })
      )
      const claim = (await created!.json()) as { claim_id: string; user_code: string }
      await approve(o, a, claim.claim_id, claim.user_code)
      assert.equal(o.store.machine(a.machine_id).status, 'offline')
      const restarted = new OnlinePairingHttp(o.store, () => 1000)
      restarted.reconcile()
      assert.equal(o.store.pairingClaim(claim.claim_id).status, 'failed')
      assert.equal(o.store.machine(a.machine_id).status, 'pending')
      assert.equal(o.store.credentialDigest(a.machine_id), null)
      restarted.close()
    } finally {
      o.close()
    }
  }
)
