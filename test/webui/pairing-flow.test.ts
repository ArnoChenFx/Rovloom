// 不挂DOM，使用真实Store/HTTP管理服务验证浏览器配对 flow 的确认、批准与核对码边界。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Store } from '../../src/store.js'
import { StoreManagementWriteService } from '../../src/admin/write-service.js'
import { createManagementHandler } from '../../src/admin/write-http.js'
import { createManagementSessionAdapter } from '../../src/admin/session-adapter.js'
import { createManagementWriteClient } from '../../src/webui/write-client.js'
import type { ManagementFetch } from '../../src/webui/http-client.js'
import { createPairingManagementFlow } from '../../src/webui/pairing-flow.js'
import { setup, confirmed, context } from '../admin/write-helpers.js'
import { management } from '../storage/helpers.js'

/** 本地 fixture：与 session-flow 同构的浏览器客户端，但服务带配对政策与内存 custody。 */
function pairingFlowFixture() {
  const custody: { machine_id: string; claim_id: string; credential: string }[] = []
  const store = new Store(':memory:', () => 1000, {
    management,
    /** 批准凭据只暂存进本 fixture 的内存 custody，断言其不进入回执或 flow 状态。 */
    pairingClaimCustody: (event: { machine_id: string; claim_id: string; credential: string }) => custody.push(event)
  })
  const f = setup(store)
  const cookie = 'SYNTHETIC_PAIRING_COOKIE_' + 'c'.repeat(32)
  const csrf = 'SYNTHETIC_PAIRING_CSRF_' + 'd'.repeat(32)
  const origin = 'http://127.0.0.1:43303'
  const adapter = createManagementSessionAdapter({
    identities: f.identities,
    origin,
    cookie_name: 'fixture_admin',
    /** 本测试可信时间不会创建/续期任何生产会话。 */ now: () => 1000,
    sessions: {
      identities: f.identities,
      /** 来源只认识本fixture内存中的短期cookie，不从HTTP参数构造管理员。 */
      async resolveCookie(value) {
        return value === cookie
          ? {
              caller: { principal_id: 'fixture_admin' },
              session_ref: 'fixture_session',
              expires_at: 301_000,
              csrf_sha256: createHash('sha256').update(csrf).digest('hex')
            }
          : null
      }
    }
  })
  const service = new StoreManagementWriteService({
    store,
    identities: adapter.identities,
    transport: { /** 此处只验证浏览器 flow 与服务边界，实际socket另有覆盖。 */ refresh() {} },
    /** 只批准本测试的固定非秘密策略引用。 */ pairingPolicy: (ref) => ref === 'policy_a'
  })
  const handler = createManagementHandler({
    origin,
    service,
    authenticate: adapter.authenticate,
    verifyCsrf: adapter.verifyCsrf
  })
  const calls: string[] = []
  const fetcher: ManagementFetch = /** 模拟浏览器实际附带同源cookie和Origin，只使用标准Request/Response。 */ async (
    path,
    init
  ) => {
    calls.push(path.split('/').at(-1)!)
    const headers = new Headers(init.headers)
    headers.set('host', '127.0.0.1:43303')
    headers.set('origin', origin)
    headers.set('cookie', 'fixture_admin=' + cookie)
    return handler.fetch(new Request(origin + path, { ...init, headers }))
  }
  const client = createManagementWriteClient({
    fetcher,
    /** 既有受保护bootstrap的内存结果，仅为fixture，不实现生产登录。 */ csrf: async () => csrf
  })
  return {
    f,
    store,
    service,
    client,
    calls,
    custody,
    /** 释放本fixture的Store与handler，绝不关闭用户Gateway。 */ close() {
      handler.stop()
      store.close()
    }
  }
}

