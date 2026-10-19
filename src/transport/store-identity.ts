// 组合现有 Store 的独立可信事实；完整身份账本只有在生命周期能力齐备时才可构造。
import type { Store } from '../store.js'
import { fail } from '../wire/index.js'
import type { DeviceLedger } from './persistent-identity.js'

export type StoreIdentityFacts = Pick<DeviceLedger, 'generation' | 'guard' | 'assert' | 'disconnect' | 'revoke'>
export type StoreIdentityBridges = Pick<DeviceLedger, 'connectVerifiedDevice' | 'resetDeviceEnrollment'>
export type IdentityLifecycleStore = Store & StoreIdentityBridges

/** 独立复用当前 Store 已有的门禁、代次和连接管理事实；不签发认证许可或伪造缺失能力。 */
export function createStoreIdentityFacts(store: Store): StoreIdentityFacts {
  return {
    /** 从业务账本读取当前恢复代次，作为身份核对的独立来源。 */
    generation: () => store.generation(),
    /** 要求 Store 处于 active 并推进可信时间检查，降级或隔离时拒绝认证。 */
    guard() {
      const health = store.health()
      if (health.mode !== 'active') {
        fail(health.mode)
      }
      store.clock()
    },
    /** 用 Store 当前状态校验完整连接 fence，不接受输入中的 authenticated 自证。 */
    assert: (identity) => store.assertConnection(identity),
    /** 只断开匹配的设备 epoch，使可能已派发的调用保持保守状态。 */
    disconnect: (identity) => store.disconnect(identity.machine_id, identity.connection_epoch),
    /** 使用 Store 的独立持久撤销入口，保留其管理权限和审计。 */
    revoke: (machine) => store.revoke(machine)
  }
}

/** 由已具备公开生命周期方法的 Store 直接构造完整账本，缺任一能力均拒绝。 */
export function createStoreDeviceLedger(store: IdentityLifecycleStore): DeviceLedger
/** 组合明确注入的受信生命周期扩展；扩展仍须满足 Store 原子提交及确认契约。 */
export function createStoreDeviceLedger(store: Store, bridges: StoreIdentityBridges): DeviceLedger
/** 保留缺桥时的构造拒绝，并对返回 epoch 使用真实 Store 再验证，不能用占位成功骗过连接门禁。 */
export function createStoreDeviceLedger(store: Store, bridges?: StoreIdentityBridges): DeviceLedger {
  const lifecycle: Partial<StoreIdentityBridges> = bridges ?? (store as IdentityLifecycleStore)
  const connect = lifecycle.connectVerifiedDevice
  const reset = lifecycle.resetDeviceEnrollment
  if (typeof connect !== 'function' || typeof reset !== 'function') {
    fail('identity_bridge_unavailable')
  }
  const facts = createStoreIdentityFacts(store)
  return {
    ...facts,
    /** 独立 hash 校验之后调用受信扩展，再核对真实 Store 已提交的连接 fence。 */
    connectVerifiedDevice(machine, generation) {
      facts.guard()
      if (generation !== facts.generation()) {
        fail('connection_unavailable')
      }
      const epoch = connect.call(lifecycle, machine, generation)
      facts.assert({ machine_id: machine, recovery_generation: generation, connection_epoch: epoch })
      return epoch
    },
    /** 先核对当前 Store 门禁和代次；精确 fence、确认及同步 prepare 仍须在扩展事务内执行。 */
    resetDeviceEnrollment(machine, generation, epoch, prepare) {
      facts.guard()
      if (generation !== facts.generation()) {
        fail('connection_unavailable')
      }
      reset.call(lifecycle, machine, generation, epoch, prepare)
    }
  }
}
