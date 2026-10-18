import type { Store } from '../store.js'
import type { AuthenticatedEnvelope } from '../wire/types.js'
import type { NativeWireBackend } from './luvus-wire.js'
import { createLuvusWireAdapter } from './luvus-wire.js'

type Services = Omit<NativeWireBackend, 'attempt' | 'provider' | 'responseAnchor' | 'contentStatus' | 'now'>
// 只填持久化事实；认证、双端本机配置、原生来源、契约与真实权限必须独立注入。
export function persistentBackend(store: Store, services: Services): NativeWireBackend {
  return {
    ...services,
    now: () => store.clock(),
    connection() {
      const connection = services.connection()
      store.assertConnection(connection)
      return connection
    },
    attempt: (call, attempt) => store.attempt(call, attempt),
    provider: (target) => store.provider(target.machine_id, target.provider_id),
    responseAnchor: (binding) => store.responseAnchor(binding),
    contentStatus: (binding) => store.responseAnchor(binding).content_status
  }
}
// 同一 writer 事务重新取原锚点并调用真实 adapter；提交前不得对外发布 responded。
export function commitLuvusResponse(
  store: Store,
  adapter: ReturnType<typeof createLuvusWireAdapter>,
  frame: Extract<AuthenticatedEnvelope, { type: 'response' }>
) {
  const binding = {
    machine_id: frame.machine_id,
    recovery_generation: frame.recovery_generation,
    connection_epoch: frame.connection_epoch,
    ...frame.payload.attempt
  }
  return store.commitEvidence(binding, () => adapter.planEvidence(frame))
}
