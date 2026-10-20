// 规范化固定服务身份与路径，并验证注册内嵌的非秘密清单。
import { posix, win32 } from 'node:path'
import { createHash } from 'node:crypto'
import { ServiceError, type ServicePlatform, type ServiceRole, type ServiceSpec } from './types.js'

export const OWNER = 'Rovloom managed boot service v1:'

// 只允许现行两种角色，禁止借服务名称管理其它项目。
export function isRole(value: unknown): value is ServiceRole {
  return value === 'gateway' || value === 'connector'
}

// 校验受支持平台，未知平台不回退到其它启动机制。
export function servicePlatform(value: string): ServicePlatform {
  if (value !== 'linux' && value !== 'darwin' && value !== 'win32') {
    throw new ServiceError('unsupported_platform')
  }
  return value
}

// 拒绝相对路径、控制字符、非规范段及 Windows UNC/设备路径，保留空格与 Unicode。
function fixedPath(value: unknown, platform: ServicePlatform): value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 4096 ||
    Array.from(value).some(/* 控制字符不能进入原生声明。 */ (c) => c.codePointAt(0)! < 32 || c.codePointAt(0) === 127)
  ) {
    return false
  }
  const path = platform === 'win32' ? win32 : posix
  if (!path.isAbsolute(value) || path.normalize(value) !== value) {
    return false
  }
  return (
    platform !== 'win32' ||
    (/^[A-Za-z]:\\/u.test(value) && !/[<>"|?*]/u.test(value.slice(3)) && !value.slice(3).includes(':'))
  )
}

// 只接受已知清单字段，防止历史注册或宽松对象扩大执行参数。
export function validateSpec(value: unknown): ServiceSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ServiceError('invalid_arguments')
  }
  const spec = value as ServiceSpec
  const keys = Object.keys(spec).sort().join(',')
  if (
    keys !== 'account,config,directory,executable,platform,role,version' ||
    spec.version !== 1 ||
    !isRole(spec.role)
  ) {
    throw new ServiceError('invalid_arguments')
  }
  servicePlatform(spec.platform)
  if (
    ![spec.config, spec.directory, spec.executable].every(
      /* 核对三个独立的绝对路径。 */ (p) => fixedPath(p, spec.platform)
    )
  ) {
    throw new ServiceError('invalid_arguments')
  }
  if (
    typeof spec.account !== 'string' ||
    !spec.account ||
    spec.account.length > 256 ||
    Array.from(spec.account).some(
      /* 账户按普通文本传递，拒绝NUL和控制字符。 */ (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127
    )
  ) {
    throw new ServiceError('invalid_arguments')
  }
  // WorkingDirectory 是单值原文，非 argv；行尾空白和续行反斜杠不能无损表达，因此明确拒绝。
  if (spec.platform === 'linux' && (spec.directory.trimEnd() !== spec.directory || spec.directory.endsWith('\\'))) {
    throw new ServiceError('invalid_arguments')
  }
  if (spec.platform === 'win32') {
    // S4U运行既有用户，不把内置系统服务账户作为用户会话；账户有效性再由正常Windows解析确认。
    if (/^S-1-5-(?:18|19|20)$/u.test(spec.account) || !spec.executable.toLowerCase().endsWith('.exe')) {
      throw new ServiceError('invalid_arguments')
    }
  } else if (!/^[a-z_][a-z0-9_-]{0,31}\$?$/u.test(spec.account) || spec.account === 'root') {
    throw new ServiceError('invalid_arguments')
  }
  return {
    version: 1,
    platform: spec.platform,
    role: spec.role,
    executable: spec.executable,
    config: spec.config,
    directory: spec.directory,
    account: spec.account
  }
}

// 使用固定字段顺序形成可复核的所有权清单，内容只含本地非秘密启动引用。
export function manifest(spec: ServiceSpec): string {
  return OWNER + Buffer.from(JSON.stringify(validateSpec(spec)), 'utf8').toString('base64')
}

// 从注册读取清单后重新严格验证，伪造或残缺清单统一作为冲突。
export function parseManifest(value: string, role: ServiceRole, platform: ServicePlatform): ServiceSpec {
  try {
    if (!value.startsWith(OWNER) || value.length > 100000) {
      throw new Error('owner')
    }
    const encoded = value.slice(OWNER.length)
    const spec = validateSpec(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')))
    if (spec.role !== role || spec.platform !== platform || manifest(spec) !== value) {
      throw new Error('identity')
    }
    return spec
  } catch {
    throw new ServiceError('service_conflict')
  }
}

// 每个平台固定一个角色名称，不接收任意服务名或任务路径。
export function serviceName(role: ServiceRole, platform: ServicePlatform): string {
  if (!isRole(role)) {
    throw new ServiceError('invalid_arguments')
  }
  return platform === 'darwin' ? `io.rovloom.${role}` : `rovloom-${role}`
}

// 固定复用现有角色命令；后台能力须由 CLI 宿主在 preflight 中确认。
export function launchArguments(spec: ServiceSpec): string[] {
  // Task Scheduler的非交互桌面也可能提供TTY句柄，必须显式关闭本地交互引导。
  return [
    spec.role,
    '--config',
    spec.config,
    ...(spec.platform === 'win32' ? ['--non-interactive', '--service-id', serviceControlId(spec)] : [])
  ]
}

// 非秘密标识精确绑定整份登记清单；普通前台非交互启动没有此标识，不创建服务停止端点。
export function serviceControlId(spec: ServiceSpec): string {
  return createHash('sha256').update(manifest(spec)).digest('hex')
}
