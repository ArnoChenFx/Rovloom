// 验证持久凭据、管理确认、同 ID 重配及崩溃拒绝，严格区分 mock 桥与生产联动。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { IdentityStore, PairingAdmin, createStoreDeviceLedger } from '../../src/transport/index.js'
import { Store } from '../../src/store.js'
import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { persistentFixture } from './persistent-helpers.js'

test(
  'hash-only 身份跨正常重启稳定，轮换双凭据、结束与撤销事实均持久',
  /** 跨真实 SQLite 重开检查双凭据、结束轮换及撤销事实，并扫描文件无凭据原文。 */
  () => {
    const f = persistentFixture()
    try {
      const old = f.install()
      const active = f.identity.authenticate(old.machine_id, old.recovery_generation, old.credential)
      const next = f.identity.rotate(old.machine_id, 20, 100)
      f.identity.assert(active.identity, active.lease)
      assert.throws(
        /** 在旧双凭据过渡尚未结束时再次轮换，确认有效凭据始终最多两份。 */
        () => f.identity.rotate(old.machine_id, 20),
        /rotation_in_progress/
      )
      f.restart()
      const resumed = f.identity.authenticate(old.machine_id, old.recovery_generation, old.credential)
      assert.notEqual(resumed.identity.connection_epoch, active.identity.connection_epoch)
      f.identity.disconnect(resumed.identity)
      const changed = f.identity.authenticate(next.machine_id, next.recovery_generation, next.credential)
      f.identity.finishRotation(old.machine_id)
      f.restart()
      assert.throws(
        /** 尝试使用失效、错绑定或旧代次的凭据，确认不能取得认证或租期许可。 */
        () => f.identity.authenticate(old.machine_id, old.recovery_generation, old.credential),
        /invalid_device_credential/
      )
      const current = f.identity.authenticate(next.machine_id, next.recovery_generation, next.credential)
      assert.notEqual(current.identity.connection_epoch, changed.identity.connection_epoch)
      f.identity.revoke(old.machine_id)
      f.restart()
      assert.throws(
        /** 尝试使用失效、错绑定或旧代次的凭据，确认不能取得认证或租期许可。 */
        () => f.identity.authenticate(next.machine_id, next.recovery_generation, next.credential),
        /invalid_device_credential/
      )
      assert.equal(f.store.read(old.machine_id)!.status, 'revoked')
      const bytes = Buffer.concat(
        readdirSync(f.root).map(
          /** 读取本 fixture 创建的文件字节，检查 Gateway 身份持久化只含 hash。 */
          (name) => readFileSync(join(f.root, name))
        )
      )
      assert.equal(bytes.includes(Buffer.from(old.credential)), false)
      assert.equal(bytes.includes(Buffer.from(next.credential)), false)
    } finally {
      f.close()
    }
  }
)

test(
  '到期认证拒绝也持久保存时间高水位，回拨和恢复代次不复活旧凭据',
  /** 在过期认证拒绝后重开数据库并回拨时间，断言旧凭据和旧代次均不复活。 */
  () => {
    const f = persistentFixture()
    try {
      const device = f.credential()
      f.devices.set(device.machine_id, 'offline')
      f.identity.install(device, 10)
      f.now += 10
      assert.throws(
        /** 尝试使用失效、错绑定或旧代次的凭据，确认不能取得认证或租期许可。 */
        () => f.identity.authenticate(device.machine_id, device.recovery_generation, device.credential),
        /invalid_device_credential/
      )
      f.restart()
      f.now -= 1
      assert.throws(
        /** 在可信时间回拨后使用身份，确认过期或旧租期不会复活。 */
        () => f.identity.authenticate(device.machine_id, device.recovery_generation, device.credential),
        /clock_untrusted/
      )
      f.now += 2
      f.restart()
      assert.throws(
        /** 触发身份配额或持久化降级后的操作，确认不会返回可用身份许可。 */
        () => f.identity.authenticate(device.machine_id, device.recovery_generation, device.credential),
        /identity_unavailable/
      )
      f.generation = 'new_generation'
      assert.throws(
        /** 切换恢复代次后使用旧身份，确认不会从旧记录重建当前授权。 */
        () => f.identity.authenticate(device.machine_id, device.recovery_generation, device.credential),
        /identity_recovery_required/
      )
    } finally {
      f.close()
    }
  }
)

