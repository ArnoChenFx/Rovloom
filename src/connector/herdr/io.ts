/** 管理 Herdr 固定 CLI 命令及单请求 Unix socket 的有界 IO，仅清理所属桥接资源。 */
import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import type { Socket } from 'node:net'
import { HerdrLocalError, herdrEnvironment, inspectHerdrPath, verifyHerdrInstallation } from './local.js'
import type { HerdrEndpoint, HerdrLocalConfig } from './local.js'
import { HERDR_READONLY_REVIEW } from './review.js'

const stoppedCommandCancellations = new WeakSet<HerdrLocalError>()

/** 只有未启动固定命令或已经观察到原child close时签发；JSON和普通同码错误不能伪造清理完成。 */
function stoppedCommandCancellation(): HerdrLocalError {
  const error = new HerdrLocalError('herdr_cancelled')
  stoppedCommandCancellations.add(error)
  return error
}

/** 供CLI区分已确认固定命令回收的取消与真正IO/清理失败，不依据signal.aborted统一吞错。 */
export function isStoppedHerdrCommandCancellation(error: unknown): boolean {
  return error instanceof HerdrLocalError && stoppedCommandCancellations.has(error)
}

/** 仅用于spawn前和确认close后的检查，此处取消时没有尚待确认回收的固定命令。 */
function checkCommandSignal(signal: AbortSignal): void {
  if (signal.aborted && signal.reason !== 'deadline') {
    throw stoppedCommandCancellation()
  }
  checkHerdrSignal(signal)
}

/** 将已中止状态转换为本地错误，不向 Herdr 发送通用 cancel 或其它控制方法。 */
export function checkHerdrSignal(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new HerdrLocalError(signal.reason === 'deadline' ? 'herdr_timeout' : 'herdr_cancelled')
  }
}

/** 为本次等待建立绝对本地上限，close 仅撤销这次等待。 */
export function herdrDeadline(parent: AbortSignal | undefined, milliseconds: number) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0 || milliseconds > 600_000) {
    throw new HerdrLocalError('herdr_deadline_invalid')
  }
  const controller = new AbortController()
  const cancel = /** 只传播桥接中止，不暗示原生工作已停止。 */ () =>
    controller.abort(parent?.reason === 'deadline' ? 'deadline' : 'cancelled')
  parent?.addEventListener('abort', cancel, { once: true })
  if (parent?.aborted) {
    cancel()
  }
  const timer = setTimeout(/** 期限到达后拒绝继续写入或等待。 */ () => controller.abort('deadline'), milliseconds)
  return {
    signal: controller.signal,
    /** 清理计时器及所属监听，阻止准备回调在范围关闭后继续使用 IO。 */
    close() {
      clearTimeout(timer)
      parent?.removeEventListener('abort', cancel)
      controller.abort('closed')
    }
  }
}

