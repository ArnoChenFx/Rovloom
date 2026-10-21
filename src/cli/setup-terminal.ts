// 初始化只从当前文件所有者的真实本地终端取得确认；非TTY不读取stdin、不发放初始化权限。
import { isatty } from 'node:tty'
import { userInfo } from 'node:os'
import { Writable } from 'node:stream'
import { createInterface, type Interface } from 'node:readline/promises'
import { windowsCurrentUserSid } from '../platform/windows.js'
import { CliCancelled, CliError, readConfig, type RoleConfig } from './config.js'
import type { CliIo } from './run.js'

// 使用内核TTY事实，流对象上的isTTY自报或来自网络的JSON均不能成为本地确认。
export function hasLocalTerminal(io: CliIo): boolean {
  const input = (io.stdin as typeof process.stdin).fd
  const output = (io.stderr as typeof process.stderr).fd
  return Number.isSafeInteger(input) && Number.isSafeInteger(output) && isatty(input) && isatty(output)
}

export class SetupTerminal {
  readonly actor: string
  readonly uid: number
  // Windows 没有 uid：以进程令牌的用户 SID 作为所有者身份，每个批准边界复验。
  readonly sid: string | undefined
  readonly #reader: Interface
  readonly #output: Writable
  #muted = false
  #closed = false
  #questionsClosed = false
  #queue: Promise<unknown> = Promise.resolve()

  // 仅open在真实UID、TTY和已有私有角色文件均核对后构造；不从配置反序列化确认对象。
  private constructor(
    readonly configPath: string,
    readonly config: RoleConfig,
    readonly io: CliIo
  ) {
    this.uid = process.platform === 'win32' ? -1 : userInfo().uid
    this.sid = process.platform === 'win32' ? windowsCurrentUserSid() : undefined
    this.actor = 'operator_' + (this.sid ?? this.uid)
    this.assertOwner()
    this.#output = new Writable({
      // 配对码输入不回显；只转交固定提示，不转发secret到标准输出或诊断日志。
      write: (chunk, _encoding, callback) => {
        if (!this.#muted) {
          io.stderr.write(chunk)
        }
        callback()
      }
    })
    this.#reader = createInterface({ input: io.stdin, output: this.#output, terminal: true })
    this.#reader.on('SIGINT', this.#interrupt)
    io.signal.addEventListener('abort', this.#abort, { once: true })
  }

  // 非交互返回空值，调用方继续使用明确setup-required；不会静默降级成允许。
  static open(path: string, config: RoleConfig, io: CliIo): SetupTerminal | undefined {
    return hasLocalTerminal(io) ? new SetupTerminal(path, config, io) : undefined
  }

  // 每个批准边界复验实际进程UID、TTY、终止信号及同一角色/数据根，不依赖SUDO或环境自报。
  assertOwner(): void {
    if (this.io.signal.aborted) {
      throw new CliCancelled()
    }
    if (this.#closed || !hasLocalTerminal(this.io) || !this.#ownerUnchanged()) {
      throw new CliError('configuration_required')
    }
    const current = readConfig(this.configPath)
    if (current.role !== this.config.role || current.state_dir !== this.config.state_dir) {
      throw new CliError('configuration_required')
    }
  }

  // Linux：真实 uid/euid 未变；Windows：令牌用户 SID 未变。其它平台没有等价证据，一律拒绝。
  #ownerUnchanged(): boolean {
    if (process.platform === 'win32') {
      return this.sid !== undefined && windowsCurrentUserSid() === this.sid
    }
    const user = userInfo()
    return (
      process.platform === 'linux' &&
      user.uid >= 0 &&
      user.uid === this.uid &&
      process.getuid?.() === this.uid &&
      process.geteuid?.() === this.uid
    )
  }

  // 串行化本地问题，避免收据回调与启动提示同时消费一行用户输入。
  ask(prompt: string, secret = false, signal = this.io.signal): Promise<string> {
    const active = AbortSignal.any([signal, this.io.signal])
    const operation = this.#queue.then(
      /* 前一问题收尾后再核对当前所有者。 */ async () => {
        this.assertOwner()
        if (this.#questionsClosed || active.aborted) {
          throw new CliError('configuration_required')
        }
        try {
          if (secret) {
            this.io.stderr.write(prompt)
            this.#muted = true
          }
          let answer: string
          try {
            answer = await this.#reader.question(secret ? '' : prompt, { signal: active })
          } catch (error) {
            if (
              this.io.signal.aborted &&
              (error === active.reason || (error instanceof Error && error.name === 'AbortError'))
            ) {
              throw new CliCancelled()
            }
            throw error
          }
          this.assertOwner()
          if (active.aborted) {
            throw new CliError('configuration_required')
          }
          return answer.trim()
        } finally {
          this.#muted = false
          if (secret) {
            this.io.stderr.write('\n')
          }
        }
      }
    )
    this.#queue = operation.catch(/* 后续问题可继续排队，原调用方仍观察实际失败。 */ () => {})
    return operation
  }

  // 管理确认必须是当前终端用户明确输入yes/y，空输入不代表批准。
  async confirm(description: string, signal = this.io.signal): Promise<boolean> {
    const answer = (await this.ask(description + ' [y/N] ', false, signal)).toLowerCase()
    return answer === 'y' || answer === 'yes'
  }

  // secret仅交付已核验的本机TTY；角色stdout、网络错误与普通诊断不能调用此通道。
  show(text: string): void {
    this.assertOwner()
    this.io.stderr.write(text)
  }

  // 同一实例持有终止回调，正常关闭时能移除监听并恢复终端模式。
  readonly #abort = () => this.close()

  // readline原始模式的Ctrl-C交给唯一进程信号处理器，统一中止问题、恢复终端并关闭角色资源。
  readonly #interrupt = () => {
    process.kill(process.pid, 'SIGINT')
  }

  // 问答结束时恢复普通终端模式；已批准操作仍须逐次核对真实所有者和中止状态。
  finishQuestions(): void {
    if (!this.#questionsClosed) {
      this.#questionsClosed = true
      this.#reader.off('SIGINT', this.#interrupt)
      this.#reader.close()
      void this.#queue.then(
        /* readline的abort回调仍会写终端收尾，问题结算后才结束本实例的包装输出。 */ () => {
          this.#output.end()
        }
      )
    }
  }

  // 关闭自己的readline和包装输出，不关闭进程共享stdin/stderr。
  close(): void {
    if (this.#closed) {
      return
    }
    this.#closed = true
    this.io.signal.removeEventListener('abort', this.#abort)
    this.finishQuestions()
  }
}
