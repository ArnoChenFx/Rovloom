// 集中导出 MCP 门面、stdio 生命周期和服务契约；不创建身份、存储或原生执行后端。
export { createMcpFacade } from './facade.js'
export type { DiagnosticCode, FacadeOptions } from './facade.js'
export { startStdioFacade } from './stdio.js'
export type { RunningStdio } from './stdio.js'
export {
  MCP_REVISION,
  PRODUCT_VERSION,
  MAX_MCP_BYTES,
  MAX_RESULT_BYTES,
  MAX_WAIT_MS,
  toolDefinition,
  toolNames,
  parseToolArguments
} from './schema.js'
export { FacadeServiceError } from './types.js'
export type {
  CallerIdentity,
  LocalOsIdentity,
  StdioCallerProvider,
  ServiceContext,
  ServiceReply,
  ServiceErrorCode,
  GatewayService,
  ToolArguments,
  ToolName,
  ReplyData,
  CallView,
  MachineView,
  ProviderView,
  Page
} from './types.js'

export { StoreGatewayService } from './store-service.js'
export type { StoreGatewayOptions } from './store-service.js'
export type * from './management.js'
export type { GatewayCatalogProvider, GatewayCatalogSource } from './native-catalog.js'
