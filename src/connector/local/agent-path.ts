/** 从本机可信目录构造 native 与 Agent 的命令搜索路径；父进程 PATH 只在安装期经严格筛选后固化。 */
import { lstatSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { fail } from '../../wire/index.js'

/** 同时生效的安装目录上限；更多目录说明应整合安装位置，而不是扩大搜索面。 */
export const MAX_BIN_DIRS = 16

/** 单个目录必须是规范绝对路径；分隔符、控制字符和根目录都不能伪装成一个安装目录。 */
function validDirectory(directory: unknown, platform: NodeJS.Platform): directory is string {
  const paths = platform === 'win32' ? win32 : posix
  return (
    typeof directory === 'string' &&
    directory.length >= 1 &&
    directory.length <= 4096 &&
    paths.isAbsolute(directory) &&
    paths.normalize(directory) === directory &&
    paths.resolve(directory) === directory &&
    paths.parse(directory).root !== directory &&
    !directory.includes(paths.delimiter) &&
    !Array.from(directory).some(
      /** 控制字符和多项 PATH 分隔符不能伪装成一个安装目录。 */ (char) =>
        char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
    )
  )
}

/** 校验显式目录列表：非空数组、数量有界、每项规范绝对目录且互不重复。 */
export function binDirectories(value: unknown, platform: NodeJS.Platform = process.platform): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_BIN_DIRS ||
    new Set(value).size !== value.length ||
    !value.every((entry) => validDirectory(entry, platform))
  ) {
    fail('agent_bin_dirs_invalid')
  }
  return value as string[]
}

/** 保留默认环境，仅将显式规范绝对目录依次前置；分隔符按宿主平台选择，不展开 home、变量或相对路径。 */
export function agentSearchPath(
  directories: unknown,
  fallback: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (directories === undefined) {
    return fallback
  }
  const paths = platform === 'win32' ? win32 : posix
  return [...binDirectories(directories, platform), fallback].join(paths.delimiter)
}

/**
 * 从启动进程的 PATH 取出可作为安装目录的条目：规范绝对、真实存在的目录；
 * POSIX 上还要求属于 root 或当前用户且组/其它用户不可写，避免 PATH 里的可写目录被植入同名程序。
 * 不合格条目静默跳过，不报错也不改写；相同目录只保留第一次出现。
 */
export function inheritedPathDirectories(
  pathValue: string | undefined = process.env.PATH,
  platform: NodeJS.Platform = process.platform
): string[] {
  const paths = platform === 'win32' ? win32 : posix
  const result: string[] = []
  for (const entry of (pathValue ?? '').split(paths.delimiter)) {
    if (!validDirectory(entry, platform) || result.includes(entry)) {
      continue
    }
    try {
      const info = lstatSync(entry)
      if (!info.isDirectory()) {
        continue
      }
      if (platform !== 'win32') {
        const owner = process.geteuid?.()
        if ((info.uid !== 0 && info.uid !== owner) || (info.mode & 0o022) !== 0) {
          continue
        }
      }
    } catch {
      continue
    }
    result.push(entry)
  }
  return result
}

/** 显式目录优先，其后是筛选后的 PATH 条目；超出上限的 PATH 条目被丢弃，显式目录永不被挤掉。 */
export function effectiveBinDirectories(
  explicit: readonly string[] | undefined,
  pathValue: string | undefined = process.env.PATH,
  platform: NodeJS.Platform = process.platform
): string[] {
  const result = [...(explicit ?? [])]
  // 固定系统目录本来就是兜底 PATH，不重复固化。
  const system = platform === 'win32' ? [] : ['/usr/bin', '/bin']
  for (const entry of inheritedPathDirectories(pathValue, platform)) {
    if (result.length >= MAX_BIN_DIRS) {
      break
    }
    if (!result.includes(entry) && !system.includes(entry)) {
      result.push(entry)
    }
  }
  return result
}
