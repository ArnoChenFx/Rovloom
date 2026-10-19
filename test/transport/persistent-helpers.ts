// 提供真实临时身份 SQLite 与明确的 mock Store 桥，控制确认、期限和跨库提交故障。
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IdentityStore, PersistentIdentity } from '../../src/transport/index.js'
import type { DeviceCredential, DeviceLedger, IdentityStoreOptions } from '../../src/transport/index.js'
import type { ConnectionIdentity } from '../../src/wire/types.js'
import { fail } from '../../src/wire/index.js'

/** 建立真实临时 SQLite 与明确 mock 的 Store 桥，验证持久身份逻辑而不改共享 Store SQL。 */
export function persistentFixture(limits: IdentityStoreOptions['limits'] = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-mock-identity-'))
  const path = join(root, 'identity.sqlite')
  let now = 1000
  let generation = 'mock_generation'
  let allowed = true
  let failCommit = false
  let failLedger = false
  let failChanged = false
  let degraded = false
  let proof: string | undefined
  const devices = new Map<string, 'pending' | 'offline' | 'online' | 'revoked'>()
  const connections = new Map<string, ConnectionIdentity>()
  const ledger: DeviceLedger = {
    /** 返回 fixture 当前恢复代次，允许测试模拟恢复代次变化。 */
    generation: () => generation,
    /** 按开关模拟业务存储降级，供身份入口拒绝路径使用。 */
    guard() {
      if (degraded) {
        fail('storage_degraded')
      }
    },
    /** 在 mock 账本中拒绝撤销和重复在线设备，为允许的设备分配独立 epoch。 */
    connectVerifiedDevice(machine, gen) {
      ledger.guard()
      if (generation !== gen || !devices.has(machine) || devices.get(machine) === 'revoked') {
        fail('invalid_device_credential')
      }
      if (connections.has(machine)) {
        fail('duplicate_device_connection')
      }
      const identity = { machine_id: machine, recovery_generation: generation, connection_epoch: randomUUID() }
      devices.set(machine, 'online')
      connections.set(machine, identity)
      return identity.connection_epoch
    },
    /** 核对 mock 账本的当前 epoch 和恢复代次，不代替生产 Store 证明。 */
    assert(identity) {
      ledger.guard()
      if (
        connections.get(identity.machine_id)?.connection_epoch !== identity.connection_epoch ||
        identity.recovery_generation !== generation
      ) {
        fail('connection_unavailable')
      }
    },
    /** 只移除匹配的 mock epoch，保留撤销状态且不影响其它连接。 */
    disconnect(identity) {
      if (connections.get(identity.machine_id)?.connection_epoch === identity.connection_epoch) {
        connections.delete(identity.machine_id)
        if (devices.get(identity.machine_id) !== 'revoked') {
          devices.set(identity.machine_id, 'offline')
        }
      }
    },
    /** 先核对 mock fence，再调用同步 prepare；可在随后注入提交失败观察持久 blocked。 */
    resetDeviceEnrollment(machine, gen, expected, prepare) {
      ledger.guard()
      if (
        gen !== generation ||
        !devices.has(machine) ||
        devices.get(machine) === 'revoked' ||
        (connections.get(machine)?.connection_epoch ?? null) !== expected
      ) {
        fail('identity_fence_mismatch')
      }
      prepare()
      if (failLedger) {
        throw new Error('mock_store_commit_failure')
      }
      connections.delete(machine)
      devices.set(machine, 'pending')
    },
    /** 模拟业务撤销及其提交失败，供跨库拒绝顺序测试。 */
    revoke(machine) {
      if (failLedger) {
        throw new Error('mock_store_commit_failure')
      }
      connections.delete(machine)
      devices.set(machine, 'revoked')
    }
  }
  const options: IdentityStoreOptions = {
    generation,
    /** 把 mock 账本门禁传给真实身份库，使降级拒绝覆盖每个事务。 */
    guard: () => ledger.guard(),
    /** 为真实身份库提供可控测试时间。 */
    now: () => now,
    limits,
    /** 为该 fixture 明确分配安全/审计预算，超额时触发真实身份库拒绝。 */
    checkBudget(usage) {
      if (usage.security_bytes + usage.audit_bytes + usage.reserved_bytes > 2_000_000) {
        fail('identity_quota')
      }
    },
    /** 在身份提交前注入确定性失败，检查凭据不会被虚假返回。 */
    fault() {
      if (failCommit) {
        throw new Error('mock_identity_commit_failure')
      }
    }
  }
  let store = new IdentityStore(path, options)
  const identityOptions = {
    ledger,
    /** 按开关发出短期 mock 管理确认，可复用指定 ID 测试一次性消费。 */
    authorize() {
      if (!allowed) {
        fail('identity_forbidden')
      }
      return { actor: 'mock_admin', confirmation_id: proof ?? randomUUID(), expires_at: now + 1000 }
    },
    /** 模拟提交后资源通知故障，状态断言直接检查持久记录而非伪造 Gateway 成功。 */
    changed() {
      if (failChanged) {
        throw new Error('mock_changed_failure')
      }
    },
    /** mock 没有实际通道，重配 prepare 只测试独立身份提交且绝不写主库。 */
    block() {}
  }
  let identity = new PersistentIdentity(store, identityOptions)
  /** 生成只在本 fixture 临时目录与内存中使用的设备凭据。 */
  const credential = (machine = 'mock_' + randomUUID()): DeviceCredential => ({
    machine_id: machine,
    recovery_generation: generation,
    credential: randomBytes(32).toString('base64url')
  })
  return {
    root,
    path,
    ledger,
    options,
    devices,
    connections,
    credential,
    /** 取得当前打开的真实身份库，供限额和持久状态断言。 */
    get store() {
      return store
    },
    /** 取得当前持久身份宿主，重启后不复用旧库句柄。 */
    get identity() {
      return identity
    },
    /** 读取 fixture 可信时间，避免通过真实等待测试过期。 */
    get now() {
      return now
    },
    /** 设置测试时间以验证边界到期、回拨和重启高水位。 */
    set now(value: number) {
      now = value
    },
    /** 切换 mock 恢复代次，验证旧身份不能跨代次继续使用。 */
    set generation(value: string) {
      generation = value
    },
    /** 设置 mock 管理授权结果，检查拒绝不会更改身份状态。 */
    set allowed(value: boolean) {
      allowed = value
    },
    /** 指定或清除 mock confirmation ID，验证消费记录跨重启有效。 */
    set proof(value: string | undefined) {
      proof = value
    },
    /** 切换身份事务提交故障，验证回滚和拒绝标记。 */
    set failCommit(value: boolean) {
      failCommit = value
    },
    /** 切换业务账本阶段故障，验证跨库操作失败保持 blocked。 */
    set failLedger(value: boolean) {
      failLedger = value
    },
    /** 切换提交后通知故障，检查未交付凭据是否仍保持持久拒绝。 */
    set failChanged(value: boolean) {
      failChanged = value
    },
    /** 切换 mock Store 降级状态，验证不会借独立身份库绕过门禁。 */
    set degraded(value: boolean) {
      degraded = value
    },
    /** 登记 mock 设备后向真实身份库安装其摘要，为后续生命周期测试提供初始状态。 */
    install() {
      const device = credential()
      devices.set(device.machine_id, 'offline')
      identity.install(device)
      return device
    },
    /** 关闭并重新打开身份 SQLite，清空模拟在线连接但保留持久安全事实。 */
    restart() {
      store.close()
      connections.clear()
      store = new IdentityStore(path, options)
      identity = new PersistentIdentity(store, identityOptions)
    },
    /** 关闭当前身份库并删除本 fixture 新建的私有临时目录。 */
    close() {
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}
