// 以绝对命令和独立 argv 执行原生工具，限制时间与输出；禁止 shell 拼接。
import { spawn } from 'node:child_process'
import { ServiceError } from './types.js'

export type CommandPlan = { executable: string; args: readonly string[]; input?: string; timeout?: number }
export type CommandResult = { code: number; stdout: string; stderr: string }
export type CommandRunner = (plan: CommandPlan) => Promise<CommandResult>

export type CommandPhase = 'starting' | 'running' | 'draining' | 'cleanup_unknown'
export class SystemCommandError extends ServiceError {
  // 只保留固定生命周期阶段；CLI仍仅输出父类固定错误码，不暴露argv、路径或系统正文。
  constructor(
    code: ServiceError['code'],
    readonly phase: CommandPhase
  ) {
    super(code)
  }
}
const uncertain = new Set<ReturnType<typeof spawn>>()
type Start = typeof spawn

// 可注入的仅是受信启动端口与回收计时；生产回收上限一秒，不改变命令自身的操作期限。
export function createSystemCommandRunner(options: { start?: Start; cleanupMs?: number } = {}): CommandRunner {
  const cleanupMs = options.cleanupMs ?? 1000
  if (!Number.isInteger(cleanupMs) || cleanupMs < 1 || cleanupMs > 1000) {
    throw new ServiceError('invalid_arguments')
  }
  const start = options.start ?? spawn
  return /* 一次调用仅拥有一个直接工具进程，整个等待和回收都受限。 */ (plan) =>
    new Promise(
      /* 监管无shell进程及两条输出流，真实close或明确失败才完成。 */ (resolve, reject) => {
        const child = start(plan.executable, [...plan.args], {
          shell: false,
          windowsHide: true,
          // 无输入时直接使用空设备，避免无意义的stdin管道阻碍退出回收；有JSON输入才建管道。
          stdio: [plan.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
          env:
            process.platform === 'win32'
              ? {
                  SystemRoot: process.env.SystemRoot,
                  WINDIR: process.env.SystemRoot,
                  PSModulePath: String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\Modules`,
                  PATH: String.raw`C:\Windows\System32;C:\Windows`
                }
              : { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' }
        })
        const chunks: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] }
        let size = 0
        let spawned = false
        let exited = false
        let closed = false
        let settled = false
        let failure: ServiceError | undefined
        let cleanup: ReturnType<typeof setTimeout> | undefined
        // 只有固定阶段进入诊断；不把PID或系统错误正文放入异常。
        const phase = (): CommandPhase => (exited ? 'draining' : spawned ? 'running' : 'starting')
        // 清理两个定时器并只结算一次；晚到退出/close仍可完成本地资源回收。
        const finish = (code: number) => {
          if (settled) {
            return
          }
          settled = true
          clearTimeout(timer)
          if (cleanup) {
            clearTimeout(cleanup)
          }
          if (failure) {
            reject(failure)
          } else {
            resolve({
              code,
              stdout: Buffer.concat(chunks.stdout).toString('utf8'),
              stderr: Buffer.concat(chunks.stderr).toString('utf8')
            })
          }
        }
        // 超时仅终止当前直接工具；回收也有上限，不能让测试或CLI无限等close。
        const stop = () => {
          if (cleanup || closed) {
            return
          }
          cleanup = setTimeout(
            /* 只销毁本次管道；无法证明退出时保留角色恢复保护，不自动重试系统操作。 */ () => {
              if (!exited && !closed) {
                failure = new SystemCommandError('service_recovery_required', 'cleanup_unknown')
                uncertain.add(child)
                child.unref()
              }
              child.stdin?.destroy()
              child.stdout?.destroy()
              child.stderr?.destroy()
              finish(-1)
            },
            cleanupMs
          )
          child.kill('SIGKILL')
        }
        const timer = setTimeout(
          /* 操作期限到达即失败并开始回收，后续close不能洗成成功。 */ () => {
            failure ??= new SystemCommandError('service_timeout', phase())
            stop()
          },
          plan.timeout ?? 35000
        )
        child.once(
          'spawn',
          /* 观察操作系统确已接受进程启动；不等于工具脚本进入首句。 */ () => {
            spawned = true
          }
        )
        child.once(
          'exit',
          /* 直接工具已退出，但仍须收齐stdout/stderr或进入失败回收。 */ () => {
            exited = true
          }
        )
        for (const stream of ['stdout', 'stderr'] as const) {
          child[stream]?.on(
            'data',
            /* 两流合计最多一MiB，超限后不再保存正文。 */ (bytes: Buffer) => {
              size += bytes.length
              if (size > 1024 * 1024) {
                failure ??= new SystemCommandError('system_command_failed', phase())
                stop()
              } else {
                chunks[stream].push(bytes)
              }
            }
          )
        }
        child.stdin?.on('error', /* EPIPE等交给工具退出状态，不反射底层正文。 */ () => {})
        child.once(
          'error',
          /* 启动失败不会成为不存在的进程；启动后的未知错误仍受有界回收保护。 */ (error: NodeJS.ErrnoException) => {
            failure ??= new SystemCommandError(
              error.code === 'EACCES' || error.code === 'EPERM'
                ? 'permission_denied'
                : error.code === 'ENOENT'
                  ? 'backend_unavailable'
                  : 'system_command_failed',
              phase()
            )
            if (!spawned && (error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'EPERM')) {
              child.stdin?.destroy()
              child.stdout?.destroy()
              child.stderr?.destroy()
              finish(-1)
            } else {
              stop()
            }
          }
        )
        child.once(
          'close',
          /* close携带真实终态并代表输出已关闭；晚到close只回收不再次结算。 */ (code) => {
            closed = true
            uncertain.delete(child)
            finish(code ?? -1)
          }
        )
        if (plan.input !== undefined) {
          child.stdin?.once(
            'finish',
            /* 完整输入已交给管道后关闭自有写端，确保子进程可观察EOF。 */ () => child.stdin?.destroy()
          )
          child.stdin?.end(plan.input)
        }
      }
    )
}

// 产品始终使用固定系统启动器与一秒回收上限；测试端口不能由CLI或配置覆盖。
export const runSystemCommand: CommandRunner = createSystemCommandRunner()

// 检查原生工具退出码，允许调用者显式处理其有文档依据的状态码。
export async function checkedCommand(run: CommandRunner, plan: CommandPlan): Promise<CommandResult> {
  const result = await run(plan)
  if (result.code !== 0) {
    throw new ServiceError('system_command_failed', result.code)
  }
  return result
}
