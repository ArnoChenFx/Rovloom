// 只给真实受控 Luvus custody 装配已审普通 RPC 分类，不把设备认证或开发实例当生产来源。
import { assertRestrictedLuvusCustody, MANAGED_LUVUS_REVISION, MANAGED_LUVUS_CLASSIFICATION } from './native-source.js'
import type { RestrictedLuvusCustody } from './native-source.js'
import type { RuntimeProvider } from './types.js'
import { createReviewedLuvusProvider } from './luvus-reviewed-provider.js'

/** 核对实际安装身份与当前契约修订，逐次来源与委托检查继续由真实 custody 持有。 */
export function createManagedLuvusProvider(
  custody: RestrictedLuvusCustody,
  peerPolicyRevision: string
): RuntimeProvider {
  assertRestrictedLuvusCustody(custody)
  return createReviewedLuvusProvider(custody, peerPolicyRevision, {
    binary: custody.config.binary_sha256,
    revision: MANAGED_LUVUS_REVISION,
    classification: MANAGED_LUVUS_CLASSIFICATION,
    error: 'managed_classification_unavailable'
  })
}
