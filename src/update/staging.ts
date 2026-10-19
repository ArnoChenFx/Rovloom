// 在已隔离的私有目录中持有排他锁并暂存下载；只创建自己的文件，永不替换可执行文件或用户数据。
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, realpath, rmdir, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { waitForUpdateOperation, type UpdateNetwork } from './network.js'
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

// 有界等待自己的 I/O；尚未静止时保留私有候选与锁，绝不让迟到操作跨入下一次事务。
export async function withStagedUpdate<T>(
  root: string,
  network: UpdateNetwork,
  plan: UpdatePlan,
  inspect: (staged: StagedUpdate, signal: AbortSignal) => Promise<T>,
  files: UpdateStagingFiles = nativeFiles
): Promise<T> {
  validateDownloadPlan(plan)
  const timeout = network.timeoutMs ?? 60_000
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60_000) {
    throw new UpdateError('invalid_arguments')
  }
  let locked = false
  let directory: string | undefined
  let path: string | undefined
  let created = false
  let file: Awaited<ReturnType<typeof open>> | undefined
  let activeIO: Promise<unknown> | undefined
  let activeConsumer: Promise<unknown> | undefined
  let result!: T
  let failure: UpdateError | undefined
  const lock = join(root, '.rovloom-update.lock')

  // 取消等待不伪造 syscall 取消；迟到结果仍只更新本事务已拥有资源的记录。
  async function io<V>(operation: () => Promise<V>, accept?: (value: V) => void): Promise<V> {
    const controller = new AbortController()
    const timer = setTimeout(/* 原生 I/O 逻辑等待也必须有界。 */ () => controller.abort(), timeout)
    const pending = Promise.resolve()
      .then(operation)
      .then(
        /* 即便已超时，也记录真实创建或关闭结果。 */ (value) => {
          accept?.(value)
          return value
        }
      )
    activeIO = pending
    // 仅在真实 Promise 静止后撤销待完成标记，不把 race 的拒绝当作静止证明。
    const settled = () => {
      if (activeIO === pending) {
        activeIO = undefined
      }
    }
    void pending.then(settled, settled)
    try {
      return await waitForUpdateOperation(pending, controller.signal)
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }

  // 按句柄、文件、子目录、锁顺序清理；若任一步仍 pending，停止后续删除或释放。
  async function cleanup(): Promise<void> {
    if (file) {
      try {
        await io(
          /* 只关闭本事务自己的句柄。 */ () => file!.close(),
          /* 关闭后不再重复使用句柄。 */ () => {
            file = undefined
          }
        )
      } catch (error) {
        failure ??= stagingError(error)
        if (activeIO) {
          return
        }
      }
    }
    if (path && created) {
      try {
        await io(
          /* 精确删除已创建候选，不递归清理其它内容。 */ () => files.unlink(path!),
          /* 删除完成才更新所有权记录。 */ () => {
            created = false
          }
        )
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          failure ??= stagingError(error)
        } else {
          created = false
        }
        if (activeIO) {
          return
        }
      }
    }
    if (directory) {
      try {
        await io(
          /* 仅移除自建空目录。 */ () => files.rmdir(directory!),
          /* 记录迟到删除结果，防止二次误删。 */ () => {
            directory = undefined
          }
        )
      } catch (error) {
        failure ??= stagingError(error)
        if (activeIO) {
          return
        }
      }
    }
    if (locked) {
      try {
        await io(
          /* 最后才释放本次取得的锁。 */ () => files.rmdir(lock),
          /* 后续实例可用后，本事务不得再次删除该名称。 */ () => {
            locked = false
          }
        )
      } catch (error) {
        failure ??= stagingError(error)
      }
    }
  }

  // 超时后仅观察既有副作用；静止后再尝试清理，永久 pending 或清理失败不清未知锁。
  function quarantine(): void {
    const pending = [activeIO, activeConsumer].filter(/* 只等待已经启动的操作。 */ (value) => value !== undefined)
    void Promise.allSettled(pending)
      .then(
        /* 旧 I/O 静止前不删除候选或释放锁。 */ async () => {
          await cleanup()
          if (activeIO || activeConsumer) {
            quarantine()
          }
        }
      )
      .catch(/* 后台回收失败保留隔离状态，不生成成功结果。 */ () => {})
  }

  try {
    await io(/* 只读预检也不无限等待。 */ () => privateRoot(root, files))
    try {
      await io(
        /* 只尝试一次排他创建。 */ () => files.mkdir(lock, { mode: 0o700 }),
        /* 迟到获取也必须记录，之后才能回收。 */ () => {
          locked = true
        }
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') {
        throw new UpdateError('update_busy')
      }
      throw error
    }
    await io(
      /* 每个事务独占随机子目录。 */ () => files.mkdtemp(join(root, '.rovloom-update-')),
      /* 保存真实返回路径。 */ (value) => {
        directory = value
      }
    )
    path = join(directory!, 'candidate')
    await io(
      /* 不覆盖或跟随既有文件。 */ () =>
        files.open(path!, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600),
      /* 即使打开迟到，也只登记本次句柄与候选。 */ (value) => {
        file = value
        created = true
      }
    )
    const receipt = await downloadUpdate(
      network,
      plan,
      /* Promise 覆盖全部短写循环；取消后不再发出下一次写入。 */ (chunk, signal) => {
        // 文件写 syscall 不可强退；等待与真实静止分别记录。
        const writing = async () => {
          let offset = 0
          while (offset < chunk.byteLength) {
            signal.throwIfAborted()
            const { bytesWritten } = await io(
              /* 单次写入只操作自有候选句柄。 */ () => file!.write(chunk, offset, chunk.byteLength - offset)
            )
            signal.throwIfAborted()
            if (bytesWritten < 1) {
              throw new UpdateError('staging_failed')
            }
            offset += bytesWritten
          }
        }
        const pending = writing()
        activeConsumer = pending
        // 只有整个 consumer 的实际 Promise 静止才能允许后台清理。
        const settled = () => {
          if (activeConsumer === pending) {
            activeConsumer = undefined
          }
        }
        void pending.then(settled, settled)
        return pending
      }
    )
    await io(/* 验证候选需先持久化原字节。 */ () => file!.sync())
    await io(
      /* 交出观察路径前完成自己的写入句柄。 */ () => file!.close(),
      /* 完整关闭后才撤销句柄。 */ () => {
        file = undefined
      }
    )
    await io(
      /* 受信观察者也必须报告完成前全部副作用静止。 */ async () => {
        const controller = new AbortController()
        const timer = setTimeout(/* 传播观察者取消请求，不伪造其已停止。 */ () => controller.abort(), timeout)
        try {
          result = await inspect(Object.freeze({ path: path!, receipt }), controller.signal)
        } finally {
          clearTimeout(timer)
        }
      }
    )
  } catch (error) {
    failure = stagingError(error)
  }
  if (activeIO || activeConsumer) {
    quarantine()
    throw new UpdateError('staging_io_pending')
  }
  await cleanup()
  if (activeIO || activeConsumer) {
    quarantine()
    throw new UpdateError('staging_io_pending')
  }
  if (failure) {
    throw failure
  }
  return result
}
