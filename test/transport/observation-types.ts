// 用严格类型检查保证 transport 观测可组合进共享管理快照，且不开放写入、原始 epoch 或 native runtime 伪造入口。
import type { DeviceSnapshot, ManagementStatus } from '../../src/mcp/management.js'
import type { GatewayTransportObservationSource } from '../../src/transport/index.js'

/** 仅供编译器检查；运行时不执行其中的类型负例或任何管理动作。 */
export function observationTypes(source: GatewayTransportObservationSource) {
  const snapshot = source.snapshot()
  const connection: DeviceSnapshot['connection'] | undefined = snapshot.devices[0]?.connection
  const authentication: DeviceSnapshot['authentication'] | undefined = snapshot.devices[0]?.authentication
  const transport: ManagementStatus['components']['transport'] =
    snapshot.transport.verification === 'verified' ? snapshot.transport.value : 'unverified'
  // @ts-expect-error snapshot 不接收工具 JSON 或自报 observed_at/verified。
  source.snapshot({ observed_at: 1, verification: 'verified' })
  // @ts-expect-error 观测源不提供设备管理动作。
  source.disconnect('machine')
  // @ts-expect-error 端口的方法引用只读，不能被替换为调用方工厂。
  source.snapshot =
    /** 仅供编译器拒绝的替换工厂，不在运行时执行。 */
    () => snapshot
  // @ts-expect-error transport 不提供不存在的 native 组件结论。
  const native = snapshot.native
  const device = snapshot.devices[0]
  if (device?.connection.verification === 'verified') {
    // @ts-expect-error 安全引用不能代替原始 Store epoch 或管理 fence。
    const epoch = device.connection.value.connection_epoch
    void epoch
  }
  return { connection, authentication, transport, native }
}
