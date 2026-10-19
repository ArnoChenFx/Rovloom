// 验证专用凭据交付的真实一次性消费、准确确认、超时回收与失败后的持久拒绝。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../../src/store.js'
import { createPairingDelivery, createFileCredentialSink, loadCredential } from '../../src/transport/index.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DeviceCredential } from '../../src/transport/index.js'
import { management } from '../storage/helpers.js'
import { persistentFixture } from './persistent-helpers.js'

test(
  '专用配对交付复用真实 Store 一次消费，普通 receipt 不含 secret，交付前已提交 hash',
  /** 组合真实 enrollment 消费和持久 hash 提交，断言普通 receipt 不包含交付的凭据。 */
  async () => {
    const f = persistentFixture()
    const store = new Store(
      ':memory:',
      /** 提供测试控制的可信时间，不推进真实设备或账号期限。 */
      () => f.now,
      {
        management
      }
    )
    let received: DeviceCredential | undefined
    const delivery = createPairingDelivery({
      backend: {
        /** 复用真实 Store 的一次性兑换事务，不在测试中仿造消费结果。 */
        redeem: (token) => store.redeem(token),
        /** 提供当前 fixture 专用恢复代次，不作为生产账本来源。 */
        generation: () => 'mock_generation'
      },
      identities: f.identity,
      /** 为准确注册目标创建无外部资源的 mock 专用 sink，保留独立渠道授权边界。 */
      authorizeChannel: ({ machine_id }) => ({
        /** 在模拟交付前断言身份 hash 已提交，并返回与本次 delivery 完全匹配的确认。 */
        async deliver(device, _signal, context) {
          assert.equal(device.machine_id, machine_id)
          assert.equal(f.store.read(machine_id)!.status, 'active')
          received = device
          return { ...context, machine_id: device.machine_id, recovery_generation: device.recovery_generation }
        },
        /** 提供没有外部句柄的 mock sink 关闭接口，不清理其它测试资源。 */
        close() {}
      })
    })
    try {
      const machine = store.register('mock')
      const token = store.issueEnrollment(machine.machine_id)
      f.devices.set(machine.machine_id, 'offline')
      const receipt = await delivery.redeem({ registration_id: machine.machine_id, enrollment: token })
      assert.equal(receipt.state, 'delivered')
      assert.equal(JSON.stringify(receipt).includes(received!.credential), false)
      assert.equal(JSON.stringify(receipt).includes(token), false)
      await assert.rejects(
        delivery.redeem({ registration_id: machine.machine_id, enrollment: token }),
        /pairing_delivery_unknown/
      )
      assert.equal(
        f.identity.authenticate(received!.machine_id, received!.recovery_generation, received!.credential).identity
          .machine_id,
        machine.machine_id
      )
    } finally {
      delivery.close()
      store.close()
      f.close()
    }
  }
)

