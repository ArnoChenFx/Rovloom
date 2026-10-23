// Connector 在线认领端到端：真实 Store/管理确认链/认领 HTTP 面与回环 HTTP，只替代操作员问答。
import assert from 'node:assert/strict'
import { digest } from '../../src/contracts.js'
import { test } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openGatewayState } from '../../src/runtime/state.js'
import { StoreManagementWriteService } from '../../src/admin/write-service.js'
import { OnlinePairingHttp } from '../../src/cli/online-pairing-http.js'
import { claimConnector } from '../../src/cli/online-claim.js'
import { CliError, configTemplate, type ConnectorConfig, type GatewayConfig } from '../../src/cli/config.js'
import { fixedHerdrSource } from '../../src/connector/herdr/review.js'
import { setupReference, setupTarget } from '../../src/cli/setup-policy.js'
import { boundedJson, hash } from '../../src/wire/index.js'
import { privateDirectory } from '../../src/cli/first-config.js'
import { readSetupJson, writeSetupJson } from '../../src/cli/setup-files.js'
import { runtimeReference } from '../../src/cli/runtime-files.js'
import type { SetupTerminal } from '../../src/cli/setup-terminal.js'
import { loadCredential, saveCredential } from '../../src/transport/credentials.js'
import type { ManagementIntent } from '../../src/mcp/management.js'
import { management } from '../storage/helpers.js'
import { confirmed, context, setup } from '../admin/write-helpers.js'

