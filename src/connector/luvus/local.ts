/** 校验固定安装、私有路径与 endpoint 归属，构造隔离环境和受限命令参数。 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'
import { DEFAULT_LIMITS } from '../../native-contract/index.js'
import { boundedJson, LIMITS, validateTarget } from '../../wire/index.js'
import { LuvusAdapterError } from './types.js'
import { pinTerminalExecution } from '../terminal-execution.js'
import { agentSearchPath } from '../local/agent-path.js'
import type { EndpointIdentity, LuvusLocalConfig, LuvusLocalLimits } from './types.js'

const defaults: LuvusLocalLimits = Object.freeze({
  request_bytes: LIMITS.frame_bytes,
  response_bytes: LIMITS.frame_bytes,
  stderr_bytes: 65_536,
  discovery_bytes: DEFAULT_LIMITS.bundle_bytes,
  timeout_ms: 30_000,
  attempts: 128
})
/** 合并本地限制，仅接受正安全整数且允许收紧，禁止扩大默认预算。 */
export function localLimits(overrides: Partial<LuvusLocalLimits> = {}): LuvusLocalLimits {
  const result = { ...defaults }
  for (const [key, value] of Object.entries(overrides)) {
    if (
      !Object.hasOwn(defaults, key) ||
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      value > defaults[key as keyof LuvusLocalLimits]
    ) {
      throw new LuvusAdapterError('invalid_local_limits')
    }
    result[key as keyof LuvusLocalLimits] = value
  }
  return Object.freeze(result)
}
/** 要求不含空字符的规范绝对路径，拒绝相对路径和路径折叠别名。 */
function canonical(path: string): void {
  if (!isAbsolute(path) || normalize(path) !== path || path.includes('\0')) {
    throw new LuvusAdapterError('local_path_invalid')
  }
}
// 当前只支持 POSIX；Windows ACL/命名管道不能凭 mode 位冒充已验证。
/** 仅在 Linux 提供有效 uid，其他平台缺少等价身份检查时拒绝运行。 */
function uid(): number {
  if (process.platform !== 'linux' || !process.geteuid) {
    throw new LuvusAdapterError('local_platform_unsupported')
  }
  return process.geteuid()
}
/** 逐级核验路径归属、类型和权限并生成身份戳；拒绝符号链接及可被其他用户改写的路径。 */
async function inspect(path: string, kind: 'directory' | 'binary' | 'socket') {
  canonical(path)
  const paths = [path]
  while (paths[0] !== sep) {
    paths.unshift(dirname(paths[0]!))
  }
  const stamps: string[] = []
  // 用户命名空间可把系统根目录属主映射为非零 uid，不能把 uid=0 当跨容器恒等式。
  const rootOwner = (await lstat(sep, { bigint: true })).uid
  for (const component of paths) {
    const info = await lstat(component, { bigint: true })
    const last = component === path
    const mode = Number(info.mode & 0o777n)
    if (
      info.isSymbolicLink() ||
      (mode & 0o022) !== 0 ||
      (info.uid !== BigInt(uid()) && info.uid !== 0n && info.uid !== rootOwner) ||
      (!last && !info.isDirectory())
    ) {
      throw new LuvusAdapterError('local_path_untrusted')
    }
    if (last) {
      const privateOwned = info.uid === BigInt(uid())
      if (
        (kind === 'directory' && (!info.isDirectory() || !privateOwned || mode !== 0o700)) ||
        (kind === 'socket' && (!info.isSocket() || !privateOwned || mode !== 0o600)) ||
        (kind === 'binary' &&
          (!info.isFile() || (mode & 0o111) === 0 || (info.mode & 0o6000n) !== 0n || info.size > 268_435_456n))
      ) {
        throw new LuvusAdapterError('local_path_untrusted')
      }
    }
    stamps.push([component, info.dev, info.ino, last ? info.ctimeNs : '', info.uid, info.mode].join(':'))
  }
  return stamps.join('\n')
}
/** 校验固定会话、来源哈希、路径和修订，并冻结配置快照以隔离调用方后续修改。 */
export function pinConfig(config: LuvusLocalConfig): LuvusLocalConfig {
  pinTerminalExecution(config.allow_terminal_execution)
  agentSearchPath(config.agent_bin_dirs, '/usr/bin:/bin')
  validateTarget(config.target)
  uid()
  if (
    config.target.profile !== 'session' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(config.target.session) ||
    !Number.isSafeInteger(config.binding_revision) ||
    config.binding_revision < 1 ||
    typeof config.config_ref !== 'string' ||
    config.config_ref.length < 1 ||
    config.config_ref.length > 256 ||
    !/^[0-9a-f]{64}$/.test(config.binary_sha256) ||
    !['ipc', 'cli'].includes(config.transport)
  ) {
    throw new LuvusAdapterError('invalid_local_config')
  }
  for (const path of [config.binary, config.state_root, config.home, config.cwd]) {
    canonical(path)
  }
  const snapshot = JSON.parse(boundedJson(config)) as LuvusLocalConfig
  Object.freeze(snapshot.target)
  if (snapshot.limits) {
    Object.freeze(snapshot.limits)
  }
  return Object.freeze(snapshot)
}
/** 测量实际安装文件的身份与摘要，不要求预设版本或发行版摘要。 */
export async function measureLuvusInstallation(binary: string): Promise<Readonly<{ stamp: string; sha256: string }>> {
  const before = await inspect(binary, 'binary')
  const digest = createHash('sha256')
  let total = 0
  for await (const bytes of createReadStream(binary)) {
    total += bytes.length
    if (total > 268_435_456) {
      throw new LuvusAdapterError('binary_identity_changed')
    }
    digest.update(bytes)
  }
  if ((await inspect(binary, 'binary')) !== before) {
    throw new LuvusAdapterError('binary_identity_changed')
  }
  return Object.freeze({ stamp: before, sha256: digest.digest('hex') })
}