test(
  '专用渠道拒绝发生于消费前；交付失败持久拒绝凭据，不自动重发',
  /** 分别注入渠道拒绝与发送失败，断言消费顺序、持久拒绝和禁止自动重发。 */
  async () => {
    const f = persistentFixture()
    const store = new Store(
      ':memory:',
      /** 提供测试控制的可信时间，不推进真实设备或账号期限。 */
      () => f.now,
      {
        management
      }
    )
    const machine = store.register('mock')
    const token = store.issueEnrollment(machine.machine_id)
    f.devices.set(machine.machine_id, 'offline')
    let allow = false
    let leaked: DeviceCredential | undefined
    let sends = 0
    const delivery = createPairingDelivery({
      backend: {
        /** 复用真实 Store 的一次性兑换事务，不在测试中仿造消费结果。 */
        redeem: (secret) => store.redeem(secret),
        /** 提供当前 fixture 专用恢复代次，不作为生产账本来源。 */
        generation: () => 'mock_generation'
      },
      identities: f.identity,
      /** 在消费前按测试开关拒绝渠道，放行后提供可注入失败的专用 sink。 */
      authorizeChannel() {
        if (!allow) {
          throw new Error('mock_channel_denied')
        }
        return {
          /** 记录一次模拟发送并抛出失败，验证凭据失效而不是自动重发。 */
          async deliver(device) {
            sends++
            leaked = device
            throw new Error('mock_sink_failure')
          },
          /** 提供没有外部句柄的 mock sink 关闭接口，不清理其它测试资源。 */
          close() {}
        }
      }
    })
    try {
      await assert.rejects(
        delivery.redeem({ registration_id: machine.machine_id, enrollment: token }),
        /pairing_channel_forbidden/
      )
      assert.equal(store.machine(machine.machine_id).status, 'pending')
      allow = true
      await assert.rejects(
        delivery.redeem({ registration_id: machine.machine_id, enrollment: token }),
        /pairing_delivery_unknown/
      )
      assert.equal(f.store.read(machine.machine_id)!.status, 'blocked')
      f.restart()
      assert.throws(
        /** 尝试使用失效、错绑定或旧代次的凭据，确认不能取得认证或租期许可。 */
        () => f.identity.authenticate(leaked!.machine_id, leaked!.recovery_generation, leaked!.credential),
        /invalid_device_credential/
      )
      await assert.rejects(
        delivery.redeem({ registration_id: machine.machine_id, enrollment: token }),
        /pairing_delivery_unknown/
      )
      assert.equal(sends, 1)
    } finally {
      delivery.close()
      store.close()
      f.close()
    }
  }
)

test(
  '交付超时关闭专用 sink；忽略 abort 的发送仍占额度直到真正结束',
  /** 让专用发送忽略中止并超时，断言关闭和并发额度一直保留到其真实完成。 */
  async () => {
    const f = persistentFixture()
    const store = new Store(
      ':memory:',
      /** 提供测试控制的可信时间，不推进真实设备或账号期限。 */
      () => f.now,
      {
        management
      }
    )
    let finish: (() => void) | undefined
    let closed = 0
    const delivery = createPairingDelivery({
      backend: {
        /** 复用真实 Store 的一次性兑换事务，不在测试中仿造消费结果。 */
        redeem: (token) => store.redeem(token),
        /** 提供当前 fixture 专用恢复代次，不作为生产账本来源。 */
        generation: () => 'mock_generation'
      },
      identities: f.identity,
      timeout_ms: 10,
      concurrency: 1,
      /** 创建可由测试显式结束的阻塞 sink，以模拟不响应 abort 的宿主发送。 */
      authorizeChannel: () => ({
        /** 保留模拟交付 Promise，只有测试调用完成入口后才给出准确确认。 */
        deliver: (device, _signal, context) =>
          new Promise(
            /** 保存交付完成入口，并把预期身份与 delivery 关联固定在最终确认中。 */
            (resolve) => {
              finish =
                /** 显式完成阻塞的 mock 发送，回显该交付的全部关联轴。 */
                () =>
                  resolve({
                    ...context,
                    machine_id: device.machine_id,
                    recovery_generation: device.recovery_generation
                  })
            }
          ),
        /** 统计关闭请求次数，确认超时确实传播到专用 sink。 */
        close() {
          closed++
        }
      })
    })
    try {
      const machine = store.register('mock')
      const token = store.issueEnrollment(machine.machine_id)
      f.devices.set(machine.machine_id, 'offline')
      await assert.rejects(
        delivery.redeem({ registration_id: machine.machine_id, enrollment: token }),
        /pairing_delivery_unknown/
      )
      assert(closed > 0)
      assert.equal(delivery.status().pending, 1)
      await assert.rejects(
        delivery.redeem({ registration_id: machine.machine_id, enrollment: token }),
        /pairing_unavailable/
      )
      finish!()
      await new Promise(
        /** 短暂让出事件循环推进关闭或异步状态，不改变业务执行期限。 */
        (resolve) => setTimeout(resolve, 0)
      )
      assert.equal(delivery.status().pending, 0)
      assert.equal(f.store.read(machine.machine_id)!.status, 'blocked')
    } finally {
      delivery.close()
      store.close()
      f.close()
    }
  }
)

