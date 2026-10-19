/** 管理只读 HTTP 宿主组合入口；不导出默认身份、默认会话或业务查询实现。 */
export {
  createManagementReadHandler,
  startManagementReadListener,
  type ManagementHttpIdentity,
  type ManagementHttpOptions,
  type ManagementHttpProblem,
  type ManagementAssets
} from './read-http.js'
export { loadManagementAssets } from './assets.js'
export { StoreManagementWriteService, ManagementServiceError, type ManagementWriteOptions } from './write-service.js'
export {
  sampleManagementTransport,
  createManagementTransportProjection,
  type ManagementObservationFence,
  type ManagementTransportProjection
} from '../mcp/transport-observations.js'

export { createManagementHandler, type ManagementWriteHttpOptions } from './write-http.js'

export {
  createManagementSessionAdapter,
  type ManagementSessionBinding,
  type ManagementSessionSource,
  type ManagementSessionAdapterOptions
} from './session-adapter.js'
