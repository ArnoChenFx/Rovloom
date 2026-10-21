/** 提供固定 argv 子进程和 Unix socket 的有界 IO、生命周期与取消控制；仅清理本次自有资源。 */
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createConnection } from 'node:net'
import type { Socket } from 'node:net'
import { WireError } from '../../wire/index.js'
import { childEnvironment, fixedArguments, verifyInstallation, withPrivateUmask } from './local.js'
import { LuvusAdapterError } from './types.js'
import type { LocalFailureOutcome, LuvusLocalConfig, LuvusLocalLimits } from './types.js'

/** 将已取消或到期的信号转换为安全的本地传输错误。 */
export function aborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new LuvusAdapterError(signal.reason === 'deadline' ? 'native_timeout' : 'native_cancelled')
  }
}
/** 允许等待被信号中断并消费原 promise 的晚到拒绝；不会撤销已经发生的宿主副作用。 */
export function interruptible<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise(
    /* 关联 promise 完成与取消通知，确保两条路径都被消费。 */ (resolve, reject) => {
      const cancel = /* 在等待取消时按信号原因拒绝本地结果。 */ () => {
        reject(new LuvusAdapterError(signal.reason === 'deadline' ? 'native_timeout' : 'native_cancelled'))
      }
      signal.addEventListener('abort', cancel, { once: true })
      // 即使宿主忽略取消，晚到 promise 的拒绝仍被消费，不继续写入原生。
      promise
        .then(resolve, reject)
        .finally(
          /* 等待结束后移除取消监听，避免保留已经结算的等待器。 */ () => signal.removeEventListener('abort', cancel)
        )
      if (signal.aborted) {
        cancel()
      }
    }
  )
}
/** 组合上游取消与本地等待期限，并提供清理计时器和终结信号的入口。 */
export function deadline(parent: AbortSignal | undefined, milliseconds: number) {
  const controller = new AbortController()
  const cancel = /* 保留 deadline 原因，将其余上游中断归为本地取消。 */ () =>
    controller.abort(parent?.reason === 'deadline' ? 'deadline' : 'cancelled')
  parent?.addEventListener('abort', cancel, { once: true })
  if (parent?.aborted) {
    cancel()
  }
  const timer = setTimeout(
    /* 等待期限到达时终结本地范围，不向原生发送撤销请求。 */ () => controller.abort('deadline'),
    milliseconds
  )
  return {
    signal: controller.signal,
    /** 清理期限和上游监听，并使未完成的准备步骤观察到范围关闭。 */
    close() {
      clearTimeout(timer)
      parent?.removeEventListener('abort', cancel)
      controller.abort('closed')
    }
  }
}
/** 为一条传输派生独立生命周期，允许 IO 先于外层派发终结准备步骤。 */
function lifecycle(parent: AbortSignal) {
  const controller = new AbortController()
  const cancel = /* 把上游的中断原因传给本条传输。 */ () => controller.abort(parent.reason)
  parent.addEventListener('abort', cancel, { once: true })
  if (parent.aborted) {
    cancel()
  }
  return {
    signal: controller.signal,
    /** 移除上游监听并取消未完成的准备，阻止 IO 结束后继续新增 claim。 */
    close() {
      parent.removeEventListener('abort', cancel)
      controller.abort('transport_closed')
    }
  }
}
export type PreparedFrame = Readonly<{
  bytes: Buffer
  /* 实际写入前同步检查最终派发条件；抛错时调用方必须停止写入。 */ beforeWrite(): void
}>
export type ProcessOutput = { stdout: Buffer; exit_code: number; stderr_bytes: number }
/** 验证固定安装后以固定 argv、最小环境和禁用 shell 的方式启动受控命令，限制输出并清理自有子进程。 */
export async function runFixedProcess(
  config: LuvusLocalConfig,
  limits: LuvusLocalLimits,
  command: 'schema' | 'sessions' | 'proxy' | 'version',
  signal: AbortSignal,
  ready?: /* 在子进程启动后验证其身份并准备输入；收到取消后不得继续准备或提交新 claim。 */ (
    child: ChildProcessWithoutNullStreams,
    signal: AbortSignal
  ) => Promise<PreparedFrame>
): Promise<ProcessOutput> {
  aborted(signal)
  // 每个固定命令都在 spawn 前验证；不能等 proxy 已经运行后才发现 binary 被替换。
  await interruptible(verifyInstallation(config), signal)
  aborted(signal)
  return new Promise(
    /* 管理本次子进程的输入、输出、错误和终结，最多结算一次。 */ (resolve, reject) => {
      const io = lifecycle(signal)
      let started = false
      let finished = false
      let failure: LuvusAdapterError | undefined
      let stdoutBytes = 0
      let stderrBytes = 0
      let inputSent = false
      const chunks: Buffer[] = []
      const outputLimit = command === 'proxy' ? limits.response_bytes : limits.discovery_bytes
      const child = withPrivateUmask(() =>
        spawn(config.binary, fixedArguments(config, command), {
          cwd: config.cwd,
          env: childEnvironment(config),
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        })
      )
      // TEMP-DEBUG（Windows e2e 排查，随后移除）
      const p0 = Date.now()
      const pmark = (label: string) =>
        process.env.ROVLOOM_DEBUG_ERRORS &&
        process.stderr.write(`DBG_PROC ${command} ${label} +${Date.now() - p0}ms pid=${child.pid}\n`)
      pmark('spawned')
      child.once('exit', (code, sig) => pmark(`exit code=${code} signal=${sig}`))
      child.stderr.on('data', (data: Buffer) => pmark('stderr ' + JSON.stringify(data.toString().slice(0, 300))))
      let killTimer: ReturnType<typeof setTimeout> | undefined
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined
      const outcome = /* 保守地区分已启动 RPC 代理的未知结果与只读命令的派发前失败。 */ (): LocalFailureOutcome =>
        command === 'proxy' && started ? 'outcome_unknown' : 'not_dispatched'
      /** 终结准备生命周期并释放监听、计时器，再返回有界输出或安全错误。 */
      function finish(code: number | null) {
        if (finished) {
          return
        }
        finished = true
        io.close()
        clearTimeout(killTimer)
        clearTimeout(cleanupTimer)
        signal.removeEventListener('abort', cancel)
        if (failure) {
          reject(new LuvusAdapterError(failure.code, outcome()))
        } else if (code === null) {
          reject(new LuvusAdapterError('native_process_signal', outcome()))
        } else {
          resolve({ stdout: Buffer.concat(chunks, stdoutBytes), exit_code: code, stderr_bytes: stderrBytes })
        }
      }
      /** 记录首次传输失败并终止本次拥有的桥接子进程；不尝试原生回滚。 */
      function stop(code: string) {
        if (finished || failure) {
          return
        }
        pmark('stop ' + code)
        failure = new LuvusAdapterError(code, outcome())
        // 终结本条传输的 prepare；外层 scope 结束前也不能再等待 auth 后新增 claim。
        io.close()
        // 只处理本次拥有的桥接子进程；不会发送 terminal.close 或其它原生撤销动作。
        child.stdin.destroy()
        child.stdout.destroy()
        child.stderr.destroy()
        child.kill('SIGTERM')
        killTimer = setTimeout(/* 宽限期后强制结束本次仍存活的桥接子进程。 */ () => child.kill('SIGKILL'), 100)
        cleanupTimer = setTimeout(
          /* 在最终清理期限强制终止自有子进程并结算等待，避免永久悬挂。 */ () => {
            child.kill('SIGKILL')
            finish(null)
          },
          500
        )
      }
      /** 根据上游中断原因结束本次子进程等待。 */
      function cancel() {
        stop(signal.reason === 'deadline' ? 'native_timeout' : 'native_cancelled')
      }
      child.once(
        'error',
        /* 区分启动失败和启动后的进程错误，并进入有界清理。 */ () =>
          stop(started ? 'native_process_error' : 'native_spawn_error')
      )
      child.stdin.on('error', /* stdin 写入失败时终结本次传输。 */ () => stop('native_stdin_error'))
      child.stdout.on('error', /* stdout 读取失败时终结本次传输。 */ () => stop('native_stdout_error'))
      child.stderr.on('error', /* stderr 读取失败时终结本次传输。 */ () => stop('native_stderr_error'))
      child.stdout.on(
        'data',
        /* 拒绝请求前的代理输出，按原始字节累积 stdout 并立即阻断超限内容。 */ (data: Buffer) => {
          if (failure || finished) {
            return
          }
          if (command === 'proxy' && !inputSent) {
            stop('native_unsolicited_response')
            return
          }
          if (stdoutBytes + data.length > outputLimit) {
            stop('native_stdout_limit')
            return
          }
          stdoutBytes += data.length
          chunks.push(Buffer.from(data))
        }
      )
      child.stderr.on(
        'data',
        /* 仅累计 stderr 大小，超限即停止且不把内容放入普通错误。 */ (data: Buffer) => {
          if (failure || finished) {
            return
          }
          stderrBytes += data.length
          if (stderrBytes > limits.stderr_bytes) {
            stop('native_stderr_limit')
          }
        }
      )
      child.once(
        'spawn',
        /* 标记子进程已经启动，并调度可取消的输入准备。 */ () => {
          started = true
          void (
            /* 异步验证准备结果后，在同一同步栈复核许可并关闭 stdin 发送唯一请求。 */ (async () => {
              try {
                aborted(io.signal)
                const input = ready
                  ? await interruptible(ready(child, io.signal), io.signal)
                  : {
                      bytes: Buffer.alloc(0),
                      /* 只读发现和 schema 命令没有 RPC 请求，写入空 stdin 前无需派发许可。 */ beforeWrite() {}
                    }
                aborted(io.signal)
                if (!failure && !finished) {
                  // 最后一次 await 之后，在真正写入的同一同步栈内重查许可和 deadline。
                  input.beforeWrite()
                  aborted(io.signal)
                  inputSent = true
                  child.stdin.end(input.bytes)
                }
              } catch (error) {
                stop(
                  error instanceof LuvusAdapterError || error instanceof WireError
                    ? error.code
                    : 'native_host_unavailable'
                )
              }
            })()
          )
        }
      )
      child.once('close', finish)
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) {
        cancel()
      }
    }
  )
}
/** 在单一本地 socket 上发送一次准备好的帧，并按原始字节限制响应、等待 EOF 和传播取消。 */
export function runSocket(
  address: string,
  limit: number,
  signal: AbortSignal,
  ready: /* 验证已连接 socket 并返回带最终同步复核钩子的请求帧。 */ (
    socket: Socket,
    signal: AbortSignal
  ) => Promise<PreparedFrame>
): Promise<Buffer> {
  aborted(signal)
  return new Promise(
    /* 管理单次 socket 连接的输入、输出和终结，最多结算一次。 */ (resolve, reject) => {
      const io = lifecycle(signal)
      let written = false
      let ended = false
      let finished = false
      let size = 0
      const chunks: Buffer[] = []
      const socket = createConnection({ path: address })
      // TEMP-DEBUG（Windows e2e 排查，随后移除）
      const startedAt = Date.now()
      if (process.env.ROVLOOM_DEBUG_ERRORS) {
        socket.once('end', () =>
          process.stderr.write(`DBG_SOCKET end after ${Date.now() - startedAt}ms written=${written}\n`)
        )
        socket.once('connect', () => process.stderr.write(`DBG_SOCKET connect after ${Date.now() - startedAt}ms\n`))
      }
      /** 取消未完成准备并销毁本次 socket；写入后的错误一律保留结果未知。 */
      function finish(error?: string) {
        if (finished) {
          return
        }
        finished = true
        io.close()
        signal.removeEventListener('abort', cancel)
        socket.destroy()
        if (error) {
          reject(new LuvusAdapterError(error, written ? 'outcome_unknown' : 'not_dispatched'))
        } else {
          resolve(Buffer.concat(chunks, size))
        }
      }
      /** 根据上游信号中止 socket 等待，不发送原生撤销命令。 */
      function cancel() {
        finish(signal.reason === 'deadline' ? 'native_timeout' : 'native_cancelled')
      }
      socket.on('error', /* 将 socket 错误收敛为不含底层细节的传输错误。 */ () => finish('native_socket_error'))
      socket.on(
        'data',
        /* 拒绝请求前响应，按原始字节执行预算后缓存响应块。 */ (data: Buffer) => {
          if (!written) {
            finish('native_unsolicited_response')
          } else if (size + data.length > limit) {
            finish('native_stdout_limit')
          } else if (!finished) {
            size += data.length
            chunks.push(Buffer.from(data))
          }
        }
      )
      socket.once(
        'connect',
        /* 连接建立后调度受身份验证与生命周期约束的请求准备。 */ () => {
          void (
            /* 等待宿主准备后同步复核许可并写入一次帧；写入开始后失败保留结果未知。 */ (async () => {
              try {
                aborted(io.signal)
                const input = await interruptible(ready(socket, io.signal), io.signal)
                aborted(io.signal)
                if (!finished) {
                  input.beforeWrite()
                  aborted(io.signal)
                  // write 回调失败也不能证明 native 未收到部分或全部 frame。
                  written = true
                  socket.write(input.bytes)
                }
              } catch (error) {
                finish(
                  error instanceof LuvusAdapterError || error instanceof WireError
                    ? error.code
                    : 'native_host_unavailable'
                )
              }
            })()
          )
        }
      )
      socket.once(
        'end',
        /* 收到正常 EOF 后结束采集；尚未写入请求则报告派发前 EOF。 */ () => {
          ended = true
          finish(written ? undefined : 'native_eof_before_dispatch')
        }
      )
      socket.once(
        'close',
        /* 没有正常 EOF 就关闭连接时拒绝截断或异常结果。 */ () => {
          if (!ended) {
            finish('native_socket_closed')
          }
        }
      )
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) {
        cancel()
      }
    }
  )
}
