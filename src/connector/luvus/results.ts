/** 保留 Luvus 结果访问接口与原解析上限，所有原 Wire、Store 和当前授权门禁由共同结果层实现。 */
import { GatewayError } from '../../contracts.js'
import type { LocalPolicies, Principal } from '../../router.js'
import type { Store } from '../../store.js'
import { LIMITS } from '../../wire/index.js'
import { createProviderResultAccess } from '../../runtime/results.js'
import type { ProviderOriginalRead, ProviderResultMetadata, ProviderResultPage } from '../../runtime/results.js'

export type LuvusResultMetadata = ProviderResultMetadata
export type LuvusResultPage = ProviderResultPage
export type LuvusOriginalRead = ProviderOriginalRead
export type LuvusResultAccessOptions = Readonly<{
  store: Store
  localPolicies: LocalPolicies
  /** 返回当前已认证主体，不从结果读取参数采信身份或策略。 */
  principal(): Principal
  /** 仅查找原请求持有的真实 Wire 上下文；缺失时不得从数据库或 JSON 恢复许可。 */
  resolveOriginalRead(callId: string): LuvusOriginalRead | undefined
}>

/** 旧入口只收窄 Luvus 的种类及原生对象上限，不创建协议、身份、permit 或另一份结果账本。 */
export function createLuvusResultAccess(options: LuvusResultAccessOptions) {
  return createProviderResultAccess({
    ...options,
    /** 以 Store 当前 canonical 配置提供旧 Luvus 入口的受保护 provider，不把 Herdr 标签当成兼容许可。 */
    provider(target) {
      const binding = options.store.provider(target.machine_id, target.provider_id)
      if (binding && binding.kind !== 'luvus') {
        throw new GatewayError('provider_kind_mismatch')
      }
      return binding ? { binding, max_response_bytes: LIMITS.frame_bytes } : undefined
    }
  })
}
