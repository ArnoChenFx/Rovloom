/** 持有开发启动的直接子进程与 Linux pidfd，核对启动身份并只终止自己拥有的实例。 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { lstatSync, readFileSync, readlinkSync, statSync } from 'node:fs'
import { dirname, sep } from 'node:path'
import { childEnvironment } from '../connector/luvus/local.js'
import { LuvusAdapterError } from '../connector/luvus/types.js'
import type { LuvusLocalConfig } from '../connector/luvus/types.js'

type Libc = {
  symbols: {
    pidfd_open(pid: number, flags: number): number
    pidfd_send_signal(fd: number, signal: number, info: number, flags: number): number
    poll(buffer: number, count: number, timeout: number): number
    close(fd: number): number
  }
}
type Ffi = {
  dlopen(path: string, symbols: Record<string, { args: string[]; returns: string }>): Libc
  ptr(buffer: Uint8Array): number
}

/** 对路径链逐层检查归属与可写性；目录 ctime 的正常内容变化不改变其身份。 */
export function ownedPathStamp(path: string, kind: 'directory' | 'binary' | 'socket'): string {
  const paths = [path]
  while (paths[0] !== sep) {
    paths.unshift(dirname(paths[0]!))
  }
  const rootOwner = lstatSync(sep, { bigint: true }).uid
  const uid = BigInt(process.geteuid!())
  const stamps: string[] = []
  for (const component of paths) {
    const info = lstatSync(component, { bigint: true })
    const last = component === path
    const mode = Number(info.mode & 0o777n)
    if (
      info.isSymbolicLink() ||
      (mode & 0o022) !== 0 ||
      (info.uid !== uid && info.uid !== 0n && info.uid !== rootOwner) ||
      (!last && !info.isDirectory()) ||
      (last && kind === 'directory' && (!info.isDirectory() || info.uid !== uid || mode !== 0o700)) ||
      (last && kind === 'socket' && (!info.isSocket() || info.uid !== uid || mode !== 0o600)) ||
      (last && kind === 'binary' && (!info.isFile() || (mode & 0o111) === 0 || (info.mode & 0o6000n) !== 0n))
    ) {
      throw new LuvusAdapterError('owned_path_untrusted')
    }
    stamps.push(
      [
        component,
        info.dev,
        info.ino,
        info.uid,
        info.gid,
        info.mode,
        last && kind !== 'directory' ? info.size : '',
        last && kind !== 'directory' ? info.ctimeNs : ''
      ].join(':')
    )
  }
  return stamps.join('\n')
}

/** 读取内核启动时钟与完整 argv/env/cwd/exe；不从 session discovery 中采信 PID。 */
function processStamp(pid: number, config: LuvusLocalConfig): string {
  const prefix = '/proc/' + pid
  const line = readFileSync(prefix + '/stat', 'utf8')
  const fields = line
    .slice(line.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/u)
  const start = fields[19]
  const state = fields[0]
  const expectedArgs = [config.binary, '--session', config.target.session, 'server'].join('\0') + '\0'
  const expectedEnv = Object.entries(childEnvironment(config))
    .map(/* 固定环境只接受本模块列明的键和值，不继承宿主凭据。 */ ([key, value]) => key + '=' + value)
    .sort()
    .join('\0')
  const actualEnv = readFileSync(prefix + '/environ', 'utf8')
    .split('\0')
    .filter(Boolean)
    .sort()
    .join('\0')
  const binary = lstatSync(config.binary, { bigint: true })
  const executable = statSync(prefix + '/exe', { bigint: true })
  if (
    !start ||
    !/^\d+$/u.test(start) ||
    ['Z', 'X', 'x'].includes(state!) ||
    readlinkSync(prefix + '/exe') !== config.binary ||
    readlinkSync(prefix + '/cwd') !== config.cwd ||
    readFileSync(prefix + '/cmdline', 'utf8') !== expectedArgs ||
    actualEnv !== expectedEnv ||
    executable.dev !== binary.dev ||
    executable.ino !== binary.ino ||
    executable.uid !== binary.uid
  ) {
    throw new LuvusAdapterError('owned_process_identity_changed')
  }
  return start
}

/** 受控 child/pidfd 的内部所有者；构造失败也不向调用方交付可伪造的进程快照。 */
export class OwnedNativeProcess {
  readonly #config: LuvusLocalConfig
  readonly #ffi: Ffi
  readonly #libc: Libc
  readonly #child: ChildProcess
  readonly #binary: string
  readonly #directories: readonly [string, string][]
  readonly #exited: Promise<void>
  #pidfd = -1
  #gone = false
  #start: string | undefined
  #closing: Promise<void> | undefined

