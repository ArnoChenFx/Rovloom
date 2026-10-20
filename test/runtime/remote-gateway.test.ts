// 用真实设备认证和 Wire 验证远端 Gateway 装配；对端是明确合成 peer，不冒充双机或正式原生执行。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createLuvusCatalog } from '../../src/connector/luvus/index.js'
import { createLuvusProductionSources } from '../../src/runtime/production-luvus.js'
import type { LuvusProductionRemoteConfig } from '../../src/runtime/remote-luvus.js'
import { createGatewayRuntime } from '../../src/runtime/gateway.js'
import { createHerdrGatewayResources } from '../../src/connector/herdr/provider.js'
import { fixedHerdrSource } from '../../src/connector/herdr/review.js'
import { createProviderConnectorRuntime } from '../../src/runtime/connector-host.js'
import { composeConnectorSessions } from '../../src/runtime/provider-sessions.js'
import { openGatewayState } from '../../src/runtime/state.js'
import { FIXED_LUVUS_SHA256, FIXED_LUVUS_SCHEMA_SHA256 } from '../../src/runtime/native-control.js'
import { MANAGED_LUVUS_REVISION, MANAGED_LUVUS_CLASSIFICATION } from '../../src/runtime/native-source.js'
import {
  boundedJson,
  contractRef,
  hash,
  encodeWireFrame,
  decodeWireFrame,
  MessageWindow
} from '../../src/wire/index.js'
import type { AuthenticatedEnvelope, ProviderSnapshot, ProviderPolicy, Direction } from '../../src/wire/types.js'
import type { Adapter, Connection, ConnectorWireSession } from '../../src/transport/index.js'
import { envelope } from '../../src/transport/common.js'
import { until } from '../transport/helpers.js'
import { privateHerdrTestRoot } from '../connector/herdr/private-root.js'

