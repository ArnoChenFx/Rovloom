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
export type ServiceSnapshot = {
  spec: ServiceSpec
  state: ServiceState
  enabled: boolean
  exitCode?: number
  loaded?: boolean
}
export type ServiceResult = {
  action: ServiceAction
  role: ServiceRole
  changed: boolean
  state: ServiceState | 'absent'
  bootEnabled: boolean
  // 自启撤销后可保留受保护控制记录，供显式 stop 与同清单重新安装使用。
  controlRetained: boolean
  // 系统监管状态不证明业务就绪；Windows 停止可能直接终止进程。
  readiness: 'not_checked'
  // 实际发出的停止请求；安装、撤销自启及无需停止的操作明确返回 not_requested。
  stopMode: 'not_requested' | 'signal_then_kill' | 'task_termination'
}
export type ServiceErrorCode =
  | 'invalid_arguments'
  | 'config_path_required'
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
  | 'service_recovery_required'

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
  // 只在禁用自启且监管记录可安全释放时清理；保留则返回 false，绝不停止进程或 bootout。
  remove(spec: ServiceSpec): Promise<boolean>
}
