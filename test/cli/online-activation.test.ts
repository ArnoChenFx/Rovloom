// 在线原生激活端到端：真实 Gateway 双库/管理确认链/在线认领面与回环 HTTP，
// 设备以真实凭据短认证提交合成 Herdr 清单；合成 source 只验证程序核验与落盘，不替代真实 native 验收。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { digest } from '../../src/contracts.js'
import { openGatewayState } from '../../src/runtime/state.js'
import { StoreManagementWriteService } from '../../src/admin/write-service.js'
import { writeAdminFiles } from '../../src/cli/admin-command.js'
import { OnlinePairingHttp } from '../../src/cli/online-pairing-http.js'
import { createProductionCliRuntime } from '../../src/cli/production.js'
import { createProductSources } from '../../src/cli/product-sources.js'
import { GatewaySetup } from '../../src/cli/setup-gateway.js'
import { CliSetup } from '../../src/cli/setup-runtime.js'
import type { SetupTerminal } from '../../src/cli/setup-terminal.js'
import type { RuntimeCliGateway } from '../../src/cli/runtime.js'
import type { Store } from '../../src/store.js'
import { configTemplate, type GatewayConfig } from '../../src/cli/config.js'
import { privateDirectory } from '../../src/cli/first-config.js'
import { fixedHerdrSource } from '../../src/connector/herdr/review.js'
import { selectedSetupPolicies, setupReference, setupTarget } from '../../src/cli/setup-policy.js'
import { readSetupJson, writeSetupJson } from '../../src/cli/setup-files.js'
import { runtimeReference } from '../../src/cli/runtime-files.js'
import { boundedJson, hash } from '../../src/wire/index.js'
import type { ManagementIntent } from '../../src/mcp/management.js'
import { confirmed, context, setup } from '../admin/write-helpers.js'

const CLAIM_SECRET = 'activation-claim-secret'

