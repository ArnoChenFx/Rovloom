// 导出可供受信宿主组合的 CLI 解析、配置和角色接口；导入本模块不启动服务。
export { runCli, parseCommand, HELP } from './run.js'
export type { CliRuntime, GatewayRuntime, RunningConnector, CliIo, CliServiceHost } from './run.js'
export { parseConfig, readConfig, configTemplate, configDocument, CliError } from './config.js'
export type { GatewayConfig, ConnectorConfig, RoleConfig } from './config.js'
export { readRuntimeConfig } from './runtime-config.js'
export type { GatewayRuntimeConfig, ConnectorRuntimeConfig } from './runtime-config.js'
export { resolveRoleConfigPath } from './config-path.js'
export type { ConfigPathEnvironment } from './config-path.js'
export { createStoreCliRuntime } from './store-runtime.js'
export type { StoreCliHost } from './store-runtime.js'
export { createRuntimeCliRuntime } from './runtime.js'
export type {
  RuntimeCliHost,
  RuntimeCliGateway,
  RuntimeCliManagement,
  RuntimeCliGatewayResources,
  RuntimeCliConnectorResources,
  RuntimeCliProviderResources
} from './runtime.js'
export { createProductionCliRuntime } from './production.js'
export type {
  ProductionCliSources,
  ProductionGatewayManagement,
  ProductionManagementHost,
  ProductionProviderReference,
  ProductionGatewayResources,
  ProductionConnectorResources
} from './production.js'
export {
  createManagementPageInitializer,
  MANAGEMENT_COOKIE_NAME,
  MANAGEMENT_BOOTSTRAP_META
} from './management-page.js'
export type { ManagementPageLeaseSource } from './management-page.js'
export { createTransportCliRuntime } from './transport-runtime.js'
export type {
  TransportCliHost,
  GatewayTransportResources,
  GatewayTransportPorts,
  ConnectorTransportResources
} from './transport-runtime.js'