/** 只允许版本和 schema 两个静态命令；既不枚举其它 session，也不执行 shell。 */
export function runHerdrCommand(
  config: HerdrLocalConfig,
  command: 'version' | 'schema',
  signal: AbortSignal
): Promise<Buffer> {
  checkCommandSignal(signal)
  if (command !== 'version' && command !== 'schema') {
    throw new HerdrLocalError('herdr_cli_command_invalid')
  }
  const installation = verifyHerdrInstallation(config)
  checkCommandSignal(signal)
  const argv = command === 'version' ? ['--version'] : ['api', 'schema', '--json']
  return new Promise(
    /** 有界收集本次 CLI 输出，清理后才结算，不泄露 stderr 原文。 */ (resolve, reject) => {
      const child = spawn(config.binary, argv, {
        cwd: config.cwd,
        env: herdrEnvironment(config),
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const chunks: Buffer[] = []
      let bytes = 0
      let stderr = 0
      let failure: string | undefined
      let done = false
      let kill: ReturnType<typeof setTimeout> | undefined
      let final: ReturnType<typeof setTimeout> | undefined
      /** 等待自有子进程关闭或最终清理期限，所有出口只保留固定错误码。 */
      function finish(code: number | null, exited = false) {
        if (done) {
          return
        }
        done = true
        clearTimeout(kill)
        clearTimeout(final)
        signal.removeEventListener('abort', cancel)
        if (failure || code !== 0) {
          reject(
            !exited
              ? new HerdrLocalError('herdr_cli_cleanup_unconfirmed')
              : failure === 'herdr_cancelled'
                ? stoppedCommandCancellation()
                : new HerdrLocalError(failure ?? 'herdr_cli_exit')
          )
        } else {
          try {
            checkCommandSignal(signal)
            if (verifyHerdrInstallation(config) !== installation) {
              throw new HerdrLocalError('herdr_binary_identity_changed')
            }
            resolve(Buffer.concat(chunks, bytes))
          } catch (cause) {
            reject(cause instanceof HerdrLocalError ? cause : new HerdrLocalError('herdr_binary_identity_changed'))
          }
        }
      }
      /** 只终止本次静态命令进程；不停止受监管的 Herdr server。 */
      function stop(code: string) {
        if (done || failure) {
          return
        }
        failure = code
        child.stdout.destroy()
        child.stderr.destroy()
        child.kill('SIGTERM')
        kill = setTimeout(/** 宽限后结束自己的静态命令。 */ () => child.kill('SIGKILL'), 100)
        final = setTimeout(
          /** 最终期限撤销等待，晚到 close 不能二次结算。 */ () => {
            child.kill('SIGKILL')
            finish(null)
          },
          500
        )
      }
      /** 上游取消只关闭本次 CLI 导出。 */
      function cancel() {
        stop(signal.reason === 'deadline' ? 'herdr_timeout' : 'herdr_cancelled')
      }
      child.once('error', /** 不输出 spawn 错误中的路径或环境。 */ () => stop('herdr_cli_unavailable'))
      child.stdout.on('error', /** stdout 失败不能获得部分 schema。 */ () => stop('herdr_cli_io'))
      child.stderr.on('error', /** stderr 失败也必须清理当前导出。 */ () => stop('herdr_cli_io'))
      child.stdout.on(
        'data',
        /** 原始输出计量在解析之前，不能静默截断大 schema。 */ (chunk: Buffer) => {
          if (done || failure) {
            return
          }
          bytes += chunk.length
          if (bytes > (command === 'schema' ? 524_288 : 4096)) {
            stop('herdr_cli_output_limit')
          } else {
            chunks.push(chunk)
          }
        }
      )
      child.stderr.on(
        'data',
        /** 诊断原文不进入产品结果或普通日志。 */ (chunk: Buffer) => {
          stderr += chunk.length
          if (stderr > 32_768) {
            stop('herdr_cli_stderr_limit')
          }
        }
      )
      child.once('close', /** close 后所有管道已关闭，保留命令实际退出结果。 */ (code) => finish(code, true))
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) {
        cancel()
      }
    }
  )
}

/** 同一 endpoint 的路径身份在连接前后及回调返回后均须保持不变；peer 另由宿主从实际连接核对。 */
function assertEndpoint(endpoint: HerdrEndpoint): void {
  if (endpoint.uid !== process.geteuid?.() || inspectHerdrPath(endpoint.address, 'socket') !== endpoint.stamp) {
    throw new HerdrLocalError('herdr_endpoint_identity_changed')
  }
}

/** 打开唯一已核对的 endpoint，回调只获得这条实际连接，不接受 JSON 自报 peer。 */
export function withHerdrSocket<T>(
  endpoint: HerdrEndpoint,
  signal: AbortSignal,
  use: (socket: Socket) => Promise<T>
): Promise<T> {
  checkHerdrSignal(signal)
  assertEndpoint(endpoint)
  return new Promise(
    /** 关联连接、回调及上游取消，所有出口销毁当前 socket 并消费晚到拒绝。 */ (resolve, reject) => {
      const socket = createConnection({ path: endpoint.address })
      let done = false
      /** 清理同一 socket 的资源，不执行任何原生控制请求。 */
      function finish(result: { ok: true; value: T } | { ok: false; error: unknown }) {
        if (done) {
          return
        }
        done = true
        signal.removeEventListener('abort', cancel)
        socket.destroy()
        if (!result.ok) {
          reject(result.error)
        } else {
          resolve(result.value)
        }
      }
      /** 上游取消关闭桥接；是否已发送由上层记录并报告 unknown。 */
      function cancel() {
        finish({
          ok: false,
          error: new HerdrLocalError(signal.reason === 'deadline' ? 'herdr_timeout' : 'herdr_cancelled')
        })
      }
      socket.once(
        'error',
        /** 系统路径和底层错误不进入结果。 */ () => finish({ ok: false, error: new HerdrLocalError('herdr_socket_io') })
      )
      socket.once(
        'connect',
        /** 连接后才测量内核 peer，回调的晚到异常始终被消费。 */ () => {
          if (done) {
            return
          }
          Promise.resolve()
            .then(
              /** 不允许取消或路径替换后继续准备原生写入。 */ () => {
                checkHerdrSignal(signal)
                assertEndpoint(endpoint)
                return use(socket)
              }
            )
            .then(
              /** 回调成功也须复核路径并清理当前连接。 */ (value) => {
                if (done) {
                  return
                }
                try {
                  checkHerdrSignal(signal)
                  assertEndpoint(endpoint)
                  finish({ ok: true, value })
                } catch (cause) {
                  finish({ ok: false, error: cause })
                }
              },
              /** 即使拒绝值为空也必须保持失败，不留下未处理拒绝或仍可写的连接。 */ (error: unknown) =>
                finish({ ok: false, error })
            )
        }
      )
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) {
        cancel()
      }
    }
  )
}

