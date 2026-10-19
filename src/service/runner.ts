// 以绝对命令和独立 argv 执行原生工具，限制时间与输出；禁止 shell 拼接。
import { spawn } from 'node:child_process'
import { ServiceError } from './types.js'

export type CommandPlan = { executable: string; args: readonly string[]; input?: string; timeout?: number }
export type CommandResult = { code: number; stdout: string; stderr: string }
export type CommandRunner = (plan: CommandPlan) => Promise<CommandResult>

// 命令超时或输出超限时结束本次直接子进程；错误原文仅留给受信调用方，不写公共诊断。
export function runSystemCommand(plan: CommandPlan): Promise<CommandResult> {
  return new Promise(
    /* 监管一次无 shell 的系统命令。 */ (resolve, reject) => {
      const child = spawn(plan.executable, [...plan.args], {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env:
          process.platform === 'win32'
            ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot }
            : { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' }
      })
      const chunks: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] }
      let size = 0
      let failure: ServiceError | undefined
      const timer = setTimeout(
        /* 超时仅终止当前工具进程，不寻找或杀死业务进程。 */ () => {
          failure = new ServiceError('service_timeout')
          child.kill('SIGKILL')
        },
        plan.timeout ?? 35000
      )
      for (const stream of ['stdout', 'stderr'] as const) {
        child[stream].on(
          'data',
          /* 统一限制两条输出流的合计内存。 */ (bytes: Buffer) => {
            size += bytes.length
            if (size > 1024 * 1024) {
              failure = new ServiceError('system_command_failed')
              child.kill('SIGKILL')
            } else {
              chunks[stream].push(bytes)
            }
          }
        )
      }
      child.stdin.on('error', /* 早退或管道关闭由 close 的退出状态统一判定。 */ () => {})
      child.once(
        'error',
        /* 将权限和缺失系统设施映射为稳定错误。 */ (error: NodeJS.ErrnoException) => {
          failure = new ServiceError(
            error.code === 'EACCES' || error.code === 'EPERM'
              ? 'permission_denied'
              : error.code === 'ENOENT'
                ? 'backend_unavailable'
                : 'system_command_failed'
          )
        }
      )
      child.once(
        'close',
        /* 收齐输出后释放计时器并报告真实退出码。 */ (code) => {
          clearTimeout(timer)
          if (failure) {
            reject(failure)
          } else {
            resolve({
              code: code ?? -1,
              stdout: Buffer.concat(chunks.stdout).toString('utf8'),
              stderr: Buffer.concat(chunks.stderr).toString('utf8')
            })
          }
        }
      )
      child.stdin.end(plan.input)
    }
  )
}

// 检查原生工具退出码，允许调用者显式处理其有文档依据的状态码。
export async function checkedCommand(run: CommandRunner, plan: CommandPlan): Promise<CommandResult> {
  const result = await run(plan)
  if (result.code !== 0) {
    throw new ServiceError('system_command_failed', result.code)
  }
  return result
}