  /** 在固定 argv/env/cwd 下直接 spawn 并立即持有 pidfd，拒绝旧 PID 的重新认领。 */
  constructor(config: LuvusLocalConfig) {
    this.#config = config
    this.#binary = ownedPathStamp(config.binary, 'binary')
    this.#directories = [
      config.state_root,
      config.home,
      config.cwd,
      ...['config', 'data', 'cache', 'runtime'].map(
        /* 绑定每个隔离 XDG 目录的实际 inode。 */ (name) => config.home + '/' + name
      )
    ].map(/* 固定目录身份用于后续同步复核。 */ (path) => [path, ownedPathStamp(path, 'directory')])
    this.#ffi = createRequire(import.meta.url)('bun:ffi') as Ffi
    this.#libc = this.#ffi.dlopen('libc.so.6', {
      pidfd_open: { args: ['int', 'u32'], returns: 'int' },
      pidfd_send_signal: { args: ['int', 'int', 'ptr', 'u32'], returns: 'int' },
      poll: { args: ['ptr', 'u64', 'int'], returns: 'int' },
      close: { args: ['int'], returns: 'int' }
    })
    this.#child = spawn(config.binary, ['--session', config.target.session, 'server'], {
      cwd: config.cwd,
      env: childEnvironment(config),
      shell: false,
      stdio: 'ignore'
    })
    this.#exited = new Promise(
      /* 永久保留直接 child 退出事实，绝不重启或重新认领。 */ (resolve) => {
        this.#child.once(
          'exit',
          /* 退出后本来源永久失效。 */ () => {
            this.#gone = true
            resolve()
          }
        )
        this.#child.once(
          'error',
          /* 启动失败也终结该实例，不泄露 OS 错误内容。 */ () => {
            this.#gone = true
            resolve()
          }
        )
      }
    )
    if (Number.isInteger(this.#child.pid)) {
      this.#pidfd = this.#libc.symbols.pidfd_open(this.#child.pid!, 0)
    }
  }

  /** 完成 spawn 后记录真实启动身份；缺 pidfd 时仅清理这次未交付的 child。 */
  async started(): Promise<void> {
    if (this.#pidfd < 0) {
      this.#child.kill('SIGKILL')
      await this.#exited
      throw new LuvusAdapterError('owned_pidfd_unavailable')
    }
    // spawn 返回时 /proc/exe 可能仍在 exec 切换，等待 Node 的 spawn 通知再固定身份。
    await new Promise<void>(
      /* 只等待本次 child 启动或失败。 */ (resolve, reject) => {
        this.#child.once('spawn', resolve)
        this.#child.once('error', /* 错误只转为安全码。 */ () => reject(new LuvusAdapterError('owned_spawn_failed')))
      }
    )
    this.#start = processStamp(this.#child.pid!, this.#config)
    this.assertLive()
  }

  /** 逐次检查 pidfd、退出事实、路径及内核启动身份，不能用 uid 相等代替归属。 */
  assertLive(): void {
    try {
      if (
        this.#gone ||
        this.#closing ||
        this.#pidfd < 0 ||
        !this.#start ||
        this.#child.exitCode !== null ||
        this.#child.signalCode !== null
      ) {
        throw new LuvusAdapterError('owned_process_unavailable')
      }
      const poll = Buffer.alloc(8)
      poll.writeInt32LE(this.#pidfd)
      poll.writeInt16LE(1, 4)
      if (
        this.#libc.symbols.poll(this.#ffi.ptr(poll), 1, 0) !== 0 ||
        ownedPathStamp(this.#config.binary, 'binary') !== this.#binary ||
        processStamp(this.#child.pid!, this.#config) !== this.#start
      ) {
        throw new LuvusAdapterError('owned_process_identity_changed')
      }
      for (const [path, stamp] of this.#directories) {
        if (ownedPathStamp(path, 'directory') !== stamp) {
          throw new LuvusAdapterError('owned_process_identity_changed')
        }
      }
    } catch (error) {
      throw error instanceof LuvusAdapterError ? error : new LuvusAdapterError('owned_process_unavailable')
    }
  }

  /** 返回直接 child 的内核对照身份；调用前必须仍通过启动身份核验。 */
  identity(): { pid: number; uid: number; gid: number } {
    this.assertLive()
    return { pid: this.#child.pid!, uid: process.geteuid!(), gid: process.getegid!() }
  }

  /** 通过持续持有的 pidfd 终止自有实例；幂等关闭不会按 discovery PID 杀进程。 */
  close(): Promise<void> {
    this.#closing ??= this.#stop()
    return this.#closing
  }

  /** 为本次 child 提供有界优雅退出和强制退出，退出确认后关闭 pidfd。 */
  async #stop(): Promise<void> {
    try {
      if (!this.#gone && this.#pidfd >= 0) {
        this.#libc.symbols.pidfd_send_signal(this.#pidfd, 15, 0, 0)
        const timer = setTimeout(
          /* 宽限后仍只对同一 pidfd 发送强制结束。 */ () => {
            if (!this.#gone && this.#pidfd >= 0) {
              this.#libc.symbols.pidfd_send_signal(this.#pidfd, 9, 0, 0)
            }
          },
          500
        )
        try {
          await this.#exited
        } finally {
          clearTimeout(timer)
        }
      }
    } finally {
      if (this.#pidfd >= 0) {
        this.#libc.symbols.close(this.#pidfd)
        this.#pidfd = -1
      }
    }
  }
}
