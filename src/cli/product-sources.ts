// 唯一入口静态链接真实provider工厂；配置只选kind，不加载任意模块、脚本或另一套角色。
import { createLuvusProductionSources } from '../runtime/index.js'
import { createHerdrProductionSources } from './production-herdr.js'
import { CliError } from './config.js'
import type { ProductionCliSources, ProductionProviderReference } from './production.js'

export type ProductionSourceRegistry = Readonly<Partial<Record<'luvus' | 'herdr', ProductionCliSources>>>

// 全部引用先选择同一已实现工厂，再交给owner解析完整配置，避免错误后已部分打开另一provider。
export function routeProductionSources(registry: ProductionSourceRegistry): ProductionCliSources {
  const sources = { ...registry }
  const select = /* 这里只选择固定静态kind，不解释原生字段或建立来源/授权。 */ (
    references: readonly ProductionProviderReference[],
    connector: boolean
  ) => {
    if (connector && references.length === 0) {
      throw new CliError('backend_unavailable', 3)
    }
    const kinds = new Set<string>()
    for (const { value } of references) {
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        !('kind' in value) ||
        (value.kind !== 'luvus' && value.kind !== 'herdr')
      ) {
        throw new CliError('invalid_config')
      }
      kinds.add(value.kind)
    }
    if (kinds.size > 1) {
      // 当前各owner交付独立会话，缺混合会话组合时明确拒绝，不能在CLI复制Router/adapter。
      throw new CliError('backend_unavailable', 3)
    }
    const kind = [...kinds][0] ?? 'luvus'
    const source = kind === 'luvus' ? sources.luvus : sources.herdr
    if (!source) {
      throw new CliError('backend_unavailable', 3)
    }
    return source
  }
  return {
    gateway: /* Gateway可无provider读取真实账本；有引用时只交给选中的真实工厂。 */ async (
      config,
      references,
      authority
    ) => {
      const source = select(references, false)
      if (!source.gateway) {
        throw new CliError('backend_unavailable', 3)
      }
      return source.gateway(config, references, authority)
    },
    connector: /* Connector必须有实际provider，全部会话和释放继续由原owner负责。 */ async (config, references) => {
      const source = select(references, true)
      if (!source.connector) {
        throw new CliError('backend_unavailable', 3)
      }
      return source.connector(config, references)
    }
  }
}

// 只有角色启动才导入固定模块表；未注册provider明确拒绝，不从JSON加载可执行代码。
export function createProductSources(): ProductionCliSources {
  return routeProductionSources({ luvus: createLuvusProductionSources(), herdr: createHerdrProductionSources() })
}
