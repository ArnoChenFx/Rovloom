/** 将 Herdr 的当前只读切片接入现有 Store；认证、原生来源和 schema 编译仍由真实宿主提供。 */
import type { Store } from '../../store.js'
import { boundedJson, fail } from '../../wire/index.js'
import type { AuthenticatedEnvelope, ProviderBinding, V2Target } from '../../wire/types.js'
import type { createHerdrReadonlyAdapter } from './readonly.js'
import type { HerdrReadonlyBackend } from './readonly.js'

/** 受保护宿主负责本机配置、双端认证与契约；没有默认 endpoint、credentials 或设备模型。 */
export type HerdrHostServices = Pick<
  HerdrReadonlyBackend,
  'context' | 'contract' | 'nativeSource' | 'currentPrincipal'
> & {
  /** 独立查询本地受保护配置，不能以设备广告或 caller Target 建立新 binding。 */
  localProvider(target: V2Target): ProviderBinding | undefined
}

/** Store 仅填持久化事实，并将当前连接及每个完整 Target 与本机 provider 配置核对。 */
export function persistentHerdrBackend(store: Store, services: HerdrHostServices): HerdrReadonlyBackend {
  return {
    ...services,
    attempt: /** 内容过期后 Store 不再返回请求，adapter 只能使用既有最小响应上下文。 */ (call, attempt) =>
      store.attempt(call, attempt),
    now: /** 事务内外共用 Store 固定的可信时钟。 */ () => store.clock(),
    responseAnchor: /** 从原账本查询绑定、状态和不可延长的期限。 */ (binding) => store.responseAnchor(binding),
    contentStatus: /** 内容状态独立于响应合法性，不因迟到结果而复活。 */ (binding) =>
      store.responseAnchor(binding).content_status,
    subscribeInvalidation: /** 只转接已提交回收与 fence 通知，退订由 adapter 负责。 */ (listener) =>
      store.subscribeInvalidation(listener),
    /** 每次取得当前认证并向 Store 核对 epoch，再封装 provider 的双端配置检查。 */
    context(principal, direction) {
      const context = services.context(principal, direction)
      store.assertConnection(context.connection)
      return {
        ...context,
        direction,
        resolveProvider: /** 同一 Target 必须在 Store 和受保护本地配置完全一致。 */ (target) => {
          const registered = store.provider(target.machine_id, target.provider_id)
          const local = services.localProvider(target)
          if (!registered || !local || boundedJson(registered) !== boundedJson(local)) {
            fail('provider_binding_mismatch')
          }
          return registered
        }
      }
    }
  }
}

/** 在现有证据事务内重新核对原锚点，提交成功才返回；不从外部接收预制 evidence plan。 */
export function commitHerdrResponse(
  store: Store,
  adapter: ReturnType<typeof createHerdrReadonlyAdapter>,
  frame: Extract<AuthenticatedEnvelope, { type: 'response' }>
) {
  return store.commitEvidence(
    {
      machine_id: frame.machine_id,
      recovery_generation: frame.recovery_generation,
      connection_epoch: frame.connection_epoch,
      ...frame.payload.attempt
    },
    /** 使用同一 Store 事务时钟校验真实响应，原文保留和证据状态一并提交。 */ () => adapter.planEvidence(frame)
  )
}
