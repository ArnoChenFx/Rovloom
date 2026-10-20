/** 从本机可信目录构造 Agent 命令搜索路径，不继承宿主 PATH 或解析调用者环境。 */
import { posix, win32 } from 'node:path'
import { fail } from '../../wire/index.js'

/** 保留默认环境，仅将显式规范绝对目录前置；分隔符按宿主平台选择，不展开 home、变量或相对路径。 */
export function agentSearchPath(
  directory: unknown,
  fallback: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (directory === undefined) {
    return fallback
  }
  const paths = platform === 'win32' ? win32 : posix
  if (
    typeof directory !== 'string' ||
    directory.length < 1 ||
    directory.length > 4096 ||
    !paths.isAbsolute(directory) ||
    paths.normalize(directory) !== directory ||
    paths.resolve(directory) !== directory ||
    paths.parse(directory).root === directory ||
    directory.includes(paths.delimiter) ||
    Array.from(directory).some(
      /** 控制字符和多项 PATH 分隔符不能伪装成一个安装目录。 */ (char) =>
        char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
    )
  ) {
    fail('agent_bin_dir_invalid')
  }
  return directory + paths.delimiter + fallback
}
