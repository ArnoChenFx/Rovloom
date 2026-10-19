// 使用真实 Store/身份库和明确失败的 mock 生命周期桥，验证本地接线与 socket 失效，不冒充未发布桥验收。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/store.js'
import {
  ChannelRegistry,
  IdentityStore,
  PersistentIdentity,
  PersistentProofIdentity,
  createDeviceLifecycleWiring,
  createDeviceLifecycleAdapter,
  createStoreDeviceLedger,
  createStoreIdentityFacts,
  createGateway
} from '../../src/transport/index.js'
import type {
  DeviceLifecycleVerifier,
  DeviceCredential,
  StoreIdentityBridges,
  Connection,
  Session,
  LifecycleStoreFactory
} from '../../src/transport/index.js'
import { OFFER } from '../../src/transport/common.js'
import { fail, negotiate } from '../../src/wire/index.js'
import { fixture, until } from './helpers.js'
import type { TrustedNativeContext } from '../../src/native-contract/index.js'
import { G, identity as nativeIdentity } from '../native-contract/helpers.js'

/** 同时建立真实业务/身份库；mock 桥仅复用临时原始凭据连接，重配总在 prepare 后模拟主事务失败。 */
function wiringFixture() {
  const f = fixture()
  const root = mkdtempSync(join(tmpdir(), 'rovloom-mock-proof-wiring-'))
  const channels = new ChannelRegistry()
  const facts = createStoreIdentityFacts(f.store)
  const db = new IdentityStore(join(root, 'identity.sqlite'), {
    generation: f.store.generation(),
    guard: facts.guard,
    /** 身份时间与业务 Store 使用同一 fixture 时钟。 */
    now: () => f.now,
    /** 明确分配本次无生产效力 fixture 的身份安全/审计预算。 */
    checkBudget(usage) {
      if (usage.security_bytes + usage.audit_bytes + usage.reserved_bytes > 2_000_000) {
        fail('identity_quota')
      }
    }
  })
  /** 发出只对当前测试有效的一次性管理员确认。 */
  const authorize = () => ({ actor: 'mock_admin', confirmation_id: randomUUID(), expires_at: f.now + 1000 })
  const identity = new PersistentProofIdentity(db, authorize)
  const credentials = new Map<string, DeviceCredential>()
  const epochs = new Map<string, string>()
  let verify: DeviceLifecycleVerifier
  let prepared = 0
  let bypassProof = false
  let reenter: undefined | (() => void)
  const bridges: StoreIdentityBridges = {
    /** 此 mock 接线只测试证明回调及真实 epoch，绝不能作为生产 Store 原子连接桥。 */
    connectVerifiedDevice(machine, generation) {
      reenter?.()
      if (!bypassProof && !verify({ action: 'connect', machine_id: machine, recovery_generation: generation })) {
        fail('invalid_device_credential')
      }
      const current = f.credentials.authenticate(machine, generation, credentials.get(machine)!.credential)
      epochs.set(machine, current.identity.connection_epoch)
      return current.identity.connection_epoch
    },
    /** 明确没有真实 reset 实现：核对测试 fence、调用 prepare 和观察器后总抛提交失败，不伪造 pending。 */
    resetDeviceEnrollment(machine, generation, expected, prepare) {
      if (generation !== f.store.generation() || (epochs.get(machine) ?? null) !== expected) {
        fail('identity_fence_mismatch')
      }
      if (expected !== null) {
        f.store.assertConnection({ machine_id: machine, recovery_generation: generation, connection_epoch: expected })
      }
      prepared++
      if (
        prepare() !== undefined ||
        !verify({
          action: 'reset_enrollment',
          machine_id: machine,
          recovery_generation: generation,
          expected_epoch: expected
        })
      ) {
        fail('identity_prepare_required')
      }
      throw new Error('mock_primary_commit_failure')
    }
  }
  const lifecycle = createDeviceLifecycleWiring(
    /** 显式把同步验证器接入 mock 扩展，不修改共享 Store，也不假称真实桥存在。 */
    (callback) => {
      verify = callback
      return Object.assign(f.store, bridges)
    },
    identity
  )
  const manager = new PersistentIdentity(db, {
    ledger: createStoreDeviceLedger(f.store, bridges),
    authorize,
    /** 管理凭据变更时同步关闭注册过的实际 socket 资源。 */
    changed: (machine) => {
      channels.blockAndClose(machine)
    },
    /** mock 重配 prepare 同步封锁作用域，不调用主 Store。 */
    block: (machine) => {
      channels.blockAndClose(machine)
    }
  })
  return {
    f,
    db,
    identity,
    lifecycle,
    channels,
    /** 真实兑换一次 mock 配对 fixture 后，把同一凭据的摘要装入唯一身份库。 */
    pair(name: string) {
      const device = f.pair(name)
      credentials.set(device.machine_id, device.credential)
      manager.install(device.credential)
      return device
    },
    /** 返回 mock prepare 次数，核对旧 fence 不触发外部封锁。 */
    get prepared() {
      return prepared
    },
    /** 允许负例模拟宿主不消费证明却返回 Store epoch 的错误实现。 */
    set bypassProof(value: boolean) {
      bypassProof = value
    },
    /** 安装同步重入负例，验证认证临界区和凭据清零。 */
    set reenter(value: undefined | (() => void)) {
      reenter = value
    },
    /** 先停止 loopback 和业务库，再关闭身份库并清理本 fixture 私有目录。 */
    close() {
      f.stop()
      db.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

test(
  'nativeSource 解析前后复验所属 socket，拒绝跨机器、跨恢复代次和跨 epoch 的宿主来源',
  /** 解析函数提供完整 mock NativeBinding；接线不制造来源，也不接受其它连接的来源。 */
  () => {
    const f = wiringFixture()
    try {
      const a = f.pair('mock_native_scope')
      const epoch = f.lifecycle.authenticate(
        a.machine_id,
        a.credential.recovery_generation,
        Buffer.from(a.credential.credential)
      )
      const channel = f.channels.open(
        {},
        /** 本单元场景只关闭 mock socket，不执行主库管理动作。 */
        () => undefined
      )
      channel.bind({
        machine_id: a.machine_id,
        recovery_generation: a.credential.recovery_generation,
        connection_epoch: epoch,
        authenticated: true,
        active: true,
        negotiated: negotiate(OFFER, OFFER)
      })
      const source: TrustedNativeContext = {
        authenticated: true,
        source_verified: true,
        binding: {
          kind: 'luvus',
          provider_id: 'provider',
          binding_revision: 1,
          contract_source_ref: 'mock_contract',
          target: { machine_id: a.machine_id, profile: 'session', session: 'synthetic' },
          server_generation: G,
          connection_epoch: epoch,
          recovery_generation: a.credential.recovery_generation,
          capability_revision: 'caps1',
          caller_policy_revision: 'caller1',
          local_policy_revision: 'local1',
          classification_revision: 'review1',
          contract: nativeIdentity
        }
      }
      const variants = [
        {
          ...source,
          binding: { ...source.binding, target: { ...source.binding.target, machine_id: 'wrong_machine' } }
        },
        { ...source, binding: { ...source.binding, recovery_generation: 'wrong_generation' } },
        { ...source, binding: { ...source.binding, connection_epoch: 'wrong_epoch' } }
      ]
      for (const variant of variants) {
        const resolve = f.lifecycle.nativeSource(
          channel,
          /** 返回只改变一个身份轴的 mock 来源，验证接线逐轴核对。 */
          () => variant
        )
        assert.throws(
          /** 任何一个身份轴不符都必须在交给 adapter 之前拒绝。 */
          () => resolve('mock_call', 'mock_attempt'),
          /native_identity_mismatch/
        )
      }
      const resolve = f.lifecycle.nativeSource(
        channel,
        /** 模拟受信解析器中途同步关闭 socket，返回值不能绕过第二次门禁。 */
        () => {
          channel.close()
          return source
        }
      )
      assert.throws(
        /** 来源解析后的失效必须再次观察到，不能继续拿旧上下文工作。 */
        () => resolve('mock_call', 'mock_attempt'),
        /authentication_required/
      )
    } finally {
      f.close()
    }
  }
)

test(
  '缺原子生命周期能力时拒绝构造，不产生默认成功实现',
  /** 明确移除负例对象的一项能力，工厂不能默默改用原始凭据或私有 SQL。 */
  () => {
    const f = wiringFixture()
    try {
      /** 模拟较旧宿主明确缺少方法，保留构造门禁且不假称当前 main 仍缺桥。 */
      const missing = () => Object.assign(new Store(':memory:'), { connectVerifiedDevice: undefined })
      assert.throws(
        /** 只在负例中显式断言缺失接口，以触发实际运行时拒绝。 */
        () => createDeviceLifecycleWiring(missing as unknown as LifecycleStoreFactory, f.identity),
        /identity_bridge_unavailable/
      )
    } finally {
      f.close()
    }
  }
)

test(
  '认证接线同步消费真实证明并清零凭据，拒绝重入及未消费证明的假成功',
  /** 使用明确 mock 的连接桥取得真实 Store epoch，验证宿主接线的安全边界。 */
  () => {
    const f = wiringFixture()
    try {
      const a = f.pair('mock_proof_a')
      const b = f.pair('mock_proof_b')
      const bytes = Buffer.from(a.credential.credential)
      const nested = Buffer.from(b.credential.credential)
      f.reenter =
        /** 在 Store mock 回调中尝试同步再认证，必须拒绝并清零内层凭据。 */
        () => {
          assert.throws(
            /** 同一接线不允许第二个 pending proof 覆盖当前认证。 */
            () => f.lifecycle.authenticate(b.machine_id, b.credential.recovery_generation, nested),
            /authentication_in_progress/
          )
          assert.equal(
            nested.every(
              /** 确认拒绝路径把整个内层缓冲区清零。 */
              (byte) => byte === 0
            ),
            true
          )
        }
      const epoch = f.lifecycle.authenticate(a.machine_id, a.credential.recovery_generation, bytes)
      assert.equal(
        bytes.every(
          /** 成功返回前也必须清零完整凭据缓冲区。 */
          (byte) => byte === 0
        ),
        true
      )
      f.f.store.assertConnection({
        machine_id: a.machine_id,
        recovery_generation: a.credential.recovery_generation,
        connection_epoch: epoch
      })
      f.reenter = undefined
      f.bypassProof = true
      const bad = Buffer.from(b.credential.credential)
      assert.throws(
        /** 错误宿主跳过证明消费时，即便建立了真实 epoch，接线也必须断开并拒绝。 */
        () => f.lifecycle.authenticate(b.machine_id, b.credential.recovery_generation, bad),
        /invalid_device_credential/
      )
      assert.equal(f.f.store.machine(b.machine_id).status, 'offline')
      assert.equal(
        bad.every(
          /** 事后复验失败不能留下未清零的凭据。 */
          (byte) => byte === 0
        ),
        true
      )
    } finally {
      f.close()
    }
  }
)

test(
  '精确 socket 作用域在主事务失败后仍拒绝旧 backend 和 nativeSource，资源只清一次',
  /** mock 只模拟主提交失败；身份封锁使用真实独立数据库提交，Store 旧 epoch 故意保留以证明外部门禁。 */
  () => {
    const f = wiringFixture()
    try {
      const a = f.pair('mock_blocked')
      const epoch = f.lifecycle.authenticate(
        a.machine_id,
        a.credential.recovery_generation,
        Buffer.from(a.credential.credential)
      )
      const connection: Connection = {
        machine_id: a.machine_id,
        recovery_generation: a.credential.recovery_generation,
        connection_epoch: epoch,
        authenticated: true,
        active: true,
        negotiated: negotiate(OFFER, OFFER)
      }
      let closed = 0
      const channel = f.channels.open(
        {},
        /** 只记录模拟底层 socket 关闭，不在管理 prepare 中断开业务 Store。 */
        () => {
          closed++
        }
      )
      channel.bind(connection)
      const session = f.f.session(connection)
      channel.attach(session)
      /** 未使用的受信服务全部明确抛错，不能成为默认允许的原生来源或权限。 */
      const unavailable = () => {
        throw new Error('mock_service_unavailable')
      }
      const { backend } = createDeviceLifecycleAdapter(f.lifecycle, channel, {
        localProvider: unavailable,
        contract: unavailable,
        policies: unavailable,
        authority: unavailable,
        /** fixture 不提供实际原生来源，未封锁时返回 undefined。 */
        nativeSource: () => undefined,
        /** 本例不建立任何 caller 原生授权。 */
        currentPrincipal: () => undefined
      })
      assert.equal(backend.connection().connection_epoch, epoch)
      assert.throws(
        /** 陈旧 fence 必须在 prepare 之前失败，不得先关闭当前 socket 或清除身份。 */
        () => f.lifecycle.reset(channel, a.machine_id, connection.recovery_generation, 'old_epoch'),
        /identity_fence_mismatch/
      )
      assert.equal(f.prepared, 0)
      assert.equal(closed, 0)
      assert.throws(
        /** 主库故障发生在外部封锁提交后，错误必须保留且不能开放新配对。 */
        () => f.lifecycle.reset(channel, a.machine_id, connection.recovery_generation, epoch),
        /mock_primary_commit_failure/
      )
      assert.equal(closed, 1)
      assert.equal(f.f.sessions.closed, 1)
      f.f.store.assertConnection(connection)
      assert.equal(f.identity.blockedCommitted(a.machine_id, connection.recovery_generation, epoch), true)
      assert.equal(f.db.read(a.machine_id)!.status, 'blocked')
      assert.throws(
        /** 旧 Store epoch 尚在也不能使失效 socket 的 backend 复活。 */
        () => backend.connection(),
        /authentication_required/
      )
      assert.throws(
        /** 原生来源解析前先检查当前 socket，不能绕开外部封锁。 */
        () => backend.nativeSource('mock_call', 'mock_attempt'),
        /authentication_required/
      )
      channel.close()
      assert.equal(closed, 1)
    } finally {
      f.close()
    }
  }
)

test(
  '注册表先拒绝全部匹配 socket 再清资源，旧关闭事件不影响同设备新作用域',
  /** 检查 cleanup 回调重入时也无法使用另一个旧 socket，异常仍保证其它 socket 清理。 */
  () => {
    const registry = new ChannelRegistry()
    const connection: Connection = {
      machine_id: 'mock_machine',
      recovery_generation: 'mock_generation',
      connection_epoch: 'mock_epoch',
      authenticated: true,
      active: true,
      negotiated: negotiate(OFFER, OFFER)
    }
    let closed = 0
    /** 模拟底层 socket 的幂等关闭计数，不进行网络活动。 */
    const close = () => {
      closed++
    }
    const a = registry.open({}, close)
    const b = registry.open({}, close)
    a.bind(connection)
    b.bind(connection)
    a.attach({
      /** cleanup 在业务门禁失效之后才可调用，此时另一旧 socket 也已不可用。 */
      close() {
        assert.throws(
          /** 确认不是逐个清理导致其它旧 socket 暂时仍可工作。 */
          () => b.connection(),
          /authentication_required/
        )
        throw new Error('mock_cleanup_failure')
      }
    } as unknown as Session)
    assert.throws(
      /** 清理错误保留为失败，但不能停止其余 socket 的关闭。 */
      () => registry.blockAndClose(connection.machine_id),
      /synchronous_channel_block_required/
    )
    assert.equal(closed, 2)
    const fresh = registry.open({}, close)
    fresh.bind({ ...connection, connection_epoch: 'fresh_epoch' })
    a.close()
    assert.equal(fresh.connection().connection_epoch, 'fresh_epoch')
    const copy = fresh.connection()
    copy.connection_epoch = 'forged_epoch'
    assert.equal(fresh.connection().connection_epoch, 'fresh_epoch')
    fresh.close()
  }
)

test(
  '真实 loopback 两个 Connector 经持久证明认证，封锁失败只关闭目标 socket 且另一设备继续完成响应',
  /** 仅 mock Store 连接桥；真实 Wire、Router、Store、身份 SQLite 和 socket 参与，未发布 bridge 不在验收范围。 */
  async () => {
    const f = wiringFixture()
    const gateway = createGateway({
      hostname: '127.0.0.1',
      port: 0,
      developmentLoopback: true,
      identity: f.lifecycle.identityHost,
      channels: f.channels,
      store: f.f.store,
      router: f.f.router,
      /** 只从 fixture 的受信 caller 上下文取得 principal。 */
      principal: () => f.f.principal,
      /** 将实际 socket 作用域交给 Gateway 注册，资源使用真实 fixture adapter。 */
      session: (current) => f.f.session(current),
      limits: { heartbeat_ms: 100, idle_ms: 5000, handshake_ms: 2000 }
    })
    try {
      const a = f.pair('mock_socket_a')
      const b = f.pair('mock_socket_b')
      const ca = f.f.connector(
        /** 只向本机临时 Gateway 提供本次 mock A 凭据。 */
        () => a.credential,
        {
          url: gateway.url,
          limits: { heartbeat_ms: 100, idle_ms: 5000, handshake_ms: 2000, reconnect_ms: 20, reconnect_max_ms: 200 }
        }
      )
      const cb = f.f.connector(
        /** B 凭据只对本次隔离身份库有效。 */
        () => b.credential,
        {
          url: gateway.url,
          limits: { heartbeat_ms: 100, idle_ms: 5000, handshake_ms: 2000, reconnect_ms: 20, reconnect_max_ms: 200 }
        }
      )
      await until(
        /** 等待两个独立认证事务及双方实际 ready，不在 Connector 完成 welcome 之前派发。 */
        () =>
          ca.status().phase === 'ready' &&
          cb.status().phase === 'ready' &&
          gateway.status().devices.length === 2 &&
          gateway.status().devices.every(
            /** 每台设备都须由宿主 readiness 单独通过。 */
            (device) => device.ready
          )
      )
      const pending = f.f.call(a.target)
      const binding = gateway.dispatch(pending.call_id)
      assert.throws(
        /** 用受信派发 binding 的精确 epoch 重配，模拟主提交失败后旧通道仍关闭。 */
        () =>
          f.lifecycle.reset(
            {
              /** 管理关闭委托给 Gateway 的同一个实际 socket 注册表。 */
              blockAndClose: (machine) => f.channels.blockAndClose(machine),
              /** 本管理对象没有当前 caller socket，不提供伪造连接。 */
              connection: () => {
                throw new Error('mock_no_management_socket')
              }
            },
            a.machine_id,
            a.credential.recovery_generation,
            binding.connection_epoch
          ),
        /mock_primary_commit_failure/
      )
      await until(
        /** A 的重连被持久 blocked 拒绝，B 的 socket 继续保持可用。 */
        () => gateway.status().devices.length === 1
      )
      assert.equal(gateway.status().devices[0]!.machine_id, b.machine_id)
      const call = f.f.call(b.target)
      gateway.dispatch(call.call_id)
      await until(
        /** B 经真实响应事务提交后才可报告完成。 */
        () => f.f.router.get(f.f.principal, call.call_id).state === 'responded'
      )
      assert.equal(
        f.identity.blockedCommitted(a.machine_id, a.credential.recovery_generation, binding.connection_epoch),
        true
      )
    } finally {
      gateway.stop()
      f.close()
    }
  }
)
