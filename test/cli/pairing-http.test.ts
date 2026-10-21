// 只在自有临时双库/凭据中回放真实enrollment及持久确认；本地确认交互为明确stub，不代表用户身份或native验收。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { DatabaseSync } from 'node:sqlite'
import { openGatewayState } from '../../src/runtime/state.js'
import { createFileCredentialSink, loadCredential, saveCredential } from '../../src/transport/credentials.js'
import type { DeviceCredential } from '../../src/transport/identity.js'
import { SetupApproval } from '../../src/cli/setup-approval.js'
import { GatewayPairingHttp } from '../../src/cli/pairing-http.js'
import { SetupTerminal, hasLocalTerminal } from '../../src/cli/setup-terminal.js'
import { privateDirectory } from '../../src/cli/first-config.js'
import { configTemplate } from '../../src/cli/config.js'
import { createProductionCliRuntime } from '../../src/cli/production.js'
import { writeSetupJson } from '../../src/cli/setup-files.js'

// 只替代用户问答，不替代正式Store、credential或持久文件sink。
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-pairing-http-'))
  const directory = join(root, 'gateway')
  const managed = join(directory, 'managed')
  const client = join(root, 'client')
  for (const path of [directory, managed, client]) {
    privateDirectory(path)
  }
  const control = { allow: true, revoked: false, checks: 0, native: 0, changed: 0 }
  const terminal = {
    actor: 'fixture_operator',
    uid: process.getuid!(),
    // 本测试只模拟终端撤权；生产SetupTerminal另外要求内核TTY和真实UID/角色文件。
    assertOwner() {
      control.checks++
      if (control.revoked) {
        throw new Error('fixture_console_revoked')
      }
    },
    // 明确的问答stub允许测试确认/拒绝两条路径，不是产品默认允许。
    async confirm() {
      this.assertOwner()
      return control.allow
    }
  }
  const approval = new SetupApproval(terminal as unknown as SetupTerminal, directory)
  const state = openGatewayState({
    state_directory: directory,
    store: {
      management: /* 实际Store仍消费精确provider/action/fence确认。 */ (request) =>
        approval.authorizeManagement(request)
    },
    changed: /* 本例无活动WebSocket，只记录真实身份拒绝通知。 */ () => {
      control.changed++
    }
  })
  approval.attach(state)
  const http = new GatewayPairingHttp(
    state,
    approval,
    /* 这些配对测试不执行native配置，误调用必须失败。 */ async () => {
      control.native++
      throw new Error('unexpected_native_setup')
    }
  )
  return {
    root,
    directory,
    managed,
    client,
    control,
    approval,
    state,
    http,
    // 只检查机器数量，独立只读连接不读取secret或绕过产品writer。
    machines() {
      const reader = new DatabaseSync(join(directory, 'gateway.db'), { readOnly: true })
      try {
        return Number(reader.prepare('SELECT count(*) AS count FROM machines').get()!.count)
      } finally {
        reader.close()
      }
    },
    // 先等原custody拒绝未确认凭据，再关闭唯一身份库和业务库。
    async close() {
      await http.close()
      approval.detach(state)
      state.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

// 请求只交给专用生产HTTP handler，测试不直接调用sink/认证回调来跳过协议。
async function post(f: ReturnType<typeof fixture>, path: string, input: unknown, headers: Record<string, string> = {}) {
  const response = f.http.handle(
    new Request('http://127.0.0.1:9443' + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(input)
    })
  )
  assert(response)
  return await response
}

// 只取一次性码的公开目标和内存secret，不写日志或把它传到命令行。
function code(value: string | undefined) {
  assert(value)
  const [machine_id, attempt_id, enrollment] = value.split('.')
  assert(machine_id && attempt_id && enrollment)
  return { machine_id, attempt_id, enrollment }
}

test(
  '非TTY或自报isTTY不能创建本地确认，拒绝问答不注册设备或生成计划',
  /* 普通流和JSON不能取得终端权限；拒绝通过真实Store结果核对。 */ async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true })
    const output = Object.assign(new PassThrough(), { isTTY: true })
    const io = { stdin: input, stdout: output, stderr: output, signal: new AbortController().signal }
    assert.equal(hasLocalTerminal(io), false)
    assert.equal(SetupTerminal.open('/not/read', configTemplate('gateway'), io), undefined)
    input.destroy()
    output.destroy()
    const f = fixture()
    try {
      f.control.allow = false
      await assert.rejects(f.approval.issue())
      assert.equal(f.machines(), 0)
      assert.deepEqual(readdirSync(f.managed), [])
    } finally {
      await f.close()
    }
  }
)

