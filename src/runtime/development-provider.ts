// 为显式隔离开发实例装配已审 Luvus 分类；生产来源使用独立包装器核对真实 opaque custody。
import { createReviewedLuvusProvider } from './luvus-reviewed-provider.js'
import {
  DEVELOPMENT_LUVUS_SHA256,
  DEVELOPMENT_LUVUS_CLASSIFICATION,
  DEVELOPMENT_LUVUS_REVISION
} from './native-instance.js'
import type { OwnedLuvusInstance } from './native-instance.js'
import type { RuntimeProvider } from './types.js'

/** 保持开发实例的固定版本、分类与角色端口，不把空白测试来源升级成生产证明。 */
export function createDevelopmentLuvusProvider(
  instance: OwnedLuvusInstance,
  peerPolicyRevision: string
): RuntimeProvider {
  return createReviewedLuvusProvider(instance, peerPolicyRevision, {
    binary: DEVELOPMENT_LUVUS_SHA256,
    revision: DEVELOPMENT_LUVUS_REVISION,
    classification: DEVELOPMENT_LUVUS_CLASSIFICATION,
    error: 'development_classification_unavailable'
  })
}
