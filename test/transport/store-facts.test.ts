// 使用真实临时 Store 验证可独立组合的事实桥，并确认缺失或伪造的生命周期扩展不会形成连接许可。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../../src/store.js'
import { createStoreDeviceLedger, createStoreIdentityFacts } from '../../src/transport/index.js'
import type { StoreIdentityBridges } from '../../src/transport/index.js'
import { fail } from '../../src/wire/index.js'
import { management } from '../storage/helpers.js'

test(
  '真实 Store 的代次、门禁、fence 和撤销可复用，缺受保护凭据证明仍拒绝',
  /** 使用真实已合并生命周期方法，确认公开事实不能代替受保护证明。 */
  () => {
    const store = new Store(':memory:', Date.now, { management })
    try {
      const facts = createStoreIdentityFacts(store)
      facts.guard()
      assert.equal(facts.generation(), store.generation())
      const machine = store.register('mock_facts')
      const device = store.redeem(store.issueEnrollment(machine.machine_id))
      const identity = {
        machine_id: machine.machine_id,
        recovery_generation: store.generation(),
        connection_epoch: store.connect(machine.machine_id, device.credential)
      }
      facts.assert(identity)
      facts.disconnect({ ...identity, connection_epoch: 'stale_epoch' })
      facts.assert(identity)
      facts.disconnect(identity)
      assert.equal(store.machine(machine.machine_id).status, 'offline')
      assert.throws(
        /** 原 epoch 已断开，独立事实桥必须使用 Store 当前连接状态拒绝旧上下文。 */
        () => facts.assert(identity),
        /connection_unavailable/
      )
      assert.throws(
        /** 已有事实及桥签名不能替代受保护认证回调。 */
        () => createStoreDeviceLedger(store).connectVerifiedDevice(machine.machine_id, store.generation()),
        /device_verification_required/
      )
      facts.revoke(machine.machine_id)
      assert.equal(store.machine(machine.machine_id).status, 'revoked')
      assert.throws(
        /** 保留 Store 自己的撤销校验，旧 mock 凭据不能重新上线。 */
        () => store.connect(machine.machine_id, device.credential),
        /invalid_device_credential/
      )
    } finally {
      store.close()
    }
  }
)

test(
  '显式扩展返回的 epoch 也须通过真实 Store 验证，缺重配实现不能假报成功',
  /** 仅用 mock 首份凭据测试扩展组合；不把此闭包当作生产轮换或重配实现。 */
  () => {
    const store = new Store(':memory:')
    try {
      const machine = store.register('mock_extension')
      const device = store.redeem(store.issueEnrollment(machine.machine_id))
      const bridges: StoreIdentityBridges = {
        /** 只用本测试新兑换的 mock 凭据建立真实 Store epoch，不持久保存原始 secret。 */
        connectVerifiedDevice(target, _generation) {
          return store.connect(target, device.credential)
        },
        /** 当前 Store 缺重配原子操作，明确拒绝而不是模拟 pending 成功。 */
        resetDeviceEnrollment() {
          fail('identity_bridge_unavailable')
        }
      }
      const ledger = createStoreDeviceLedger(store, bridges)
      assert.throws(
        /** 错恢复代次在进入扩展前拒绝，不让扩展更新真实设备连接。 */
        () => ledger.connectVerifiedDevice(machine.machine_id, 'stale_generation'),
        /connection_unavailable/
      )
      const generation = store.generation()
      const epoch = ledger.connectVerifiedDevice(machine.machine_id, generation)
      ledger.assert({ machine_id: machine.machine_id, recovery_generation: generation, connection_epoch: epoch })
      ledger.disconnect({ machine_id: machine.machine_id, recovery_generation: generation, connection_epoch: epoch })
      const fake = createStoreDeviceLedger(store, {
        ...bridges,
        /** 返回未在 Store 登记的 epoch，验证单纯提供函数不能伪造连接许可。 */
        connectVerifiedDevice: () => 'uncommitted_epoch'
      })
      assert.throws(
        /** 无实际 Store 连接锚点的成功返回值必须被事实桥再次拦截。 */
        () => fake.connectVerifiedDevice(machine.machine_id, generation),
        /connection_unavailable/
      )
      assert.throws(
        /** 真实重配接口未实现时不调用 prepare，也不能返回成功。 */
        () =>
          ledger.resetDeviceEnrollment(
            machine.machine_id,
            generation,
            null,
            /** 若缺桥分支错误调用了 prepare，测试必须立即失败。 */
            () => {
              throw new Error('unexpected_prepare')
            }
          ),
        /identity_bridge_unavailable/
      )
    } finally {
      store.close()
    }
  }
)
