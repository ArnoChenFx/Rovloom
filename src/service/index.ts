// 导出独立开机服务模块及最小 CLI 接缝；不会在导入时安装或启动任何服务。
export { ServiceManager } from './manager.js'
export type { ServiceClock } from './manager.js'
export { handleServiceCommand, parseServiceCommand, SERVICE_HELP } from './command.js'
export type { ServiceCommandHost, ServiceConfigPathResolver } from './command.js'
export { createNativeServiceBackend } from './native.js'
export type { NativeServiceOptions } from './native.js'
export { ServiceError } from './types.js'
export type {
  ServiceAction,
  ServiceBackend,
  ServicePlatform,
  ServiceRequest,
  ServiceResult,
  ServiceRole,
  ServiceSnapshot,
  ServiceSpec,
  ServiceState
} from './types.js'
