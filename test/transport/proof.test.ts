// 使用真实临时身份 SQLite 验证 opaque 证明、独立提交观察、精确封锁、重启与有界容量。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { PersistentProofIdentity } from '../../src/transport/index.js'
import { hash } from '../../src/wire/index.js'
import { persistentFixture } from './persistent-helpers.js'

/** 为同一真实身份库提供独立短期 mock 确认，不另建身份状态或保存原始凭据。 */
function host(f: ReturnType<typeof persistentFixture>) {
  return new PersistentProofIdentity(
    f.store,
    /** 每次独立发出单次确认，全部仅在本次临时 fixture 内有效。 */
    () => ({ actor: 'mock_admin', confirmation_id: randomUUID(), expires_at: f.now + 1000 })
  )
}

test(
  '每次读取都推进的真实时间语义使用已提交 checkpoint，不因第二次墙钟采样误拒绝',
  /** 固定时间 fixture 会隐藏此回归；每次 now 调用递增，要求合法认证和一次性消费仍通过。 */
  () => {
    const f = persistentFixture()
    try {
      const device = f.install()
      let tick = f.now
      f.options.now =
        /** 模拟真实 fsync/查询期间不断推进的可信时钟，不依赖线程调度或阻塞等待。 */
        () => ++tick
      const identity = host(f)
      assert.equal(identity.usableCommitted(device.machine_id, device.recovery_generation), true)
      const proof = identity.verifyCredential(
        device.machine_id,
        device.recovery_generation,
        Buffer.from(device.credential)
      )
      assert.equal(identity.consumeProof(proof, device.machine_id, device.recovery_generation), true)
      assert.equal(identity.consumeProof(proof, device.machine_id, device.recovery_generation), false)
    } finally {
      f.close()
    }
  }
)

test(
  '真实身份库：证明对象一次性、不能克隆或 JSON 自证、错绑定消费后不可重试',
  /** 对真正已登记凭据签发证明，逐项检查私有注册表及全部身份绑定。 */
  () => {
    const f = persistentFixture()
    try {
      const device = f.install()
      const identity = host(f)
      const proof = identity.verifyCredential(
        device.machine_id,
        device.recovery_generation,
        Buffer.from(device.credential)
      )
      assert.equal(identity.consumeProof({ ...proof }, device.machine_id, device.recovery_generation), false)
      assert.equal(
        identity.consumeProof(JSON.parse(JSON.stringify(proof)), device.machine_id, device.recovery_generation),
        false
      )
      assert.equal(identity.consumeProof(proof, device.machine_id, device.recovery_generation), true)
      assert.equal(identity.consumeProof(proof, device.machine_id, device.recovery_generation), false)
      const wrong = identity.verifyCredential(
        device.machine_id,
        device.recovery_generation,
        Buffer.from(device.credential)
      )
      assert.equal(identity.consumeProof(wrong, 'mock_other', device.recovery_generation), false)
      assert.equal(identity.consumeProof(wrong, device.machine_id, device.recovery_generation), false)
      const expired = identity.verifyCredential(
        device.machine_id,
        device.recovery_generation,
        Buffer.from(device.credential)
      )
      f.now += 5000
      assert.equal(identity.consumeProof(expired, device.machine_id, device.recovery_generation), false)
      const rotated = identity.verifyCredential(
        device.machine_id,
        device.recovery_generation,
        Buffer.from(device.credential)
      )
      f.identity.rotate(device.machine_id, 1000)
      assert.equal(identity.consumeProof(rotated, device.machine_id, device.recovery_generation), false)
      const surviving = identity.verifyCredential(
        device.machine_id,
        device.recovery_generation,
        Buffer.from(device.credential)
      )
      f.restart()
      assert.equal(host(f).consumeProof(surviving, device.machine_id, device.recovery_generation), false)
      assert.equal(identity.consumeProof(surviving, device.machine_id, device.recovery_generation), false)
    } finally {
      f.close()
    }
  }
)

test(
  '独立租期观察持久保存到期高水位；轮换按原 socket hash 核对；离线 null fence 可区分',
  /** 只执行独立观察也不能让重启回拨恢复权限，过渡凭据和 nullable epoch 均按精确边界判断。 */
  () => {
    const f = persistentFixture()
    try {
      const device = f.install()
      const identity = host(f)
      const old = hash(device.credential)
      const rotated = f.identity.rotate(device.machine_id, 1000)
      assert.equal(identity.leaseCommitted(device.machine_id, device.recovery_generation, old), true)
      f.identity.finishRotation(device.machine_id)
      assert.equal(identity.leaseCommitted(device.machine_id, device.recovery_generation, old), false)
      assert.equal(
        identity.leaseCommitted(device.machine_id, device.recovery_generation, hash(rotated.credential)),
        true
      )
      identity.blockCommitted(device.machine_id, device.recovery_generation, null)
      assert.equal(identity.blockedCommitted(device.machine_id, device.recovery_generation, null), true)
      assert.equal(identity.blockedCommitted(device.machine_id, device.recovery_generation, 'mock_epoch'), false)
      const other = f.install()
      f.now += 24 * 3_600_000
      assert.equal(identity.usableCommitted(other.machine_id, other.recovery_generation), false)
      f.now = 1000
      f.restart()
      assert.equal(host(f).usableCommitted(other.machine_id, other.recovery_generation), false)
    } finally {
      f.close()
    }
  }
)

