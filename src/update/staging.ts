// 在已隔离的私有目录中持有排他锁并暂存下载；只创建自己的文件，永不替换可执行文件或用户数据。
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, realpath, rmdir, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { UpdateNetwork } from './network.js'
import { downloadUpdate, type VerifiedDownload } from './download.js'
import { validateDownloadPlan, type UpdatePlan } from './plan.js'
import { UpdateError } from './contract.js'

export type StagedUpdate = Readonly<{ path: string; receipt: VerifiedDownload }>
export type UpdateStagingFiles = Pick<
  typeof import('node:fs/promises'),
  'lstat' | 'mkdir' | 'mkdtemp' | 'open' | 'realpath' | 'rmdir' | 'unlink'
>
const nativeFiles: UpdateStagingFiles = { lstat, mkdir, mkdtemp, open, realpath, rmdir, unlink }

// 映射权限与暂存错误；不泄露文件系统路径或原始系统诊断。
function stagingError(error: unknown): UpdateError {
  if (error instanceof UpdateError) {
    return error
  }
  const code = (error as NodeJS.ErrnoException)?.code
  return new UpdateError(code === 'EACCES' || code === 'EPERM' ? 'permission_denied' : 'staging_failed')
}

// 验证现有暂存根为当前用户独占的真实目录；安装父目录及 ACL 须另由替换宿主验证。
async function privateRoot(root: string, files: UpdateStagingFiles): Promise<void> {
  if (process.platform !== 'linux') {
    // macOS/Windows 不能仅用 mode 推断有效 ACL；缺受信宿主前拒绝落盘。
    throw new UpdateError('replacement_unavailable')
  }
  if (!isAbsolute(root) || resolve(root) !== root || (await files.realpath(root)) !== root) {
    throw new UpdateError('unsafe_staging')
  }
  const stat = await files.lstat(root)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) {
    throw new UpdateError('unsafe_staging')
  }
  let parent = dirname(root)
  while (true) {
    const ancestor = await files.lstat(parent)
    // 对共享临时根只允许 sticky 目录；其它祖先不得允许组或任意用户改写目录项。
    if (
      !ancestor.isDirectory() ||
      ancestor.isSymbolicLink() ||
      ((ancestor.mode & 0o022) !== 0 && (ancestor.mode & 0o1000) === 0)
    ) {
      throw new UpdateError('unsafe_staging')
    }
    if (parent === dirname(parent)) {
      break
    }
    parent = dirname(parent)
  }
}

// 只做一次排他锁尝试，不删除旧锁、不猜 PID；调用结束前释放锁和全部自建暂存文件。
export async function withStagedUpdate<T>(
  root: string,
  network: UpdateNetwork,
  plan: UpdatePlan,
  inspect: (staged: StagedUpdate) => Promise<T>,
  files: UpdateStagingFiles = nativeFiles
): Promise<T> {
  validateDownloadPlan(plan)
  let locked = false
  let directory: string | undefined
  let path: string | undefined
  let created = false
  let file: Awaited<ReturnType<typeof open>> | undefined
  let result!: T
  let failure: UpdateError | undefined
  const lock = join(root, '.rovloom-update.lock')
  try {
    await privateRoot(root, files)
    try {
      await files.mkdir(lock, { mode: 0o700 })
      locked = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') {
        throw new UpdateError('update_busy')
      }
      throw error
    }
    directory = await files.mkdtemp(join(root, '.rovloom-update-'))
    path = join(directory, 'candidate')
    file = await files.open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600
    )
    created = true
    const receipt = await downloadUpdate(
      network,
      plan,
      /* 完整处理文件系统短写，失败交还暂存事务清理。 */ async (chunk) => {
        let offset = 0
        while (offset < chunk.byteLength) {
          const { bytesWritten } = await file!.write(chunk, offset, chunk.byteLength - offset)
          if (bytesWritten < 1) {
            throw new UpdateError('staging_failed')
          }
          offset += bytesWritten
        }
      }
    )
    await file.sync()
    await file.close()
    file = undefined
    result = await inspect(Object.freeze({ path, receipt }))
  } catch (error) {
    failure = stagingError(error)
  }
  // 每个清理步骤均尝试执行；保留首个失败，不递归删除任意目录或留下成功假象。
  try {
    await file?.close()
  } catch (error) {
    failure ??= stagingError(error)
  }
  if (path && created) {
    try {
      await files.unlink(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        failure ??= stagingError(error)
      }
    }
  }
  if (directory) {
    try {
      await files.rmdir(directory)
    } catch (error) {
      failure ??= stagingError(error)
    }
  }
  if (locked) {
    try {
      await files.rmdir(lock)
    } catch (error) {
      failure ??= stagingError(error)
    }
  }
  if (failure) {
    throw failure
  }
  return result
}
