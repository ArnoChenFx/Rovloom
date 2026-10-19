// 在既有受保护控制目录内保存及锁定注册文件；删除范围仅为指定项目文件。
import { lstat, open, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { protectedPath } from './security.js'
import { ServiceError } from './types.js'
import type { FileHandle } from 'node:fs/promises'

// 关闭失败的自有锁句柄不能交给 GC 隐式处理；对应持久锁仍阻止再次进入。
const unclosedLocks = new Set<FileHandle>()

// 显式观察 close 失败并保留资源所有权，不让 finally 覆盖生命周期分支控制。
async function closeLockHandle(file: FileHandle): Promise<void> {
  try {
    await file.close()
  } catch (error) {
    unclosedLocks.add(file)
    throw error
  }
}

export type RegistrationFiles = {
  // 验证控制目录的管理员所有权及不可替换性。
  verify(): Promise<void>
  // 有界读取普通注册文件，不跟随符号链接。
  read(name: string): Promise<string | undefined>
  // 独占创建新文件，不覆盖既有注册。
  create(name: string, content: string): Promise<void>
  // 比较完整内容后仅移除该注册文件。
  remove(name: string, content: string): Promise<void>
  // 持有角色专用锁完成状态转换；未知残留锁不自动回收。
  lock<T>(name: string, operation: () => Promise<T>): Promise<T>
}

// 固定根目录由宿主选择，所有相对文件名须由模块内部固定身份生成。
export function registrationFiles(
  directory: string,
  windows = false,
  verifyPermissions?: (paths: readonly string[]) => Promise<void>
): RegistrationFiles {
  // 拒绝目录穿越，内部文件名不允许成为其它路径。
  function path(name: string): string {
    if (!/^[a-z0-9._-]+$/u.test(name)) {
      throw new ServiceError('service_conflict')
    }
    return join(directory, name)
  }
  const files: RegistrationFiles = {
    // POSIX 权限在本模块验证，Windows ACL 由原生宿主验证。
    async verify() {
      if (!windows) {
        await protectedPath(directory, 0, false)
      }
      await verifyPermissions?.([directory])
    },
    // lstat 后以 O_NOFOLLOW 打开，且核对 inode，阻断检查与打开之间的替换。
    async read(name) {
      const target = path(name)
      let stat
      try {
        stat = await lstat(target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return undefined
        }
        throw error
      }
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 131072 ||
        (!windows && (stat.uid !== 0 || (stat.mode & 0o022) !== 0))
      ) {
        throw new ServiceError('service_conflict')
      }
      await verifyPermissions?.([target])
      const fd = await open(target, windows ? 'r' : constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const actual = await fd.stat()
        if (actual.ino !== stat.ino || actual.dev !== stat.dev) {
          throw new ServiceError('service_conflict')
        }
        return await fd.readFile('utf8')
      } finally {
        await fd.close()
      }
    },
    // 注册独占写入且 fsync；失败保留可识别文件，由下一次命令明确处理。
    async create(name, content) {
      const fd = await open(path(name), 'wx', 0o644)
      try {
        await fd.writeFile(content, 'utf8')
        await fd.sync()
      } finally {
        await fd.close()
      }
    },
    // 删除前重新核对完整声明，绝不递归删除或触及业务路径。
    async remove(name, content) {
      if ((await files.read(name)) !== content) {
        throw new ServiceError('service_conflict')
      }
      await unlink(path(name))
    },
    // 通过管理员目录内的独占文件实现跨进程锁，并在 finally 中只释放自有 inode。
    async lock(name, operation) {
      const target = path(`.${name}.lock`)
      let fd
      try {
        fd = await open(target, 'wx', 0o600)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new ServiceError('service_busy')
        }
        throw error
      }
      let owned
      try {
        owned = await fd.stat()
      } catch (error) {
        // 身份尚未证明时不能删除持久锁，但仍须显式关闭已取得的自有句柄。
        await closeLockHandle(fd)
        throw error
      }
      let retain = false
      try {
        return await operation()
      } catch (error) {
        retain = error instanceof ServiceError && error.code === 'service_recovery_required'
        throw error
      } finally {
        await closeLockHandle(fd)
        const current = await lstat(target)
        if (!retain && owned.ino === current.ino && owned.dev === current.dev && !current.isSymbolicLink()) {
          await unlink(target)
        }
      }
    }
  }
  return files
}
