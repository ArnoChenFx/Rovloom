// 共用双角色配置路径选择规则；只读用户home，不创建目录，也不把平台默认目录替换为AppData。
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { CliError, type RoleConfig } from './config.js'

export type ConfigPathEnvironment = { home: string | undefined; platform: NodeJS.Platform }

// 拒绝不可见分隔符，避免路径在诊断或平台规范化时产生歧义。
function hasControl(value: string): boolean {
  return Array.from(value).some(
    /* 逐字符检查控制区间，不改变空格及Unicode路径。 */ (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
  )
}

// 按当前平台检查规范绝对路径；实际文件所有权和权限继续由readConfig校验。
function validPath(value: string, paths: typeof posix): boolean {
  return (
    value.length > 0 &&
    value.length <= 4096 &&
    !hasControl(value) &&
    paths.isAbsolute(value) &&
    paths.normalize(value) === value &&
    paths.parse(value).root !== value
  )
}

// 显式配置优先且不要求home；缺省时只选择该角色的home/.config/rovloom文件，不做跨角色回退。
export function resolveRoleConfigPath(
  role: RoleConfig['role'],
  explicitPath?: string,
  environment?: ConfigPathEnvironment
): string {
  if (role !== 'gateway' && role !== 'connector') {
    throw new CliError('invalid_arguments')
  }
  const paths = (environment?.platform ?? process.platform) === 'win32' ? win32 : posix
  if (explicitPath !== undefined) {
    if (!validPath(explicitPath, paths)) {
      throw new CliError('invalid_config_path')
    }
    return explicitPath
  }
  let home: string | undefined
  try {
    home = environment ? environment.home : homedir()
  } catch {
    throw new CliError('config_home_unavailable')
  }
  if (typeof home !== 'string' || !home.length || !paths.isAbsolute(home) || hasControl(home)) {
    throw new CliError('config_home_unavailable')
  }
  const path = paths.join(home, '.config', 'rovloom', `${role}.json`)
  if (!validPath(path, paths)) {
    throw new CliError('config_home_unavailable')
  }
  return path
}
