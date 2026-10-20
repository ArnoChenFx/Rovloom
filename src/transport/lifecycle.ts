// 组合受保护 Store 生命周期回调、独立身份事实与具体 socket 上下文；缺原子桥时拒绝构造。
import type { Store } from '../store.js'
import { persistentBackend } from '../integration/persistence.js'
import { createLuvusWireAdapter } from '../integration/luvus-wire.js'
import type { NativeWireBackend } from '../integration/luvus-wire.js'
import { fail, hash } from '../wire/index.js'
import type { ConnectionIdentity } from '../wire/types.js'
import type { IdentityHost } from './identity.js'
import type { ChannelHost } from './channel-host.js'
import type { DeviceProofHost, VerifiedDeviceProof } from './proof-identity.js'
import type { StoreIdentityBridges } from './store-identity.js'

export type DeviceLifecycleRequest = Readonly<
  | { action: 'connect'; machine_id: string; recovery_generation: string }
  | { action: 'reset_enrollment'; machine_id: string; recovery_generation: string; expected_epoch: string | null }
>
/** 仅在 Store 原子事务内同步消费证明或复验已提交封锁，普通工具不能直接调用此回调。 */
export type DeviceLifecycleVerifier = (request: DeviceLifecycleRequest) => boolean
/** 宿主须把回调注入真实 StoreOptions.deviceLifecycle，并提供其独立 management；不存在默认授权实现。 */
export type LifecycleStoreFactory = (verify: DeviceLifecycleVerifier) => Store & StoreIdentityBridges