/** 检查本轮实际安装未被替换，同时要求状态和子进程目录保持私有。 */
export async function verifyInstallation(config: LuvusLocalConfig): Promise<string> {
  const measured = await measureLuvusInstallation(config.binary)
  if (measured.sha256 !== config.binary_sha256) {
    throw new LuvusAdapterError('binary_identity_changed')
  }
  for (const path of [config.state_root, config.home, config.cwd, ...childDirectories(config)]) {
    await inspect(path, 'directory')
  }
  return measured.stamp
}
/** 列出固定 HOME 下供子进程使用的私有 XDG 目录。 */
function childDirectories(config: LuvusLocalConfig): string[] {
  return ['config', 'data', 'cache', 'runtime'].map(
    /* 将固定的 XDG 子目录名称映射为该安装的绝对路径。 */ (name) => join(config.home, name)
  )
}
/** 构造固定且最小的子进程环境，隔离父进程凭据和实例选择器。 */
export function childEnvironment(config: LuvusLocalConfig): NodeJS.ProcessEnv {
  // 不继承调用进程的环境，不允许 caller 扩展 env 或设置其它实例选择器。
  return {
    PATH: agentSearchPath(config.agent_bin_dirs, '/usr/bin:/bin'),
    HOME: config.home,
    XDG_CONFIG_HOME: join(config.home, 'config'),
    XDG_DATA_HOME: join(config.home, 'data'),
    XDG_CACHE_HOME: join(config.home, 'cache'),
    XDG_RUNTIME_DIR: join(config.home, 'runtime'),
    LUVUS_HOME: config.state_root,
    SHELL: '/bin/sh',
    LANG: 'C.UTF-8'
  }
}
/** 仅生成 schema、会话发现或 proxy 的固定 argv；不接受请求参数或任意 shell 文本。 */
export function fixedArguments(
  config: LuvusLocalConfig,
  command: 'schema' | 'sessions' | 'proxy' | 'version'
): string[] {
  if (command === 'version') {
    return ['--version']
  }
  return [
    '--session',
    config.target.session,
    ...(command === 'sessions' ? ['session', 'list', '--json'] : ['uhp', command])
  ]
}
/** 要求 endpoint 位于受保护状态根目录内，并核验每级私有目录及 socket 身份。 */
export async function inspectEndpoint(config: LuvusLocalConfig, address: string): Promise<EndpointIdentity> {
  canonical(address)
  const inside = relative(config.state_root, address)
  if (!inside || inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside)) {
    throw new LuvusAdapterError('endpoint_outside_state_root')
  }
  await inspect(config.state_root, 'directory')
  // 从受保护 root 到 socket 的每级目录均须私有。
  let parent = dirname(address)
  while (parent !== config.state_root) {
    await inspect(parent, 'directory')
    parent = dirname(parent)
  }
  return Object.freeze({ address, uid: uid(), stamp: await inspect(address, 'socket') })
}
/** 重新核验 endpoint 的完整路径身份戳，发现替换或权限变化时拒绝继续。 */
export async function recheckEndpoint(config: LuvusLocalConfig, endpoint: EndpointIdentity): Promise<void> {
  if ((await inspectEndpoint(config, endpoint.address)).stamp !== endpoint.stamp) {
    throw new LuvusAdapterError('endpoint_identity_changed')
  }
}
