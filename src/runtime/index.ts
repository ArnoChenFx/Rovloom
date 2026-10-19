// 导出可组合的角色宿主和可信请求接缝；唯一 CLI/HTTP/MCP 入口消费本模块。
export { createGatewayRuntime } from './gateway.js'
export { createTrustedRequestScope } from './request-scope.js'
export { createDevelopmentLuvusProvider } from './development-provider.js'
export { openGatewayState } from './state.js'
export { createConnectorRuntime } from './connector.js'
export { ConnectorAttemptBook, createConnectorAdmissionBackend } from './connector-attempts.js'
export {
  startDevelopmentLuvus,
  DEVELOPMENT_LUVUS_SHA256,
  DEVELOPMENT_LUVUS_REVISION,
  DEVELOPMENT_LUVUS_CLASSIFICATION
} from './native-instance.js'
export type { ConnectorAttemptBookOptions, ConnectorAdmissionOptions } from './connector-attempts.js'
export type { DevelopmentLuvusOptions, LuvusIssuanceMetadata, OwnedLuvusInstance } from './native-instance.js'
export type { GatewayStateOptions } from './state.js'
export type * from './types.js'
