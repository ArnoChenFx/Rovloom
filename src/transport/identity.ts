// 声明设备凭据与受信认证宿主接口；身份、恢复代次和 epoch 均由宿主建立。
import type { ConnectionIdentity } from '../wire/types.js'

export type DeviceCredential = {
  machine_id: string
  recovery_generation: string
  credential: string
}
export interface IdentityHost {
  /** 读取受信账本当前恢复代次，禁止从消息字段建立当前来源。 */
  generation(): string
  /** 核对独立设备凭据后建立 fresh epoch，返回供当前 socket 复验的租期标识。 */
  authenticate(machine: string, generation: string, credential: string): { identity: ConnectionIdentity; lease: string }
  /** 复验当前凭据或连接 fence，撤销、旧代次及旧 epoch 必须拒绝。 */
  assert(identity: ConnectionIdentity, lease: string): void
  /** 只断开精确匹配的连接 epoch，不把临时离线当作持久撤销。 */
  disconnect(identity: ConnectionIdentity): void
}
