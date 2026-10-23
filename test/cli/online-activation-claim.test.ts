// 在线认领的客户端续跑端到端：Connector 在同一命令内完成认领、取回、确认与原生激活；
// Herdr 准备记录以合成已测清单种子注入（与 setup-manifest 夹具同口径），不替代真实 native 验收。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openGatewayState } from '../../src/runtime/state.js'
import { StoreManagementWriteService } from '../../src/admin/write-service.js'
import { OnlinePairingHttp } from '../../src/cli/online-pairing-http.js'
import { claimConnector } from '../../src/cli/online-claim.js'
import { configTemplate, type ConnectorConfig, type GatewayConfig } from '../../src/cli/config.js'
import { privateDirectory } from '../../src/cli/first-config.js'
import { fixedHerdrSource } from '../../src/connector/herdr/review.js'
import { setupReference, setupTarget } from '../../src/cli/setup-policy.js'
import { readSetupJson, writeSetupJson } from '../../src/cli/setup-files.js'
import { runtimeReference } from '../../src/cli/runtime-files.js'
import { loadCredential } from '../../src/transport/credentials.js'
import { boundedJson, hash } from '../../src/wire/index.js'
import type { ManagementIntent } from '../../src/mcp/management.js'
import type { SetupTerminal } from '../../src/cli/setup-terminal.js'
import { confirmed, context, setup } from '../admin/write-helpers.js'

/** Gateway 侧 fixture：与生产同一装配（双库、管理服务、在线 custody 与激活宿主）。 */
function activationGateway() {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-online-activation-claim-'))
  const directory = join(root, 'gateway')
  privateDirectory(directory)
  privateDirectory(join(directory, 'managed'))
  const custody: { http?: OnlinePairingHttp } = {}
  const state = openGatewayState({
    state_directory: directory,
    store: {
      pairingClaimCustody: (event) => {
        if (!custody.http) {
          throw new Error('online_pairing_unavailable')
        }
        custody.http.hold(event)
      }
    },
    changed: () => {}
  })
  const store = state.store
  const config = { ...configTemplate('gateway'), state_dir: directory } as GatewayConfig
  let reloads = 0
  const online = new OnlinePairingHttp(store, Date.now, {
    state,
    config,
    reload: () => {
      reloads++
    }
  })
  custody.http = online
  const f = setup(store)
  const service = new StoreManagementWriteService({
    store,
    identities: f.identities,
    pairingPolicy: (ref) => ref === 'policy_a'
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
    reloads: () => reloads,
    async serve() {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      return (server.address() as AddressInfo).port
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      online.close()
      state.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

type Gateway = ReturnType<typeof activationGateway>

async function application(g: Gateway, name: string) {
  const operation: ManagementIntent = { action: 'pairing_create', target: { name, labels: [], policy_ref: 'policy_a' } }
  const c = await confirmed(g.service, operation, 0)
  const receipt = await g.service.execute('pairings_create', { ...c.write, ...operation.target }, context())
  g.f.grant(
    { action: 'devices_read', machine_id: receipt.machine_id },
    { action: 'devices_revoke', machine_id: receipt.machine_id }
  )
  return receipt
}

async function approve(
  g: Gateway,
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

/** 合成 Herdr 远端清单值：与 setup-manifest 夹具同口径，策略修订按本次谱系推导。 */
function herdrRemote(claim_id: string, machine_id: string) {
  const raw = readFileSync(new URL('../fixtures/herdr/0.9.5/schema.json', import.meta.url), 'utf8')
  return {
    kind: 'herdr',
    schema_bundle: raw,
    config: {
      version: 1,
      target: setupTarget(machine_id, 'herdr'),
      binding_revision: 1,
      config_ref: setupReference(claim_id, 'herdr'),
      peer_policy_revision: 'setup_local_' + claim_id,
      expected_source: {
        ...fixedHerdrSource(),
        binary_version: 'synthetic-future',
        server_version: 'synthetic-future',
        binary_sha256: 'f'.repeat(64),
        schema_sha256: hash(raw)
      }
    }
  }
}

test(
  'claimConnector continues from pairing into native activation in one run and converges on rerun',
  /* 批准后同一命令完成取回、确认与原生激活：网关认领转 activated，本机落 providers 与 configured 谱系，重跑为空操作。 */ async () => {
    const g = activationGateway()
    const client = mkdtempSync(join(tmpdir(), 'rovloom-online-activation-client-'))
    try {
      const port = await g.serve()
      const a = await application(g, 'activation_client_e2e')
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
        gateway_url: 'ws://127.0.0.1:' + port,
        native: { provider: 'herdr' }
      } as ConnectorConfig
      privateDirectory(client)
      privateDirectory(join(client, 'managed'))
      const running = claimConnector(config, terminal as unknown as SetupTerminal)
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
      // 批准前把本次 attempt 的 Herdr 准备记录种入本机状态目录（模拟已测安装发现结果）。
      const reference = setupReference(claim_id, 'herdr')
      const remote = herdrRemote(claim_id, a.machine_id)
      const local = { fixture: 'herdr-local-owner-config' }
      writeSetupJson(
        runtimeReference(client, 'herdr-setup'),
        {
          schema_version: 1,
          attempt_id: claim_id,
          machine_id: a.machine_id,
          phase: 'prepared',
          settings: { provider: 'herdr' },
          reference,
          local,
          remote
        },
        false,
        1_048_576
      )
      const progress = await g.service.execute(
        'pairings_get',
        { machine_id: a.machine_id, pairing_id: a.pairing_id },
        context()
      )
      await approve(g, a, claim_id, progress.claim!.user_code)
      await running
      const fingerprint = hash(boundedJson({ installations: [{ reference, value: remote }] }, 1_048_576))
      const claim = g.store.pairingClaim(claim_id)
      assert.equal(claim.status, 'activated')
      assert.equal(claim.native_fingerprint, fingerprint)
      assert.equal(claim.approved_by, 'fixture_admin')
      assert.equal(g.store.provider(a.machine_id, 'herdr')?.config_ref, reference)
      await new Promise((resolve) => setImmediate(resolve))
      assert(g.reloads() >= 1)
      const credential = loadCredential(runtimeReference(client, 'device'))
      assert.equal(credential.machine_id, a.machine_id)
      const providers = readSetupJson(runtimeReference(client, 'providers'), 1_048_576) as {
        role: string
        providers: { reference: string; value: unknown }[]
      }
      assert.equal(providers.role, 'connector')
      assert.deepEqual(providers.providers, [{ reference, value: local }])
      const lineage = readSetupJson(runtimeReference(client, 'pairing')) as Record<string, unknown>
      assert.equal(lineage.phase, 'configured')
      assert.equal(lineage.attempt_id, claim_id)
      const saved = readSetupJson(runtimeReference(client, 'pairing-claim')) as Record<string, unknown>
      assert.equal(saved.phase, 'configured')
      assert.equal('secret' in saved, false)
      assert(shown.some((text) => text.includes('pairing_completed')))
      // 重跑：已 configured 直接收敛，不重复提交或改写。
      await claimConnector(config, terminal as unknown as SetupTerminal)
      assert.equal(g.store.pairingClaim(claim_id).status, 'activated')
    } finally {
      await g.close()
      rmSync(client, { recursive: true, force: true })
    }
  }
)
