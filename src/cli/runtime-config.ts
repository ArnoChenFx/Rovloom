// 仅从已解析的单文件配置及程序管理状态装配运行资源；不读取runtime.json或用户ref清单。
import { CliError, type ConnectorConfig, type GatewayConfig, type RoleConfig } from './config.js'
import { readRuntimeJson, runtimeReference } from './runtime-files.js'
import { boundedJson, fields, id, object } from '../wire/index.js'

export type ManagedProviderEntry = Readonly<{ reference: string; value: unknown }>
export type GatewayRuntimeConfig = {
  schema_version: 1
  role: 'gateway'
  authentication_ref: string
  device_listener: { hostname: string; port: number }
  provider_config_refs: string[]
  providers: readonly ManagedProviderEntry[]
}
export type ConnectorRuntimeConfig = {
  schema_version: 1
  role: 'connector'
  credential_ref: string
  provider_config_refs: string[]
  providers: readonly ManagedProviderEntry[]
}

// 内部registry只记录程序准备的来源；不存在代表尚未发现，畸形或不可读状态不能伪装成空配置。
function providers(config: RoleConfig): readonly ManagedProviderEntry[] {
  let input: unknown
  try {
    input = readRuntimeJson(runtimeReference(config.state_dir, 'providers'), 1_048_576)
  } catch (error) {
    if (error instanceof CliError && error.code === 'backend_unavailable') {
      return Object.freeze([])
    }
    throw error
  }
  try {
    const value = object(input)
    fields(value, ['schema_version', 'role', 'providers'])
    if (
      value.schema_version !== 1 ||
      value.role !== config.role ||
      !Array.isArray(value.providers) ||
      value.providers.length > 32
    ) {
      throw new Error('invalid_managed_providers')
    }
    const names = new Set<string>()
    const result = value.providers.map(
      /* 私有状态仍经过完整字段与有界JSON检查，来源认证继续由原生产工厂实测。 */ (raw) => {
        const entry = object(raw)
        fields(entry, ['reference', 'value'])
        id(entry.reference)
        if (names.has(entry.reference)) {
          throw new Error('duplicate_managed_provider')
        }
        names.add(entry.reference)
        return Object.freeze({ reference: entry.reference, value: JSON.parse(boundedJson(entry.value, 1_048_576)) })
      }
    )
    return Object.freeze(result)
  } catch {
    throw new CliError('invalid_config')
  }
}

// Gateway运行字段直接来自用户功能分组；身份和provider为程序管理资源，不接受旧runtime文档。
export function readRuntimeConfig(config: GatewayConfig): GatewayRuntimeConfig
// Connector同样从唯一用户配置与自己的受保护状态装配，不接收CA或用户凭据路径。
export function readRuntimeConfig(config: ConnectorConfig): ConnectorRuntimeConfig
// 联合角色沿相同边界装配，仅返回内部宿主需要的固定字段。
export function readRuntimeConfig(config: RoleConfig): GatewayRuntimeConfig | ConnectorRuntimeConfig
// 不创建身份或编造ready；首次空registry留给Gateway的待配对状态与Connector明确诊断。
export function readRuntimeConfig(config: RoleConfig): GatewayRuntimeConfig | ConnectorRuntimeConfig {
  const entries = providers(config)
  const common = {
    schema_version: 1 as const,
    providers: entries,
    provider_config_refs: entries.map(/* 仅从程序管理条目派生内部索引。 */ (entry) => entry.reference)
  }
  return config.role === 'gateway'
    ? {
        ...common,
        role: 'gateway',
        authentication_ref: 'mcp-callers',
        device_listener: { hostname: config.device_hostname, port: config.device_port }
      }
    : { ...common, role: 'connector', credential_ref: 'device' }
}
