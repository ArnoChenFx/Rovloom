/** 固定 Herdr 本机安装和 session 路径，校验逐级权限、文件身份及运行进程绑定；不启动 runtime。 */
import { ChildProcess, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync
} from 'node:fs'
import { dirname, isAbsolute, join, normalize, sep } from 'node:path'
import { boundedJson, validateTarget } from '../../wire/index.js'
import type { V2Target } from '../../wire/types.js'
import type { NativePeer } from '../local/linux-peer.js'
import { pinTerminalExecution } from '../terminal-execution.js'
import { agentSearchPath } from '../local/agent-path.js'

export class HerdrLocalError extends Error {
  /** 区分未派发与可能已发送的失败，仅保留固定错误码。 */
  constructor(
    readonly code: string,
    readonly outcome: 'not_dispatched' | 'outcome_unknown' = 'not_dispatched'
  ) {
    super(code)
    this.name = 'HerdrLocalError'
  }
}

export type HerdrLocalConfig = Readonly<{
  target: V2Target & { profile: 'session' }
  binding_revision: number
  config_ref: string
  binary: string
  home: string
  config_home: string
  state_home: string
  cache_home: string
  temporary_home: string
  cwd: string
  // 默认关闭直接终端执行；本地显式开启不扩大 caller grants 或赋予操作系统权限。
  allow_terminal_execution?: boolean
  // 显式 Agent 安装目录列表只来自本地配置（含安装期固化的 PATH 条目），始终排在固定系统 PATH 之前。
  agent_bin_dirs?: readonly string[]
  // 附着用户已在运行的实例：config_home 是用户真实配置目录（常见 0755），不由产品创建或收紧；
  // 实例身份改由对端进程（可执行文件、命令行、启动时间）证明。省略即由产品自己拉起并拥有实例。
  attach?: true
}>
export type HerdrEndpoint = Readonly<{ address: string; stamp: string; uid: number }>

/** 只接受规范绝对路径，不能由方法参数提交路径、状态根或远程地址。 */
function canonical(path: string): void {
  if (typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path || path.includes('\0')) {
    throw new HerdrLocalError('herdr_local_path_invalid')
  }
}

/** 按当前 uid/系统根属主核对所有父目录，最后一项还须满足准确类型及权限（private=0700，shared=属主且不被组/其他写入）。 */
export function inspectHerdrPath(path: string, kind: 'directory' | 'shared_directory' | 'binary' | 'socket'): string {
  try {
    canonical(path)
    if (process.platform !== 'linux' || !process.geteuid || !process.getegid) {
      throw new HerdrLocalError('herdr_local_platform_unsupported')
    }
    const owner = process.geteuid()
    const rootOwner = lstatSync(sep).uid
    const paths = [path]
    while (paths[0] !== sep) {
      paths.unshift(dirname(paths[0]!))
    }
    const stamps: string[] = []
    for (const component of paths) {
      const entry = lstatSync(component, { bigint: true })
      const last = component === path
      const mode = Number(entry.mode & 0o777n)
      if (
        entry.isSymbolicLink() ||
        (mode & 0o022) !== 0 ||
        (entry.uid !== BigInt(owner) && entry.uid !== BigInt(rootOwner) && entry.uid !== 0n) ||
        (!last && !entry.isDirectory())
      ) {
        throw new HerdrLocalError('herdr_local_path_untrusted')
      }
      if (
        last &&
        (entry.uid !== BigInt(owner) ||
          (kind === 'directory' && (!entry.isDirectory() || mode !== 0o700)) ||
          // 用户真实目录：属主是当前用户且不被组/其他用户写入即可（上面的逐级检查已覆盖写位）。
          (kind === 'shared_directory' && !entry.isDirectory()) ||
          (kind === 'socket' && (!entry.isSocket() || mode !== 0o600)) ||
          (kind === 'binary' &&
            (!entry.isFile() ||
              (mode & 0o111) === 0 ||
              entry.nlink !== 1n ||
              (entry.mode & 0o6000n) !== 0n ||
              entry.size > 64n * 1024n * 1024n)))
      ) {
        throw new HerdrLocalError('herdr_local_path_untrusted')
      }
      stamps.push(
        [
          component,
          entry.dev,
          entry.ino,
          entry.uid,
          entry.mode,
          last ? entry.ctimeNs : '',
          last ? entry.size : ''
        ].join(':')
      )
    }
    return stamps.join('\n')
  } catch (cause) {
    throw cause instanceof HerdrLocalError ? cause : new HerdrLocalError('herdr_local_path_untrusted')
  }
}

