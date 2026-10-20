// 仅在角色文件缺失时独占创建单份用户配置；不读取stdin、不生成凭据、不写runtime/ref文档。
import { closeSync, constants, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, parse } from 'node:path'
import { CliError, configDocument, configTemplate, parseConfig, readConfig, type RoleConfig } from './config.js'
import { resolveRoleConfigPath, type ConfigPathEnvironment } from './config-path.js'

// 逐级拒绝链接和非目录，只创建缺失目录，已有目录的权限及内容永不修复或覆盖。
export function privateDirectory(path: string): void {
  const chain = [path]
  while (chain[0] !== parse(path).root) {
    chain.unshift(dirname(chain[0]!))
  }
  for (const current of chain) {
    try {
      mkdirSync(current, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new CliError('config_unreadable')
      }
    }
    const stat = lstatSync(current)
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (current === path && (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700))
    ) {
      throw new CliError('config_not_protected')
    }
  }
}

// 角色和状态目录分离；显式config只覆盖用户文件位置，默认数据仍属于当前用户的home。
function defaults(role: RoleConfig['role'], environment?: ConfigPathEnvironment): RoleConfig {
  let home: string | undefined
  try {
    home = environment ? environment.home : homedir()
  } catch {
    throw new CliError('config_home_unavailable')
  }
  resolveRoleConfigPath(role, undefined, { home, platform: process.platform })
  return parseConfig({
    ...configDocument(configTemplate(role)),
    data: { directory: join(home!, '.local', 'share', 'rovloom', role) }
  })
}

// 只有缺失错误触发首次生成；O_EXCL同时保护存在文件和竞态，既有损坏配置也不自动重置。
export function readOrCreateRoleConfig(
  role: RoleConfig['role'],
  path: string,
  environment?: ConfigPathEnvironment
): RoleConfig {
  try {
    return readConfig(path)
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== 'config_not_found') {
      throw error
    }
  }
  if (process.platform !== 'linux') {
    throw new CliError('config_platform_unsupported')
  }
  const config = defaults(role, environment)
  privateDirectory(dirname(path))
  let fd: number
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return readConfig(path)
    }
    throw new CliError('config_unreadable')
  }
  try {
    fchmodSync(fd, 0o600)
    writeFileSync(fd, JSON.stringify(configDocument(config), null, 2) + '\n')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return config
}