/** Gateway 侧 fixture：双库、管理服务、在线 custody 与激活宿主同一装配，与生产形状一致。 */
function activationGateway() {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-online-activation-'))
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
    directory,
    state,
    store,
    service,
    f,
    online,
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

async function post(port: number, path: string, body: unknown) {
  const response = await fetch('http://127.0.0.1:' + port + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> }
}

/** 通过真实管理确认事务创建一份配对申请。 */
async function application(g: Pick<Gateway, 'service' | 'f'>, name: string) {
  const operation: ManagementIntent = { action: 'pairing_create', target: { name, labels: [], policy_ref: 'policy_a' } }
  const c = await confirmed(g.service, operation, 0)
  const receipt = await g.service.execute('pairings_create', { ...c.write, ...operation.target }, context())
  g.f.grant(
    { action: 'devices_read', machine_id: receipt.machine_id },
    { action: 'devices_revoke', machine_id: receipt.machine_id }
  )
  return receipt
}

/** 经真实确认流程批准指定认领（批准人固定为 fixture_admin）。 */
async function approve(
  g: Pick<Gateway, 'service'>,
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

/** 合成 Herdr 安装清单：与 setup-manifest 测试同一夹具口径，引用与策略修订按本次 attempt 推导。 */
function herdrInstallation(claim_id: string, machine_id: string, lineage?: string) {
  const raw = readFileSync(new URL('../fixtures/herdr/0.9.5/schema.json', import.meta.url), 'utf8')
  const reference = setupReference(claim_id, 'herdr')
  return {
    installations: [
      {
        reference,
        value: {
          kind: 'herdr',
          schema_bundle: raw,
          config: {
            version: 1,
            target: setupTarget(machine_id, 'herdr'),
            binding_revision: 1,
            config_ref: reference,
            peer_policy_revision: 'setup_local_' + (lineage ?? claim_id),
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
    ]
  }
}

/** 走完认领→批准→取回→确认，返回设备凭据三元组。 */
async function deliver(
  g: Pick<Gateway, 'service' | 'f'>,
  port: number,
  name: string
): Promise<{ receipt: Awaited<ReturnType<typeof application>>; claim_id: string; credential: Record<string, string> }> {
  const receipt = await application(g, name)
  const created = await post(port, '/pairing/claim', {
    pairing_id: receipt.pairing_id,
    secret_hash: digest(CLAIM_SECRET)
  })
  assert.equal(created.status, 200)
  const claim_id = created.body.claim_id as string
  await approve(g, receipt, claim_id, created.body.user_code as string)
  const fetched = await post(port, '/pairing/claim/status', { claim_id, secret: CLAIM_SECRET })
  assert.equal(fetched.body.status, 'approved')
  const credential = {
    machine_id: receipt.machine_id,
    recovery_generation: fetched.body.recovery_generation as string,
    credential: fetched.body.credential as string
  }
  const ack = await post(port, '/pairing/claim/ack', { claim_id, secret: CLAIM_SECRET })
  assert.equal(ack.body.status, 'delivered')
  return { receipt, claim_id, credential }
}

test(
  'online activation: delivered claim submits a reviewed manifest and persists providers, callers and binding',
  /* 授权由批准人主体确定性推导；激活落盘与本机仪式一致，认领转 activated，重入只核对指纹。 */ async () => {
    const g = activationGateway()
    try {
      const port = await g.serve()
      const { receipt, claim_id, credential } = await deliver(g, port, 'activation_e2e')
      const status = await post(port, '/pairing/claim/activation/status', {
        attempt_id: claim_id,
        authentication: credential,
        providers: ['herdr']
      })
      assert.equal(status.status, 200)
      assert.equal(status.body.phase, 'paired')
      assert.deepEqual(
        status.body.authorization,
        JSON.parse(
          boundedJson(
            selectedSetupPolicies({ attempt_id: claim_id, actor: 'caller_' + claim_id }, receipt.machine_id, ['herdr'])
          )
        )
      )
      const installation = herdrInstallation(claim_id, receipt.machine_id)
      const fingerprint = hash(boundedJson(installation, 1_048_576))
      const applied = await post(port, '/pairing/claim/activation/native', {
        attempt_id: claim_id,
        authentication: credential,
        installation
      })
      assert.equal(applied.status, 200)
      assert.deepEqual(applied.body, { state: 'configured', fingerprint })
      const claim = g.store.pairingClaim(claim_id)
      assert.equal(claim.status, 'activated')
      assert.equal(claim.native_fingerprint, fingerprint)
      assert.equal(claim.approved_by, 'fixture_admin')
      const binding = g.store.provider(receipt.machine_id, 'herdr')
      assert.equal(binding?.config_ref, setupReference(claim_id, 'herdr'))
      const client = readSetupJson(runtimeReference(g.directory, 'mcp-client')) as Record<string, unknown>
      assert.equal(client.principal_id, 'caller_' + claim_id)
      assert.equal(client.attempt_id, claim_id)
      const callers = readSetupJson(runtimeReference(g.directory, 'mcp-callers')) as {
        local_policy: { revision: string }
        callers: { principal: { id: string } }[]
      }
      assert.equal(callers.local_policy.revision, 'setup_local_' + claim_id)
      assert.equal(callers.callers[0]?.principal.id, 'caller_' + claim_id)
      const providers = readSetupJson(runtimeReference(g.directory, 'providers'), 1_048_576) as {
        providers: { reference: string }[]
      }
      assert.deepEqual(
        providers.providers.map((entry) => entry.reference),
        [setupReference(claim_id, 'herdr')]
      )
      await new Promise((resolve) => setImmediate(resolve))
      assert(g.reloads() >= 1)
      // 重入：同一清单只核对指纹后返回 configured；不同清单（指纹变化）在核验阶段被拒绝。
      const again = await post(port, '/pairing/claim/activation/native', {
        attempt_id: claim_id,
        authentication: credential,
        installation
      })
      assert.equal(again.status, 200)
      const tampered = structuredClone(installation)
      tampered.installations[0]!.value.schema_bundle += '\n'
      const refused = await post(port, '/pairing/claim/activation/native', {
        attempt_id: claim_id,
        authentication: credential,
        installation: tampered
      })
      assert.equal(refused.status, 409)
      const progress = await g.service.execute(
        'pairings_get',
        { machine_id: receipt.machine_id, pairing_id: receipt.pairing_id },
        context()
      )
      assert.equal(progress.claim?.status, 'activated')
      assert.equal(progress.claim?.activation, 'configured')
    } finally {
      await g.close()
    }
  }
)

test(
  'online activation gates: undelivered claims and bad credentials are refused uniformly',
  /* 未交付（pending/approved）不能查询授权或提交清单；凭据错误与不存在同为 409，不泄露核验细节。 */ async () => {
    const g = activationGateway()
    try {
      const port = await g.serve()
      const receipt = await application(g, 'activation_gates')
      const created = await post(port, '/pairing/claim', {
        pairing_id: receipt.pairing_id,
        secret_hash: digest(CLAIM_SECRET)
      })
      const claim_id = created.body.claim_id as string
      const bogus = { machine_id: receipt.machine_id, recovery_generation: 'gen_x', credential: 'B'.repeat(48) }
      const early = await post(port, '/pairing/claim/activation/native', {
        attempt_id: claim_id,
        authentication: bogus,
        installation: herdrInstallation(claim_id, receipt.machine_id)
      })
      assert.equal(early.status, 409)
      await approve(g, receipt, claim_id, created.body.user_code as string)
      const fetched = await post(port, '/pairing/claim/status', { claim_id, secret: CLAIM_SECRET })
      const credential = {
        machine_id: receipt.machine_id,
        recovery_generation: fetched.body.recovery_generation as string,
        credential: fetched.body.credential as string
      }
      // 已批准未确认交付：仍不能激活。
      const beforeAck = await post(port, '/pairing/claim/activation/native', {
        attempt_id: claim_id,
        authentication: credential,
        installation: herdrInstallation(claim_id, receipt.machine_id)
      })
      assert.equal(beforeAck.status, 409)
      await post(port, '/pairing/claim/ack', { claim_id, secret: CLAIM_SECRET })
      // 交付后凭据错误：状态与清单都拒绝。
      const wrong = { ...credential, credential: 'C'.repeat(48) }
      const badStatus = await post(port, '/pairing/claim/activation/status', {
        attempt_id: claim_id,
        authentication: wrong
      })
      assert.equal(badStatus.status, 409)
      const badNative = await post(port, '/pairing/claim/activation/native', {
        attempt_id: claim_id,
        authentication: wrong,
        installation: herdrInstallation(claim_id, receipt.machine_id)
      })
      assert.equal(badNative.status, 409)
      assert.equal(g.store.pairingClaim(claim_id).status, 'delivered')
    } finally {
      await g.close()
    }
  }
)

test('independent administrator expands the existing MCP caller without becoming that caller', async () => {
  const g = activationGateway()
  try {
    const port = await g.serve()
    const first = await deliver(g, port, 'activation_first')
    const applied = await post(port, '/pairing/claim/activation/native', {
      attempt_id: first.claim_id,
      authentication: first.credential,
      installation: herdrInstallation(first.claim_id, first.receipt.machine_id)
    })
    assert.equal(applied.status, 200)
    const clientPath = runtimeReference(g.directory, 'mcp-client')
    const clientBytes = readFileSync(clientPath)
    writeAdminFiles({ ...configTemplate('gateway'), state_dir: g.directory } as GatewayConfig, 'admin', Date.now())
    const second = await deliver(g, port, 'activation_second')
    const status = await post(port, '/pairing/claim/activation/status', {
      attempt_id: second.claim_id,
      authentication: second.credential,
      providers: ['herdr']
    })
    assert.equal(status.status, 200)
    assert.equal((status.body.authorization as { principal_id: string }).principal_id, 'caller_' + first.claim_id)
    const result = await post(port, '/pairing/claim/activation/native', {
      attempt_id: second.claim_id,
      authentication: second.credential,
      installation: herdrInstallation(second.claim_id, second.receipt.machine_id, first.claim_id)
    })
    assert.equal(result.status, 200)
    assert.deepEqual(readFileSync(clientPath), clientBytes)
    assert.equal(g.store.pairingClaim(second.claim_id).approved_by, 'fixture_admin')
    const registry = readSetupJson(runtimeReference(g.directory, 'mcp-callers')) as {
      callers: { principal: { id: string; policy: { grants: unknown[] } } }[]
    }
    assert.equal(
      registry.callers.find((entry) => entry.principal.id === 'caller_' + first.claim_id)?.principal.policy.grants
        .length,
      2
    )
    assert.equal(registry.callers.find((entry) => entry.principal.id === 'admin')?.principal.policy.grants.length, 0)
    assert(!registry.callers.some((entry) => entry.principal.id === 'fixture_admin'))
  } finally {
    await g.close()
  }
})

// 按真实发布次序留下前缀，恢复仍是原认领的初次发布，不能误入合并分支。
for (const prefix of ['client', 'callers'] as const) {
  test(`first online activation resumes after publishing ${prefix}`, async () => {
    const g = activationGateway()
    try {
      const port = await g.serve()
      const d = await deliver(g, port, 'partial_' + prefix)
      const principal = 'caller_' + d.claim_id
      const issued = Date.now()
      const client = {
        schema_version: 1,
        kind: 'mcp-client-credential',
        attempt_id: d.claim_id,
        resource: 'http://127.0.0.1:9444/mcp',
        principal_id: principal,
        token: 'T'.repeat(43),
        issued_at: issued,
        expires_at: issued + 86400_000
      }
      const clientPath = runtimeReference(g.directory, 'mcp-client')
      writeSetupJson(clientPath, client)
      const before = readFileSync(clientPath)
      if (prefix === 'callers') {
        const authorization = selectedSetupPolicies(
          { attempt_id: d.claim_id, actor: principal },
          d.receipt.machine_id,
          ['herdr']
        )
        writeSetupJson(runtimeReference(g.directory, 'mcp-callers'), {
          schema_version: 1,
          kind: 'mcp-caller-source',
          resource: client.resource,
          local_policy: authorization.policies.local,
          callers: [
            {
              principal: { id: principal, policy: authorization.policies.caller },
              token_sha256: digest(client.token),
              issued_at: client.issued_at,
              expires_at: client.expires_at
            }
          ]
        })
      }
      const installation = herdrInstallation(d.claim_id, d.receipt.machine_id)
      const result = await post(port, '/pairing/claim/activation/native', {
        attempt_id: d.claim_id,
        authentication: d.credential,
        installation
      })
      assert.equal(result.status, 200)
      assert.equal(g.store.pairingClaim(d.claim_id).status, 'activated')
      assert(g.store.provider(d.receipt.machine_id, 'herdr'))
      assert(existsSync(runtimeReference(g.directory, 'mcp-callers')))
      assert(existsSync(runtimeReference(g.directory, 'providers')))
      assert.deepEqual(readFileSync(clientPath), before)
    } finally {
      await g.close()
    }
  })
}

test('online pairing surface without an activation host does not expose status/native paths', () => {
  const g = activationGateway()
  try {
    const bare = new OnlinePairingHttp(g.store)
    const request = new Request('http://127.0.0.1/pairing/status', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
    assert.equal(bare.handle(request), undefined)
  } finally {
    void g.close()
  }
})

for (const interactive of [false, true]) {
  test(
    `production gateway activates and reloads remote providers (interactive: ${interactive})`,
    { timeout: 30_000 },
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'rovloom-online-production-'))
      const directory = join(root, 'gateway')
      privateDirectory(directory)
      privateDirectory(join(directory, 'managed'))
      // 仅预约本机空闲端口；实际请求由生产 listener 处理。
      const reservation = createServer()
      await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve))
      const port = (reservation.address() as AddressInfo).port
      await new Promise<void>((resolve) => reservation.close(() => resolve()))
      const config = {
        ...configTemplate('gateway'),
        state_dir: directory,
        device_port: port,
        management_enabled: false
      } as GatewayConfig
      let store: Store | undefined
      const terminal = {
        actor: 'operator_1000',
        uid: 1000,
        assertOwner() {},
        async confirm() {
          throw new Error('unexpected local approval')
        }
      } as unknown as SetupTerminal
      const onboarding = new GatewaySetup(config, terminal)
      const sources = createProductSources()
      // 捕获真实 Store 只为构造测试管理面，不替代生产 listener/provider 工厂或管理批准。
      const originalGateway = sources.gateway!
      sources.gateway = async (...args) => {
        const result = await originalGateway(...args)
        return {
          ...result,
          started(active: RuntimeCliGateway) {
            store = active.store
            result.started?.(active)
          }
        }
      }
      const cliSetup = new CliSetup()
      cliSetup.gateway = () => onboarding
      const runtime = createProductionCliRuntime(sources, interactive ? cliSetup : undefined)
      let running = await runtime.gateway!(config)
      try {
        assert(store, 'production Store should be captured')
        const f = setup(store)
        const service = new StoreManagementWriteService({
          store,
          identities: f.identities,
          pairingPolicy: (ref) => ref === 'policy_a'
        })
        const d = await deliver({ service, f }, port, 'production_activation')
        const status = await post(port, '/pairing/claim/activation/status', {
          attempt_id: d.claim_id,
          authentication: d.credential,
          providers: ['herdr']
        })
        assert.equal(status.status, 200)
        const applied = await post(port, '/pairing/claim/activation/native', {
          attempt_id: d.claim_id,
          authentication: d.credential,
          installation: herdrInstallation(d.claim_id, d.receipt.machine_id)
        })
        assert.equal(applied.status, 200)
        assert.equal(
          await Promise.race([
            running.reconfigure!.then(() => 'reload'),
            new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 1000))
          ]),
          'reload'
        )
        assert.equal(store.pairingClaim(d.claim_id).status, 'activated')
        await running.close()
        running = await runtime.gateway!(config)
        assert.equal(running.setupRequired, false)
      } finally {
        await running.close()
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
}
