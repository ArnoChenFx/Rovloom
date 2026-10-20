// 为唯一产品入口组合正常系统服务；检查当前产物与配置格式，不修改权限或自动提权。
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
  // Gateway服务支持Linux/macOS；本机native Connector仍限Linux x64。
  if (
    !['linux', 'darwin'].includes(environment.platform) ||
    (spec.role === 'connector' && (environment.platform !== 'linux' || environment.arch !== 'x64'))
  ) {
    throw new ServiceError('backend_unavailable')
  }
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
        !['linux', 'darwin'].includes(environment.platform) ||
        !environment.standalone ||
        (role === 'connector' && (environment.platform !== 'linux' || environment.arch !== 'x64'))
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
    resolveDefaultConfig: /* 与前台共用当前用户的唯一角色文件；安装后只使用保存的绝对路径。 */ (role) =>
      resolveRoleConfigPath(role)
  }
}
