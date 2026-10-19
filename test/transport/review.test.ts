// 回归独立审查确认的提交重入、截止时间、身份拒绝顺序与跨 revision 凭据交付边界。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPairingDelivery } from '../../src/transport/index.js'
import type { CredentialSink, DeviceCredential } from '../../src/transport/index.js'
import { hash } from '../../src/wire/index.js'
import { fixture, until } from './helpers.js'
import { realFixture } from './real-helpers.js'
import { persistentFixture } from './persistent-helpers.js'

test(
  '真实 Store 认证提交期间轮换结束，不能把任一新 hash 当作旧凭据许可',
  /** 在 proof 已消费后的真实提交钩子轮换，旧认证必须拒绝并释放它刚建立的精确 epoch。 */
  () => {
    const f = realFixture()
    try {
      const device = f.pair('mock_auth_rotation')
      const bytes = Buffer.from(device.credential.credential)
      f.beforeStoreCommit =
        /** 新 hash 仍 active，但本次证明对应的旧 hash 已失效。 */
        () => {
          f.manager.rotate(device.machine_id, 1000)
          f.manager.finishRotation(device.machine_id)
        }
      assert.throws(
        /** 经真实 Store 保护回调消费原证明，不用 mock 桥或私有 SQL。 */
        () => f.lifecycle.authenticate(device.machine_id, device.credential.recovery_generation, bytes),
        /invalid_device_credential/
      )
      assert.equal(
        bytes.every(
          /** 每个原始输入字节都必须已被清零。 */
          (byte) => byte === 0
        ),
        true
      )
      assert.equal(f.f.store.machine(device.machine_id).status, 'offline')
      assert.equal(
        f.identity.leaseCommitted(
          device.machine_id,
          device.credential.recovery_generation,
          hash(device.credential.credential)
        ),
        false
      )
    } finally {
      f.close()
    }
  }
)

test(
  'auth 注入或 accepted 编码推进到 deadline，均不能实际执行',
  { timeout: 15_000 },
  /** 用可控可信时间在两个宿主回调中到期，检查 execute 次数始终为零。 */
  async () => {
    for (const phase of ['nativeInput', 'accepted'] as const) {
      const f = fixture()
      let executed = 0
      let crossed = false
      try {
        const device = f.pair('mock_deadline_' + phase)
        const client = f.connector(
          /** 仅读取本次无生产效力 fixture 凭据。 */
          () => device.credential,
          {
            /** 在 auth 注入点推进到截止时间，模拟注入与编码所耗时间。 */
            nativeInput(input, binding) {
              if (phase === 'nativeInput') {
                crossed = true
                f.now = binding.registration.deadline
              }
              return input
            },
            /** 保留真实 adapter，仅在 accepted 编码后推进可信时间到截止边界。 */
            session(connection) {
              const current = f.session(connection)
              const encode = current.adapter.encode
              return {
                ...current,
                adapter: {
                  ...current.adapter,
                  /** accepted 的编码也可能消耗时间，真正 execute 前必须再次复验。 */
                  encode(frame, direction) {
                    const raw = encode(frame, direction)
                    if (phase === 'accepted' && frame.type === 'accepted') {
                      crossed = true
                      f.now = frame.payload.attempt.registration.deadline
                    }
                    return raw
                  }
                }
              }
            },
            /** 只计数 mock 执行；到期路径绝不应该进入这个宿主边界。 */
            async execute(raw) {
              executed++
              return { id: JSON.parse(raw).id, result: { id: 'mock' } }
            }
          }
        )
        await until(
          /** 必须先收到真实 welcome 并 ready。 */
          () => client.status().phase === 'ready'
        )
        const call = f.call(device.target)
        f.gateway.dispatch(call.call_id)
        await until(
          /** 等待到期拒绝导致真实连接关闭，不能以短暂未执行当作成功。 */
          () => crossed && f.gateway.status().connections === 0
        )
        assert.equal(executed, 0)
      } finally {
        f.stop()
      }
    }
  }
)

test(
  '真实 prepare 的独立身份授权拒绝保留原 socket、epoch 和另一设备',
  { timeout: 15_000 },
  /** 两个公开协调器都先核对身份授权，失败不能留下无 socket 的永久 online 记录。 */
  async () => {
    for (const method of ['lifecycle', 'manager'] as const) {
      const f = realFixture()
      try {
        const a = f.pair('mock_prepare_a')
        const b = f.pair('mock_prepare_b')
        const ca = f.connector(a)
        const cb = f.connector(b)
        await f.ready(ca, cb)
        const epoch = ca.status().connection_epoch!
        f.approve(a.machine_id, epoch)
        f.allowIdentity = false
        assert.throws(
          /** 精确 Store 确认已通过，只拒绝独立身份确认。 */
          () => (method === 'lifecycle' ? f.reset(a.machine_id, epoch) : f.manager.rePair(a.machine_id, epoch))
        )
        assert.equal(f.f.store.machine(a.machine_id).status, 'online')
        assert.equal(f.db.read(a.machine_id)!.status, 'active')
        assert.equal(f.f.gateway.status().connections, 2)
        assert.equal(ca.status().connection_epoch, epoch)
        f.allowIdentity = true
        const call = f.f.call(a.target)
        const other = f.f.call(b.target)
        f.f.gateway.dispatch(call.call_id)
        f.f.gateway.dispatch(other.call_id)
        await until(
          /** 被拒绝的管理操作不损坏任一设备的真实响应路径。 */
          () =>
            f.f.store.call(f.f.principal.id, call.call_id).state === 'responded' &&
            f.f.store.call(f.f.principal.id, other.call_id).state === 'responded'
        )
      } finally {
        f.close()
      }
    }
  }
)

