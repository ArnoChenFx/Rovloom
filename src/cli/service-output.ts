// 在唯一CLI的stderr边界重新校验服务输出，TypeScript类型不能代替运行时秘密隔离。
const errors = new Set([
  'invalid_arguments',
  'config_path_required',
  'unsupported_platform',
  'permission_denied',
  'unsafe_installation',
  'service_conflict',
  'service_not_installed',
  'service_busy',
  'service_timeout',
  'service_start_failed',
  'system_command_failed',
  'backend_unavailable',
  'service_recovery_required'
])
const fields = ['action', 'role', 'changed', 'state', 'bootEnabled', 'controlRetained', 'readiness', 'stopMode']

// 只重建已知错误或固定监管状态；拒绝畸形宿主输出，使委托分支返回真实失败而非假成功。
export function serviceDiagnostic(text: string): string {
  if (text.endsWith('\n') && errors.has(text.slice(0, -1))) {
    return text
  }
  let value: Record<string, unknown> | undefined
  try {
    value = text.length <= 2048 ? JSON.parse(text) : undefined
  } catch {
    throw new Error('invalid_service_output')
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    fields.some(/* 确认所有固定字段存在，不允许额外路径、异常或凭据。 */ (field) => !Object.hasOwn(value!, field)) ||
    !['install', 'uninstall', 'start', 'restart', 'stop'].includes(value.action as string) ||
    !['gateway', 'connector'].includes(value.role as string) ||
    typeof value.changed !== 'boolean' ||
    typeof value.bootEnabled !== 'boolean' ||
    typeof value.controlRetained !== 'boolean' ||
    !['running', 'stopped', 'starting', 'stopping', 'failed', 'absent'].includes(value.state as string) ||
    value.readiness !== 'not_checked' ||
    !['not_requested', 'signal_then_kill', 'task_termination', 'graceful_request'].includes(value.stopMode as string)
  ) {
    throw new Error('invalid_service_output')
  }
  return JSON.stringify(value) + '\n'
}