test(
  '同 ID 重配须独立确认和精确 epoch，旧快照无副作用，失败后 blocked 跨重启保留',
  /** 分别拒绝未授权和过期 fence，再在跨库阶段故障后验证 blocked 持久保留及明确重配。 */
  () => {
    const f = persistentFixture()
    try {
      const old = f.install()
      const active = f.identity.authenticate(old.machine_id, old.recovery_generation, old.credential)
      const revision = f.store.read(old.machine_id)!.revision
      f.allowed = false
      assert.throws(
        /** 执行无法完成的重配请求，确认错误不会伪装成已生效的授权。 */
        () => f.identity.rePair(old.machine_id, active.identity.connection_epoch),
        /identity_change_incomplete/
      )
      assert.equal(f.store.read(old.machine_id)!.revision, revision)
      f.allowed = true
      assert.throws(
        /** 执行无法完成的重配请求，确认错误不会伪装成已生效的授权。 */
        () => f.identity.rePair(old.machine_id, 'stale_epoch'),
        /identity_change_incomplete/
      )
      f.identity.assert(active.identity, active.lease)
      f.failLedger = true
      assert.throws(
        /** 执行无法完成的重配请求，确认错误不会伪装成已生效的授权。 */
        () => f.identity.rePair(old.machine_id, active.identity.connection_epoch),
        /identity_change_incomplete/
      )
      assert.equal(f.store.read(old.machine_id)!.status, 'blocked')
      f.restart()
      assert.throws(
        /** 尝试使用失效、错绑定或旧代次的凭据，确认不能取得认证或租期许可。 */
        () => f.identity.authenticate(old.machine_id, old.recovery_generation, old.credential),
        /invalid_device_credential/
      )
      f.failLedger = false
      f.identity.rePair(old.machine_id, null)
      const fresh = f.credential(old.machine_id)
      f.identity.install(fresh)
      assert.equal(
        f.identity.authenticate(fresh.machine_id, fresh.recovery_generation, fresh.credential).identity.machine_id,
        old.machine_id
      )
      assert.throws(
        /** 尝试使用失效、错绑定或旧代次的凭据，确认不能取得认证或租期许可。 */
        () => f.identity.authenticate(old.machine_id, old.recovery_generation, old.credential),
        /invalid_device_credential/
      )
    } finally {
      f.close()
    }
  }
)

test(
  '管理确认一次性持久消费，默认复制凭据不能抢连接，显式 takeover 隔离旧 epoch',
  /** 检查复制凭据不能抢连接，明确接管更换凭据与 epoch，确认消费跨重启保持唯一。 */
  () => {
    const f = persistentFixture()
    try {
      const device = f.install()
      const original = f.identity.authenticate(device.machine_id, device.recovery_generation, device.credential)
      assert.throws(
        /** 复制当前设备凭据再次连接，确认已有 epoch 保持独占。 */
        () => f.identity.authenticate(device.machine_id, device.recovery_generation, device.credential),
        /duplicate_device_connection/
      )
      f.proof = 'one_confirmation'
      const replacement = f.identity.takeover(original.identity)
      assert.throws(
        /** 尝试使用失效、错绑定或旧代次的凭据，确认不能取得认证或租期许可。 */
        () => f.identity.assert(original.identity, original.lease),
        /invalid_device_credential/
      )
      f.restart()
      assert.throws(
        /** 重复使用已消费的确认 ID，确认不能产生第二次安全变更。 */
        () => f.identity.rotate(device.machine_id, 20),
        /identity_confirmation_replayed/
      )
      f.proof = undefined
      assert.throws(
        /** 尝试使用失效、错绑定或旧代次的凭据，确认不能取得认证或租期许可。 */
        () => f.identity.authenticate(device.machine_id, device.recovery_generation, device.credential),
        /invalid_device_credential/
      )
      const current = f.identity.authenticate(
        replacement.machine_id,
        replacement.recovery_generation,
        replacement.credential
      )
      assert.notEqual(current.identity.connection_epoch, original.identity.connection_epoch)
    } finally {
      f.close()
    }
  }
)