/** 复制管理员配置，拒绝未声明字段与不能映射到安装版本地 session 的目标。 */
export function pinHerdrConfig(value: HerdrLocalConfig): HerdrLocalConfig {
  const config = JSON.parse(boundedJson(value, 16_384)) as HerdrLocalConfig
  pinTerminalExecution(config.allow_terminal_execution)
  agentSearchPath(config.agent_bin_dirs, '/usr/bin:/bin')
  validateTarget(config.target)
  const keys = [
    'target',
    'binding_revision',
    'config_ref',
    'binary',
    'home',
    'config_home',
    'state_home',
    'cache_home',
    'temporary_home',
    'cwd'
  ]
  if (
    Object.keys(config).some(
      /** 只接纳明确本地扩展，其余未知配置仍拒绝。 */ (key) =>
        !keys.includes(key) && key !== 'allow_terminal_execution' && key !== 'agent_bin_dirs' && key !== 'attach'
    ) ||
    keys.some(/** 任何配置项缺失都不能使用环境默认值。 */ (key) => !Object.hasOwn(config, key)) ||
    config.target.profile !== 'session' ||
    (Object.hasOwn(config, 'attach') && config.attach !== true) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(config.target.session) ||
    !Number.isSafeInteger(config.binding_revision) ||
    config.binding_revision <= 0 ||
    typeof config.config_ref !== 'string' ||
    !config.config_ref.length ||
    config.config_ref.length > 256
  ) {
    throw new HerdrLocalError('herdr_local_config_invalid')
  }
  for (const path of [
    config.binary,
    config.home,
    config.config_home,
    config.state_home,
    config.cache_home,
    config.temporary_home,
    config.cwd
  ]) {
    canonical(path)
  }
  Object.freeze(config.target)
  return Object.freeze(config)
}

/** 端点所在目录：default 会话直接位于 herdr 目录，其它会话在 sessions/<name> 下。 */
function endpointDirectory(config: HerdrLocalConfig): string {
  return config.target.session === 'default'
    ? join(config.config_home, 'herdr')
    : join(config.config_home, 'herdr', 'sessions', config.target.session)
}

/**
 * Herdr 自己新建目录会继承宿主 umask（常见 022 → 0755），而端点目录必须是 0700。
 * 启动前由产品逐级创建缺失的私有目录；已存在的目录不修改，仍由 inspectHerdrPath 严格复核。
 */
export function prepareHerdrEndpointDirectory(config: HerdrLocalConfig): void {
  const target = endpointDirectory(config)
  const missing: string[] = []
  for (let current = target; current !== config.config_home; current = dirname(current)) {
    try {
      lstatSync(current)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new HerdrLocalError('herdr_local_path_untrusted')
      }
      missing.unshift(current)
    }
  }
  for (const directory of missing) {
    mkdirSync(directory, { mode: 0o700 })
  }
}

/** 不遍历 session list，不使用 HERDR_SOCKET 等环境覆盖；仅推导此显式目标的官方路径。 */
export function herdrEndpoint(config: HerdrLocalConfig): HerdrEndpoint {
  const directory = endpointDirectory(config)
  const address = join(directory, 'herdr.sock')
  inspectHerdrPath(directory, config.attach ? 'shared_directory' : 'directory')
  return Object.freeze({ address, stamp: inspectHerdrPath(address, 'socket'), uid: process.geteuid!() })
}

/** 只导出本次配置的最小环境，普通发现不继承 SSH、模型凭据或 session/socket 覆盖。 */
export function herdrEnvironment(config: HerdrLocalConfig): NodeJS.ProcessEnv {
  return {
    PATH: agentSearchPath(config.agent_bin_dirs, '/usr/bin:/bin'),
    HOME: config.home,
    XDG_CONFIG_HOME: config.config_home,
    XDG_STATE_HOME: config.state_home,
    XDG_CACHE_HOME: config.cache_home,
    TMPDIR: config.temporary_home,
    TERM: 'xterm-256color',
    LANG: 'C.UTF-8',
    ...(config.attach
      ? // 附着/自建的是用户自己的会话：沿用用户的 shell 与 git 配置；SSH agent、API key 等环境变量仍不继承。
        { SHELL: userShell() }
      : {
          SHELL: '/bin/sh',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CEILING_DIRECTORIES: config.cwd
        })
  }
}

