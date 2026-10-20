// 唯一入口静态链接真实provider工厂；配置只选kind，不加载任意模块、脚本或另一套角色。
import { createLuvusProductionSources } from '../runtime/index.js'
import { createHerdrProductionSources } from './production-herdr.js'
import { prepareMixedGateway, prepareMixedConnector, type ProductionSourceGroup } from './composite-sources.js'
import { CliError } from './config.js'
import type { ProductionCliSources, ProductionProviderReference } from './production.js'

export type ProductionSourceRegistry = Readonly<Partial<Record<'luvus' | 'herdr', ProductionCliSources>>>

// 全部引用先选择固定已实现工厂；混合组只委托runtime组合，不在CLI解释Wire或native协议。
export function routeProductionSources(registry: ProductionSourceRegistry): ProductionCliSources {
  const sources = { ...registry }
  const select = /* 这里只选择固定静态kind，不解释原生字段或建立来源/授权。 */ (
    references: readonly ProductionProviderReference[],
    connector: boolean
  ) => {
    if (connector && references.length === 0) {
      throw new CliError('backend_unavailable', 3)
    }
    const kinds = new Set<'luvus' | 'herdr'>()
    const names = new Set<string>()
    for (const { reference, value } of references) {
      if (names.has(reference)) {
        throw new CliError('invalid_config')
      }
      names.add(reference)
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
      return (['luvus', 'herdr'] as const).map(
        /** 先核对两个固定kind的实际工厂都存在，再形成原引用分组。 */ (kind): ProductionSourceGroup => {
          const source = sources[kind]
          if (!source || (connector ? !source.connector : !source.gateway)) {
            throw new CliError('backend_unavailable', 3)
          }
          return {
            kind,
            source,
            references: references.filter(
              /** 每个组只取得属于自己kind的原受保护引用。 */ (entry) => (entry.value as { kind: string }).kind === kind
            )
          }
        }
      )
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
      if (Array.isArray(source)) {
        return prepareMixedGateway(config, source, authority)
      }
      if (!source.gateway) {
        throw new CliError('backend_unavailable', 3)
      }
      return source.gateway(config, references, authority)
    },
    connector: /* Connector必须有实际provider，全部会话和释放继续由原owner负责。 */ async (config, references) => {
      const source = select(references, true)
      if (Array.isArray(source)) {
        return prepareMixedConnector(config, source)
      }
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