test(
  '真实enrollment兑换后只有持久文件sink的精确ack才能完成，重复请求不再注册或重发secret',
  /* 真实双库、独立设备proof与O_EXCL文件交付全程有效，不调用模型或native。 */ async () => {
    const f = fixture()
    try {
      const issued = await f.approval.issue()
      const input = code(issued.code)
      const response = await post(f, '/pairing/redeem', input)
      assert.equal(response.status, 200)
      const delivery = (await response.json()) as DeviceCredential & {
        attempt_id: string
        delivery_id: string
        revision: number
        state: string
      }
      assert.equal(delivery.state, 'persist_and_acknowledge')
      assert.equal(f.approval.read(input.attempt_id).phase, 'redeeming')
      const credential = {
        machine_id: delivery.machine_id,
        recovery_generation: delivery.recovery_generation,
        credential: delivery.credential
      }
      const duplicate = await post(f, '/pairing/redeem', input)
      assert.equal(duplicate.status, 409)
      const path = join(f.client, 'device.json')
      const sink = createFileCredentialSink(path, {
        machine_id: input.machine_id,
        recovery_generation: delivery.recovery_generation
      })
      const ack = await sink.deliver(credential, new AbortController().signal, {
        delivery_id: delivery.delivery_id,
        revision: delivery.revision
      })
      sink.close()
      const saved = loadCredential(path)
      assert.equal(
        createHash('sha256').update(saved.credential).digest('hex'),
        createHash('sha256').update(credential.credential).digest('hex')
      )
      const completed = await post(f, '/pairing/ack', {
        attempt_id: input.attempt_id,
        authentication: saved,
        acknowledgement: ack
      })
      assert.equal(completed.status, 200)
      assert.equal(((await completed.json()) as { state: string }).state, 'delivered')
      assert.equal(f.approval.read(input.attempt_id).phase, 'paired')
      assert.equal(f.state.credentials.credentialRevision(input.machine_id), 1)
      assert.equal(f.machines(), 1)
      const status = await post(f, '/pairing/status', { attempt_id: input.attempt_id, authentication: saved })
      assert.equal(status.status, 200)
      assert.equal(((await status.json()) as { phase: string }).phase, 'paired')
      assert.equal((await post(f, '/pairing/redeem', input)).status, 409)
      assert.equal(f.machines(), 1)
      assert.equal(f.control.native, 0)
    } finally {
      await f.close()
    }
  }
)

test(
  '慢请求有固定并发额度，关闭中止body读取并等实际handler收尾后才交还双库',
  /* 有界真实流不提供任何身份；关闭不能因为对端尚未发送body而永久等待。 */ async () => {
    const f = fixture()
    let cancelled = 0
    try {
      const requests = Array.from(
        { length: 16 },
        /* 每个请求持有独立未完成流，不能共享一个取消结果。 */ () => {
          const body = new ReadableStream<Uint8Array>({
            // 只观测生产读取边界的实际取消，不提供凭据或成功响应。
            cancel() {
              cancelled++
            }
          })
          return f.http.handle(
            new Request('http://127.0.0.1:9443/pairing/redeem', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body
            })
          )!
        }
      )
      assert.equal((await post(f, '/pairing/redeem', {})).status, 503)
      await f.http.close()
      assert(
        (await Promise.all(requests)).every(
          /* 关闭只拒绝请求，不能误报一次性交付完成。 */ (response) => response.status === 409
        )
      )
      assert.equal(cancelled, 16)
      assert.equal(f.machines(), 0)
      assert.equal(f.control.native, 0)
    } finally {
      await f.close()
    }
  }
)