/** 为轮换回归提供专用 mock sink，禁止意外触发 enrollment 分支。 */
function rotationDelivery(f: ReturnType<typeof persistentFixture>, sink: CredentialSink) {
  return createPairingDelivery({
    backend: {
      /** 仅返回 fixture 代次，不能建立生产身份事实。 */
      generation: () => 'mock_generation',
      /** 本组仅验证轮换，任何 enrollment 调用都是接线错误。 */
      redeem() {
        throw new Error('unused_fixture')
      }
    },
    identities: f.identity,
    /** 固定专用 mock sink，不接收业务输入决定路径或 principal。 */
    authorizeChannel: () => sink
  })
}

test(
  '轮换提交后 changed 抛错，未交付凭据和旧重叠凭据都持久拒绝',
  /** 回调故障发生在 issue 返回之前，也必须由签发方关闭已提交的新 hash。 */
  async () => {
    const f = persistentFixture()
    let deliveries = 0
    const service = rotationDelivery(f, {
      /** 未成功收敛的签发不应到达专用交付边界。 */
      async deliver(device, _signal, context) {
        deliveries++
        return { ...context, machine_id: device.machine_id, recovery_generation: device.recovery_generation }
      },
      /** mock sink 没有外部资源。 */
      close() {}
    })
    try {
      const device = f.install()
      f.failChanged = true
      await assert.rejects(service.rotate(device.machine_id, 1000), /pairing_delivery_unknown/)
      assert.equal(deliveries, 0)
      assert.equal(f.store.read(device.machine_id)!.status, 'blocked')
      f.failChanged = false
      f.restart()
      assert.throws(
        /** 旧重叠凭据不能在未知交付后继续取得许可。 */
        () => f.identity.authenticate(device.machine_id, device.recovery_generation, device.credential),
        /invalid_device_credential/
      )
    } finally {
      service.close()
      f.close()
    }
  }
)

test(
  '失败交付按精确 hash 跨 revision 拒绝，已被替换的旧清理不误封新凭据',
  /** 在 sink 内结束或再次推进轮换；失败 secret 仍存在时封锁，已完全替换时保留新许可。 */
  async () => {
    for (const position of ['current', 'previous', 'replaced'] as const) {
      const f = persistentFixture()
      const device = f.install()
      const other = f.install()
      let failed: DeviceCredential | undefined
      let fresh: DeviceCredential | undefined
      const service = rotationDelivery(f, {
        /** 在交付确认前推进 revision，再抛错模拟 custody 未完成。 */
        async deliver(credential) {
          failed = credential
          f.identity.finishRotation(device.machine_id)
          if (position !== 'current') {
            fresh = f.identity.rotate(device.machine_id, 10)
            if (position === 'replaced') {
              f.identity.finishRotation(device.machine_id)
            }
          }
          throw new Error('mock_delivery_failure')
        },
        /** mock sink 没有外部资源。 */
        close() {}
      })
      try {
        await assert.rejects(service.rotate(device.machine_id, 1000), /pairing_delivery_unknown/)
        assert.equal(f.store.read(device.machine_id)!.status, position === 'replaced' ? 'active' : 'blocked')
        f.restart()
        assert.throws(
          /** 失败交付对应的精确 secret 不能因 revision 变化重新有效。 */
          () => f.identity.authenticate(device.machine_id, device.recovery_generation, failed!.credential),
          /invalid_device_credential/
        )
        if (fresh && position === 'replaced') {
          const active = f.identity.authenticate(fresh.machine_id, fresh.recovery_generation, fresh.credential)
          f.identity.disconnect(active.identity)
        }
        const active = f.identity.authenticate(other.machine_id, other.recovery_generation, other.credential)
        f.identity.disconnect(active.identity)
      } finally {
        service.close()
        f.close()
      }
    }
  }
)

test(
  'sink 清理或修改入参不能改变失败撤销 hash 与确认代次',
  /** 专用 sink 可清零自己的输入副本；内部撤销依据和确认轴必须保持交付前的值。 */
  async () => {
    for (const outcome of ['lost', 'wrong_generation'] as const) {
      const f = persistentFixture()
      const device = f.install()
      let issued: DeviceCredential | undefined
      const service = rotationDelivery(f, {
        /** 保存原值再修改收到的入参，分别模拟 custody 清理后丢确认与错误代次确认。 */
        async deliver(credential, _signal, context) {
          issued = { ...credential }
          credential.credential = ''
          credential.recovery_generation = 'wrong_generation'
          if (outcome === 'lost') {
            throw new Error('mock_ack_lost')
          }
          return { ...context, machine_id: credential.machine_id, recovery_generation: credential.recovery_generation }
        },
        /** mock sink 没有外部资源。 */
        close() {}
      })
      try {
        await assert.rejects(service.rotate(device.machine_id, 1000), /pairing_delivery_unknown/)
        assert.equal(f.store.read(device.machine_id)!.status, 'blocked')
        assert.throws(
          /** 即使 sink 曾保存原始 secret，丢交付后也不得取得许可。 */
          () => f.identity.authenticate(issued!.machine_id, issued!.recovery_generation, issued!.credential),
          /invalid_device_credential/
        )
      } finally {
        service.close()
        f.close()
      }
    }
  }
)