/** 建立串行认证和拒绝优先重配接线；open 必须返回已经实际实现两项原子生命周期操作的 Store。 */
export function createDeviceLifecycleWiring(open: LifecycleStoreFactory, identity: DeviceProofHost) {
  let pendingProof: VerifiedDeviceProof | undefined
  let authenticating = false
  let proofAccepted = false
  const store = open(
    /** connect 恰好一次消费 pending proof；reset 只接受独立连接可见的精确已提交封锁。 */
    (request) => {
      if (request.action === 'connect') {
        const proof = pendingProof
        pendingProof = undefined
        proofAccepted =
          proof !== undefined && identity.consumeProof(proof, request.machine_id, request.recovery_generation) === true
        return proofAccepted
      }
      return identity.blockedCommitted(request.machine_id, request.recovery_generation, request.expected_epoch) === true
    }
  )
  if (typeof store.connectVerifiedDevice !== 'function' || typeof store.resetDeviceEnrollment !== 'function') {
    store.close()
    fail('identity_bridge_unavailable')
  }
  /** 无 await 地核对并消费一次性证明，提交 fresh epoch 后复验；所有出口清零输入缓冲区。 */
  function authenticate(machine: string, generation: string, credential: Uint8Array): string {
    if (!(credential instanceof Uint8Array)) {
      fail('invalid_device_credential')
    }
    if (authenticating) {
      credential.fill(0)
      fail('authentication_in_progress')
    }
    authenticating = true
    proofAccepted = false
    try {
      let lease: string
      try {
        pendingProof = identity.verifyCredential(machine, generation, credential)
        lease = hash(credential)
      } catch {
        fail('invalid_device_credential')
      } finally {
        credential.fill(0)
      }
      const epoch = store.connectVerifiedDevice(machine, generation)
      const connection = { machine_id: machine, recovery_generation: generation, connection_epoch: epoch }
      try {
        if (!proofAccepted || pendingProof !== undefined || !identity.leaseCommitted(machine, generation, lease!)) {
          fail('invalid_device_credential')
        }
        store.assertConnection(connection)
      } catch {
        store.disconnect(machine, epoch)
        fail('invalid_device_credential')
      }
      return epoch
    } finally {
      pendingProof = undefined
      authenticating = false
      proofAccepted = false
    }
  }
  /** 从具体 socket 读取身份，独立已提交身份库和当前 Store fence 都通过后才交给 backend。 */
  function connection(channels: ChannelHost) {
    const current = channels.connection()
    if (
      current.authenticated !== true ||
      current.active !== true ||
      !identity.usableCommitted(current.machine_id, current.recovery_generation)
    ) {
      fail('authentication_required')
    }
    store.assertConnection(current)
    return current
  }
  /** 对原生来源解析前后各复验同一 socket，并校验来源 target/代次/epoch，不从 Wire 输入制造来源。 */
  function nativeSource(
    channels: ChannelHost,
    resolve: NativeWireBackend['nativeSource']
  ): NativeWireBackend['nativeSource'] {
    /** 保持解析函数闭包只引用所属 socket 的连接门禁，不使用最近上线的设备身份。 */
    const guarded: NativeWireBackend['nativeSource'] = (call, attempt) => {
      connection(channels)
      const source = resolve(call, attempt)
      const current = connection(channels)
      if (
        source &&
        (source.binding.target.machine_id !== current.machine_id ||
          source.binding.recovery_generation !== current.recovery_generation ||
          source.binding.connection_epoch !== current.connection_epoch)
      ) {
        fail('native_identity_mismatch')
      }
      return source
    }
    return guarded
  }
  const identityHost: IdentityHost = {
    /** 只读取主 Store 的当前代次。 */
    generation: () => store.generation(),
    /** 将 Wire 凭据转换为可清零缓冲区，返回当前精确 epoch 及该原凭据的 hash 租期。 */
    authenticate(machine, generation, credential) {
      const bytes = Buffer.from(credential, 'utf8')
      const lease = hash(bytes)
      const epoch = authenticate(machine, generation, bytes)
      return { identity: { machine_id: machine, recovery_generation: generation, connection_epoch: epoch }, lease }
    },
    /** 复验原 socket 的 hash 租期与真实 Store fence，轮换、封锁和旧 epoch 均不能混用。 */
    assert(current, lease) {
      if (!identity.leaseCommitted(current.machine_id, current.recovery_generation, lease)) {
        fail('authentication_required')
      }
      store.assertConnection(current)
    },
    /** 普通断连只断开匹配 epoch；管理 prepare 的通道关闭不通过此入口。 */
    disconnect(current: ConnectionIdentity) {
      store.disconnect(current.machine_id, current.connection_epoch)
    }
  }
  return {
    store,
    identityHost,
    authenticate,
    connection,
    nativeSource,
    /** Store 先校验确认/fence/预算，再 prepare；外部封锁提交后主事务失败也不恢复旧通道。 */
    reset(channels: ChannelHost, machine: string, generation: string, expectedEpoch: string | null): void {
      let prepared = false
      store.resetDeviceEnrollment(
        machine,
        generation,
        expectedEpoch,
        /** 先授权并提交身份封锁，再关闭旧 socket；授权拒绝无关闭副作用，清理失败仍保留 blocked。 */
        () => {
          if (prepared) {
            fail('identity_prepare_replayed')
          }
          prepared = true
          if (identity.blockCommitted(machine, generation, expectedEpoch) !== undefined) {
            fail('synchronous_channel_block_required')
          }
          let failed = false
          try {
            failed = channels.blockAndClose(machine) !== undefined
          } catch {
            failed = true
          }
          if (failed) {
            fail('synchronous_channel_block_required')
          }
        }
      )
      if (
        !prepared ||
        store.generation() !== generation ||
        store.machine(machine).status !== 'pending' ||
        !identity.blockedCommitted(machine, generation, expectedEpoch)
      ) {
        fail('identity_prepare_required')
      }
      identity.finishReset(machine, generation, expectedEpoch)
    }
  }
}

export type DeviceLifecycleWiring = ReturnType<typeof createDeviceLifecycleWiring>
/** 为具体 socket 组合 persistentBackend 与真实 adapter，当前连接和原生来源均经过失效门禁。 */
export function createDeviceLifecycleAdapter(
  lifecycle: DeviceLifecycleWiring,
  channels: ChannelHost,
  services: Omit<Parameters<typeof persistentBackend>[1], 'connection'>
) {
  /** 生命周期已同步核对双库和当前 Store fence；直接复用本次结果，避免紧邻的重复持久时钟写入。 */
  const connection = () => lifecycle.connection(channels)
  const backend = {
    ...persistentBackend(lifecycle.store, {
      ...services,
      /** 每次 backend 使用均从当前 socket 及双库重新取可信连接。 */
      connection,
      nativeSource: lifecycle.nativeSource(channels, services.nativeSource)
    }),
    connection
  }
  return { backend, adapter: createLuvusWireAdapter(backend) }
}