test(
  '已初始化来源更改Gateway origin或安装目录时，在秘密发送或任何native工厂之前拒绝',
  /* 这里只验证正式loader前置边界，明确的拒绝工厂不提供任何身份/来源或native成功替身。 */ async () => {
    const f = fixture()
    let calls = 0
    try {
      const managed = join(f.client, 'managed')
      privateDirectory(managed)
      const config = {
        ...configTemplate('connector'),
        state_dir: f.client,
        gateway_url: 'ws://127.0.0.1:9443',
        native: { agent_bin_dir: '/opt/approved/bin' }
      }
      const credential = {
        machine_id: 'loader_fixture',
        recovery_generation: 'fixture_generation',
        credential: 'SYNTHETIC_DEVICE_ONLY_'.padEnd(48, 'x')
      }
      saveCredential(join(managed, 'device.json'), credential)
      writeSetupJson(join(managed, 'providers.json'), {
        schema_version: 1,
        role: 'connector',
        providers: [
          {
            reference: 'fixture_luvus',
            value: { kind: 'luvus', native: { root_record: join(f.client, 'control', 'luvus-root.json') } }
          }
        ]
      })
      writeSetupJson(join(managed, 'pairing.json'), {
        schema_version: 1,
        attempt_id: 'fixture_attempt',
        machine_id: credential.machine_id,
        gateway_url: config.gateway_url,
        phase: 'configured'
      })
      writeSetupJson(join(managed, 'native-setup.json'), {
        schema_version: 1,
        attempt_id: 'fixture_attempt',
        machine_id: credential.machine_id,
        phase: 'prepared',
        settings: config.native,
        reference: 'fixture_luvus',
        local: {},
        remote: {}
      })
      const runtime = createProductionCliRuntime({
        // 被拒绝路径绝不能打开native、发送秘密或把这个明确的测试计数器当作真实后端。
        async connector() {
          calls++
          throw new Error('fixture_native_must_not_open')
        }
      })
      for (const changed of [
        { ...config, gateway_url: 'ws://127.0.0.1:1' },
        { ...config, native: { agent_bin_dir: '/other/bin' } }
      ]) {
        await assert.rejects(runtime.connector!(changed), { code: 'configuration_required' })
      }
      assert.equal(calls, 0)
      assert.equal(existsSync(join(f.client, 'control')), false)
      assert.deepEqual(loadCredential(join(managed, 'device.json')), credential)
    } finally {
      await f.close()
    }
  }
)

test(
  '错误code不消耗另一设备enrollment，错误ack及关闭拒绝不确定凭据并保留原attempt',
  /* 不提高原5秒交付预算；显式关闭模拟响应/确认丢失，并在库仍打开时检查持久拒绝。 */ async () => {
    const f = fixture()
    try {
      const issued = await f.approval.issue()
      const input = code(issued.code)
      const unrelated = f.state.store.register('unrelated_fixture')
      const other = f.state.store.issueEnrollment(unrelated.machine_id)
      const refused = await post(f, '/pairing/redeem', { ...input, enrollment: other })
      assert.equal(refused.status, 409)
      assert.equal(f.state.store.redeem(other).machine_id, unrelated.machine_id)
      assert.equal(f.approval.read(input.attempt_id).phase, 'issued')
      assert.equal((await post(f, '/pairing/redeem', input, { origin: 'https://untrusted.invalid' })).status, 403)
      const response = await post(f, '/pairing/redeem', input)
      assert.equal(response.status, 200)
      const delivery = (await response.json()) as DeviceCredential & { delivery_id: string; revision: number }
      const credential = {
        machine_id: delivery.machine_id,
        recovery_generation: delivery.recovery_generation,
        credential: delivery.credential
      }
      assert.equal(
        (
          await post(f, '/pairing/ack', {
            attempt_id: input.attempt_id,
            authentication: credential,
            acknowledgement: {
              delivery_id: delivery.delivery_id,
              revision: delivery.revision + 1,
              machine_id: input.machine_id,
              recovery_generation: delivery.recovery_generation
            }
          })
        ).status,
        409
      )
      await f.http.close()
      assert.equal(f.approval.read(input.attempt_id).phase, 'unknown')
      assert.throws(
        /* 不确定交付的同一digest不能再认证成新epoch。 */ () =>
          f.state.lifecycle.identityHost.authenticate(
            credential.machine_id,
            credential.recovery_generation,
            credential.credential
          )
      )
      assert.equal(f.control.changed, 1)
      assert.equal(f.machines(), 2)
      await assert.rejects(/* 不能因上次结果不确定而悄悄再注册一个设备。 */ () => f.approval.issue())
      assert.equal(f.machines(), 2)
      assert.equal(f.approval.active()?.attempt_id, input.attempt_id)
      assert.equal(f.control.native, 0)
    } finally {
      await f.close()
    }
  }
)
