// 保留更新器尚在使用的旧macOS检查；service入口已不依赖本模块，后续由更新器范围单独清理。
import { dirname } from 'node:path'
import { checkedCommand, type CommandRunner } from './runner.js'
import { ServiceError } from './types.js'

// 展开路径及全部祖先，避免只校验叶节点而忽略可替换它的父目录权限。
export function macosPermissionPaths(paths: readonly string[]): string[] {
  const result = new Set<string>()
  for (const path of paths) {
    let current = path
    for (;;) {
      result.add(current)
      if (current === '/') {
        break
      }
      current = dirname(current)
    }
  }
  return [...result]
}

// macOS 扩展 ACL 可覆盖 BSD mode；缺省只接受 ls 已知单行模式，无任何扩展 ACE。
export async function verifyMacosAcl(paths: readonly string[], run: CommandRunner): Promise<void> {
  for (const path of macosPermissionPaths(paths)) {
    const result = await checkedCommand(run, { executable: '/bin/ls', args: ['-lde', path], timeout: 5000 })
    const lines = result.stdout.trimEnd().split('\n')
    if (lines.length !== 1 || !/^[d-][rwxStTs-]{9}[@]?\s/u.test(lines[0]!)) {
      throw new ServiceError('unsafe_installation')
    }
  }
}
