// 已配对设备的重新配对：只用自有临时双库/凭据文件回放真实 enrollment 与持久确认；本地确认交互为明确 stub，不代表用户身份。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openGatewayState } from '../../src/runtime/state.js'
import { createFileCredentialSink, loadCredential } from '../../src/transport/credentials.js'
import type { DeviceCredential } from '../../src/transport/identity.js'
import { SetupApproval, type PairingPlan } from '../../src/cli/setup-approval.js'
import { GatewayPairingHttp } from '../../src/cli/pairing-http.js'
import { SetupTerminal } from '../../src/cli/setup-terminal.js'
import { privateDirectory } from '../../src/cli/first-config.js'
import { configTemplate, type ConnectorConfig } from '../../src/cli/config.js'
import { repairConnector } from '../../src/cli/setup-repair.js'
import { writeSetupJson } from '../../src/cli/setup-files.js'

// 只替代用户问答，不替代正式 Store、credential 或持久文件 sink。
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-pairing-repair-'))
  const directory = join(root, 'gateway')
  const client = join(root, 'client')
  const managed = join(client, 'managed')
  for (const path of [directory, join(directory, 'managed'), client, managed]) {
    privateDirectory(path)
  }
  const control = { allow: true, repaired: 0 }
  const terminal = {
    io: { signal: new AbortController().signal },
    actor: 'fixture_operator',
    uid: process.getuid!(),
    assertOwner() {},
    async confirm() {
      return control.allow
    }
  }
  const approval = new SetupApproval(terminal as unknown as SetupTerminal, directory)
  const state = openGatewayState({
    state_directory: directory,
    store: {
      management: /* 实际 Store 仍消费精确 action/fence 确认。 */ (request) => approval.authorizeManagement(request)
    },
    changed: () => {}
  })
  approval.attach(state)
  const http = new GatewayPairingHttp(
    state,
    approval,
    async () => {
      throw new Error('unexpected_native_setup')
    },
    () => {
      control.repaired++
    }
  )
  const credentialPath = join(managed, 'device.json')
  return {
    root,
    client,
    credentialPath,
    control,
    approval,
    state,
    http,
    async close() {
      await http.close()
      approval.detach(state)
      state.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}
type Fixture = ReturnType<typeof fixture>

async function post(f: Fixture, path: string, input: unknown) {
  const response = f.http.handle(
    new Request('http://127.0.0.1:9443' + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input)
    })
  )
  assert(response)
  return await response
}

function parts(value: string | undefined) {
  assert(value)
  const [machine_id, attempt_id, enrollment] = value.split('.')
  assert(machine_id && attempt_id && enrollment)
  return { machine_id, attempt_id, enrollment }
}

/** 走完首次配对到 ready：兑换、持久确认、原生批准、configured、ready；返回设备身份。 */
async function pairFirstTime(f: Fixture): Promise<{ credential: DeviceCredential; plan: PairingPlan }> {
  const issued = await f.approval.issue()
  const input = parts(issued.code)
  const delivery = (await (await post(f, '/pairing/redeem', input)).json()) as DeviceCredential & {
    delivery_id: string
    revision: number
  }
  const credential = {
    machine_id: delivery.machine_id,
    recovery_generation: delivery.recovery_generation,
    credential: delivery.credential
  }
  const sink = createFileCredentialSink(f.credentialPath, credential)
  const ack = await sink.deliver(credential, new AbortController().signal, {
    delivery_id: delivery.delivery_id,
    revision: delivery.revision
  })
  sink.close()
  const completed = await post(f, '/pairing/ack', {
    attempt_id: input.attempt_id,
    authentication: credential,
    acknowledgement: ack
  })
  assert.equal(completed.status, 200)
  const fingerprint = 'a'.repeat(64)
  await f.approval.approveNative(input.attempt_id, ['herdr'], fingerprint, 'fixture')
  f.approval.finishNative(input.attempt_id, fingerprint)
  f.approval.finishReady(input.attempt_id)
  return { credential, plan: f.approval.read(input.attempt_id) }
}