test(
  '浏览器 pairing_create 仅在明确 confirm 之后提交一次并返回申请编号',
  /** 新设备名目标不取 write_state，确认前 Store 里没有申请。 */ async () => {
    const fx = pairingFlowFixture()
    const flow = createPairingManagementFlow({ transport: fx.client })
    try {
      const prepared = await flow.prepare({
        action: 'pairing_create',
        name: 'browser_new_box',
        policy_ref: 'policy_a',
        labels: []
      })
      assert.equal(prepared.phase, 'awaiting_confirmation')
      assert.deepEqual(fx.calls, ['history_open', 'confirmations_create'])
      const committed = await flow.confirm()
      assert.equal(committed.phase, 'committed')
      assert(committed.phase === 'committed')
      const receipt = committed.receipt as typeof committed.receipt & { pairing_id: string; machine_id: string }
      assert.equal(receipt.action, 'pairing_create')
      assert.equal(typeof receipt.pairing_id, 'string')
      assert.equal(fx.store.pairingApplication(receipt.pairing_id)?.machine_id, receipt.machine_id)
      assert.equal(JSON.stringify(flow.state()).includes('credential'), false)
    } finally {
      flow.dispose()
      fx.close()
    }
  }
)

test(
  '认领到达后 pairings_get 如实带核对码，批准 flow 把凭据只交付 custody',
  /** 核对码来自 pairings_get 的 claim 视图；错码不能签发，对码批准后回执不含凭据。 */ async () => {
    const fx = pairingFlowFixture()
    try {
      const createOp = {
        action: 'pairing_create',
        target: { name: 'browser_claim_box', policy_ref: 'policy_a', labels: [] }
      } as const
      const createConfirm = await confirmed(fx.service, createOp, 0)
      const created = await fx.service.execute(
        'pairings_create',
        { ...createConfirm.write, ...createOp.target },
        context()
      )
      assert(created.operation_state === 'committed')
      const pairing = created as typeof created & { machine_id: string; pairing_id: string }
      fx.f.grant(
        { action: 'devices_read', machine_id: pairing.machine_id },
        { action: 'devices_revoke', machine_id: pairing.machine_id }
      )
      const secret = 'browser-claim-secret'
      const digest = createHash('sha256').update(secret).digest('hex')
      const claim = fx.store.startPairingClaim(pairing.machine_id, pairing.pairing_id, digest, 'BRAVO234', 600_000)
      const view = (await fx.client.execute(
        'pairings_get',
        { machine_id: pairing.machine_id, pairing_id: pairing.pairing_id },
        new AbortController().signal
      )) as { claim?: { claim_id: string; user_code: string; status: string } }
      assert.equal(view.claim?.claim_id, claim.claim_id)
      assert.equal(view.claim?.user_code, claim.user_code)

      const wrong = createPairingManagementFlow({ transport: fx.client })
      await wrong.prepare({
        action: 'pairing_claim_approve',
        machine_id: pairing.machine_id,
        pairing_id: pairing.pairing_id,
        claim_id: claim.claim_id,
        user_code: 'ZZZZ9999'
      })
      const wrongResult = await wrong.confirm()
      assert.notEqual(wrongResult.phase, 'committed')
      assert.equal(fx.store.pairingClaim(claim.claim_id)?.status, 'pending')
      assert.equal(fx.custody.length, 0)
      wrong.dispose()

      const flow = createPairingManagementFlow({ transport: fx.client })
      const prepared = await flow.prepare({
        action: 'pairing_claim_approve',
        machine_id: pairing.machine_id,
        pairing_id: pairing.pairing_id,
        claim_id: claim.claim_id,
        user_code: claim.user_code
      })
      assert.equal(prepared.phase, 'awaiting_confirmation')
      assert(fx.calls.includes('write_state_get'))
      const committed = await flow.confirm()
      assert.equal(committed.phase, 'committed')
      assert.equal(fx.custody.length, 1)
      assert.equal(fx.custody[0]!.claim_id, claim.claim_id)
      assert.equal(JSON.stringify(committed).includes(fx.custody[0]!.credential), false)
      assert.equal(JSON.stringify(flow.state()).includes(fx.custody[0]!.credential), false)
      flow.dispose()
    } finally {
      fx.close()
    }
  }
)
