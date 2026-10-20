// 在普通服务控制目录内保存及锁定注册文件；删除范围仅为指定项目文件。
import { lstat, open, unlink, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
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
  // 准备普通控制目录，不修改已有目录权限。
  verify(): Promise<void>
  // 用普通文件API有界读取登记内容。
  read(name: string): Promise<string | undefined>
  // 独占创建新文件，不覆盖既有注册。
  create(name: string, content: string): Promise<void>
  // 比较完整内容后仅移除该注册文件。
  remove(name: string, content: string): Promise<void>
  // 持有角色专用锁完成状态转换；未知残留锁不自动回收。
  lock<T>(name: string, operation: () => Promise<T>): Promise<T>
}

// 固定根目录由宿主选择，所有相对文件名须由模块内部固定身份生成。
// 历史windows标志仅为调用兼容保留，不再选择本机权限策略。
export function registrationFiles(directory: string, _windows = false): RegistrationFiles {
  // 拒绝目录穿越，内部文件名不允许成为其它路径。
  function path(name: string): string {
    if (!/^[a-z0-9._-]+$/u.test(name)) {
      throw new ServiceError('service_conflict')
    }
    return join(directory, name)
  }
  const files: RegistrationFiles = {
    // 服务目录按普通平台规则创建；权限不足由文件系统明确报错。
    async verify() {
      await mkdir(directory, { recursive: true })
    },
    // 仅解析普通登记文件，保留大小限制；不验证本机所有权、权限或祖先。
    async read(name) {
      let fd
      try {
        fd = await open(path(name), 'r')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return undefined
        }
        throw error
      }
      try {
        const stat = await fd.stat()
        if (!stat.isFile() || stat.size > 131072) {
          throw new ServiceError('service_conflict')
        }
        const bytes = Buffer.alloc(131073)
        let length = 0
        while (length < bytes.length) {
          const { bytesRead } = await fd.read(bytes, length, bytes.length - length, null)
          if (!bytesRead) {
            break
          }
          length += bytesRead
        }
        if (length > 131072) {
          throw new ServiceError('service_conflict')
        }
        return bytes.toString('utf8', 0, length)
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
    // 通过控制目录内的独占文件实现跨进程互斥，并在 finally 中只释放自有 inode。
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
        if (retain) {
          try {
            await closeLockHandle(fd)
          } catch {
            // 恢复保护必须传到全部外层角色锁；close 失败不能覆盖它，持久锁也不再查询或删除。
          }
        } else {
          await closeLockHandle(fd)
          const current = await lstat(target)
          if (owned.ino === current.ino && owned.dev === current.dev && !current.isSymbolicLink()) {
            await unlink(target)
          }
        }
      }
    }
  }
  return files
}
