// 仅为隔离通道测试提供内存租期与旧 Store custody 代理，生产入口不导出此实现。
import { randomBytes } from 'node:crypto'
import { hash, fail, id } from '../../src/wire/index.js'
import { positive } from '../../src/transport/common.js'
import type { ConnectionIdentity } from '../../src/wire/types.js'

import type { DeviceCredential, IdentityHost } from '../../src/transport/identity.js'
export type IdentityCustody = {
  /** 读取 fixture 宿主控制的恢复代次，不代表生产来源。 */
  generation(): string
  /** 只用 fixture 内存 custody 建立隔离 Store epoch，JSON 不得替换原始凭据。 */
  connect(machine: string): string
  /** 核对 fixture 当前连接 fence，避免测试跨 epoch 关联。 */
  assert(identity: ConnectionIdentity): void
  /** 只释放 fixture 当前匹配的连接状态。 */
  disconnect(identity: ConnectionIdentity): void
}
type Lease = { hash: string; expires: number }
type Device = { generation: string; leases: Lease[] }

// 有界内存租期实现，重启默认失效；生产持久事务须由独立宿主提供。
export class CredentialLifecycle implements IdentityHost {
  private readonly devices = new Map<string, Device>()
  private lastNow = 0
  /** 创建仅限测试的有界内存租期容器，并验证容量配置。 */
  constructor(
    private readonly custody: IdentityCustody,
    private readonly now = Date.now,
    private readonly capacity = 256
  ) {
    positive(capacity, 4096)
  }
  /** 维护 fixture 时间高水位，模拟回拨时拒绝身份使用。 */
  private time(): number {
    const now = this.now()
    if (!Number.isSafeInteger(now) || now < this.lastNow) {
      fail('clock_untrusted')
    }
    this.lastNow = now
    return now
  }
  /** 读取 fixture custody 的恢复代次，不生成新的设备身份。 */
  generation(): string {
    return this.custody.generation()
  }
  /** 生成仅用于隔离测试的随机租期凭据及 hash，固定其原到期时间。 */
  private issue(machine: string, ttl: number): { result: DeviceCredential; lease: Lease } {
    id(machine)
    positive(ttl, 86_400_000)
    const credential = randomBytes(32).toString('base64url')
    const expires = this.time() + ttl
    if (!Number.isSafeInteger(expires)) {
      fail('clock_untrusted')
    }
    return {
      result: { machine_id: machine, recovery_generation: this.generation(), credential },
      lease: { hash: hash(credential), expires }
    }
  }
  /** 只为尚未配对的 fixture 设备保存首份租期，容量满时拒绝。 */
  provision(machine: string, ttl = 3_600_000): DeviceCredential {
    if (this.devices.has(machine)) {
      fail('device_already_paired')
    }
    if (this.devices.size >= this.capacity) {
      fail('credential_limit')
    }
    const issued = this.issue(machine, ttl)
    this.devices.set(machine, {
      generation: issued.result.recovery_generation,
      leases: [issued.lease]
    })
    return issued.result
  }
  /** 为 fixture 模拟有界双凭据过渡，旧租期到期不会被续命。 */
  rotate(machine: string, overlapMs: number, ttl = 3_600_000): DeviceCredential {
    const device = this.devices.get(machine)
    const now = this.time()
    if (!device || device.generation !== this.generation()) {
      fail('invalid_device_credential')
    }
    positive(overlapMs, 600_000)
    device.leases = device.leases.filter(
      /** 只保留尚未到期的 fixture 租期，判断是否已有未完成轮换。 */
      (l) => l.expires > now
    )
    if (device.leases.length !== 1) {
      fail('rotation_in_progress')
    }
    const issued = this.issue(machine, ttl)
    device.leases[0]!.expires = Math.min(device.leases[0]!.expires, now + overlapMs)
    device.leases.push(issued.lease)
    return issued.result
  }
  /** 模拟显式结束轮换，移除旧过渡凭据。 */
  finishRotation(machine: string): void {
    const device = this.devices.get(machine)
    if (!device || device.leases.length !== 2) {
      fail('rotation_not_pending')
    }
    device.leases.shift()
  }
  /** 删除该 mock 设备的内存租期，供撤销对连接的影响测试。 */
  revoke(machine: string): void {
    this.devices.delete(machine)
  }
  /** 核对 fixture 代次、hash 和固定到期时间，不能凭同名机器接管。 */
  private check(machine: string, generation: string, lease: string): void {
    const now = this.time()
    const device = this.devices.get(machine)
    if (
      generation !== this.generation() ||
      device?.generation !== generation ||
      !device.leases.some(
        /** 匹配仍有效的租期摘要，避免旧凭据在边界时刻继续可用。 */
        (l) => l.hash === lease && l.expires > now
      )
    ) {
      fail('invalid_device_credential')
    }
  }
  /** 通过内存租期校验后由 fixture custody 建立真实 Store epoch。 */
  authenticate(machine: string, generation: string, credential: string) {
    const lease = hash(credential)
    this.check(machine, generation, lease)
    return {
      identity: {
        machine_id: machine,
        recovery_generation: generation,
        connection_epoch: this.custody.connect(machine)
      },
      lease
    }
  }
  /** 同时核对 fixture 租期和 Store 连接状态，模拟当前认证复验。 */
  assert(identity: ConnectionIdentity, lease: string): void {
    this.check(identity.machine_id, identity.recovery_generation, lease)
    this.custody.assert(identity)
  }
  /** 只通知 fixture custody 断开指定连接，不模拟原生回滚。 */
  disconnect(identity: ConnectionIdentity): void {
    this.custody.disconnect(identity)
  }
}
