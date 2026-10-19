// 核对 POSIX 真实安装及受限原生候选；拒绝符号链接、额外硬链接、特殊权限和无法保真的扩展访问元数据。
import * as nativeFiles from 'node:fs/promises'
import { constants, type BigIntStats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, normalize } from 'node:path'
import { createHash } from 'node:crypto'
import { runSystemCommand, type CommandRunner } from '../../service/runner.js'
import { verifyMacosAcl } from '../../service/security.js'
import { MAX_BINARY_BYTES, UpdateError, type UpdatePlatform } from '../contract.js'

export type PosixFiles = Pick<
  typeof nativeFiles,
  'lstat' | 'realpath' | 'open' | 'access' | 'mkdir' | 'mkdtemp' | 'link' | 'rename' | 'unlink' | 'rmdir' | 'readdir'
>
export const posixFiles: PosixFiles = nativeFiles
const unclosedHandles = new Set<FileHandle>()

// 原生 close 拒绝时保留句柄所有权，禁止 GC 以未观察的异常隐式关闭；不把它视为 I/O 静止证明。
export async function closeOwnedHandle(file: FileHandle | undefined): Promise<void> {
  if (!file) {
    return
  }
  try {
    await file.close()
  } catch (error) {
    unclosedHandles.add(file)
    throw error
  }
}
export type FileIdentity = Readonly<{
  dev: string
  ino: string
  uid: number
  gid: number
  mode: number
  size: number
  sha256: string
}>
export type PosixInstallation = {
  executable: string
  directory: string
  file: FileHandle
  parent: FileHandle
  identity: FileIdentity
  parentDev: string
  parentIno: string
}

