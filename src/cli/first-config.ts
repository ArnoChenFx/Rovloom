// 仅在角色文件缺失时独占创建单份用户配置；不读取stdin、不生成凭据、不写runtime/ref文档。
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
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

// 同步已发布文件的目录项；临时文件本身在发布前已完整写入并fsync。
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

// 只有缺失错误触发首次生成；完整临时文件通过原子link发布，不覆盖已有文件或留下写入残片。
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
  const directory = dirname(path)
  privateDirectory(directory)
  const temporary = join(directory, '.rovloom-config-' + randomUUID() + '.tmp')
  let fd: number | undefined
  let created = false
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    created = true
    fchmodSync(fd, 0o600)
    writeFileSync(fd, JSON.stringify(configDocument(config), null, 2) + '\n')
    fsyncSync(fd)
    const written = fd
    fd = undefined
    closeSync(written)
    try {
      linkSync(temporary, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
    }
    unlinkSync(temporary)
    created = false
    syncDirectory(directory)
    // 也校验并发获胜者；其内容、角色或权限有误仍拒绝，绝不以自己的默认值覆盖。
    return readConfig(path)
  } catch (error) {
    if (error instanceof CliError) {
      throw error
    }
    throw new CliError('config_unreadable')
  } finally {
    try {
      if (fd !== undefined) {
        closeSync(fd)
      }
    } finally {
      if (created) {
        unlinkSync(temporary)
        syncDirectory(directory)
      }
    }
  }
}
