// 打开唯一业务 Store 并组合设备认证生命周期与通道注册表；不代用户注册或配置真实凭据。
import { join } from 'node:path'
import { Store } from '../store.js'
import type { StoreOptions } from '../store.js'
import { createDeviceLifecycle, ChannelRegistry } from '../transport/index.js'
import type { DeliveryLedger } from '../transport/index.js'
import { privatePath } from '../storage/files.js'

export type GatewayStateOptions = Readonly<{
  state_directory: string
  now?: () => number
  store?: StoreOptions
  // 凭据交付失败后的正常断连须交给同一 Gateway；只在状态提交后调用。
  changed(machine: string): void
}>

/** 本机受保护状态目录必须预先存在；正常启动不注册设备、发放凭据或解除隔离。 */
export function openGatewayState(options: GatewayStateOptions) {
  const path = join(options.state_directory, 'gateway.db')
  privatePath(path)
  const channels = new ChannelRegistry()
  const store = new Store(path, options.now ?? Date.now, options.store)
  try {
    const lifecycle = createDeviceLifecycle(store)
    const credentials: DeliveryLedger = {
      /** 先在 Store 事务中拒绝该精确凭据，再通知宿主关闭失效通道。 */
      rejectDelivery(machine, digest) {
        store.denyDelivery(machine, digest)
        options.changed(machine)
      },
      /** 以凭据签发序号关联一次交付与确认，不返回 secret。 */
      credentialRevision: (machine) => store.credentialRevision(machine)
    }
    let closed = false
    return {
      store,
      lifecycle,
      channels,
      credentials,
      /** 仅释放本次打开的数据库，不清除凭据、崩溃锁或持久调用墓碑。 */
      close() {
        if (!closed) {
          closed = true
          store.close()
        }
      }
    }
  } catch (error) {
    store.close()
    throw error
  }
}
