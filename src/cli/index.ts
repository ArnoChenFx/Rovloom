// 导出可供受信宿主组合的 CLI 解析、配置和角色接口；导入本模块不启动服务。
export { runCli, parseCommand, HELP } from './run.js'
export type { CliRuntime, GatewayRuntime, RunningConnector, CliIo } from './run.js'
export { parseConfig, readConfig, configTemplate, CliError } from './config.js'
export type { GatewayConfig, ConnectorConfig, RoleConfig } from './config.js'
export { createStoreCliRuntime } from './store-runtime.js'
export type { StoreCliHost } from './store-runtime.js'
export { createLocalCallerProvider } from './caller-binding.js'
export type { LocalCallerBinding, LocalCallerBindings } from './caller-binding.js'
export { createTransportCliRuntime } from './transport-runtime.js'
export type {
  TransportCliHost,
  GatewayTransportResources,
  GatewayTransportPorts,
  ConnectorTransportResources
} from './transport-runtime.js'