export type HerdrPreparedRequest = Readonly<{
  bytes: Uint8Array
  /** 紧贴唯一同步 write 的最终宿主核验及派发标记；失败不得写入。 */
  beforeWrite(): void
}>

/** 已结束或尚未连接的流不能进入最终派发标记；此检查不替代 peer 与策略核验。 */
function assertOpenSocket(socket: Socket): void {
  if (socket.destroyed || socket.connecting || !socket.writable || socket.readableEnded) {
    throw new HerdrLocalError('herdr_socket_eof')
  }
}

/** 在写入前安装完整帧/EOF 接收边界，随后同步准备唯一请求并写入；不重试。 */
export function exchangeHerdr(
  socket: Socket,
  signal: AbortSignal,
  prepare: () => HerdrPreparedRequest
): Promise<Buffer> {
  checkHerdrSignal(signal)
  assertOpenSocket(socket)
  return new Promise(
    /** 只有完整单行和实际 EOF 才产生回复，部分数据和超限均失败。 */ (resolve, reject) => {
      const chunks: Buffer[] = []
      let bytes = 0
      let done = false
      let writing = false
      /** 解绑本次读取监听，不关闭其它实例或补造响应。 */
      function finish(failure?: HerdrLocalError) {
        if (done) {
          return
        }
        done = true
        signal.removeEventListener('abort', cancel)
        socket.removeListener('data', data)
        socket.removeListener('end', end)
        socket.removeListener('close', close)
        socket.removeListener('error', error)
        if (failure) {
          reject(failure)
        } else {
          resolve(Buffer.concat(chunks, bytes))
        }
      }
      /** 原始字节超限立即停止，不靠重新序列化缩小响应。 */
      function data(chunk: Buffer) {
        if (!Buffer.isBuffer(chunk)) {
          finish(new HerdrLocalError('herdr_socket_io'))
          return
        }
        bytes += chunk.length
        if (bytes > HERDR_READONLY_REVIEW.frame_bytes) {
          finish(new HerdrLocalError('herdr_response_limit'))
        } else {
          chunks.push(chunk)
        }
      }
      /** 断线没有结果，只有单条完整原生 JSON LF 才可交给 codec。 */
      function end() {
        const raw = Buffer.concat(chunks, bytes)
        if (!raw.length || raw.at(-1) !== 10 || raw.subarray(0, -1).includes(10)) {
          finish(new HerdrLocalError('herdr_native_framing'))
        } else {
          finish()
        }
      }
      /** 未观察到 end 的关闭不能伪造成回复成功。 */
      function close() {
        if (!done) {
          finish(new HerdrLocalError('herdr_socket_eof'))
        }
      }
      /** 读取错误只返回固定码。 */
      function error() {
        finish(new HerdrLocalError('herdr_socket_io'))
      }
      /** 中止不提供原生执行回滚保证。 */
      function cancel() {
        finish(new HerdrLocalError(signal.reason === 'deadline' ? 'herdr_timeout' : 'herdr_cancelled'))
      }
      socket.on('data', data)
      socket.once('end', end)
      socket.once('close', close)
      socket.once('error', error)
      signal.addEventListener('abort', cancel, { once: true })
      try {
        checkHerdrSignal(signal)
        const prepared = prepare()
        if (!(prepared.bytes instanceof Uint8Array) || typeof prepared.beforeWrite !== 'function') {
          throw new HerdrLocalError('herdr_prepare_rejected')
        }
        if (prepared.bytes.byteLength === 0 || prepared.bytes.byteLength > HERDR_READONLY_REVIEW.frame_bytes) {
          throw new HerdrLocalError('herdr_request_framing')
        }
        const request = Buffer.from(prepared.bytes)
        if (
          !request.length ||
          request.length > HERDR_READONLY_REVIEW.frame_bytes ||
          request.at(-1) !== 10 ||
          request.subarray(0, -1).includes(10)
        ) {
          throw new HerdrLocalError('herdr_request_framing')
        }
        checkHerdrSignal(signal)
        if (done) {
          return
        }
        assertOpenSocket(socket)
        const ready: unknown = prepared.beforeWrite()
        if (ready !== undefined) {
          if (ready instanceof Promise) {
            void ready.catch(/** 消费违反同步契约的晚到拒绝，但不等待或允许写入。 */ () => {})
          }
          throw new HerdrLocalError('herdr_prepare_rejected')
        }
        checkHerdrSignal(signal)
        if (done) {
          return
        }
        assertOpenSocket(socket)
        writing = true
        socket.write(request)
      } catch (cause) {
        finish(
          cause instanceof HerdrLocalError
            ? cause
            : new HerdrLocalError(writing ? 'herdr_socket_io' : 'herdr_prepare_rejected')
        )
      }
    }
  )
}
