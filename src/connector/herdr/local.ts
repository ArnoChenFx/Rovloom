/** 固定 Herdr 本机安装和 session 路径，校验逐级权限、文件身份及运行进程绑定；不启动 runtime。 */
import { ChildProcess, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, sep } from 'node:path'
import { boundedJson, validateTarget } from '../../wire/index.js'
import type { V2Target } from '../../wire/types.js'
import type { NativePeer } from '../local/linux-peer.js'
import { HERDR_READONLY_REVIEW } from './review.js'

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
}>
export type HerdrEndpoint = Readonly<{ address: string; stamp: string; uid: number }>

/** 只接受规范绝对路径，不能由方法参数提交路径、状态根或远程地址。 */
function canonical(path: string): void {
  if (typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path || path.includes('\0')) {
    throw new HerdrLocalError('herdr_local_path_invalid')
  }
}

/** 按当前 uid/系统根属主核对所有父目录，最后一项还须满足准确类型及私有权限。 */
export function inspectHerdrPath(path: string, kind: 'directory' | 'binary' | 'socket'): string {
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
    Object.keys(config).length !== keys.length ||
    keys.some(/** 任何配置项缺失都不能使用环境默认值。 */ (key) => !Object.hasOwn(config, key)) ||
    config.target.profile !== 'session' ||
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

/** 不遍历 session list，不使用 HERDR_SOCKET 等环境覆盖；仅推导此显式目标的官方路径。 */
export function herdrEndpoint(config: HerdrLocalConfig): HerdrEndpoint {
  const directory =
    config.target.session === 'default'
      ? join(config.config_home, 'herdr')
      : join(config.config_home, 'herdr', 'sessions', config.target.session)
  const address = join(directory, 'herdr.sock')
  inspectHerdrPath(directory, 'directory')
  return Object.freeze({ address, stamp: inspectHerdrPath(address, 'socket'), uid: process.geteuid!() })
}

/** 只导出本次配置的最小环境，普通发现不继承 SSH、模型凭据或 session/socket 覆盖。 */
export function herdrEnvironment(config: HerdrLocalConfig): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin',
    HOME: config.home,
    XDG_CONFIG_HOME: config.config_home,
    XDG_STATE_HOME: config.state_home,
    XDG_CACHE_HOME: config.cache_home,
    TMPDIR: config.temporary_home,
    TERM: 'xterm-256color',
    SHELL: '/bin/sh',
    LANG: 'C.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CEILING_DIRECTORIES: config.cwd
  }
}

/** 通过不跟随链接的同一 fd 求 hash，前后 stat 与路径身份均保持不变才接受安装。 */
export function verifyHerdrInstallation(config: HerdrLocalConfig): string {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new HerdrLocalError('herdr_local_platform_unsupported')
  }
  try {
    const before = inspectHerdrPath(config.binary, 'binary')
    const fd = openSync(config.binary, constants.O_RDONLY | constants.O_NOFOLLOW)
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
      if (
        hash.digest('hex') !== HERDR_READONLY_REVIEW.binary_sha256 ||
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
    for (const path of [
      config.home,
      config.config_home,
      config.state_home,
      config.cache_home,
      config.temporary_home,
      config.cwd
    ]) {
      inspectHerdrPath(path, 'directory')
    }
    return before
  } catch (cause) {
    throw cause instanceof HerdrLocalError ? cause : new HerdrLocalError('herdr_installation_untrusted')
  }
}

const processBindingToken = Object.freeze({})
const processBindings = new WeakSet<HerdrProcessBinding>()
let issueProcessBinding: ((config: HerdrLocalConfig, child: ChildProcess) => HerdrProcessBinding) | undefined

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

/** 显式宿主操作才启动固定实例；产品发现/open 不调用此入口，也不继承模型或 SSH 凭据。 */
export async function launchHerdrProcess(config: HerdrLocalConfig): Promise<{
  binding: HerdrProcessBinding
  child: ChildProcess
}> {
  const fixed = pinHerdrConfig(config)
  const installation = verifyHerdrInstallation(fixed)
  let child: ChildProcess | undefined
  try {
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