/** 用户的登录 shell（来自 Connector 自己的环境）；不是绝对路径或不存在则回退 /bin/sh。 */
function userShell(): string {
  const shell = process.env.SHELL
  try {
    return shell && isAbsolute(shell) && statSync(shell).isFile() ? shell : '/bin/sh'
  } catch {
    return '/bin/sh'
  }
}

/** 通过不跟随链接的同一 fd 求 hash，前后 stat 与路径身份均保持不变才接受安装。 */
export function measureHerdrInstallation(config: HerdrLocalConfig): Readonly<{ stamp: string; sha256: string }> {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new HerdrLocalError('herdr_local_platform_unsupported')
  }
  try {
    const before = inspectHerdrPath(config.binary, 'binary')
    const fd = openSync(config.binary, constants.O_RDONLY | constants.O_NOFOLLOW)
    let digest: string
    try {
      const initial = fstatSync(fd, { bigint: true })
      const hash = createHash('sha256')
      const chunk = Buffer.alloc(65_536)
      let total = 0
      for (;;) {
        const size = readSync(fd, chunk)
        if (!size) {
          break
        }
        total += size
        if (total > 64 * 1024 * 1024) {
          throw new HerdrLocalError('herdr_binary_limit')
        }
        hash.update(chunk.subarray(0, size))
      }
      const after = fstatSync(fd, { bigint: true })
      digest = hash.digest('hex')
      if (
        before !== inspectHerdrPath(config.binary, 'binary') ||
        initial.dev !== after.dev ||
        initial.ino !== after.ino ||
        initial.ctimeNs !== after.ctimeNs ||
        initial.size !== after.size ||
        initial.size !== BigInt(total)
      ) {
        throw new HerdrLocalError('herdr_binary_identity_changed')
      }
    } finally {
      closeSync(fd)
    }
    // 附着模式下 home/config/state/cache/cwd 都是用户真实目录（属主为当前用户、不被组/其他写入即可）；
    // 临时目录仍由产品私有创建。
    const runtime = config.attach ? 'shared_directory' : 'directory'
    for (const path of [config.home, config.config_home, config.state_home, config.cache_home, config.cwd]) {
      inspectHerdrPath(path, runtime)
    }
    inspectHerdrPath(config.temporary_home, 'directory')
    return { stamp: before, sha256: digest }
  } catch (cause) {
    throw cause instanceof HerdrLocalError ? cause : new HerdrLocalError('herdr_installation_untrusted')
  }
}

/** 核对实际安装身份，可选摘要来自受保护的本机配置，绝不使用预设发行版白名单。 */
export function verifyHerdrInstallation(config: HerdrLocalConfig, expectedSha256?: string): string {
  const measured = measureHerdrInstallation(config)
  if (expectedSha256 !== undefined && expectedSha256 !== measured.sha256) {
    throw new HerdrLocalError('herdr_binary_identity_changed')
  }
  return measured.stamp
}

const processBindingToken = Object.freeze({})
const processBindings = new WeakSet<HerdrProcessBinding>()
const attachedBindings = new WeakSet<HerdrAttachedBinding>()
let issueProcessBinding: ((config: HerdrLocalConfig, child: ChildProcess) => HerdrProcessBinding) | undefined
let issueAttachedBinding:
  | ((config: HerdrLocalConfig, process: ObservedHerdrProcess) => HerdrAttachedBinding)
  | undefined

/** 受信实例绑定：自己拉起的子进程，或经内核证据确认的已运行实例。 */
export type HerdrInstanceBinding = HerdrProcessBinding | HerdrAttachedBinding

/** 只有本模块签发的绑定才被接受；调用者自造的同形对象不会通过。 */
export function isHerdrInstanceBinding(value: unknown): value is HerdrInstanceBinding {
  return (
    (value instanceof HerdrProcessBinding && processBindings.has(value)) ||
    (value instanceof HerdrAttachedBinding && attachedBindings.has(value))
  )
}