// 所有保存到恢复记录中的文件身份均无浮点 inode 损失。
export function sameInode(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

// 在固定字节上限内通过持有句柄计算摘要，不从变动中的路径重新打开内容。
export async function handleDigest(file: FileHandle): Promise<string> {
  const hash = createHash('sha256')
  const block = Buffer.alloc(1024 * 1024)
  let position = 0
  while (true) {
    const { bytesRead } = await file.read(block, 0, block.length, position)
    if (!bytesRead) {
      break
    }
    position += bytesRead
    if (position > MAX_BINARY_BYTES) {
      throw new UpdateError('unsafe_installation')
    }
    hash.update(block.subarray(0, bytesRead))
  }
  return hash.digest('hex')
}

// 只接受本平台 64 位原生 executable；不执行 shebang、shell、JS 或其它下载脚本。
export async function nativeHeader(file: FileHandle, platform: UpdatePlatform): Promise<void> {
  const bytes = Buffer.alloc(32)
  const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
  if (bytesRead < 32) {
    throw new UpdateError('candidate_unusable')
  }
  if (platform.os === 'linux') {
    if (
      bytes.subarray(0, 4).toString('hex') !== '7f454c46' ||
      bytes[4] !== 2 ||
      bytes[5] !== 1 ||
      ![2, 3].includes(bytes.readUInt16LE(16)) ||
      bytes.readUInt16LE(18) !== (platform.arch === 'x64' ? 62 : 183)
    ) {
      throw new UpdateError('candidate_unusable')
    }
  } else if (platform.os === 'darwin') {
    if (
      bytes.readUInt32LE(0) !== 0xfeedfacf ||
      bytes.readUInt32LE(4) !== (platform.arch === 'x64' ? 0x01000007 : 0x0100000c) ||
      bytes.readUInt32LE(12) !== 2
    ) {
      throw new UpdateError('candidate_unusable')
    }
  } else {
    throw new UpdateError('replacement_unavailable')
  }
}

// GNU/BSD ls 的扩展访问标记不是可忽略信息；不支持 ACL、security context 或 xattr 时明确拒绝而非改写。
async function plainPermissions(paths: string[], platform: UpdatePlatform, run: CommandRunner): Promise<void> {
  if (platform.os === 'darwin') {
    // 祖先不被替换，复用现有 ACL 证明并保留其 xattr；被替换的叶文件仍拒绝任何未知 xattr。
    await verifyMacosAcl(paths, run)
    const leaf = await run({ executable: '/bin/ls', args: ['-lde', paths[0]!], timeout: 5000 })
    if (leaf.code !== 0 || leaf.stdout.trimEnd().split('\n').length !== 1 || !/^-[rwxStTs-]{9}\s/u.test(leaf.stdout)) {
      throw new UpdateError('unsafe_installation')
    }
    return
  }
  if (platform.os === 'linux') {
    const version = await run({ executable: '/bin/ls', args: ['--version'], timeout: 5000 })
    if (version.code !== 0 || !version.stdout.startsWith('ls (GNU coreutils) ')) {
      throw new UpdateError('replacement_unavailable')
    }
    // capability 是额外执行权限，不能仅凭 mode 位或 ls ACL 标记断言其不存在。
    const capabilities = await run({ executable: '/usr/sbin/getcap', args: ['-n', paths[0]!], timeout: 5000 })
    if (capabilities.code !== 0 || capabilities.stdout !== '' || capabilities.stderr !== '') {
      throw new UpdateError('unsafe_installation')
    }
  }
  const result = await run({
    executable: '/bin/ls',
    args: ['-ld', '--', ...paths],
    timeout: 5000
  })
  const rows = result.stdout.trimEnd().split('\n')
  if (
    result.code !== 0 ||
    rows.length !== paths.length ||
    rows.some(/* 额外 +/@/./? 标记和 ACL 详情均不可被忽略。 */ (row) => !/^[d-][rwxStTs-]{9}\s/u.test(row))
  ) {
    throw new UpdateError('unsafe_installation')
  }
}

// 从叶节点到文件系统根验证不可由其它用户替换；sticky 共享祖先只信任系统根拥有者或 root。
export async function protectedExecutablePath(
  path: string,
  platform: UpdatePlatform,
  files: PosixFiles,
  run: CommandRunner,
  expectedLinks: 1 | 2 = 1
): Promise<void> {
  if (
    !isAbsolute(path) ||
    normalize(path) !== path ||
    path.length > 4096 ||
    Array.from(path).some(
      /* 控制字符不能进入路径或原生输出。 */ (char) => char.codePointAt(0)! < 32 || char.codePointAt(0) === 127
    ) ||
    (await files.realpath(path)) !== path
  ) {
    throw new UpdateError('unsafe_installation')
  }
  const caller = process.getuid!()
  const systemOwner = (await files.lstat('/', { bigint: true })).uid
  const paths: string[] = []
  let current = path
  while (true) {
    if (paths.length >= 128) {
      throw new UpdateError('unsafe_installation')
    }
    const stat = await files.lstat(current, { bigint: true })
    const leaf = current === path
    const mode = Number(stat.mode)
    const administrator = stat.uid === 0n || stat.uid === systemOwner
    if (
      stat.isSymbolicLink() ||
      (!administrator && stat.uid !== BigInt(caller)) ||
      (leaf &&
        (stat.uid !== BigInt(caller) ||
          !stat.isFile() ||
          stat.nlink !== BigInt(expectedLinks) ||
          !(mode & 0o111) ||
          mode & 0o7022)) ||
      (!leaf && (!stat.isDirectory() || ((mode & 0o022) !== 0 && (!(mode & 0o1000) || !administrator))))
    ) {
      throw new UpdateError('unsafe_installation')
    }
    paths.push(current)
    if (current === '/') {
      break
    }
    current = dirname(current)
  }
  await plainPermissions(paths, platform, run)
}

// 候选必须按产品固定 --version 协议真正执行成功，原始 stdout/stderr 不进入公共诊断。
export async function probeVersion(
  path: string,
  version: string,
  run: CommandRunner = runSystemCommand
): Promise<void> {
  const result = await run({ executable: path, args: ['--version'], timeout: 10000 })
  if (result.code !== 0 || result.stdout !== '' || result.stderr !== `Rovloom ${version}\n`) {
    throw new UpdateError('candidate_unusable')
  }
}

// 取得原程序及父目录句柄并验证身份；目录 fsync 不支持时在任何服务停止或文件替换前拒绝。
export async function openInstallation(
  executable: string,
  version: string,
  platform: UpdatePlatform,
  files: PosixFiles = posixFiles,
  run: CommandRunner = runSystemCommand
): Promise<PosixInstallation> {
  await protectedExecutablePath(executable, platform, files, run)
  await files.access(dirname(executable), constants.W_OK | constants.X_OK)
  const before = await files.lstat(executable, { bigint: true })
  const file = await files.open(executable, constants.O_RDONLY | constants.O_NOFOLLOW)
  let parent: FileHandle | undefined
  try {
    const actual = await file.stat({ bigint: true })
    if (!sameInode(before, actual)) {
      throw new UpdateError('target_changed')
    }
    await nativeHeader(file, platform)
    await probeVersion(executable, version, run)
    const identity = Object.freeze({
      dev: String(actual.dev),
      ino: String(actual.ino),
      uid: Number(actual.uid),
      gid: Number(actual.gid),
      mode: Number(actual.mode) & 0o777,
      size: Number(actual.size),
      sha256: await handleDigest(file)
    })
    if (identity.size < 1 || identity.size > MAX_BINARY_BYTES) {
      throw new UpdateError('unsafe_installation')
    }
    const directory = dirname(executable)
    const parentStat = await files.lstat(directory, { bigint: true })
    parent = await files.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    if (!sameInode(parentStat, await parent.stat({ bigint: true }))) {
      throw new UpdateError('target_changed')
    }
    await parent.sync()
    return {
      executable,
      directory,
      file,
      parent,
      identity,
      parentDev: String(parentStat.dev),
      parentIno: String(parentStat.ino)
    }
  } catch (error) {
    await closeOwnedHandle(file)
    await closeOwnedHandle(parent)
    throw error
  }
}

// 在备份与每次原子替换前核对旧句柄、路径及父目录；硬链接备份只允许额外增加本次的一条链接。
export async function assertOriginal(
  installation: PosixInstallation,
  files: PosixFiles,
  linked: boolean
): Promise<void> {
  const stat = await files.lstat(installation.executable, { bigint: true })
  const parent = await files.lstat(installation.directory, { bigint: true })
  const expected = installation.identity
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    String(stat.dev) !== expected.dev ||
    String(stat.ino) !== expected.ino ||
    Number(stat.uid) !== expected.uid ||
    Number(stat.gid) !== expected.gid ||
    (Number(stat.mode) & 0o7777) !== expected.mode ||
    Number(stat.size) !== expected.size ||
    stat.nlink !== (linked ? 2n : 1n) ||
    String(parent.dev) !== installation.parentDev ||
    String(parent.ino) !== installation.parentIno ||
    (await handleDigest(installation.file)) !== expected.sha256
  ) {
    throw new UpdateError('target_changed')
  }
}