/** Gateway 只建立自身状态目录；没有 binary、HOME、native root 或 socket 输入。 */
async function fixture(mixed = false, isolated = false) {
  const root = mixed
    ? privateHerdrTestRoot('.remote-gateway-')
    : mkdtempSync(join(fileURLToPath(new URL('../../', import.meta.url)), '.remote-gateway-'))
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
  let herdr: Awaited<ReturnType<typeof createHerdrGatewayResources>> | undefined
  if (mixed) {
    try {
      const herdrTarget = { ...target, provider_id: 'herdr_snapshot' }
      const schema = join(root, 'herdr-schema.json')
      writeFileSync(schema, readFileSync(new URL('../fixtures/herdr/0.9.5/schema.json', import.meta.url)), {
        mode: 0o600
      })
      herdr = await createHerdrGatewayResources({
        config: {
          version: 1,
          target: herdrTarget,
          binding_revision: 1,
          config_ref: 'herdr_snapshot',
          expected_source: fixedHerdrSource(),
          schema_path: schema,
          peer_policy_revision: local.revision
        }
      })
      state.store.defineProvider(herdr.providers[0]!.binding)
      for (const policy of [caller, local]) {
        policy.grants.push({ target: herdrTarget, methods: ['ping'], actions: ['dispatch', 'read'] })
      }
    } catch (error) {
      try {
        await herdr?.release()
      } finally {
        try {
          await resources.release()
        } finally {
          state.close()
          rmSync(root, { recursive: true, force: true })
        }
      }
      throw error
    }
  }
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
    ...(herdr ? { hosted: [herdr] } : {}),
    listener: {
      hostname: '127.0.0.1',
      port: 0,
      developmentLoopback: true,
      ...(isolated
        ? {
            offer: { major: 2, minor: 0, capabilities: ['rpc', 'provider_fence'], required: ['rpc', 'provider_fence'] },
            limits: { heartbeat_ms: 30, idle_ms: 3000 }
          }
        : {})
    },
    release: /** listener 停止后释放来源和唯一状态 writer。 */ async () => {
      await resources.release()
      await herdr?.release()
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
    credential,
    herdr,
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

/** 非空快照只使用真实Wire治理codec；所有native端口是明确拒绝执行的测试stub。 */
function snapshotSession(
  connection: Connection,
  route: Pick<ProviderSnapshot, 'binding' | 'target'>,
  policy: string
): ConnectorWireSession {
  let closed = false
  const windows = new Map<Direction, MessageWindow>()
  const context = /** 原codec独立核对真实welcome及完整canonical provider，不接纳其它组。 */ (direction: Direction) => ({
    phase: 'authenticated' as const,
    direction,
    connection,
    resolveProvider: /** 完整目标匹配，不能只按kind或provider名称授权。 */ (target: ProviderSnapshot['target']) =>
      boundedJson(target) === boundedJson(route.target) ? route.binding : undefined
  })
  const native = /** 此测试没有native backend，意外业务调用始终失败。 */ () => {
    throw new Error('snapshot_test_native_unavailable')
  }
  const adapter: Adapter = {
    encode: /** 原encoder核对快照完整形状、协商能力与epoch。 */ (frame, direction) =>
      encodeWireFrame(frame, context(direction)),
    decode: /** 原decoder收到真实通道字节后再次验证全部原字段。 */ (raw, direction) =>
      decodeWireFrame(raw, context(direction)),
    observeMessage: /** 原组保持真实Wire消息窗口，组合窗口不能替代它。 */ (frame, direction) => {
      let window = windows.get(direction)
      if (!window) {
        window = new MessageWindow()
        windows.set(direction, window)
      }
      return window.observe(frame, context(direction), Date.now())
    },
    checkResult: native,
    checkResultRetention: native,
    encodeResponseObject: native,
    acceptChunk: native,
    planEvidence: native,
    release: native,
    stats: /** 没有native上下文，关闭状态只属于本测试端口。 */ () => ({ closed, executions: 0, responses: 0 }),
    close: /** 原codec所有者记录实际关闭，组合层仍负责全部组。 */ () => {
      closed = true
    }
  }
  return {
    adapter,
    admissions: {
      accept: native,
      assertRequest: native,
      closeEpoch: /** 本例不接收准入证明，没有需要落盘的receipt；不能由此放行业务。 */ () => {}
    },
    readiness: /** 只有本组的受保护配置；不宣称原生执行就绪。 */ () => ({
      policy_revision: policy,
      peer_policy_revision: policy,
      providers: [{ expected: route.binding, local: route.binding, native_ready: true }]
    }),
    executeWire: /** 该合成Connector仅发布快照，没有业务成功stub。 */ async () => native(),
    close: /** 本例没有额外原生owner，adapter关闭由原角色执行。 */ () => {}
  }
}

for (const isolated of [false, true]) {
  test(
    `mixed Connector publishes original sources through one channel (provider isolation: ${isolated})`,
    { timeout: 45_000 },
    /** 实际角色transport、组合codec和远端pin接纳均执行；不配对真实设备或调用native/model。 */ async () => {
      const f = await fixture(true, isolated)
      let connector: Awaited<ReturnType<typeof createProviderConnectorRuntime>> | undefined
      let combined: ConnectorWireSession | undefined
      let connected: Connection | undefined
      let publicationFailure: unknown
      let snapshotEncodes = 0
      let releases = 0
      let luvusReady = true
      let heartbeats = 0
      try {
        const nativeSnapshots = structuredClone([f.snapshot])
        /** 原transport要求稳定深冻结快照，测试不通过空数组绕过实际编码。 */
        function freeze(value: unknown): void {
          if (value && typeof value === 'object') {
            for (const child of Object.values(value)) {
              freeze(child)
            }
            Object.freeze(value)
          }
        }
        freeze(nativeSnapshots)
        connector = await createProviderConnectorRuntime({
          provider_snapshot: true,
          transport: {
            ...(isolated
              ? {
                  offer: {
                    major: 2,
                    minor: 0,
                    capabilities: ['rpc', 'provider_fence'],
                    required: ['rpc', 'provider_fence']
                  },
                  limits: { heartbeat_ms: 30, idle_ms: 3000 }
                }
              : {}),
            url: f.runtime.transport.url,
            developmentLoopback: true,
            credential: /** 仅使用本fixture原有的短期合成身份，不读取用户凭据。 */ () => f.credential
          },
          session: /** 原host在实际认证welcome后建立一个组合会话。 */ (connection) => {
            connected = connection
            const luvus = snapshotSession(connection, f.snapshot, f.local.revision)
            const readiness = luvus.readiness
            luvus.readiness = /** 显式模拟单个原安装来源失效，不影响 Herdr 或认证通道。 */ () => {
              const state = readiness()
              return {
                ...state,
                providers: state.providers.map(
                  /** 只撤去本组原生可用事实。 */ (provider) => ({
                    ...provider,
                    native_ready: provider.native_ready && luvusReady
                  })
                )
              }
            }
            luvus.providerSnapshot = /** 交付同一份非空原始快照，不复制或刷新generation。 */ () => nativeSnapshots
            const hosted = f.herdr!.providers[0]!
            const herdr = snapshotSession(connection, hosted, f.local.revision)
            combined = composeConnectorSessions(
              connection,
              [
                { providers: [f.snapshot], session: luvus },
                { providers: [hosted], session: herdr }
              ],
              Date.now
            )
            const original = combined
            return {
              ...original,
              adapter: {
                ...original.adapter,
                encode: /** 仅观察实际transport发布失败，仍调用原组合encoder且保留其拒绝。 */ (frame, direction) => {
                  try {
                    const bytes = original.adapter.encode(frame, direction)
                    if (frame.type === 'heartbeat') {
                      heartbeats++
                    }
                    if (frame.type === 'provider_snapshot') {
                      snapshotEncodes++
                    }
                    return bytes
                  } catch (error) {
                    if (frame.type === 'provider_snapshot') {
                      publicationFailure = error
                    }
                    throw error
                  }
                }
              }
            }
          },
          release: /** 原Connector关闭后只释放本例长期资源一次。 */ async () => {
            releases++
          }
        })
        await until(
          /** Gateway原remote owner接纳非空快照后，原provider健康才会变ready。 */ () =>
            f.runtime.transport
              .status()
              .devices.some(
                /** Herdr单独ready不能代替Luvus实际快照已接纳。 */ (device) =>
                  device.providers.some(
                    /** 指定原Luvus provider，避免把任一其它组就绪当成通过。 */ (provider) =>
                      provider.provider_id === f.target.provider_id && provider.ready
                  )
              )
        )
        assert.equal(f.runtime.transport.status().devices.length, 1)
        assert(['authenticated', 'ready'].includes(connector.transport.status().phase))
        assert.equal(combined!.providerSnapshot!().length, 1)
        assert.equal(publicationFailure, undefined)
        assert.equal(snapshotEncodes, 1)
        await f.runtime.runAuthenticated(
          { principal_id: 'remote_reader' },
          /** Gateway组合decoder、observe和accept均已执行，目录来源必须与原快照完全一致。 */ () => {
            const resolved = f.runtime.catalog.resolve(f.target, f.runtime.principal())!
            assert(resolved)
            assert.deepEqual(resolved.record.wire.source, f.snapshot.source)
            assert.deepEqual(resolved.record.capabilities, f.snapshot.capabilities)
            assert(f.herdr!.catalog.resolve(f.herdr!.providers[0]!.target, f.runtime.principal()))
          }
        )
        const frame = envelope(connected!, 'provider_snapshot', f.snapshot)
        assert.equal(Object.hasOwn(frame.payload, 'attempt'), false)
        assert.throws(
          /** 错kind不能选择其它组的原codec。 */ () =>
            combined!.adapter.encode(
              { ...frame, payload: { ...f.snapshot, binding: { ...f.snapshot.binding, kind: 'herdr' } } },
              'connector_to_gateway'
            )
        )
        assert.throws(
          /** 同名provider的其它session没有受保护路由。 */ () =>
            combined!.adapter.encode(
              { ...frame, payload: { ...f.snapshot, target: { ...f.target, session: 'foreign' } } },
              'connector_to_gateway'
            )
        )
        assert.throws(
          /** 同一路由的陈旧binding仍拒绝，不能只比较kind。 */ () =>
            combined!.adapter.encode(
              { ...frame, payload: { ...f.snapshot, binding: { ...f.snapshot.binding, binding_revision: 2 } } },
              'connector_to_gateway'
            )
        )
        assert.throws(
          /** 选中正确组以后，原codec仍拒绝错误连接epoch。 */ () =>
            combined!.adapter.encode({ ...frame, connection_epoch: 'foreign_epoch' }, 'connector_to_gateway')
        )
        if (isolated) {
          const epoch = connected!.connection_epoch
          luvusReady = false
          await until(
            /** Gateway 原来源撤回必须只影响 Luvus，Herdr 保留同一原资源。 */ () => {
              const providers = f.runtime.transport.status().devices[0]?.providers ?? []
              return (
                providers.find(/** 失败实例不再就绪。 */ (provider) => provider.provider_id === f.target.provider_id)
                  ?.ready === false &&
                providers.find(
                  /** 健康 Herdr 不随其它来源关闭。 */ (provider) => provider.provider_id === 'herdr_snapshot'
                )?.ready === true
              )
            }
          )
          assert.equal(f.runtime.transport.status().connections, 1)
          assert.equal(connector.transport.status().connection_epoch, epoch)
          assert.equal(connector.transport.status().reconnects, 0)
          assert.equal(combined!.providerSnapshot!().length, 0)
          await f.runtime.runAuthenticated(
            { principal_id: 'remote_reader' },
            /** 实际 RemoteLuvus pin 失效且健康 Herdr schema 目录仍可读，不用元数据代替原来源。 */ () => {
              assert.equal(f.runtime.catalog.resolve(f.target, f.runtime.principal()), undefined)
              assert(f.herdr!.catalog.resolve(f.herdr!.providers[0]!.target, f.runtime.principal()))
            }
          )
          luvusReady = true
          const before = heartbeats
          await until(/** 恢复两轮原连接心跳也不能复活旧来源。 */ () => heartbeats >= before + 2)
          assert.equal(combined!.providerSnapshot!().length, 0)
          assert.equal(snapshotEncodes, 1)
          assert.equal(connector.transport.status().connection_epoch, epoch)
          await f.runtime.runAuthenticated(
            { principal_id: 'remote_reader' },
            /** 原 epoch 的固定撤回继续生效，不重新打开旧 pin。 */ () => {
              assert.equal(f.runtime.catalog.resolve(f.target, f.runtime.principal()), undefined)
              assert(f.herdr!.catalog.resolve(f.herdr!.providers[0]!.target, f.runtime.principal()))
            }
          )
        }
        assert.equal(f.writes(), 0)
      } catch (error) {
        throw publicationFailure ?? error
      } finally {
        await connector?.close()
        await f.close()
      }
      assert.equal(releases, 1)
    }
  )
}

test(
  'Herdr 启动前不可用声明经真实通道撤回，Gateway 的健康 Luvus pin 仍在同 epoch 就绪',
  { timeout: 45_000 },
  /** Herdr 没有构造替代session；Luvus合成peer只发布原快照，不执行native或模型。 */ async () => {
    const f = await fixture(true, true)
    let connector: Awaited<ReturnType<typeof createProviderConnectorRuntime>> | undefined
    try {
      const snapshots = structuredClone([f.snapshot])
      /** 与正式快照来源相同的固定深冻结数据要求。 */
      function freeze(value: unknown): void {
        if (value && typeof value === 'object') {
          for (const child of Object.values(value)) {
            freeze(child)
          }
          Object.freeze(value)
        }
      }
      freeze(snapshots)
      connector = await createProviderConnectorRuntime({
        provider_snapshot: true,
        transport: {
          url: f.runtime.transport.url,
          developmentLoopback: true,
          offer: { major: 2, minor: 0, capabilities: ['rpc', 'provider_fence'], required: ['rpc', 'provider_fence'] },
          limits: { heartbeat_ms: 30, idle_ms: 3000 },
          credential: /** 仅使用本轮合成设备身份。 */ () => f.credential
        },
        session: /** 实际welcome后仅建立健康原会话，不为Herdr生成adapter或来源。 */ (connection) => {
          const luvus = snapshotSession(connection, f.snapshot, f.local.revision)
          luvus.providerSnapshot = /** 原稳定快照不刷新generation。 */ () => snapshots
          return composeConnectorSessions(
            connection,
            [{ providers: [f.snapshot], session: luvus }],
            Date.now,
            f.herdr!.providers
          )
        },
        release: /** 此合成peer没有额外安装或child资源。 */ async () => {}
      })
      await until(
        /** 两个实例都须有明确状态，不能把缺项当作已隔离。 */ () => {
          const providers = f.runtime.transport.status().devices[0]?.providers ?? []
          return (
            connector!.transport.status().phase === 'ready' &&
            providers.find(/** 健康原Luvus来源仍ready。 */ (provider) => provider.provider_id === f.target.provider_id)
              ?.ready === true &&
            providers.find(
              /** 无原生backend的Herdr明确不可用。 */ (provider) => provider.provider_id === 'herdr_snapshot'
            )?.ready === false
          )
        }
      )
      assert.equal(f.runtime.transport.status().connections, 1)
      assert.equal(connector.transport.status().reconnects, 0)
      assert.equal(
        connector.transport
          .status()
          .providers.find(
            /** 原失败配置也在Connector健康中明确报告。 */ (provider) => provider.provider_id === 'herdr_snapshot'
          )!.ready,
        false
      )
      await f.runtime.runAuthenticated(
        { principal_id: 'remote_reader' },
        /** 仍读取实际Gateway pin创建的原Luvus目录，不以元数据stub自证来源。 */ () => {
          const resolved = f.runtime.catalog.resolve(f.target, f.runtime.principal())!
          assert(resolved)
          assert.deepEqual(resolved.record.wire.source, f.snapshot.source)
        }
      )
      assert.equal(f.writes(), 0)
    } finally {
      await connector?.close()
      await f.close()
    }
  }
)

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