/** 绑定显式宿主启动的同一 ChildProcess；路径前后 hash 与内核 peer PID 不等于 exec 映像 hash。 */
export class HerdrProcessBinding {
  readonly #process: ChildProcess
  readonly #config: HerdrLocalConfig
  readonly #pid: number
  #ended = false
  static {
    issueProcessBinding = /** 只有本模块核对启动前后安装身份后才能签发绑定。 */ (config, child) =>
      new HerdrProcessBinding(config, child, processBindingToken)
  }
  /** 只接受模块私有启动凭据，外部 ChildProcess 或伪造字段不能创建实例来源。 */
  private constructor(config: HerdrLocalConfig, child: ChildProcess, token: object) {
    if (token !== processBindingToken) {
      throw new HerdrLocalError('herdr_supervised_process_required')
    }
    this.#config = pinHerdrConfig(config)
    if (
      !(child instanceof ChildProcess) ||
      !child.pid ||
      child.exitCode !== null ||
      child.signalCode !== null ||
      child.spawnfile !== config.binary ||
      boundedJson(child.spawnargs) !== boundedJson([config.binary, '--session', config.target.session, 'server'])
    ) {
      throw new HerdrLocalError('herdr_supervised_process_required')
    }
    this.#process = child
    this.#pid = child.pid
    processBindings.add(this)
    child.once(
      'exit',
      /** 原进程结束后能力永久失效，不因 PID 重用恢复。 */ () => {
        this.#ended = true
      }
    )
    child.once(
      'error',
      /** 原进程监管出错也不能继续使用该实例绑定。 */ () => {
        this.#ended = true
      }
    )
  }
  /** 每次检查同一安装配置及原 ChildProcess 生命周期，原生 socket 连接还必须核对实际内核 peer。 */
  assert(config: HerdrLocalConfig, peer?: NativePeer): void {
    if (!processBindings.has(this)) {
      throw new HerdrLocalError('herdr_native_instance_untrusted')
    }
    if (
      this.#ended ||
      this.#process.pid !== this.#pid ||
      this.#process.exitCode !== null ||
      this.#process.signalCode !== null ||
      boundedJson(config) !== boundedJson(this.#config) ||
      (peer && (peer.pid !== this.#pid || peer.uid !== process.geteuid!() || peer.gid !== process.getegid!()))
    ) {
      throw new HerdrLocalError('herdr_native_instance_untrusted')
    }
  }
}

/** 已运行 Herdr 服务端进程的内核证据：PID 与启动 tick 共同防止 PID 重用被当作同一实例。 */
export type ObservedHerdrProcess = Readonly<{ pid: number; start: string }>

/** 读取 /proc/<pid>/stat 的状态与启动 tick；进程不存在或已成僵尸返回 undefined。 */
function readProcessStart(pid: number): string | undefined {
  try {
    const line = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = line
      .slice(line.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/u)
    if (['Z', 'X', 'x'].includes(fields[0]!) || !/^\d+$/u.test(fields[19] ?? '')) {
      return undefined
    }
    return fields[19]
  } catch {
    return undefined
  }
}

/**
 * 核对对端 PID 确实是本机已安装 herdr 的服务端进程：
 * 属主是当前用户；/proc/<pid>/exe 与配置的二进制是同一 inode（被替换/删除后的旧映像不接受）；
 * 命令行恰为 `server` 或 `--session <name> server`（用户自行运行 `herdr` 时由客户端拉起的形态）。
 */
export function inspectHerdrServerProcess(config: HerdrLocalConfig, pid: number): ObservedHerdrProcess {
  try {
    if (!Number.isSafeInteger(pid) || pid <= 0 || config.attach !== true) {
      throw new HerdrLocalError('herdr_native_instance_untrusted')
    }
    const start = readProcessStart(pid)
    const owner = statSync(`/proc/${pid}`).uid
    const executable = statSync(`/proc/${pid}/exe`)
    const installed = statSync(config.binary)
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
    if (argv.at(-1) === '') {
      argv.pop()
    }
    const tail = argv.slice(1)
    if (
      start === undefined ||
      owner !== process.geteuid!() ||
      executable.dev !== installed.dev ||
      executable.ino !== installed.ino ||
      !(
        (tail.length === 1 && tail[0] === 'server') ||
        (tail.length === 3 && tail[0] === '--session' && tail[1] === config.target.session && tail[2] === 'server')
      ) ||
      readProcessStart(pid) !== start
    ) {
      throw new HerdrLocalError('herdr_native_instance_untrusted')
    }
    return Object.freeze({ pid, start })
  } catch (cause) {
    throw cause instanceof HerdrLocalError ? cause : new HerdrLocalError('herdr_native_instance_untrusted')
  }
}

/** 绑定一个已运行的 Herdr 服务端：不拥有进程，只在其仍是同一实例时放行。 */
export class HerdrAttachedBinding {
  readonly #config: HerdrLocalConfig
  readonly #observed: ObservedHerdrProcess
  static {
    issueAttachedBinding = /** 只有核对过对端进程的 attach 模块能签发。 */ (config, observed) =>
      new HerdrAttachedBinding(config, observed, processBindingToken)
  }
  private constructor(config: HerdrLocalConfig, observed: ObservedHerdrProcess, token: object) {
    if (token !== processBindingToken || config.attach !== true) {
      throw new HerdrLocalError('herdr_native_instance_untrusted')
    }
    this.#config = pinHerdrConfig(config)
    this.#observed = observed
    attachedBindings.add(this)
  }
  /** 配置未变、实例仍是被确认的那个进程（PID 与启动 tick 都没变）；连接还须核对内核 peer。 */
  assert(config: HerdrLocalConfig, peer?: NativePeer): void {
    if (!attachedBindings.has(this)) {
      throw new HerdrLocalError('herdr_native_instance_untrusted')
    }
    if (
      boundedJson(config) !== boundedJson(this.#config) ||
      readProcessStart(this.#observed.pid) !== this.#observed.start ||
      (peer && (peer.pid !== this.#observed.pid || peer.uid !== process.geteuid!() || peer.gid !== process.getegid!()))
    ) {
      throw new HerdrLocalError('herdr_native_instance_untrusted')
    }
  }
  /** 被绑定的服务端进程 ID，仅供诊断与重新附着比较。 */
  get pid(): number {
    return this.#observed.pid
  }
}

/** 由 attach 模块在核对对端后签发；本模块不接受调用者自造的观察结果之外的任何来源。 */
export function bindAttachedHerdr(config: HerdrLocalConfig, observed: ObservedHerdrProcess): HerdrAttachedBinding {
  if (!issueAttachedBinding) {
    throw new HerdrLocalError('herdr_native_instance_untrusted')
  }
  return issueAttachedBinding(config, observed)
}

/** 显式宿主操作才启动固定实例；产品发现/open 不调用此入口，也不继承模型或 SSH 凭据。 */
export async function launchHerdrProcess(config: HerdrLocalConfig): Promise<{
  binding: HerdrProcessBinding
  child: ChildProcess
}> {
  const fixed = pinHerdrConfig(config)
  const installation = verifyHerdrInstallation(fixed)
  let child: ChildProcess | undefined
  try {
    prepareHerdrEndpointDirectory(fixed)
    const launched = spawn(fixed.binary, ['--session', fixed.target.session, 'server'], {
      cwd: fixed.cwd,
      env: herdrEnvironment(fixed),
      shell: false,
      stdio: 'ignore'
    })
    child = launched
    await new Promise<void>(
      /** 只等待本次直接子进程的 spawn；启动失败不会签发来源。 */ (resolve, reject) => {
        launched.once(
          'error',
          /** 消费晚到错误，不泄露系统路径或保留可用来源。 */ () =>
            reject(new HerdrLocalError('herdr_launch_unavailable'))
        )
        launched.once('spawn', /** spawn 只证明子进程已创建，安装与存活仍须在下方复核。 */ () => resolve())
      }
    )
    if (verifyHerdrInstallation(fixed) !== installation || !issueProcessBinding) {
      throw new HerdrLocalError('herdr_binary_identity_changed')
    }
    return Object.freeze({ binding: issueProcessBinding(fixed, launched), child: launched })
  } catch (cause) {
    // 未能建立来源时只结束本次显式启动的子进程；从不操作其它 Herdr 实例。
    child?.kill('SIGKILL')
    throw cause instanceof HerdrLocalError ? cause : new HerdrLocalError('herdr_launch_unavailable')
  }
}
