// 仅为隔离测试组合真实 Store 配对与内存租期，模拟独立管理员及旧接口接线。
import type { Store } from '../../src/store.js'
import { fail } from '../../src/wire/index.js'
import { CredentialLifecycle } from './memory-identity.js'

export type ManagementAction = 'register' | 'enroll' | 'redeem' | 'rotate' | 'revoke' | 'takeover'
export type ManagementHost = {
  /** 模拟独立管理员允许或拒绝，不能作为生产管理授权。 */
  authorize(action: ManagementAction, machine?: string): void
  /** 仅在测试进程内保存兑换凭据，不导出到生产入口。 */
  installCanonical(machine: string, credential: string): void
}

// 进程内受保护接口；不注册 HTTP/MCP 路由，也不通过 Wire welcome 交付秘密。
export class PairingAdmin {
  /** 绑定测试 Store、内存租期和 mock 管理员，保留旧 Store 接口的隔离接线。 */
  constructor(
    private readonly store: Store,
    private readonly credentials: CredentialLifecycle,
    private readonly host: ManagementHost
  ) {}
  /** 在 fixture 管理门禁后复用真实 Store 创建 pending 机器。 */
  register(name: string) {
    this.host.authorize('register')
    return this.store.register(name)
  }
  /** 在 fixture 管理门禁后复用真实 Store 签发一次性 enrollment。 */
  issue(machine: string, ttlMs = 600_000): string {
    this.host.authorize('enroll', machine)
    return this.store.issueEnrollment(machine, ttlMs)
  }
  /** 消费真实 Store enrollment 后保存 fixture custody，再签发无生产效力内存租期；失败不重置消费。 */
  redeem(enrollment: string) {
    this.host.authorize('redeem')
    const device = this.store.redeem(enrollment)
    // custody 失败保持已消费状态，不能为了重试重新激活 enrollment。
    this.host.installCanonical(device.machine_id, device.credential)
    return this.credentials.provision(device.machine_id)
  }
  /** 经 fixture 管理门禁模拟有界轮换，不接触真实设备凭据。 */
  rotate(machine: string, overlapMs: number, ttlMs?: number) {
    this.host.authorize('rotate', machine)
    return this.credentials.rotate(machine, overlapMs, ttlMs)
  }
  /** 经 fixture 管理门禁完成内存过渡，供旧连接失效测试。 */
  finishRotation(machine: string): void {
    this.host.authorize('rotate', machine)
    this.credentials.finishRotation(machine)
  }
  /** 先使用真实 Store 撤销，再清除 fixture 租期，避免假报持久撤销成功。 */
  revoke(machine: string): void {
    this.host.authorize('revoke', machine)
    // 持久撤销提交成功后才报告成功；Store 的独立 management 门禁仍须通过。
    this.store.revoke(machine)
    this.credentials.revoke(machine)
  }
  /** 只在 mock 授权下关闭当前连接，用于通道 epoch 隔离测试。 */
  takeover(machine: string, disconnect: () => void): void {
    this.host.authorize('takeover', machine)
    if (this.store.machine(machine).status === 'revoked') {
      fail('invalid_device_credential')
    }
    disconnect()
  }
}
