// POSIX 私有目录与同描述符字节读取；Linux/macOS 共用对象身份检查，macOS 另核实际 ACL。
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { GatewayError } from '../contracts.js'
import { assertMacosDescriptorAcl } from './macos-acl.js'

// 只接受规范当前平台路径与可核对的真实 UID，不按未定义 UID 推导所有权。
function currentUser(path: string): number {
  const uid = process.getuid?.()
  if (!['linux', 'darwin'].includes(process.platform) || !Number.isSafeInteger(uid)) {
    throw new GatewayError('unsupported_storage_platform')
  }
  if (!isAbsolute(path) || resolve(path) !== path || path.includes('\0')) {
    throw new GatewayError('invalid_storage_path')
  }
  return uid!
}

// 对目录实际打开的描述符核验类型、所有权、mode 与扩展 ACL，并比对路径对象身份。
function directory(path: string, privateLeaf: boolean, ownerOnly = false): void {
  const uid = currentUser(path)
  const before = lstatSync(path, { bigint: true })
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new GatewayError('unsafe_storage_path')
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd, { bigint: true })
    if (stat.dev !== before.dev || stat.ino !== before.ino || !stat.isDirectory()) {
      throw new GatewayError('unsafe_storage_path')
    }
    if (privateLeaf) {
      if (stat.uid !== BigInt(uid) || (ownerOnly ? (stat.mode & 0o077n) !== 0n : (stat.mode & 0o777n) !== 0o700n)) {
        throw new GatewayError('private_storage_directory_required')
      }
    } else if (
      process.platform === 'darwin' &&
      (![0n, BigInt(uid)].includes(stat.uid) ||
        ((stat.mode & 0o022n) !== 0n && !(stat.uid === 0n && (stat.mode & 0o1000n) !== 0n)))
    ) {
      throw new GatewayError('unsafe_storage_path')
    }
    assertMacosDescriptorAcl(fd, privateLeaf)
  } finally {
    closeSync(fd)
  }
}

// 从根到直接父目录逐个验证；macOS 另核祖先所有权/写权限，Linux 保留既有祖先类型边界。
export function posixPrivatePath(path: string, ownerOnly = false): void {
  currentUser(path)
  let current = parse(path).root
  directory(current, dirname(path) === current, ownerOnly)
  for (const part of dirname(path).slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part)
    directory(current, current === dirname(path), ownerOnly)
  }
}

// mode、单硬链接与同一 fd 身份共同限制私有普通文件；只读角色配置允许其所有者收紧写权限。
export function assertPrivateDescriptor(fd: number, ownerOnly: boolean) {
  const stat = fstatSync(fd, { bigint: true })
  const uid = process.getuid?.()
  if (
    uid === undefined ||
    !stat.isFile() ||
    stat.nlink !== 1n ||
    stat.uid !== BigInt(uid) ||
    (ownerOnly ? (stat.mode & 0o077n) !== 0n : (stat.mode & 0o777n) !== 0o600n)
  ) {
    throw new GatewayError('unsafe_storage_file')
  }
  assertMacosDescriptorAcl(fd, true)
  return stat
}

// 路径检查后只读取此 fd，末次对象/长度/时间检查不能由预检路径的 stat 替代。
export function readPosixPrivate(path: string, maximum: number, ownerOnly: boolean): Buffer {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16_777_216) {
    throw new GatewayError('invalid_storage_limit')
  }
  posixPrivatePath(path, ownerOnly)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  const bytes = Buffer.alloc(maximum + 1)
  let keep = false
  try {
    const before = assertPrivateDescriptor(fd, ownerOnly)
    const named = lstatSync(path, { bigint: true })
    if (
      named.isSymbolicLink() ||
      before.dev !== named.dev ||
      before.ino !== named.ino ||
      before.size > BigInt(maximum)
    ) {
      throw new GatewayError('unsafe_storage_file')
    }
    let length = 0
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null)
      if (!count) {
        break
      }
      length += count
    }
    const after = assertPrivateDescriptor(fd, ownerOnly)
    const final = lstatSync(path, { bigint: true })
    if (
      length > maximum ||
      BigInt(length) !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      after.dev !== final.dev ||
      after.ino !== final.ino
    ) {
      throw new GatewayError('unsafe_storage_file')
    }
    keep = true
    return bytes.subarray(0, length)
  } finally {
    if (!keep) {
      bytes.fill(0)
    }
    closeSync(fd)
  }
}

// 元数据检查仍打开实际文件对象，不把路径 mode 当作之后读取描述符的证明。
export function posixPrivateFile(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = assertPrivateDescriptor(fd, false)
    const named = lstatSync(path, { bigint: true })
    if (stat.dev !== named.dev || stat.ino !== named.ino || named.isSymbolicLink()) {
      throw new GatewayError('unsafe_storage_file')
    }
  } finally {
    closeSync(fd)
  }
}

// 仅新建当前用户独占目录；现有权限不足时拒绝，不 chmod 修复已有对象。
export function ensurePosixPrivateDirectory(path: string): void {
  currentUser(path)
  const chain = [path]
  while (chain[0] !== parse(path).root) {
    chain.unshift(dirname(chain[0]!))
  }
  for (const current of chain) {
    try {
      mkdirSync(current, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
    }
    directory(current, current === path)
  }
}

// 排他新建后先核验同 fd 权限再写入，避免向继承的不安全 ACL 写入正文。
export function createPosixPrivate(path: string, content: string): void {
  posixPrivatePath(path)
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    assertPrivateDescriptor(fd, false)
    writeFileSync(fd, content)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
