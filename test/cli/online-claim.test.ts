// Connector 在线认领端到端：真实 Store/管理确认链/认领 HTTP 面与回环 HTTP，只替代操作员问答。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/store.js'
import { StoreManagementWriteService } from '../../src/admin/write-service.js'
import { OnlinePairingHttp } from '../../src/cli/online-pairing-http.js'
import { claimConnector } from '../../src/cli/online-claim.js'
import { configTemplate, type ConnectorConfig } from '../../src/cli/config.js'
import { privateDirectory } from '../../src/cli/first-config.js'
import { readSetupJson } from '../../src/cli/setup-files.js'
import { runtimeReference } from '../../src/cli/runtime-files.js'
import type { SetupTerminal } from '../../src/cli/setup-terminal.js'
import { loadCredential } from '../../src/transport/credentials.js'
import type { ManagementIntent } from '../../src/mcp/management.js'
import { management } from '../storage/helpers.js'
import { confirmed, context, setup } from '../admin/write-helpers.js'

/** Gateway 侧 fixture：Store、管理服务与在线 custody 同一实例装配，与生产形状一致。 */
function gateway() {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-online-claim-'))
  const path = join(root, 'gateway.sqlite')
  const now = 1000
  const custody: { http?: OnlinePairingHttp } = {}
  const store = new Store(path, /** 受控短期材料只使用 fixture 时钟。 */ () => now, {
    management,
    pairingClaimCustody: (event) => {
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
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = []
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
    incoming.on('end', () => {
      const request = new Request('http://127.0.0.1' + incoming.url, {
        method: incoming.method ?? 'POST',
        headers: { 'content-type': incoming.headers['content-type'] ?? '' },
        body: Buffer.concat(chunks)
      })
      void (online.handle(request) ?? Promise.resolve(new Response('', { status: 404 }))).then(async (response) => {
        outgoing.writeHead(response.status, Object.fromEntries(response.headers))
        outgoing.end(Buffer.from(await response.arrayBuffer()))
      })
    })
  })
  return {
    root,
    store,
    service,
    f,
    online,
    /** 在回环地址上提供认领 HTTP 面。 */ async serve() {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      return (server.address() as AddressInfo).port
    },
    /** 回收服务器、custody 与数据库。 */ async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      online.close()
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

/** 通过真实管理确认事务创建一份配对申请。 */
async function application(g: ReturnType<typeof gateway>, name: string) {
  const operation: ManagementIntent = {
    action: 'pairing_create',
    target: { name, labels: [], policy_ref: 'policy_a' }
  }
  const c = await confirmed(g.service, operation, 0)
  const receipt = await g.service.execute('pairings_create', { ...c.write, ...operation.target }, context())
  g.f.grant(
    { action: 'devices_read', machine_id: receipt.machine_id },
    { action: 'devices_revoke', machine_id: receipt.machine_id }
  )
  return receipt
}

/** 经真实确认流程批准指定认领。 */
async function approve(
  g: ReturnType<typeof gateway>,
  target: { machine_id: string; pairing_id: string },
  claim_id: string,
  user_code: string
) {
  const revision = (await g.service.execute('write_state_get', { machine_id: target.machine_id }, context()))
    .resource_revision
  const intent: ManagementIntent = {
    action: 'pairing_claim_approve',
    target: { machine_id: target.machine_id, pairing_id: target.pairing_id, claim_id, user_code }
  }
  const c = await confirmed(g.service, intent, revision)
  return g.service.execute('pairings_claim_approve', { ...c.write, ...intent.target }, context())
}

test(
  'claimConnector pairs a fresh connector against a running gateway after admin approval',
  /* 操作员只输入申请 ID 并核对展示码；管理员批准后凭据落盘、确认完成、认领秘密从恢复记录删除。 */ async () => {
    const g = gateway()
    const client = mkdtempSync(join(tmpdir(), 'rovloom-online-claim-client-'))
    try {
      const port = await g.serve()
      const a = await application(g, 'claim_client_e2e')
      const shown: string[] = []
      const terminal = {
        configPath: join(client, 'config.json'),
        io: { signal: new AbortController().signal },
        actor: 'fixture_operator',
        uid: process.getuid!(),
        assertOwner() {},
        async ask(prompt: string) {
          if (prompt.includes('Pairing application ID')) {
            return a.pairing_id
          }
          throw new Error('unexpected question: ' + prompt)
        },
        async confirm() {
          return true
        },
        show(text: string) {
          shown.push(text)
        },
        finishQuestions() {}
      }
      const config = {
        ...configTemplate('connector'),
        state_dir: client,
        gateway_url: 'ws://127.0.0.1:' + port
      } as ConnectorConfig
      privateDirectory(client)
      privateDirectory(join(client, 'managed'))
      const running = claimConnector(config, terminal as unknown as SetupTerminal)
      // 等待认领在账本出现后按管理页同链批准，核对码取自 pairings_get 的认领视图。
      let claim_id = ''
      for (let i = 0; i < 50 && !claim_id; i++) {
        const active = g.store.activePairingClaim(a.pairing_id)
        if (active) {
          claim_id = active.claim_id
        } else {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }
      assert(claim_id, 'claim should be started by the connector')
      const progress = await g.service.execute(
        'pairings_get',
        { machine_id: a.machine_id, pairing_id: a.pairing_id },
        context()
      )
      assert.equal(progress.claim?.claim_id, claim_id)
      await approve(g, a, claim_id, progress.claim!.user_code)
      await running
      const credential = loadCredential(runtimeReference(client, 'device'))
      assert.equal(credential.machine_id, a.machine_id)
      assert.equal(g.store.pairingClaim(claim_id).status, 'delivered')
      const saved = readSetupJson(runtimeReference(client, 'pairing-claim')) as Record<string, unknown>
      assert.equal(saved.phase, 'paired')
      assert.equal('secret' in saved, false)
      assert(shown.some((text) => text.includes(progress.claim!.user_code)))
    } finally {
      await g.close()
      rmSync(client, { recursive: true, force: true })
    }
  }
)
