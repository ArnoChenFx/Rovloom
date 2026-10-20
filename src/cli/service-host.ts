// 为唯一产品入口组合正常系统服务；检查当前产物与配置格式，不修改权限或自动提权。
import { execFileSync } from 'node:child_process'
import { closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { createNativeServiceBackend } from '../service/native.js'
import { ServiceManager } from '../service/manager.js'
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
  // 本机native Connector仍限Linux x64；macOS服务入口由独立接线提供。
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

// 已有配置只做普通文件/JSON/角色检查；缺失配置留给角色正常首次启动生成，不核对UID/mode/ACL或状态目录。
export async function verifyProductServiceRuntime(
  spec: ServiceSpec,
  environment: ProductServiceEnvironment
): Promise<void> {
  assertServiceProduct(spec, environment)
  if (!statSync(spec.directory).isDirectory()) {
    throw new ServiceError('invalid_arguments')
  }
  let fd: number
  try {
    fd = openSync(spec.config, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw error
  }
  const bytes = Buffer.alloc(16385)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 16384) {
      throw new ServiceError('invalid_arguments')
    }
    let length = 0
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null)
      if (!count) {
        break
      }
      length += count
    }
    const parsed = parseNativeJson(bytes.subarray(0, length), {
      object_bytes: 16384,
      object_depth: 16,
      object_nodes: 4096
    })
    if (length > 16384 || !parsed.ok) {
      throw new ServiceError('invalid_arguments')
    }
    let role: string
    try {
      role = parseConfig(parsed.value).role
    } catch {
      throw new ServiceError('invalid_arguments')
    }
    if (role !== spec.role) {
      throw new ServiceError('invalid_arguments')
    }
  } finally {
    bytes.fill(0)
    closeSync(fd)
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
    async authorize(role?: ServiceRole) {
      if (
        environment.platform !== 'linux' ||
        !environment.standalone ||
        (role === 'connector' && environment.arch !== 'x64')
      ) {
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
