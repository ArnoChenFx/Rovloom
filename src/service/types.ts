// 定义开机服务的固定身份、受信宿主接缝与系统后端契约；导入不产生系统副作用。
export type ServicePlatform = 'linux' | 'darwin' | 'win32'
export type ServiceRole = 'gateway' | 'connector'
export type ServiceAction = 'install' | 'uninstall' | 'start' | 'restart' | 'stop'
export type ServiceSpec = {
  version: 1
  platform: ServicePlatform
  role: ServiceRole
  executable: string
  config: string
  directory: string
  account: string
}
export type ServiceRequest = { action: ServiceAction; role: ServiceRole; spec?: ServiceSpec }
export type ServiceState = 'running' | 'stopped' | 'starting' | 'stopping' | 'failed'
export type ServiceSnapshot = { spec: ServiceSpec; state: ServiceState; enabled: boolean; exitCode?: number }
export type ServiceResult = {
  action: ServiceAction
  role: ServiceRole
  changed: boolean
  state: ServiceState | 'absent'
  bootEnabled: boolean
  // 系统监管状态不证明业务就绪；Windows 停止可能直接终止进程。
  readiness: 'not_checked'
  stopMode: 'signal_then_kill' | 'task_termination'
}
export type ServiceErrorCode =
  | 'invalid_arguments'
  | 'unsupported_platform'
  | 'permission_denied'
  | 'unsafe_installation'
  | 'service_conflict'
  | 'service_not_installed'
  | 'service_busy'
  | 'service_timeout'
  | 'service_start_failed'
  | 'system_command_failed'
  | 'backend_unavailable'

export class ServiceError extends Error {
  // 固定公共错误及可选底层退出码，不把命令输出或敏感路径放入公开诊断。
  constructor(
    readonly code: ServiceErrorCode,
    readonly nativeExitCode?: number
  ) {
    super(code)
    this.name = 'ServiceError'
  }
}
export type ServiceBackend = {
  platform: ServicePlatform
  // 整个状态转换持有项目角色专用跨进程锁，不清除未知旧锁。
  lock<T>(role: ServiceRole, operation: () => Promise<T>): Promise<T>
  // 检查提权与系统设施；不自行提权或静默退回登录启动。
  authorize(): Promise<void>
  // 重新核对运行账户、固定路径及宿主支持的后台角色，不扩大文件 ACL。
  preflight(spec: ServiceSpec): Promise<void>
  // 仅返回完全属于本项目的注册；同名异物、重定向或附加覆盖必须拒绝。
  inspect(role: ServiceRole): Promise<ServiceSnapshot | undefined>
  // 只创建新注册，冲突时绝不覆盖；不启动程序。
  create(spec: ServiceSpec): Promise<void>
  // 修改开机注册；不隐含启动或停止。
  enable(spec: ServiceSpec, enabled: boolean): Promise<void>
  // 仅向已核验的本项目角色发送启动请求。
  start(spec: ServiceSpec): Promise<void>
  // 请求停止本项目实例，不按进程名或任意 PID 杀进程。
  stop(spec: ServiceSpec): Promise<void>
  // 仅移除已停止的本项目注册，不能删除配置、数据库或日志。
  remove(spec: ServiceSpec): Promise<void>
}
