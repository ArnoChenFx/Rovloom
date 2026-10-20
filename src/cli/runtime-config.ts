// 共用无秘密runtime描述契约，CLI离线模板与检查不加载角色工厂或读取凭据。
import { join } from 'node:path'
import { fields, object } from '../wire/index.js'
import { CliError, configTemplate, type ConnectorConfig, type GatewayConfig, type RoleConfig } from './config.js'
import { readRuntimeJson, runtimeReference } from './runtime-files.js'

export type GatewayRuntimeConfig = {
  schema_version: 1
  role: 'gateway'
  authentication_ref: string
  device_listener: { hostname: string; port: number; tls_ref: string }
  provider_config_refs: string[]
  management_ref?: string
}
export type ConnectorRuntimeConfig = {
  schema_version: 1
  role: 'connector'
  credential_ref: string
  ca_ref: string
  provider_config_refs: string[]
}

// runtime描述只保存固定监听和非秘密引用；与角色配置冲突或未知字段均在打开状态前拒绝。
export function parseRuntimeConfig(value: unknown, config: GatewayConfig): GatewayRuntimeConfig
// Connector描述使用同一字段门禁，凭据/CA和provider引用仍分别绑定当前角色。
export function parseRuntimeConfig(value: unknown, config: ConnectorConfig): ConnectorRuntimeConfig
// 联合角色调用仍使用同一解析器，调用者无需复制分支。
export function parseRuntimeConfig(value: unknown, config: RoleConfig): GatewayRuntimeConfig | ConnectorRuntimeConfig
// 所有运行资源都先通过非秘密描述校验，未通过前不访问身份、凭据或数据库。
export function parseRuntimeConfig(
  raw: unknown,
  config: GatewayConfig | ConnectorConfig
): GatewayRuntimeConfig | ConnectorRuntimeConfig {
  try {
    const value = object(raw)
    fields(
      value,
      config.role === 'gateway'
        ? ['schema_version', 'role', 'authentication_ref', 'device_listener', 'provider_config_refs']
        : ['schema_version', 'role', 'credential_ref', 'ca_ref', 'provider_config_refs'],
      config.role === 'gateway' ? ['management_ref'] : []
    )
    if (value.schema_version !== 1 || value.role !== config.role) {
      throw new Error('invalid_runtime_manifest')
    }
    const refs = value.provider_config_refs
    if (!Array.isArray(refs) || refs.length > 32 || new Set(refs).size !== refs.length) {
      throw new Error('invalid_runtime_manifest')
    }
    for (const ref of refs) {
      runtimeReference(config.state_dir, ref)
    }
    if (config.role === 'gateway') {
      const listener = object(value.device_listener)
      fields(listener, ['hostname', 'port', 'tls_ref'])
      if (
        value.authentication_ref !== config.authentication_ref ||
        typeof listener.hostname !== 'string' ||
        !['127.0.0.1', '::1', '0.0.0.0', '::'].includes(listener.hostname) ||
        !Number.isSafeInteger(listener.port) ||
        (listener.port as number) < 1 ||
        (listener.port as number) > 65_535
      ) {
        throw new Error('invalid_runtime_manifest')
      }
      runtimeReference(config.state_dir, listener.tls_ref)
      if (value.management_ref !== undefined) {
        runtimeReference(config.state_dir, value.management_ref)
      }
      return value as unknown as GatewayRuntimeConfig
    }
    if (JSON.stringify(refs) !== JSON.stringify(config.provider_config_refs)) {
      throw new Error('invalid_runtime_manifest')
    }
    runtimeReference(config.state_dir, value.credential_ref)
    runtimeReference(config.state_dir, value.ca_ref)
    return value as unknown as ConnectorRuntimeConfig
  } catch (error) {
    if (error instanceof CliError) {
      throw error
    }
    throw new CliError('invalid_config')
  }
}

// 实际启动和只读检查使用完全相同的runtime字段校验，不打开身份、原生实例或Store。
export function readRuntimeConfig(config: GatewayConfig): GatewayRuntimeConfig
// Connector同样保留与角色配置逐项一致的provider引用。
export function readRuntimeConfig(config: ConnectorConfig): ConnectorRuntimeConfig
// CLI只读检查可直接交付已经解析的任一角色。
export function readRuntimeConfig(config: RoleConfig): GatewayRuntimeConfig | ConnectorRuntimeConfig
// 保留原受保护文件读取结果与错误，检查成功只表示描述结构有效。
export function readRuntimeConfig(config: RoleConfig): GatewayRuntimeConfig | ConnectorRuntimeConfig {
  const value = readRuntimeJson(join(config.state_dir, 'runtime.json'))
  return parseRuntimeConfig(value, config)
}

// 模板不含身份、token、证书或本机provider秘密，只列出由用户另行配置的已有资源引用。
export function runtimeConfigTemplate(role: 'gateway' | 'connector'): GatewayRuntimeConfig | ConnectorRuntimeConfig {
  const config = configTemplate(role)
  if (config.role === 'gateway') {
    return parseRuntimeConfig(
      {
        schema_version: 1,
        role,
        authentication_ref: config.authentication_ref,
        device_listener: { hostname: '127.0.0.1', port: 9443, tls_ref: 'device-tls' },
        provider_config_refs: []
      },
      config
    )
  }
  return parseRuntimeConfig(
    {
      schema_version: 1,
      role,
      credential_ref: 'device',
      ca_ref: 'gateway',
      provider_config_refs: config.provider_config_refs
    },
    config
  )
}
