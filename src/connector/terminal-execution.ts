/** 统一目录预检与本机最终写入的直接终端执行开关；不替代原生授权或操作系统隔离。 */
import { fail } from '../wire/index.js'

export type TerminalExecutionKind = 'luvus' | 'herdr'

const direct = Object.freeze({
  luvus: new Set([
    'pane.run',
    'pane.send_input',
    'terminal.backend.create',
    'terminal.backend.control',
    'terminal.backend.type_literal',
    'terminal.backend.paste_text',
    'terminal.backend.submit_text',
    'terminal.backend.send_key',
    'module.action.invoke',
    'agent.report',
    'pane.report_session',
    'pane.report_event'
  ]),
  herdr: new Set(['pane.send_text', 'pane.send_keys', 'pane.send_input', 'pane.link.activate'])
})

const launches = Object.freeze({
  luvus: new Set([
    'agent.start',
    'agent.resume',
    'agent.fork',
    'workspace.new',
    'workspace.open',
    'node.new',
    'node.open',
    'tab.new',
    'pane.split',
    'pane.report_session',
    'agent.report'
  ]),
  herdr: new Set([
    'agent.start',
    'workspace.create',
    'tab.create',
    'pane.split',
    'pane.report_agent',
    'pane.report_agent_session'
  ])
})

/** 仅接受显式布尔值；省略保持关闭，字符串、数字和对象均不能隐式开启。 */
export function pinTerminalExecution(value: unknown): boolean {
  if (value !== undefined && typeof value !== 'boolean') {
    fail('terminal_execution_config_invalid')
  }
  return value === true
}

/** 判断可直接写 shell、启动自定义程序或保存恢复命令的输入；普通 Agent 对话不落入此分类。 */
export function requiresTerminalExecution(
  kind: TerminalExecutionKind,
  method: string,
  params: Readonly<Record<string, unknown>> = {}
): boolean {
  if (direct[kind].has(method)) {
    return true
  }
  if (!launches[kind].has(method)) {
    return false
  }
  for (const key of ['command', 'args', 'env', 'resume_command', 'resume_argv']) {
    const value = params[key]
    if (value === undefined || value === null || value === '') {
      continue
    }
    if (typeof value === 'object' && Object.keys(value).length === 0) {
      continue
    }
    return true
  }
  return false
}

/** 目录可对完整请求使用同一判定；参数敏感方法仍可描述，其具体请求必须再经预检。 */
export function terminalExecutionAllowed(
  kind: TerminalExecutionKind,
  method: string,
  params: Readonly<Record<string, unknown>>,
  enabled: boolean = false
): boolean {
  return enabled === true || !requiresTerminalExecution(kind, method, params)
}

/** 本机只在同步边界接受当前显式许可；不签发 dispatch permit、不清除持久 claim、不改变结果。 */
export function assertTerminalExecutionAllowed(
  kind: TerminalExecutionKind,
  request: Readonly<{ method?: unknown; params?: unknown }>,
  enabled: boolean = false
): void {
  if (
    typeof request.method !== 'string' ||
    !request.params ||
    typeof request.params !== 'object' ||
    Array.isArray(request.params)
  ) {
    fail('terminal_execution_request_invalid')
  }
  if (!terminalExecutionAllowed(kind, request.method, request.params as Record<string, unknown>, enabled)) {
    fail('terminal_execution_disabled')
  }
}
