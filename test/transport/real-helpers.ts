// 在私有临时目录组合真实 Store 桥、唯一 IdentityStore、实际 socket 与真实 Wire/native adapter。
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/store.js'
import {
  ChannelRegistry,
  IdentityStore,
  PersistentIdentity,
  PersistentProofIdentity,
  createStoreDeviceLedger,
  createStoreIdentityFacts,
  createDeviceLifecycleWiring,
  createDeviceLifecycleAdapter
} from '../../src/transport/index.js'
import type { Connection, DeviceLifecycleVerifier, IdentityHost, SocketChannel } from '../../src/transport/index.js'
import type { IdentityIntent } from '../../src/transport/identity-store.js'
import type { ConnectorOptions } from '../../src/transport/connector.js'
import { boundedJson, fail } from '../../src/wire/index.js'
import { fixture, until } from './helpers.js'
import { management } from '../storage/helpers.js'

/** 初始化真实双 SQLite 与双端 loopback，独立管理确认、凭据及 native 来源均仅为本次 mock fixture。 */
export function realFixture(options: { tls?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-real-bridge-mock-'))
  const storePath = join(root, 'store.sqlite')
  const identityPath = join(root, 'identity.sqlite')
  const channels = new ChannelRegistry()
  let tls: { cert: string; key: string } | undefined
  if (options.tls) {
    execFileSync(
      '/usr/bin/openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=mock-loopback-only',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
        '-keyout',
        join(root, 'mock.key'),
        '-out',
        join(root, 'mock.crt')
      ],
      { stdio: 'ignore' }
    )
    tls = { cert: readFileSync(join(root, 'mock.crt'), 'utf8'), key: readFileSync(join(root, 'mock.key'), 'utf8') }
  }
  let verify: DeviceLifecycleVerifier | undefined
  let approval: { machine: string; fence: string; id: string } | undefined
  let failStore = false
  let beforeStoreCommit: (() => void) | undefined
  let failIdentity = false
  let allowIdentity = true
  let identityChanges = 0
  const records: {
    connection: Connection
    channel: SocketChannel
    native: ReturnType<typeof createDeviceLifecycleAdapter>
  }[] = []
  const events: Parameters<Parameters<Store['subscribeInvalidation']>[0]>[0][] = []
  const identityProxy: IdentityHost = {
    /** 仅在创建完真实接线后读取主 Store 代次。 */
    generation: () => lifecycle.identityHost.generation(),
    /** 真实桥同步消费 PersistentProofIdentity 私有证明；不存在原始 Store 凭据代理。 */
    authenticate: (machine, generation, credential) =>
      lifecycle.identityHost.authenticate(machine, generation, credential),
    /** 每次复验该原 socket 的持久租期与真实 Store epoch。 */
    assert: (current, lease) => lifecycle.identityHost.assert(current, lease),
    /** 普通断连使用真实 Store 精确 epoch 操作。 */
    disconnect: (current) => lifecycle.identityHost.disconnect(current)
  }
  const f = fixture(
    {
      identity: identityProxy,
      channels,
      ...(tls ? { tls } : {}),
      limits: { heartbeat_ms: 200, idle_ms: 10_000, handshake_ms: 5000 }
    },
    {
      maintenanceIntervalMs: 60_000,
      /** reset 只消费精确设备、代次与 epoch 的独立确认，其它合成管理操作仍用 fixture 管理员。 */
      management(request) {
        if (request.action !== 'device_enrollment_reset') {
          return management!(request)
        }
        if (!approval || approval.machine !== request.target || approval.fence !== request.fence) {
          return { actor: '', confirmation_id: '' }
        }
        return { actor: 'mock_admin', confirmation_id: approval.id }
      },
      /** 真实 Store 事务同步进入受保护验证器，不接受 Wire 或普通 JSON 的 verified 自证。 */
      deviceLifecycle: (request) => verify?.(request) === true,
      /** 在真实业务 COMMIT 前制造失败，独立身份提交不受本库回滚影响。 */
      fault(point) {
        if (point === 'before_commit' && beforeStoreCommit) {
          const callback = beforeStoreCommit
          beforeStoreCommit = undefined
          callback()
        }
        if (failStore && point === 'before_commit') {
          throw new Error('mock_primary_commit_failure')
        }
      }
    },
    {
      /** 真实业务账本仅写本测试新建的 0700 根目录。 */
      store: (now, settings) => new Store(storePath, now, settings),
      /** Gateway 每个实际 socket 均使用生命周期 backend 和提交后回收订阅，记录仅供资源断言。 */
      adapter(connection, channel, services) {
        const native = createDeviceLifecycleAdapter(lifecycle, channel, services)
        records.push({ connection, channel, native })
        return native.adapter
      }
    }
  )
  const facts = createStoreIdentityFacts(f.store)
  const db = new IdentityStore(identityPath, {
    generation: f.store.generation(),
    guard: facts.guard,
    /** 真实身份库和业务库共用可控可信测试时间。 */
    now: () => f.now,
    /** 明确为同一测试身份库分配安全及审计份额，不建立第二身份真相。 */
    checkBudget(usage) {
      if (usage.security_bytes + usage.audit_bytes + usage.reserved_bytes > 2_000_000) {
        fail('identity_quota')
      }
    },
    /** 在身份提交前制造落盘失败，保证 Store 和 socket 不能假报认证成功。 */
    fault() {
      if (failIdentity) {
        throw new Error('mock_identity_commit_failure')
      }
    }
  })
  /** 为本 fixture 管理操作给出独立短期确认，重配还必须匹配与 Store 相同的精确 fence。 */
  const authorize = (intent: IdentityIntent) => {
    if (
      !allowIdentity ||
      (intent.action === 're_pair' &&
        (!approval ||
          approval.machine !== intent.machine_id ||
          approval.fence !==
            boundedJson({
              recovery_generation: intent.recovery_generation,
              connection_epoch: intent.connection_epoch
            })))
    ) {
      fail('identity_forbidden')
    }
    identityChanges++
    return { actor: 'mock_admin', confirmation_id: randomUUID(), expires_at: f.now + 1000 }
  }
  const identity = new PersistentProofIdentity(db, authorize)
  const lifecycle = createDeviceLifecycleWiring(
    /** 只注入回调并返回真实 Store；这里没有 Object.assign 桥方法、私有 SQL 或原始凭据后门。 */
    (callback) => {
      verify = callback
      return f.store
    },
    identity
  )
  const manager = new PersistentIdentity(db, {
    ledger: createStoreDeviceLedger(f.store),
    authorize,
    /** prepare 仅关闭实际通道，不能在主 Store 事务中重入断连。 */
    block: (machine) => {
      channels.blockAndClose(machine)
    },
    /** 身份操作提交后走正常断连，轮换后的新凭据才能建立 fresh epoch。 */
    changed: (machine) => {
      f.gateway.disconnect(machine)
    }
  })
  const unsubscribe = f.store.subscribeInvalidation(
    /** 收集真实 COMMIT 后的最小设备作用域回收事件，不收集请求或凭据。 */
    (event) => {
      events.push(event)
    }
  )
  return {
    f,
    db,
    identity,
    manager,
    lifecycle,
    channels,
    records,
    events,
    root,
    storePath,
    identityPath,
    /** 原子消费 mock enrollment 后只向真实身份库安装摘要，连接完全依赖真实已合并桥。 */
    pair(name: string) {
      const device = f.pair(name)
      manager.install(device.credential)
      return device
    },
    /** 使用当前设备启动配置创建真实 loopback Connector，不运行任何真实原生进程。 */
    connector(device: ReturnType<typeof f.pair>, options: Partial<ConnectorOptions> = {}) {
      return f.connector(
        /** 凭据来自本 fixture 受保护启动闭包，不取自业务输入或设备名称。 */
        () => device.credential,
        {
          ...(tls ? { ca: tls.cert } : {}),
          limits: { heartbeat_ms: 200, idle_ms: 10_000, handshake_ms: 5000, reconnect_ms: 20, reconnect_max_ms: 200 },
          ...options
        }
      )
    },
    /** 同时等待双方真实 ready，避免 Gateway 就绪早于 Connector 完成 welcome 的竞态。 */
    async ready(...clients: ReturnType<typeof f.connector>[]) {
      await until(
        /** 每个指定 Connector 都必须收到 welcome 并完成本机 readiness 检查。 */
        () =>
          clients.every(
            /** 当前连接必须实际 ready，不能只检查 TCP 或 socket open。 */
            (client) => client.status().phase === 'ready'
          ),
        8000
      )
    },
    /** 为一次主 Store 重配签发精确 fence 管理确认。 */
    approve(machine: string, epoch: string | null) {
      approval = {
        machine,
        fence: boundedJson({ recovery_generation: f.store.generation(), connection_epoch: epoch }),
        id: randomUUID()
      }
    },
    /** 按当前记录的精确 epoch 调用真实跨库重配协调，结果由两个真实库判断。 */
    reset(machine: string, epoch: string | null) {
      const record = records.findLast(
        /** 只取此设备实际认证 socket 的作用域，绝不从 Wire 帧构造 connection。 */
        (item) => item.connection.machine_id === machine
      )
      if (!record) {
        fail('mock_channel_unavailable')
      }
      lifecycle.reset(record.channel, machine, f.store.generation(), epoch)
    },
    /** 返回独立管理确认消费计数，验证旧 fence 不触发身份副作用。 */
    get identityChanges() {
      return identityChanges
    },
    /** 开关真实主 Store 提交故障，不改变任何生产配置。 */
    set failStore(value: boolean) {
      failStore = value
    },
    /** 在下次真实 Store 提交前同步重入一次管理操作，验证提交后的认证复验。 */
    set beforeStoreCommit(callback: (() => void) | undefined) {
      beforeStoreCommit = callback
    },
    /** 开关真实身份库提交故障，观察 socket/epoch 是否保持拒绝。 */
    set failIdentity(value: boolean) {
      failIdentity = value
    },
    /** 模拟身份管理员拒绝，检查主库即使先授权也不能替代独立身份确认。 */
    set allowIdentity(value: boolean) {
      allowIdentity = value
    },
    /** 幂等停止本 fixture 的网络、adapter、Store 和唯一身份库，然后清除新建目录。 */
    close() {
      unsubscribe()
      f.stop()
      db.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}
