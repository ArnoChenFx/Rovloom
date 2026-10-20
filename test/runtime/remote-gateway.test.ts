// 用真实设备认证和 Wire 验证远端 Gateway 装配；对端是明确合成 peer，不冒充双机或正式原生执行。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createLuvusCatalog } from '../../src/connector/luvus/index.js'
import { createLuvusProductionSources } from '../../src/runtime/production-luvus.js'
import type { LuvusProductionRemoteConfig } from '../../src/runtime/remote-luvus.js'
import { createGatewayRuntime } from '../../src/runtime/gateway.js'
import { openGatewayState } from '../../src/runtime/state.js'
import { FIXED_LUVUS_SHA256, FIXED_LUVUS_SCHEMA_SHA256 } from '../../src/runtime/native-control.js'
import { MANAGED_LUVUS_REVISION, MANAGED_LUVUS_CLASSIFICATION } from '../../src/runtime/native-source.js'
import { boundedJson, contractRef, hash } from '../../src/wire/index.js'
import type { AuthenticatedEnvelope, ProviderSnapshot, ProviderPolicy } from '../../src/wire/types.js'
import type { Connection } from '../../src/transport/index.js'
import { until } from '../transport/helpers.js'

/** Gateway 只建立自身状态目录；没有 binary、HOME、native root 或 socket 输入。 */
async function fixture() {
  const root = mkdtempSync(join(fileURLToPath(new URL('../../', import.meta.url)), '.remote-gateway-'))
  const directory = join(root, 'gateway')
  mkdirSync(directory, { mode: 0o700 })
  const active: { gateway?: Awaited<ReturnType<typeof createGatewayRuntime>> } = {}
  const state = openGatewayState({
    state_directory: directory,
    store: {
      management: /** 仅本轮临时合成设备与 provider 的管理能力。 */ () => ({
        actor: 'remote_fixture_admin',
        confirmation_id: randomUUID()
      })
    },
    authorizeIdentity: /** 本轮短期非生产设备身份批准，不读取用户凭据。 */ () => ({
      actor: 'remote_fixture_admin',
      confirmation_id: randomUUID(),
      expires_at: Date.now() + 10000
    }),
    changed: /** 原身份更改驱动原通道封锁。 */ (machine) => active.gateway?.transport.disconnect(machine),
    identity_reservation: { security_bytes: 1048576, audit_bytes: 4194304, file_bytes: 8388608 }
  })
  const machine = state.store.register('synthetic_remote_device')
  const credential = {
    ...state.store.redeem(state.store.issueEnrollment(machine.machine_id)),
    recovery_generation: state.store.generation()
  }
  state.credentials.install(credential, 60000)
  const target = {
    machine_id: machine.machine_id,
    provider_id: 'remote_provider',
    profile: 'session' as const,
    session: 'synthetic_remote'
  }
  const binding = {
    machine_id: target.machine_id,
    provider_id: target.provider_id,
    kind: 'luvus' as const,
    config_ref: 'remote_config',
    binding_revision: 1,
    enabled: true
  }
  state.store.defineProvider(binding)
  const caller: ProviderPolicy = {
    revision: 'remote_caller',
    grants: [{ target, methods: ['pane.list'], actions: ['dispatch', 'read', 'cancel'] }]
  }
  const local: ProviderPolicy = { ...structuredClone(caller), revision: 'remote_local' }
  const schema = readFileSync(new URL('../fixtures/luvus/0.14.3/linux/schema-bundle.json', import.meta.url), 'utf8')
  const config: LuvusProductionRemoteConfig = {
    kind: 'luvus',
    authentication: 'remote_connector',
    binding,
    target,
    peer_policy_revision: local.revision,
    contract: {
      binary_version: '0.14.3',
      binary_sha256: FIXED_LUVUS_SHA256,
      schema_sha256: FIXED_LUVUS_SCHEMA_SHA256,
      adapter_revision: MANAGED_LUVUS_REVISION,
      classification_revision: MANAGED_LUVUS_CLASSIFICATION,
      schema_bundle: schema
    }
  }
  const resources = await createLuvusProductionSources().gateway({ state_dir: directory }, [
    { reference: binding.config_ref, value: config }
  ])
  const caps = JSON.parse(
    readFileSync(new URL('../fixtures/luvus/0.14.3/linux/session-capabilities.json', import.meta.url), 'utf8')
  )
  caps.result.session = target.session
  caps.result.server_generation = 'a'.repeat(32)
  const snapshot: ProviderSnapshot = {
    binding,
    target,
    source: {
      provider_kind: 'luvus',
      protocol_family: 'uhp',
      binary_version: '0.14.3',
      binary_sha256: FIXED_LUVUS_SHA256,
      schema_sha256: FIXED_LUVUS_SCHEMA_SHA256,
      schema_origin: 'installed_cli',
      schema_command: 'luvus uhp schema',
      server_version: '0.14.3',
      native_protocol_version: '1.0',
      runtime_generation: caps.result.server_generation,
      adapter_revision: MANAGED_LUVUS_REVISION,
      classification_revision: MANAGED_LUVUS_CLASSIFICATION,
      support_basis: 'live_catalog'
    },
    capabilities: caps,
    capability_revision: hash(boundedJson(caps.result))
  }
  const gateway = await createGatewayRuntime({
    lifecycle: state.lifecycle,
    channels: state.channels,
    identities: {
      principal: /** 合成 caller 与设备身份独立。 */ (identity) =>
        identity.principal_id === 'remote_reader' ? { id: 'remote_reader', policy: caller } : null,
      administrator: /** 普通读取不取得管理身份。 */ () => null
    },
    localPolicies: /** 每次门禁读取当前完整目标策略。 */ () => local,
    providers: resources.providers,
    listener: { hostname: '127.0.0.1', port: 0, developmentLoopback: true },
    release: /** listener 停止后释放来源和唯一状态 writer。 */ async () => {
      await resources.release()
      state.close()
    }
  })
  active.gateway = gateway
  const runtime = gateway
  const sockets = new Set<WebSocket>()
  let writes = 0
  let hold = false
  /** 此合成 peer 只测试 Gateway；没有生产 Connector、本机 native 权限或正式 claims 的证明效力。 */
  async function peer() {
    const socket = new WebSocket(runtime.transport.url)
    sockets.add(socket)
    let connection: Connection | undefined
    let sequence = 0
    socket.onopen = /** 凭本轮真实签发的临时设备凭据走原认证握手。 */ () =>
      socket.send(
        JSON.stringify({
          protocol_major: 2,
          protocol_minor: 0,
          type: 'authenticate',
          message_id: randomUUID(),
          payload: {
            machine_id: credential.machine_id,
            recovery_generation: credential.recovery_generation,
            device_credential: credential.credential,
            connector_instance_id: randomUUID(),
            offer: { major: 2, minor: 0, capabilities: ['rpc', 'provider_snapshot'], required: ['rpc'] }
          }
        })
      )
    /** 测试只按当前 welcome 的私有连接发送数据，不自建或覆盖 Store epoch。 */
    function send(type: AuthenticatedEnvelope['type'], payload: unknown) {
      assert(connection)
      socket.send(
        JSON.stringify({
          protocol_major: 2,
          protocol_minor: 0,
          type,
          message_id: randomUUID(),
          machine_id: connection.machine_id,
          recovery_generation: connection.recovery_generation,
          connection_epoch: connection.connection_epoch,
          payload
        })
      )
    }
    socket.onmessage = /** 合成响应保留原 attempt/native ID，Gateway 必须通过其原结果门禁。 */ (event) => {
      const frame = JSON.parse(String(event.data))
      if (frame.type === 'welcome') {
        const { in_reply_to: _reply, selected, ...identity } = frame.payload
        connection = { ...identity, negotiated: selected, authenticated: true, active: true }
      } else if (frame.type === 'heartbeat') {
        send('heartbeat', { sequence: sequence++ })
      } else if (frame.type === 'request') {
        writes++
        send('accepted', { attempt: frame.payload.attempt })
        if (!hold) {
          send('response', {
            attempt: frame.payload.attempt,
            native_response: { id: frame.payload.attempt.native_request_id, result: { panes: [] } }
          })
        }
      }
    }
    await until(/** 实际身份宿主完成握手才交付测试 socket。 */ () => !!connection)
    return {
      socket,
      connection: connection!,
      snapshot: /** 每次测试消息仍经同一认证通道。 */ (value = snapshot) => send('provider_snapshot', value)
    }
  }
  return {
    runtime,
    state,
    config,
    target,
    local,
    caller,
    peer,
    snapshot,
    writes: /** 仅统计合成 peer 收到的 Wire request，不宣称 native 已执行。 */ () => writes,
    hold: /** 允许制造真实断连后的可能执行未知状态。 */ () => {
      hold = true
    },
    close: /** 全部测试 socket 与 Gateway 都关闭后才清理本轮唯一私有目录。 */ async () => {
      for (const socket of sockets) {
        socket.close()
      }
      await runtime.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

test(
  'remote Gateway starts without Luvus paths, waits for authenticated snapshot, and reads original Wire result',
  // 集成总预算覆盖真实认证、持久写与原结果读取；不改变产品编译、业务 deadline 或阶段等待上限。
  { timeout: 45_000 },
  /** 真实认证、目录、dispatch 与结果分页均复用生产 Gateway，合成 peer 明确只作为协议回归。 */ async () => {
    const f = await fixture()
    try {
      assert.equal(f.config.authentication, 'remote_connector')
      assert.equal('native' in f.config, false)
      const p = await f.peer()
      await f.runtime.runAuthenticated(
        { principal_id: 'remote_reader' },
        /** 快照到达前，设备已认证仍没有目录来源。 */ () => {
          assert.equal(f.runtime.catalog.resolve(f.target, f.runtime.principal()), undefined)
        }
      )
      assert.equal(f.runtime.transport.status().devices[0]?.ready, false)
      p.snapshot()
      await until(
        /** 当前认证 epoch 的有效快照接纳后才标 provider 就绪。 */ () =>
          f.runtime.transport.status().devices.some(/** 仅观察本轮唯一设备。 */ (device) => device.ready)
      )
      const ref = await f.runtime.runAuthenticated(
        { principal_id: 'remote_reader' },
        /** 使用既有目录实现发现、描述并取得实际契约引用。 */ () => {
          const resolved = f.runtime.catalog.resolve(f.target, f.runtime.principal())!
          assert(resolved)
          const catalog = createLuvusCatalog(resolved.record.compiled, resolved.record.capabilities, resolved.source, {
            now: Date.now,
            expires_at: resolved.expires_at,
            current: /** 每次读取都重验当前 caller、Store 与原真实 epoch。 */ () =>
              f.runtime.catalog.resolve(f.target, f.runtime.principal())!.source
          })
          assert(
            catalog
              .list({ query: 'pane.list' })
              .methods.some(/** 固定方法来自原能力视图。 */ (method) => method.method === 'pane.list')
          )
          assert.equal(catalog.describe('pane.list').schema_status, 'conditional_branch')
          return contractRef(resolved.record.wire.source)
        }
      )
      const admitted = await f.runtime.runAuthenticated(
        { principal_id: 'remote_reader' },
        /** 只对本次明确原请求准入一次。 */ () =>
          f.runtime.admit({
            target: f.target,
            native_request: { method: 'pane.list', params: { all_tabs: true } },
            options: { binding_revision: 1, contract_ref: ref, validation: 'strict', deadline: Date.now() + 30000 }
          })
      )
      assert.equal(admitted.created, true)
      await until(
        /** 原 Store 合规响应提交后才读取正文。 */ () =>
          f.state.store.call('remote_reader', admitted.call.call_id).state === 'responded'
      )
      await f.runtime.runAuthenticated(
        { principal_id: 'remote_reader' },
        /** 原结果句柄和原 Wire 读门禁必须交付完整未改写 native frame。 */ () => {
          const opened = f.runtime.results.open(admitted.call.call_id)
          const page = f.runtime.results.read(opened.result_id, 0, 4096)
          assert.equal(page.eof, true)
          assert.deepEqual(JSON.parse(Buffer.from(page.data, 'base64').toString()).result, { panes: [] })
        }
      )
      assert.equal(f.writes(), 1)
      p.socket.close()
      await until(
        /** 旧实际通道移除后目录不得继续返回快照来源。 */ () =>
          !f.runtime.transport.currentConnection(f.target.machine_id)
      )
      await f.runtime.runAuthenticated(
        { principal_id: 'remote_reader' },
        /** 失效旧 epoch 不从 pin 自动恢复 live 目录。 */ () =>
          assert.equal(f.runtime.catalog.resolve(f.target, f.runtime.principal()), undefined)
      )
    } finally {
      await f.close()
    }
  }
)

test(
  'remote Gateway loses old epoch on rebind and keeps unanswered dispatch unknown without replay',
  // 两次真实认证与持久状态门禁在 strace 下需要独立测试总预算，不能误用 Bun 默认五秒。
  { timeout: 45_000 },
  /** 断连后重新认证也不迁移 snapshot 或自动重派原请求；canonical重绑同步阻止目录。 */ async () => {
    const f = await fixture()
    try {
      const p = await f.peer()
      p.snapshot()
      await until(
        /** 等待原认证快照完成。 */ () =>
          f.runtime.transport.status().devices.some(/** 观察固定设备就绪。 */ (device) => device.ready)
      )
      f.hold()
      const admitted = await f.runtime.runAuthenticated(
        { principal_id: 'remote_reader' },
        /** 原 call 只派发一次，合成对端故意不回响应。 */ () =>
          f.runtime.admit({
            target: f.target,
            native_request: { method: 'pane.list', params: {} },
            options: {
              binding_revision: 1,
              contract_ref: contractRef(f.snapshot.source),
              validation: 'strict',
              deadline: Date.now() + 30000
            }
          })
      )
      await until(/** 对端已收到原 request，不能再声称确定未执行。 */ () => f.writes() === 1)
      p.socket.close()
      await until(
        /** 原断连处理把可能执行的调用固定为 unknown。 */ () =>
          f.state.store.call('remote_reader', admitted.call.call_id).state === 'outcome_unknown'
      )
      const next = await f.peer()
      assert.notEqual(next.connection.connection_epoch, p.connection.connection_epoch)
      await f.runtime.runAuthenticated(
        { principal_id: 'remote_reader' },
        /** 新连接没有继承旧快照。 */ () =>
          assert.equal(f.runtime.catalog.resolve(f.target, f.runtime.principal()), undefined)
      )
      next.snapshot()
      await until(
        /** 新 epoch 独立接纳自己的快照。 */ () =>
          f.runtime.transport.status().devices.some(/** 只检查实际设备。 */ (device) => device.ready)
      )
      assert.equal(f.writes(), 1)
      assert.equal(f.state.store.call('remote_reader', admitted.call.call_id).state, 'outcome_unknown')
      f.state.store.setProviderEnabled(f.target.machine_id, f.target.provider_id, 1, false)
      await f.runtime.runAuthenticated(
        { principal_id: 'remote_reader' },
        /** 当前canonical binding已变，旧pin/live来源不能继续使用。 */ () =>
          assert.equal(f.runtime.catalog.resolve(f.target, f.runtime.principal()), undefined)
      )
      assert.equal(f.writes(), 1)
    } finally {
      await f.close()
    }
  }
)
