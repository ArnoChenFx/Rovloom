// 为唯一产品入口组合真实开机监管器；只读预检当前产物和目标账户配置，不提权、不修复权限或启动角色。
import { execFileSync } from 'node:child_process'
import { constants, closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { createNativeServiceBackend } from '../service/native.js'
import { ServiceManager } from '../service/manager.js'
import { protectedPath } from '../service/security.js'
import { checkedCommand, runSystemCommand, type CommandRunner } from '../service/runner.js'
import { ServiceError, type ServiceRole, type ServiceSpec } from '../service/types.js'
import { parseNativeJson } from '../native-contract/json.js'
import { parseConfig } from './config.js'
import { resolveRoleConfigPath } from './config-path.js'
import type { CliServiceHost } from './run.js'

export type ProductServiceEnvironment = Readonly<{
  platform: string
  arch: string
  executable: string
  standalone: boolean
}>

// Bun 编译入口位于只读虚拟文件系统；源码入口及解释器不能登记为产品服务。
export function productServiceEnvironment(): ProductServiceEnvironment {
  return {
    platform: process.platform,
    arch: process.arch,
    executable: realpathSync(process.execPath),
    standalone: !!process.versions.bun && /^(?:\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/u.test(process.argv[1] ?? '')
  }
}

// 不先执行安装目标；先证明它是本次正在执行的单文件，并保留现有角色平台限制。
export function assertServiceProduct(spec: ServiceSpec, environment: ProductServiceEnvironment): void {
  if (!environment.standalone) {
    throw new ServiceError('backend_unavailable')
  }
  if (spec.platform !== environment.platform || spec.executable !== environment.executable) {
    throw new ServiceError('unsafe_installation')
  }
  // 受保护角色状态尚限 Linux，本机 native owner 另限 x64；不能以成功注册冒充运行时可用。
  if (environment.platform !== 'linux' || (spec.role === 'connector' && environment.arch !== 'x64')) {
    throw new ServiceError('backend_unavailable')
  }
}

// 查目标服务账户的系统数据库记录，不读取 HOME、SUDO_USER 或提权前用户自报；未知来源要求显式配置。
export function serviceAccountConfig(
  role: ServiceRole,
  account: string,
  lookup: (account: string) => string = accountRecord
): string {
  if (!/^[a-z_][a-z0-9_-]{0,31}\$?$/u.test(account) || account === 'root') {
    throw new ServiceError('invalid_arguments')
  }
  let record: string
  try {
    record = lookup(account).trimEnd()
  } catch (error) {
    if (error instanceof ServiceError && error.code === 'backend_unavailable') {
      throw error
    }
    throw new ServiceError('config_path_required')
  }
  const fields = record.split(':')
  if (
    fields.length !== 7 ||
    fields[0] !== account ||
    !/^[1-9]\d*$/u.test(fields[2]!) ||
    !Number.isSafeInteger(Number(fields[2])) ||
    record.includes('\n')
  ) {
    throw new ServiceError('config_path_required')
  }
  try {
    return resolveRoleConfigPath(role, undefined, { home: fields[5], platform: 'linux' })
  } catch {
    throw new ServiceError('config_path_required')
  }
}

// 同步 parser 只读取有界 passwd 记录；绝对程序、独立 argv 和固定环境阻止 shell/环境注入。
function accountRecord(account: string): string {
  if (process.platform !== 'linux') {
    throw new ServiceError('backend_unavailable')
  }
  return execFileSync('/usr/bin/getent', ['passwd', account], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 16384,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' }
  })
}

// 安装器以 root 只读目标账户的无密钥配置；描述符核验限制所有权、链接、大小和路径替换。
async function serviceConfig(spec: ServiceSpec, verifyStatePath: typeof protectedPath): Promise<void> {
  const fd = openSync(spec.config, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  const bytes = Buffer.alloc(16385)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid === 0 || (stat.mode & 0o777) !== 0o600 || stat.size > 16384) {
      throw new ServiceError('unsafe_installation')
    }
    const length = readSync(fd, bytes, 0, bytes.length, 0)
    const parsed = parseNativeJson(bytes.subarray(0, length), {
      object_bytes: 16384,
      object_depth: 16,
      object_nodes: 4096
    })
    if (length > 16384 || !parsed.ok) {
      throw new ServiceError('unsafe_installation')
    }
    const config = parseConfig(parsed.value)
    if (config.role !== spec.role || (config.role === 'connector' && !config.gateway_url)) {
      throw new ServiceError('unsafe_installation')
    }
    await verifyStatePath(config.state_dir, stat.uid, true)
  } finally {
    bytes.fill(0)
    closeSync(fd)
  }
}

// 原生路径预检通过后，以实际目标账户运行同一产物的只读检查；不打开角色、listener 或 writer。
export async function verifyProductServiceRuntime(
  spec: ServiceSpec,
  environment: ProductServiceEnvironment,
  run: CommandRunner = runSystemCommand,
  verifyStatePath: typeof protectedPath = protectedPath
): Promise<void> {
  assertServiceProduct(spec, environment)
  await serviceConfig(spec, verifyStatePath)
  const check = await checkedCommand(run, {
    executable: '/usr/sbin/runuser',
    args: [
      '--user',
      spec.account,
      '--',
      spec.executable,
      'config',
      'check-runtime',
      '--role',
      spec.role,
      '--config',
      spec.config
    ],
    timeout: 10000
  })
  if (check.stdout !== '' || check.stderr !== 'runtime_config_valid\n') {
    throw new ServiceError('unsafe_installation')
  }
}

// 构造无副作用；仅 service 动作会 authorize/lock，help/version 也不会触碰系统设施。
export function createProductServiceHost(): CliServiceHost {
  const environment = productServiceEnvironment()
  const native = createNativeServiceBackend({
    platform: environment.platform,
    verifyRuntime: /* 安装和每次启动均验证当前精确产物，不能接管另一安装。 */ async (spec) =>
      verifyProductServiceRuntime(spec, environment)
  })
  const backend = {
    ...native,
    // 当前不能运行角色的平台在接触系统控制目录、权限或注册之前明确拒绝。
    async authorize() {
      if (environment.platform !== 'linux' || !environment.standalone) {
        throw new ServiceError('backend_unavailable')
      }
      await native.authorize()
    }
  }
  return {
    platform: environment.platform,
    executable: environment.executable,
    manager: new ServiceManager(backend),
    resolveDefaultConfig: /* 仅目标账户系统记录决定缺省路径；显式配置由 parser 优先采用。 */ (role, account) =>
      serviceAccountConfig(role, account)
  }
}
