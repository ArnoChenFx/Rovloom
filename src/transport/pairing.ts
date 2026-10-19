// 将注册与 enrollment 签发限制在独立授权的管理宿主，复用 Store 的稳定身份与一次性消费。
import type { Store } from '../store.js'
import { fail } from '../wire/index.js'

export type ManagementAction = 'register' | 'enroll'
export type ManagementHost = {
  /** 从受保护管理员上下文核对操作权限；secret 只能进入专用管理 custody，普通输入不能自证批准。 */
  authorize(action: ManagementAction, machine?: string): void
}

export class PairingAdmin {
  /** 绑定业务 Store 与独立管理员宿主，提供只供受保护管理面调用的注册接口。 */
  constructor(
    private readonly store: Store,
    private readonly host: ManagementHost
  ) {}
  /** 管理员授权通过后创建稳定 pending 设备，不依据设备自报名称形成认证。 */
  register(name: string) {
    if (this.host.authorize('register') !== undefined) {
      fail('pairing_admin_forbidden')
    }
    return this.store.register(name)
  }
  /** 在管理员授权后签发有界一次性 enrollment，返回 secret 只能进入专用管理 custody。 */
  issue(machine: string, ttlMs = 600_000): string {
    if (this.host.authorize('enroll', machine) !== undefined) {
      fail('pairing_admin_forbidden')
    }
    return this.store.issueEnrollment(machine, ttlMs)
  }
}