/** Connector 端状态：已配对设备凭据文件与一份原生来源，使 repairConnector 把它视为已完成首次配对。 */
function connectorConfig(f: Fixture, port: number): ConnectorConfig {
  writeSetupJson(join(f.client, 'managed', 'providers.json'), {
    schema_version: 1,
    role: 'connector',
    providers: [{ reference: 'fixture_herdr', value: { kind: 'herdr' } }]
  })
  return {
    ...configTemplate('connector'),
    state_dir: f.client,
    gateway_url: 'ws://127.0.0.1:' + port
  } as ConnectorConfig
}

// 把专用 handler 放到真实回环 HTTP 上，让 Connector 的正式 fetch 路径走完整请求。
async function serve(f: Fixture) {
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = []
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
    incoming.on('end', () => {
      const request = new Request('http://127.0.0.1' + incoming.url, {
        method: incoming.method ?? 'POST',
        headers: { 'content-type': incoming.headers['content-type'] ?? '' },
        body: Buffer.concat(chunks)
      })
      void (f.http.handle(request) ?? Promise.resolve(new Response('', { status: 404 }))).then(async (response) => {
        outgoing.writeHead(response.status, Object.fromEntries(response.headers))
        outgoing.end(Buffer.from(await response.arrayBuffer()))
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function connectorTerminal(answers: { code: string; trust?: boolean }) {
  return {
    io: { signal: new AbortController().signal },
    shown: [] as string[],
    assertOwner() {},
    show(text: string) {
      this.shown.push(text)
    },
    async ask() {
      return answers.code
    },
    async confirm() {
      return answers.trust ?? true
    }
  }
}

test('重新配对：旧凭据立即失效，新凭据覆盖本机文件并能认证，设备数量不变', async () => {
  const f = fixture()
  const server = await serve(f)
  try {
    const first = await pairFirstTime(f)
    const config = connectorConfig(f, server.port)
    const machine = first.credential.machine_id
    const repair = await f.approval.issueRepair()
    const input = parts(repair.code)
    assert.equal(input.machine_id, machine)
    assert.notEqual(input.attempt_id, first.plan.attempt_id)
    assert.equal(repair.plan.repair, true)
    assert.equal(f.approval.active()?.attempt_id, input.attempt_id)
    // 旧凭据此刻已失效，没有等到新凭据落盘。
    assert.throws(() =>
      f.state.lifecycle.identityHost.authenticate(
        machine,
        first.credential.recovery_generation,
        first.credential.credential
      )
    )
    const terminal = connectorTerminal({ code: repair.code })
    await repairConnector(config, terminal as unknown as SetupTerminal)
    const saved = loadCredential(f.credentialPath)
    assert.equal(saved.machine_id, machine)
    assert.notEqual(saved.credential, first.credential.credential)
    assert.equal(f.control.repaired, 1)
    assert.equal(f.approval.read(input.attempt_id).phase, 'configured')
    assert.equal(f.state.credentials.credentialRevision(machine), 2)
    // 新凭据能认证；设备仍只有这一台。
    const active = f.state.lifecycle.identityHost.authenticate(machine, saved.recovery_generation, saved.credential)
    f.state.lifecycle.identityHost.disconnect(active.identity)
    f.approval.finishReady(input.attempt_id)
    assert.equal(f.approval.read(input.attempt_id).phase, 'ready')
    assert.equal(f.state.store.machine(machine).status, 'offline')
    // 同一份码不能再次兑换。
    assert.equal((await post(f, '/pairing/redeem', input)).status, 409)
  } finally {
    await server.stop()
    await f.close()
  }
})

test('重新配对：另一台设备的码不能覆盖本机身份，且不向 Gateway 发出任何请求', async () => {
  const f = fixture()
  const server = await serve(f)
  try {
    const first = await pairFirstTime(f)
    const config = connectorConfig(f, server.port)
    const other = f.state.store.register('unrelated_fixture')
    const enrollment = f.state.store.issueEnrollment(other.machine_id)
    const foreign = other.machine_id + '.' + first.plan.attempt_id + '.' + enrollment
    await assert.rejects(repairConnector(config, connectorTerminal({ code: foreign }) as unknown as SetupTerminal), {
      code: 'configuration_required'
    })
    assert.deepEqual(loadCredential(f.credentialPath), first.credential)
    // 拒绝发生在本机：Gateway 侧另一设备的 enrollment 未被消耗。
    assert.equal(f.state.store.redeem(enrollment).machine_id, other.machine_id)
  } finally {
    await server.stop()
    await f.close()
  }
})

test('重新配对：拒绝确认、首次配对未完成、设备已撤销时都不重置设备', async () => {
  const f = fixture()
  try {
    // 首次配对尚未完成（只有兑换）：不是 ready，拒绝。
    const issued = await f.approval.issue()
    const input = parts(issued.code)
    await assert.rejects(f.approval.issueRepair(), { code: 'configuration_required' })
    await post(f, '/pairing/redeem', input)
    await f.http.close()
    const f2 = fixture()
    try {
      const first = await pairFirstTime(f2)
      f2.control.allow = false
      await assert.rejects(f2.approval.issueRepair(), { code: 'configuration_required' })
      // 拒绝后凭据仍有效：没有发生重置。
      const active = f2.state.lifecycle.identityHost.authenticate(
        first.credential.machine_id,
        first.credential.recovery_generation,
        first.credential.credential
      )
      f2.state.lifecycle.identityHost.disconnect(active.identity)
      assert.equal(f2.state.credentials.credentialRevision(first.credential.machine_id), 1)
      f2.control.allow = true
      // 设备被撤销后不能重新配对。
      const writer = new DatabaseSync(join(f2.root, 'gateway', 'gateway.db'))
      writer.prepare("UPDATE machines SET status='revoked' WHERE machine_id=?").run(first.credential.machine_id)
      writer.close()
      await assert.rejects(f2.approval.issueRepair(), { code: 'configuration_required' })
    } finally {
      await f2.close()
    }
  } finally {
    await f.close()
  }
})

test('重新配对：交付确认丢失后凭据不可用，重新执行可恢复，不留两份有效凭据', async () => {
  const f = fixture()
  try {
    const first = await pairFirstTime(f)
    const machine = first.credential.machine_id
    const repair = await f.approval.issueRepair()
    const input = parts(repair.code)
    const response = await post(f, '/pairing/redeem', input)
    assert.equal(response.status, 200)
    const delivery = (await response.json()) as DeviceCredential
    // 没有 ack：关闭使不确定的凭据被拒绝。
    await f.http.close()
    assert.equal(f.approval.read(input.attempt_id).phase, 'unknown')
    assert.throws(() =>
      f.state.lifecycle.identityHost.authenticate(machine, delivery.recovery_generation, delivery.credential)
    )
    assert.throws(() =>
      f.state.lifecycle.identityHost.authenticate(
        machine,
        first.credential.recovery_generation,
        first.credential.credential
      )
    )
    // 新的 Gateway 周期（同一计划文件）可以再签发一次，并完成。
    f.http = new GatewayPairingHttp(
      f.state,
      f.approval,
      async () => {
        throw new Error('unexpected_native_setup')
      },
      () => {
        f.control.repaired++
      }
    )
    const again = await f.approval.issueRepair()
    const retry = parts(again.code)
    assert.notEqual(retry.attempt_id, input.attempt_id)
    assert.equal(retry.machine_id, machine)
    const second = (await (await post(f, '/pairing/redeem', retry)).json()) as DeviceCredential & {
      delivery_id: string
      revision: number
    }
    const credential = {
      machine_id: machine,
      recovery_generation: second.recovery_generation,
      credential: second.credential
    }
    const sink = createFileCredentialSink(f.credentialPath, credential, true)
    const ack = await sink.deliver(credential, new AbortController().signal, {
      delivery_id: second.delivery_id,
      revision: second.revision
    })
    sink.close()
    const done = await post(f, '/pairing/ack', {
      attempt_id: retry.attempt_id,
      authentication: credential,
      acknowledgement: ack
    })
    assert.equal(done.status, 200)
    assert.equal(f.control.repaired, 1)
    // 只有最后这份凭据有效。
    for (const stale of [first.credential, delivery]) {
      assert.throws(() =>
        f.state.lifecycle.identityHost.authenticate(machine, stale.recovery_generation, stale.credential)
      )
    }
    const active = f.state.lifecycle.identityHost.authenticate(
      machine,
      credential.recovery_generation,
      credential.credential
    )
    f.state.lifecycle.identityHost.disconnect(active.identity)
  } finally {
    await f.close()
  }
})