test(
  '真实身份库：独立连接看不到未提交 blocked，精确 fence 持久且不含凭据原文',
  /** 在 writer 提交钩子里从独立只读连接查询，避免内存标志或未提交行冒充封锁。 */
  () => {
    const f = persistentFixture()
    try {
      const device = f.install()
      const identity = host(f)
      let observed = false
      f.options.fault =
        /** 本事务已暂存 blocked，但独立快照仍须看到上次提交的 active 行。 */
        () => {
          observed = true
          assert.equal(identity.blockedCommitted(device.machine_id, device.recovery_generation, 'mock_epoch'), false)
          assert.equal(identity.usableCommitted(device.machine_id, device.recovery_generation), true)
        }
      identity.blockCommitted(device.machine_id, device.recovery_generation, 'mock_epoch')
      f.options.fault = undefined
      assert.equal(observed, true)
      assert.equal(identity.blockedCommitted(device.machine_id, device.recovery_generation, 'mock_epoch'), true)
      assert.equal(identity.blockedCommitted(device.machine_id, device.recovery_generation, null), false)
      assert.equal(identity.blockedCommitted(device.machine_id, 'old_generation', 'mock_epoch'), false)
      assert.equal(identity.blockedCommitted(device.machine_id, device.recovery_generation, 'other_epoch'), false)
      assert.equal(identity.usableCommitted(device.machine_id, device.recovery_generation), false)
      assert.equal(readFileSync(f.path).includes(Buffer.from(device.credential)), false)
      f.restart()
      const restarted = host(f)
      assert.equal(restarted.blockedCommitted(device.machine_id, device.recovery_generation, 'mock_epoch'), true)
      assert.throws(
        /** blocked 不能凭原始凭据签发新证明。 */
        () => restarted.verifyCredential(device.machine_id, device.recovery_generation, Buffer.from(device.credential)),
        /invalid_device_credential/
      )
      assert.throws(
        /** 错 epoch 不能把既有封锁收敛为 pending。 */
        () => restarted.finishReset(device.machine_id, device.recovery_generation, null),
        /identity_fence_mismatch/
      )
      restarted.finishReset(device.machine_id, device.recovery_generation, 'mock_epoch')
      assert.equal(f.store.read(device.machine_id)!.status, 'pending')
      assert.equal(restarted.blockedCommitted(device.machine_id, device.recovery_generation, 'mock_epoch'), false)
    } finally {
      f.close()
    }
  }
)

test(
  '真实身份库：证明容量不提前淘汰、固定过期后释放、撤销或回拨使旧证明不可用',
  /** 验证证明注册表的严格上限与持久身份的当前期限，不能用证明绕过安全状态。 */
  () => {
    const f = persistentFixture()
    try {
      const device = f.install()
      const identity = host(f)
      const proofs = []
      for (let index = 0; index < 128; index++) {
        proofs.push(
          identity.verifyCredential(device.machine_id, device.recovery_generation, Buffer.from(device.credential))
        )
      }
      assert.throws(
        /** 满容量不能驱逐仍有效的证明来接纳更多工作。 */
        () => identity.verifyCredential(device.machine_id, device.recovery_generation, Buffer.from(device.credential)),
        /identity_proof_quota/
      )
      assert.equal(identity.consumeProof(proofs[0]!, device.machine_id, device.recovery_generation), true)
      f.now += 5000
      const current = identity.verifyCredential(
        device.machine_id,
        device.recovery_generation,
        Buffer.from(device.credential)
      )
      assert.equal(identity.consumeProof(proofs[1]!, device.machine_id, device.recovery_generation), false)
      f.identity.revoke(device.machine_id)
      assert.equal(identity.consumeProof(current, device.machine_id, device.recovery_generation), false)
      f.now--
      assert.equal(identity.usableCommitted(device.machine_id, device.recovery_generation), false)
    } finally {
      f.close()
    }
  }
)

test(
  '独立身份观察只执行一次当前 guard，writer 重入仍执行 guard 且只看已提交状态',
  /** 门禁计数仅限本测试实例；拒绝、重入和重启回拨不能因去重失去原来的封锁边界。 */
  () => {
    const f = persistentFixture()
    try {
      const device = f.install()
      const guard = f.options.guard
      let guards = 0
      f.options.guard = /** 保留真实 fixture 门禁，只记录此次实际观察次数。 */ () => {
        guards++
        return guard()
      }
      const identity = host(f)
      assert.equal(identity.usableCommitted(device.machine_id, device.recovery_generation), true)
      assert.equal(guards, 1)
      f.options.fault = /** writer 已暂存 blocked，独立连接仍须观察原 active 行并执行当前门禁。 */ () => {
        guards = 0
        assert.equal(identity.usableCommitted(device.machine_id, device.recovery_generation), true)
        assert.equal(guards, 1)
      }
      identity.blockCommitted(device.machine_id, device.recovery_generation, null)
      f.options.fault = undefined
      assert.equal(identity.usableCommitted(device.machine_id, device.recovery_generation), false)
      f.degraded = true
      assert.throws(
        /** 入口 guard 原来向调用者抛出的错误仍须直接传播，不能被读取 catch 吞掉。 */ () =>
          f.store.committed(device.machine_id, device.recovery_generation),
        /storage_degraded/
      )
    } finally {
      f.close()
    }
  }
)
