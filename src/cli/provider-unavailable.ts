// 仅交付已验证配置的不可用事实；没有原生来源、会话、凭据或可执行替代后端。
import { CliError } from './config.js'
import { validateProvider, validateTarget } from '../wire/index.js'
import type { ProviderSessionGroup } from '../runtime/provider-sessions.js'

export class ProviderUnavailableError extends CliError {
  readonly provider: ProviderSessionGroup['providers'][number]

  /** 只在原工厂尚未取得资源且明确不可用时交付，混合宿主可撤回该原配置而保留健康 owner。 */
  constructor(provider: ProviderSessionGroup['providers'][number]) {
    super('backend_unavailable', 3)
    const binding = Object.freeze(structuredClone(provider.binding))
    const target = Object.freeze(structuredClone(provider.target))
    validateProvider(binding)
    validateTarget(target)
    if (binding.machine_id !== target.machine_id || binding.provider_id !== target.provider_id) {
      throw new CliError('invalid_config')
    }
    this.provider = Object.freeze({ binding, target })
  }
}