test(
  '预算/提交失败不返回可用凭据；降级和崩溃锁不被绕过',
  /** 分别耗尽设备预算与注入提交故障，断言不返回可用凭据且拒绝状态跨重启保持。 */
  () => {
    const f = persistentFixture({ devices: 1 })
    try {
      const device = f.install()
      assert.throws(
        /** 再次打开同一身份库，确认独占锁阻止第二个 writer。 */
        () => new IdentityStore(f.path, f.options),
        /EEXIST/
      )
      const second = f.credential()
      f.devices.set(second.machine_id, 'offline')
      assert.throws(
        /** 触发身份配额或持久化降级后的操作，确认不会返回可用身份许可。 */
        () => f.identity.install(second),
        /identity_unavailable/
      )
      f.restart()
      assert.throws(
        /** 触发身份配额或持久化降级后的操作，确认不会返回可用身份许可。 */
        () => f.identity.authenticate(device.machine_id, device.recovery_generation, device.credential),
        /identity_unavailable/
      )
    } finally {
      f.close()
    }
    const fault = persistentFixture()
    try {
      const device = fault.install()
      fault.failCommit = true
      assert.throws(
        /** 触发身份配额或持久化降级后的操作，确认不会返回可用身份许可。 */
        () => fault.identity.rotate(device.machine_id, 10),
        /identity_unavailable/
      )
      fault.failCommit = false
      fault.restart()
      assert.throws(
        /** 触发身份配额或持久化降级后的操作，确认不会返回可用身份许可。 */
        () => fault.identity.authenticate(device.machine_id, device.recovery_generation, device.credential),
        /identity_unavailable/
      )
    } finally {
      fault.close()
    }
  }
)

test(
  '真实子进程在身份 prepare 提交后退出，blocked 和 writer 锁保留且不能自动恢复',
  /** 让真实子进程在 prepare 提交后退出，检查 blocked 与独占锁都不会被自动清除。 */
  () => {
    const f = persistentFixture()
    const path = join(f.root, 'crashed.sqlite')
    try {
      const child = spawnSync(
        process.execPath,
        ['--no-env-file', fileURLToPath(new URL('./persistent-crash-fixture.ts', import.meta.url)), path],
        { encoding: 'utf8', timeout: 10_000 }
      )
      assert.equal(child.status, 77)
      assert.equal(child.stdout + child.stderr, '')
      const inspect = new DatabaseSync(path)
      try {
        assert.equal(inspect.prepare('SELECT status FROM device_credentials').get()!.status, 'blocked')
      } finally {
        inspect.close()
      }
      assert.throws(
        /** 再次打开同一身份库，确认独占锁阻止第二个 writer。 */
        () => new IdentityStore(path, { ...f.options, generation: 'mock_crash' }),
        /EEXIST/
      )
    } finally {
      f.close()
    }
  }
)

test(
  '首次交付中断后的同 ID 修复仍需授权；真实 Store 缺独立证明时不建立连接',
  /** 修复孤立身份仍须授权，真实已合并桥也必须要求受保护证明和管理回调。 */
  () => {
    const f = persistentFixture()
    const store = new Store(':memory:')
    try {
      const orphan = f.credential()
      f.devices.set(orphan.machine_id, 'offline')
      f.allowed = false
      assert.throws(
        /** 执行无法完成的重配请求，确认错误不会伪装成已生效的授权。 */
        () => f.identity.rePair(orphan.machine_id, null),
        /identity_change_incomplete/
      )
      assert.equal(f.store.read(orphan.machine_id), undefined)
      f.allowed = true
      f.identity.rePair(orphan.machine_id, null)
      const fresh = f.credential(orphan.machine_id)
      f.identity.install(fresh)
      assert.equal(
        f.identity.authenticate(fresh.machine_id, fresh.recovery_generation, fresh.credential).identity.machine_id,
        orphan.machine_id
      )
      const unverified = store.register('mock_unverified')
      store.redeem(store.issueEnrollment(unverified.machine_id))
      assert.throws(
        /** 已配对离线设备仍不能跳过独立证明，仅有真实桥方法不足以建立许可。 */
        () => createStoreDeviceLedger(store).connectVerifiedDevice(unverified.machine_id, store.generation()),
        /device_verification_required/
      )
      const denied = new PairingAdmin(store, {
        /** 模拟错误地返回 false 的管理员回调，验证不能被误当作授权成功。 */
        authorize: () => false
      })
      assert.throws(
        /** 使用错误的管理员回调结果，确认注册或 enrollment 在副作用前拒绝。 */
        () => denied.register('mock_admin'),
        /pairing_admin_forbidden/
      )
      const admin = new PairingAdmin(store, {
        /** 仅为相邻对照提供无副作用的 mock 管理放行，生产身份服务不使用此回调。 */
        authorize() {}
      })
      const machine = admin.register('mock_admin')
      assert.throws(
        /** 使用错误的管理员回调结果，确认注册或 enrollment 在副作用前拒绝。 */
        () => denied.issue(machine.machine_id),
        /pairing_admin_forbidden/
      )
      assert(admin.issue(machine.machine_id).length >= 32)
    } finally {
      store.close()
      f.close()
    }
  }
)
