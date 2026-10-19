// 在 POSIX 平台核对安装边界与非 root 账户；不创建账户或改变既有文件权限。
import { lstat, realpath } from 'node:fs/promises'
import { dirname, parse } from 'node:path'
import { checkedCommand, type CommandRunner } from './runner.js'
import { ServiceError, type ServiceSpec } from './types.js'

// 核对路径本身及所有祖先均不可由不受信用户替换；符号链接和可写祖先一律拒绝。
export async function protectedPath(path: string, leafOwner: number, privateLeaf: boolean): Promise<void> {
  if ((await realpath(path)) !== path) {
    throw new ServiceError('unsafe_installation')
  }
  let current = path
  for (;;) {
    const stat = await lstat(current)
    const leaf = current === path
    if (
      stat.isSymbolicLink() ||
      (stat.uid !== 0 && stat.uid !== leafOwner) ||
      (stat.mode & 0o022) !== 0 ||
      (leaf && stat.uid !== leafOwner) ||
      (leaf && privateLeaf && (stat.mode & 0o077) !== 0)
    ) {
      throw new ServiceError('unsafe_installation')
    }
    if (current === parse(current).root) {
      break
    }
    current = dirname(current)
  }
}

// 查明本地真实 UID 并拒绝 root 别名；可执行文件由 root 控制，配置及工作目录归目标账户。
export async function verifyPosixInstallation(spec: ServiceSpec, run: CommandRunner): Promise<void> {
  const id = await checkedCommand(run, { executable: '/usr/bin/id', args: ['-u', spec.account] })
  const uid = Number(id.stdout.trim())
  if (!/^[0-9]+$/u.test(id.stdout.trim()) || !Number.isSafeInteger(uid) || uid <= 0) {
    throw new ServiceError('unsafe_installation')
  }
  await protectedPath(spec.executable, 0, false)
  await protectedPath(spec.config, uid, true)
  await protectedPath(dirname(spec.config), uid, true)
  await protectedPath(spec.directory, uid, true)
  const executable = await lstat(spec.executable)
  const config = await lstat(spec.config)
  const directory = await lstat(spec.directory)
  if (!executable.isFile() || !(executable.mode & 0o111) || !config.isFile() || !directory.isDirectory()) {
    throw new ServiceError('unsafe_installation')
  }
}

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
