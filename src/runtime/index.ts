// 导出可组合的角色宿主和可信请求接缝；唯一 CLI/HTTP/MCP 入口消费本模块。
export { createGatewayRuntime, createProviderGatewayRuntime } from './gateway.js'
export { createTrustedRequestScope } from './request-scope.js'
export { createDevelopmentLuvusProvider } from './development-provider.js'
export { openGatewayState } from './state.js'
export { createConnectorRuntime } from './connector.js'
export { createProviderConnectorRuntime, ConnectorHostStartupError } from './connector-host.js'
export type { ConnectorHostOptions, ConnectorHostShutdown, ConnectorReleaseStatus } from './connector-host.js'
export { createManagementSessionAuthority } from './management-session.js'
export type {
  ManagementSessionAuthority,
  ManagementSessionLease,
  ManagementSessionBootstrap,
  CurrentManagementSession
} from './management-session.js'
export { createLuvusCustodyAuthorizer } from './luvus-custody-authorization.js'
export type { LuvusCustodyGrant } from './luvus-custody-authorization.js'
export { initializeManagedLuvusRoot, openManagedLuvusRoot } from './native-root.js'
export type { ManagedLuvusRoot, NativeCustodyPolicy } from './native-root.js'
export { startManagedLuvus, MANAGED_LUVUS_REVISION, MANAGED_LUVUS_CLASSIFICATION } from './native-source.js'
export type {
  ControlledLuvusProcess,
  LocalOwnerLuvusInstance,
  RestrictedLuvusCustody,
  RestrictedLuvusRequest,
  RestrictedLuvusIssuance
} from './native-source.js'
export { openNativeCustodyApprovals } from './native-custody.js'
export type {
  NativeCustodyIntent,
  NativeCustodyDecision,
  NativeCustodyAuthorizer,
  NativeCustodyApproval,
  NativeCustodyApprovalWriter
} from './native-custody.js'
export { createManagedLuvusProvider } from './managed-provider.js'
export { createLuvusOperationsProvider } from './luvus-operations-provider.js'
export { attachExistingLuvus } from './native-attach.js'
export type { AttachedLuvusInstance } from './native-attach.js'
export { createLuvusProductionSources, LuvusProductionStartupError } from './production-luvus.js'
export type { LuvusProductionOwnerConfig, LuvusProductionReference } from './production-luvus.js'
export type { LuvusProductionRemoteConfig } from './remote-luvus.js'
export {
  LUVUS_OPERATION_METHODS,
  luvusOperationDescriptor,
  luvusOperationValidation,
  validateLuvusOperationParams
} from './luvus-operations.js'
export {
  ConnectorAttemptBook,
  createConnectorAdmissionBackend,
  createConnectorAdmissionLedger
} from './connector-attempts.js'
export {
  startDevelopmentLuvus,
  DEVELOPMENT_LUVUS_SHA256,
  DEVELOPMENT_LUVUS_REVISION,
  DEVELOPMENT_LUVUS_CLASSIFICATION
} from './native-instance.js'
export type {
  ConnectorAttemptBookOptions,
  ConnectorAdmissionOptions,
  ConnectorAdmissionLedgerOptions
} from './connector-attempts.js'
export type { DevelopmentLuvusOptions, LuvusIssuanceMetadata, OwnedLuvusInstance } from './native-instance.js'
export type { GatewayStateOptions } from './state.js'
export type * from './types.js'

export { createProviderResultAccess } from './results.js'
export type {
  ProviderResultAccessOptions,
  ProviderOriginalRead,
  ProviderResultMetadata,
  ProviderResultPage,
  ResultProvider
} from './results.js'