test(
  '轮换只经绑定身份的一次性文件 sink 交付，普通返回只含 receipt',
  /** 将新轮换凭据交给固定身份的受限文件，重启后验证有效性且普通返回仍不含 secret。 */
  async () => {
    const f = persistentFixture()
    const root = mkdtempSync(join(tmpdir(), 'rovloom-mock-connector-custody-'))
    const device = f.install()
    const path = join(root, 'credential.json')
    const operations: string[] = []
    const service = createPairingDelivery({
      backend: {
        /** 提供当前 fixture 专用恢复代次，不作为生产账本来源。 */
        generation: () => 'mock_generation',
        /** 阻止轮换测试意外调用 enrollment 兑换，保证测试只覆盖预期交付分支。 */
        redeem() {
          throw new Error('unused_fixture')
        }
      },
      identities: f.identity,
      /** 记录专用操作类型，并为固定设备创建真实受限文件 sink。 */
      authorizeChannel(context) {
        operations.push(context.operation)
        return createFileCredentialSink(path, {
          machine_id: device.machine_id,
          recovery_generation: device.recovery_generation
        })
      }
    })
    try {
      const receipt = await service.rotate(device.machine_id, 10)
      const credential = loadCredential(path)
      assert.deepEqual(operations, ['rotate'])
      assert.equal(receipt.state, 'delivered')
      assert.equal(JSON.stringify(receipt).includes(credential.credential), false)
      assert.notEqual(credential.credential, device.credential)
      f.restart()
      const active = f.identity.authenticate(
        credential.machine_id,
        credential.recovery_generation,
        credential.credential
      )
      f.identity.disconnect(active.identity)
      const sink = createFileCredentialSink(join(root, 'wrong.json'), {
        machine_id: 'another_machine',
        recovery_generation: device.recovery_generation
      })
      await assert.rejects(
        sink.deliver(credential, new AbortController().signal, { delivery_id: 'mock_delivery', revision: 1 }),
        /credential_sink_mismatch/
      )
      sink.close()
    } finally {
      service.close()
      f.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  '错误交付确认不能冒充完成，delivery/目标/代次/revision 均独立核对',
  /** 分别破坏四个交付关联轴，断言错误确认均导致对应凭据持久拒绝。 */
  async () => {
    for (const field of ['delivery_id', 'revision', 'machine_id', 'recovery_generation'] as const) {
      const f = persistentFixture()
      const device = f.install()
      const service = createPairingDelivery({
        backend: {
          /** 提供当前 fixture 专用恢复代次，不作为生产账本来源。 */
          generation: () => 'mock_generation',
          /** 阻止确认绑定负例意外使用 enrollment 分支。 */
          redeem() {
            throw new Error('unused_fixture')
          }
        },
        identities: f.identity,
        /** 为每个关联轴负例创建只会返回错误确认的 mock sink。 */
        authorizeChannel: () => ({
          /** 只破坏当前选定的确认字段，验证每个关联轴都独立受检。 */
          async deliver(credential, _signal, context) {
            return {
              ...context,
              machine_id: credential.machine_id,
              recovery_generation: credential.recovery_generation,
              [field]: field === 'revision' ? context.revision - 1 : 'wrong_binding'
            }
          },
          /** 提供没有外部句柄的 mock sink 关闭接口，不清理其它测试资源。 */
          close() {}
        })
      })
      try {
        await assert.rejects(service.rotate(device.machine_id, 10), /pairing_delivery_unknown/)
        assert.equal(f.store.read(device.machine_id)!.status, 'blocked')
        f.restart()
        assert.throws(
          /** 尝试使用失效、错绑定或旧代次的凭据，确认不能取得认证或租期许可。 */
          () => f.identity.authenticate(device.machine_id, device.recovery_generation, device.credential),
          /invalid_device_credential/
        )
      } finally {
        service.close()
        f.close()
      }
    }
  }
)
