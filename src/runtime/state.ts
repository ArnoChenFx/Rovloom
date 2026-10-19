// 打开唯一业务 Store 和 hash-only 身份库，复用一次性证明生命周期；不代用户注册或配置真实凭据。
import { join } from 'node:path'
import { Store, DEFAULT_RETENTION } from '../store.js'
import type { StoreOptions } from '../store.js'
import { GatewayError } from '../contracts.js'
import {
  createDeviceLifecycleWiring,
  createStoreIdentityFacts,
  createStoreDeviceLedger,
  IdentityStore,
  PersistentIdentity,
  PersistentProofIdentity,
  ChannelRegistry
} from '../transport/index.js'
import type { DeviceProofHost, IdentityAuthorizer } from '../transport/index.js'
import { managedBytes, privatePath } from '../storage/files.js'

export type GatewayStateOptions = Readonly<{
  state_directory: string
  now?: () => number
  store?: Omit<StoreOptions, 'deviceLifecycle'>
  // 身份安装/轮换等真实动作须由独立管理员逐动作确认；缺失不提供默认允许。
  authorizeIdentity: IdentityAuthorizer
  // 提交后的正常断连须交给同一 Gateway，不能在重配 prepare 中重入主 Store。
  changed(machine: string): void
  // 从总安全/审计/磁盘预算保守预留独立身份库份额，不能把它视为免费第二份容量。
  identity_reservation: { security_bytes: number; audit_bytes: number; file_bytes: number }
}>

/** 本机受保护状态目录必须预先存在；正常启动不注册设备、发放凭据或解除隔离。 */
export function openGatewayState(options: GatewayStateOptions) {
  const path = join(options.state_directory, 'gateway.db')
  const identityPath = join(options.state_directory, 'identity.db')
  privatePath(path)
  const total = { ...DEFAULT_RETENTION, ...options.store?.retention }
  const reserved = { ...options.identity_reservation }
  if (
    Object.values(reserved).some(
      /** 所有预留为正安全整数，非法预算不能进入部分初始化状态。 */ (value) => !Number.isSafeInteger(value) || value < 1
    ) ||
    reserved.security_bytes >= total.security_metadata_bytes ||
    reserved.audit_bytes >= total.audit_bytes ||
    reserved.file_bytes > 8 * 1_048_576 ||
    reserved.file_bytes < 131_072 ||
    reserved.file_bytes >= total.storage_total_bytes - total.storage_reserve_bytes
  ) {
    throw new GatewayError('identity_reservation_invalid')
  }
  const now = options.now ?? Date.now
  const channels = new ChannelRegistry()
  let proof: PersistentProofIdentity | undefined
  let database: IdentityStore | undefined
  // 延迟端口只连接真实 PersistentProofIdentity；未完成初始化的所有入口均拒绝。
  const guarded: DeviceProofHost = {
    /** 凭据只能交给同一身份库的真实一次性证明工厂。 */
    verifyCredential(machine, generation, credential) {
      return required().verifyCredential(machine, generation, credential)
    },
    /** 同步一次性消费原对象，不存在测试授权或原始 Store.connect 回退。 */
    consumeProof(value, machine, generation) {
      return required().consumeProof(value, machine, generation)
    },
    /** 每次读取已提交的当前身份，不沿用启动时认证状态。 */
    usableCommitted(machine, generation) {
      return required().usableCommitted(machine, generation)
    },
    /** 精确原 hash 租期与代次均须匹配。 */
    leaseCommitted(machine, generation, digest) {
      return required().leaseCommitted(machine, generation, digest)
    },
    /** 重配先提交外部身份封锁，真实管理员确认仍由独立来源决定。 */
    blockCommitted(machine, generation, epoch) {
      return required().blockCommitted(machine, generation, epoch)
    },
    /** 仅接受独立只读连接可见的精确已提交封锁。 */
    blockedCommitted(machine, generation, epoch) {
      return required().blockedCommitted(machine, generation, epoch)
    },
    /** 业务 Store 重配成功后才收敛身份状态。 */
    finishReset(machine, generation, epoch) {
      required().finishReset(machine, generation, epoch)
    }
  }
  /** 初始化期间、来源缺失或已关闭时不构造任何成功证明。 */
  function required(): PersistentProofIdentity {
    if (!proof) {
      throw new GatewayError('identity_host_unavailable')
    }
    return proof
  }
  const lifecycle = createDeviceLifecycleWiring(
    /** 受保护 deviceLifecycle 由唯一协调器注入，普通配置不能替换证明回调。 */
    (verify) =>
      new Store(path, now, {
        ...options.store,
        deviceLifecycle: verify,
        retention: {
          ...total,
          security_metadata_bytes: total.security_metadata_bytes - reserved.security_bytes,
          audit_bytes: total.audit_bytes - reserved.audit_bytes,
          // 保守预留未来身份库增长；Store 的实际目录统计仍计入其当前字节。
          storage_total_bytes: total.storage_total_bytes - reserved.file_bytes
        }
      }),
    guarded
  )
  const store = lifecycle.store
  try {
    const facts = createStoreIdentityFacts(store)
    database = new IdentityStore(identityPath, {
      generation: store.generation(),
      now,
      guard: facts.guard,
      limits: { bytes: reserved.file_bytes },
      /** 身份事务也遵守总量与独立子额，失败不能通过扩大预算恢复。 */
      checkBudget(usage) {
        if (
          usage.security_bytes + usage.reserved_bytes > reserved.security_bytes ||
          usage.audit_bytes > reserved.audit_bytes ||
          managedBytes(options.state_directory) > total.storage_total_bytes - total.storage_reserve_bytes
        ) {
          throw new GatewayError('identity_quota')
        }
      }
    })
    proof = new PersistentProofIdentity(database, options.authorizeIdentity)
    const credentials = new PersistentIdentity(database, {
      ledger: createStoreDeviceLedger(store),
      authorize: options.authorizeIdentity,
      /** prepare 内只封锁具体通道，绝不重入 Store。 */
      block: (machine) => {
        channels.blockAndClose(machine)
      },
      changed: options.changed
    })
    let closed = false
    return {
      store,
      lifecycle,
      channels,
      credentials,
      /** 仅释放本次打开的双库，不清除凭据、崩溃锁或持久调用墓碑。 */
      close() {
        if (closed) {
          return
        }
        closed = true
        proof = undefined
        try {
          database!.close()
        } finally {
          store.close()
        }
      }
    }
  } catch (error) {
    try {
      database?.close()
    } finally {
      store.close()
    }
    throw error
  }
}