/** Gateway 侧 fixture：Store、管理服务与在线 custody 同一实例装配，与生产形状一致。 */
function gateway() {
  const faults = { ack: 'none' as 'none' | 'refuse' | 'lost', status: false }
  const requests: string[] = []
  const root = mkdtempSync(join(tmpdir(), 'rovloom-online-claim-'))
  const directory = join(root, 'gateway')
  privateDirectory(directory)
  privateDirectory(join(directory, 'managed'))
  let now = Date.now()
  const custody: { http?: OnlinePairingHttp } = {}
  const state = openGatewayState({
    state_directory: directory,
    now: () => now,
    store: {
      management,
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
  const gatewayConfig = { ...configTemplate('gateway'), state_dir: directory } as GatewayConfig
  const online = new OnlinePairingHttp(store, () => now, { state, config: gatewayConfig, reload: () => {} })
  custody.http = online
  const f = setup(store)
  const service = new StoreManagementWriteService({
    store,
    identities: f.identities,
    /** 只批准本测试的固定非秘密策略引用。 */ pairingPolicy: (ref) => ref === 'policy_a'
  })
  const server = createServer((incoming, outgoing) => {
    requests.push(incoming.url!)
    if (
      (incoming.url === '/pairing/claim/ack' && faults.ack === 'refuse') ||
      (incoming.url === '/pairing/claim/status' && faults.status)
    ) {
      incoming.resume()
      outgoing.writeHead(503)
      outgoing.end()
      return
    }
    const chunks: Buffer[] = []
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
    incoming.on('end', () => {
      const request = new Request('http://127.0.0.1' + incoming.url, {
        method: incoming.method ?? 'POST',
        headers: { 'content-type': incoming.headers['content-type'] ?? '' },
        body: Buffer.concat(chunks)
      })
      void (online.handle(request) ?? Promise.resolve(new Response('', { status: 404 }))).then(async (response) => {
        if (incoming.url === '/pairing/claim/ack' && faults.ack === 'lost' && response.status === 200) {
          faults.status = true
          outgoing.writeHead(503)
          outgoing.end()
          return
        }
        outgoing.writeHead(response.status, Object.fromEntries(response.headers))
        outgoing.end(Buffer.from(await response.arrayBuffer()))
      })
    })
  })
  return {
    root,
    faults,
    requests,
    advance(delta: number) {
      now += delta
    },
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
      state.close()
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
        gateway_url: 'ws://127.0.0.1:' + port,
        native: { provider: 'herdr' }
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
      // 种入本次 attempt 的 Herdr 已测准备记录（合成清单与 setup-manifest 夹具同口径），使认领后可继续原生激活。
      const raw = readFileSync(new URL('../fixtures/herdr/0.9.5/schema.json', import.meta.url), 'utf8')
      const reference = setupReference(claim_id, 'herdr')
      const remote = {
        kind: 'herdr',
        schema_bundle: raw,
        config: {
          version: 1,
          target: setupTarget(a.machine_id, 'herdr'),
          binding_revision: 1,
          config_ref: reference,
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
      writeSetupJson(
        runtimeReference(client, 'herdr-setup'),
        {
          schema_version: 1,
          attempt_id: claim_id,
          machine_id: a.machine_id,
          phase: 'prepared',
          settings: { provider: 'herdr' },
          reference,
          local: { fixture: 'herdr-local-owner-config' },
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
      assert.equal(progress.claim?.claim_id, claim_id)
      await approve(g, a, claim_id, progress.claim!.user_code)
      await running
      const credential = loadCredential(runtimeReference(client, 'device'))
      assert.equal(credential.machine_id, a.machine_id)
      assert.equal(g.store.pairingClaim(claim_id).status, 'activated')
      assert.equal(
        g.store.pairingClaim(claim_id).native_fingerprint,
        hash(boundedJson({ installations: [{ reference, value: remote }] }, 1_048_576))
      )
      const saved = readSetupJson(runtimeReference(client, 'pairing-claim')) as Record<string, unknown>
      assert.equal(saved.phase, 'configured')
      assert.equal('secret' in saved, false)
      assert(shown.some((text) => text.includes(progress.claim!.user_code)))
    } finally {
      await g.close()
      rmSync(client, { recursive: true, force: true })
    }
  }
)

/** 客户端只替代终端问答，凭据与恢复记录均使用真正的文件交付实现。 */
function client(port: number, pairing: string) {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-claim-resume-'))
  const answers = { pairing, restart: false, asked: 0 }
  const config = {
    ...configTemplate('connector'),
    state_dir: root,
    gateway_url: 'ws://127.0.0.1:' + port,
    native: { provider: 'herdr' }
  } as ConnectorConfig
  const terminal = {
    configPath: join(root, 'config.json'),
    io: { signal: new AbortController().signal },
    actor: 'fixture_operator',
    uid: process.getuid?.() ?? 0,
    assertOwner() {},
    async ask() {
      answers.asked++
      return answers.pairing
    },
    async confirm(prompt: string) {
      return prompt.includes('new claim') ? answers.restart : true
    },
    show() {},
    finishQuestions() {}
  } as unknown as SetupTerminal
  return {
    root,
    answers,
    config,
    terminal,
    close() {
      rmSync(root, { recursive: true, force: true })
    }
  }
}

/** 等待真正的客户端请求产生认领，避免用定时器猜测准备顺序。 */
async function waitClaim(g: ReturnType<typeof gateway>, pairing: string) {
  for (let i = 0; i < 100; i++) {
    const claim = g.store.activePairingClaim(pairing)
    if (claim) {
      return claim
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('claim not started')
}

/** 把本次 attempt 的 Herdr 已测准备记录种入客户端状态目录（合成清单与 setup-manifest 夹具同口径），使配对完成后可继续原生激活。 */
function seedHerdr(root: string, claim_id: string, machine_id: string) {
  const raw = readFileSync(new URL('../fixtures/herdr/0.9.5/schema.json', import.meta.url), 'utf8')
  const reference = setupReference(claim_id, 'herdr')
  writeSetupJson(
    runtimeReference(root, 'herdr-setup'),
    {
      schema_version: 1,
      attempt_id: claim_id,
      machine_id,
      phase: 'prepared',
      settings: { provider: 'herdr' },
      reference,
      local: { fixture: 'herdr-local-owner-config' },
      remote: {
        kind: 'herdr',
        schema_bundle: raw,
        config: {
          version: 1,
          target: setupTarget(machine_id, 'herdr'),
          binding_revision: 1,
          config_ref: reference,
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
    },
    false,
    1_048_576
  )
}

for (const failure of ['refuse', 'lost', 'before_phase_save'] as const) {
  test(`saved claim credential resumes without replacement after ${failure}`, async () => {
    const g = gateway()
    const a = await application(g, 'resume_' + failure)
    const c = client(await g.serve(), a.pairing_id)
    try {
      g.faults.ack = failure === 'lost' ? 'lost' : 'refuse'
      const first = assert.rejects(
        claimConnector(c.config, c.terminal),
        (error) => error instanceof CliError && error.code === 'configuration_required'
      )
      const claim = await waitClaim(g, a.pairing_id)
      seedHerdr(c.root, claim.claim_id, a.machine_id)
      await approve(g, a, claim.claim_id, claim.user_code)
      await first
      const path = runtimeReference(c.root, 'device')
      const before = readFileSync(path)
      const recordPath = runtimeReference(c.root, 'pairing-claim')
      const saved = readSetupJson(recordPath) as Record<string, unknown>
      assert.equal(saved.phase, 'credential_saved')
      if (failure === 'before_phase_save') {
        writeSetupJson(recordPath, { ...saved, phase: 'waiting' }, true)
      }
      g.faults.ack = 'none'
      g.faults.status = false
      await claimConnector(c.config, c.terminal)
      assert.deepEqual(readFileSync(path), before)
      assert.equal(g.store.pairingClaim(claim.claim_id).status, 'activated')
      assert.equal((readSetupJson(recordPath) as Record<string, unknown>).phase, 'configured')
      assert.equal(g.requests.filter((path) => path === '/pairing/claim').length, 1)
      assert.equal(c.answers.asked, 1)
    } finally {
      c.close()
      await g.close()
    }
  })
}

// 两次完整轮询至少占 4 秒，另给真实持久写入留预算。
test('cancelled claim requires explicit restart and then accepts a new application', { timeout: 15_000 }, async () => {
  const g = gateway()
  const a = await application(g, 'restart_old')
  const c = client(await g.serve(), a.pairing_id)
  try {
    const first = assert.rejects(
      claimConnector(c.config, c.terminal),
      (error) => error instanceof CliError && error.code === 'configuration_required'
    )
    await waitClaim(g, a.pairing_id)
    const revision = (await g.service.execute('write_state_get', { machine_id: a.machine_id }, context()))
      .resource_revision
    const operation: ManagementIntent = {
      action: 'pairing_cancel',
      target: { machine_id: a.machine_id, pairing_id: a.pairing_id }
    }
    const confirmation = await confirmed(g.service, operation, revision)
    await g.service.execute('pairings_cancel', { ...confirmation.write, ...operation.target }, context())
    await first
    assert.equal(c.answers.asked, 1)
    assert(existsSync(runtimeReference(c.root, 'pairing-claim')))
    const next = await application(g, 'restart_new')
    c.answers.pairing = next.pairing_id
    c.answers.restart = true
    const second = claimConnector(c.config, c.terminal)
    const rejected = second.catch(() => {})
    const claim = await waitClaim(g, next.pairing_id)
    seedHerdr(c.root, claim.claim_id, next.machine_id)
    await approve(g, next, claim.claim_id, claim.user_code)
    await second
    await rejected
    assert.equal(loadCredential(runtimeReference(c.root, 'device')).machine_id, next.machine_id)
    assert.equal(c.answers.asked, 2)
  } finally {
    c.close()
    await g.close()
  }
})

for (const mismatch of ['machine', 'generation', 'secret', 'missing'] as const) {
  test(`claim recovery rejects a ${mismatch} credential without confirming or replacing it`, async () => {
    const g = gateway()
    const a = await application(g, 'mismatch_' + mismatch)
    const c = client(await g.serve(), a.pairing_id)
    try {
      const secret = 'synthetic-claim-secret-1234567890'
      const claim = g.store.startPairingClaim(a.machine_id, a.pairing_id, digest(secret), 'CHECK234')
      await approve(g, a, claim.claim_id, claim.user_code)
      const response = await g.online.handle(
        new Request('http://gateway/pairing/claim/status', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ claim_id: claim.claim_id, secret })
        })
      )
      const issued = (await response!.json()) as { machine_id: string; recovery_generation: string; credential: string }
      privateDirectory(join(c.root, 'managed'))
      writeSetupJson(runtimeReference(c.root, 'pairing-claim'), {
        schema_version: 1,
        claim_id: claim.claim_id,
        machine_id: claim.machine_id,
        pairing_id: a.pairing_id,
        gateway_url: c.config.gateway_url,
        secret,
        phase: 'credential_saved',
        credential_hash: digest(issued.credential),
        recovery_generation: issued.recovery_generation
      })
      const path = runtimeReference(c.root, 'device')
      if (mismatch !== 'missing') {
        saveCredential(path, {
          machine_id: mismatch === 'machine' ? 'another_machine' : issued.machine_id,
          recovery_generation: mismatch === 'generation' ? 'another_generation' : issued.recovery_generation,
          credential: mismatch === 'secret' ? 'x'.repeat(43) : issued.credential
        })
      }
      const before = existsSync(path) ? readFileSync(path) : undefined
      const requests = g.requests.length
      await assert.rejects(
        claimConnector(c.config, c.terminal),
        (error) => error instanceof CliError && error.code === 'configuration_required'
      )
      assert.equal(g.requests.length, requests)
      assert.equal(g.store.pairingClaim(claim.claim_id).status, 'approved')
      if (before) {
        assert.deepEqual(readFileSync(path), before)
      } else {
        assert(!existsSync(path))
      }
    } finally {
      c.close()
      await g.close()
    }
  })
}

test('expired and swept claim can restart explicitly without polling a deleted claim', async () => {
  const g = gateway()
  const a = await application(g, 'expired_old')
  const c = client(await g.serve(), a.pairing_id)
  try {
    const secret = 'synthetic-expired-secret-1234567890'
    const claim = g.store.startPairingClaim(a.machine_id, a.pairing_id, digest(secret), 'CHECK234', 1)
    privateDirectory(join(c.root, 'managed'))
    const path = runtimeReference(c.root, 'pairing-claim')
    writeSetupJson(path, {
      schema_version: 1,
      claim_id: claim.claim_id,
      machine_id: claim.machine_id,
      pairing_id: a.pairing_id,
      gateway_url: c.config.gateway_url,
      secret,
      expires_at: claim.expires,
      phase: 'waiting'
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    g.advance(100)
    g.store.expire()
    assert.throws(() => g.store.pairingClaim(claim.claim_id), /pairing_claim_not_found/)
    const before = readFileSync(path)
    await assert.rejects(
      claimConnector(c.config, c.terminal),
      (error) => error instanceof CliError && error.code === 'configuration_required'
    )
    assert.deepEqual(readFileSync(path), before)
    assert.equal(g.requests.length, 0)
    const next = await application(g, 'expired_new')
    c.answers.pairing = next.pairing_id
    c.answers.restart = true
    const running = claimConnector(c.config, c.terminal)
    const observed = running.catch(() => {})
    const nextClaim = await waitClaim(g, next.pairing_id)
    seedHerdr(c.root, nextClaim.claim_id, next.machine_id)
    await approve(g, next, nextClaim.claim_id, nextClaim.user_code)
    await running
    await observed
    assert.equal(loadCredential(runtimeReference(c.root, 'device')).machine_id, next.machine_id)
  } finally {
    c.close()
    await g.close()
  }
})
