// 固定Herdr配置封套只委托现有资源工厂；本模块不生成installation、身份、策略或进程所有权。
import { createHerdrGatewayResources, parseHerdrProviderRefConfig } from '../connector/herdr/provider.js'
import { fields, object } from '../wire/index.js'
import { CliError } from './config.js'
import type { ProductionCliSources } from './production.js'

/** 当前Herdr工厂交付一个provider会话；组合会话仍须由runtime所有者交付，不能在CLI复制Wire。 */
export function createHerdrProductSources(): ProductionCliSources {
  return {
    gateway: /** 封套kind只供静态路由，原工厂始终收到其原有精确配置形状。 */ async (_config, references) => {
      if (references.length !== 1) {
        throw new CliError('backend_unavailable', 3)
      }
      const entry = references[0]!
      let config
      try {
        const envelope = object(entry.value)
        fields(envelope, ['kind', 'config'])
        if (envelope.kind !== 'herdr') {
          throw new CliError('invalid_config')
        }
        config = parseHerdrProviderRefConfig(envelope.config)
        if (config.config_ref !== entry.reference) {
          throw new CliError('invalid_config')
        }
      } catch {
        throw new CliError('invalid_config')
      }
      return createHerdrGatewayResources({ config })
    }
  }
}
