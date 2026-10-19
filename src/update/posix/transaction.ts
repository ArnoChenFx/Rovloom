// 执行持有安装/角色锁的 POSIX 更新事务；原生 I/O 未静止时只返回非零，后台保持租约并恢复安全状态。
import { constants } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import { createHash } from 'node:crypto'
import { ServiceManager } from '../../service/manager.js'
import { ServiceError, type ServiceSpec } from '../../service/types.js'
import { runSystemCommand, type CommandRunner } from '../../service/runner.js'
import { UpdateError, type UpdatePlatform } from '../contract.js'
import { downloadUpdate } from '../download.js'
import type { UpdateNetwork } from '../network.js'
import { checkForUpdate, validateDownloadPlan, type UpdatePlan } from '../plan.js'
import {
  assertOriginal,
  closeOwnedHandle,
  handleDigest,
  nativeHeader,
  openInstallation,
  posixFiles,
  probeVersion,
  protectedExecutablePath,
  sameInode,
  type FileIdentity,
  type PosixFiles,
  type PosixInstallation
} from './policy.js'

export type PosixUpdateOptions = {
  executable: string
  services: ServiceManager
  // 服务业务就绪由既有角色宿主证明；不能以 supervisor running 或固定 true 代替。
  verifyRoleReady?: (spec: ServiceSpec, version: string, signal: AbortSignal) => Promise<void>
  files?: PosixFiles
  runner?: CommandRunner
  timeoutMs?: number
}
export type PosixUpdateResult = Readonly<{ status: 'updated'; version: string }>
// 调用方逻辑超时后，真实后台事务仍有明确所有者，不能随未被引用的 Promise 一起被 GC 回收。
const activeTransactions = new Set<Promise<PosixUpdateResult>>()
type JournalPhase =
  | 'prepared'
  | 'backing_up'
  | 'quiescing'
  | 'quiesced'
  | 'replacing'
  | 'replaced'
  | 'restoring'
  | 'committed'
  | 'rolling_back'
  | 'rolled_back'
  | 'recovery_required'

// 将原生失败收敛为固定公共错误，不输出路径、角色配置或子进程原文。
function failure(error: unknown): UpdateError {
  if (error instanceof UpdateError) {
    return error
  }
  if (error instanceof ServiceError) {
    if (error.code === 'service_recovery_required') {
      return new UpdateError('update_recovery_required')
    }
    if (error.code === 'permission_denied') {
      return new UpdateError('permission_denied')
    }
    if (error.code === 'service_busy') {
      return new UpdateError('update_busy')
    }
    if (error.code === 'backend_unavailable') {
      return new UpdateError('replacement_unavailable')
    }
    return new UpdateError('unsafe_installation')
  }
  const code = (error as NodeJS.ErrnoException)?.code
  return new UpdateError(code === 'EACCES' || code === 'EPERM' ? 'permission_denied' : 'staging_failed')
}

export class PosixUpdater {
  #options: PosixUpdateOptions
  #pending = new Set<Promise<PosixUpdateResult>>()
  // 仅工厂创建具体状态机；CLI 不接受任意 apply 回调或用户输入的替换路径。
  private constructor(options: PosixUpdateOptions) {
    this.#options = Object.freeze({ ...options })
  }

  // 绑定受信运行时选定的安装和既有服务管理器，构造不产生系统副作用。
  static create(options: PosixUpdateOptions): PosixUpdater {
    return new PosixUpdater(options)
  }

  // 仅观察真实事务静止，不强制解锁；永久 I/O 等待仍可能使此观察保持 pending。
  async settled(): Promise<void> {
    await Promise.allSettled(this.#pending)
  }

  // 调用方有界等待，真正事务仍持有文件/角色锁直到全部副作用静止；失败不能伪装成更新完成。
  async update(network: UpdateNetwork, plan: UpdatePlan, callerSignal?: AbortSignal): Promise<PosixUpdateResult> {
    validateDownloadPlan(plan)
    const platform = plan.platform
    const report = process.report.getReport() as { header?: { glibcVersionRuntime?: unknown } }
    if (
      platform.os !== process.platform ||
      platform.arch !== process.arch ||
      (platform.os === 'linux' &&
        (typeof report.header?.glibcVersionRuntime !== 'string' || report.header.glibcVersionRuntime === ''))
    ) {
      throw new UpdateError('unsupported_platform')
    }
    const budget = this.#options.timeoutMs ?? 180_000
    if (!Number.isInteger(budget) || budget < 1 || budget > 180_000) {
      throw new UpdateError('invalid_arguments')
    }
    const controller = new AbortController()
    let rejectCaller!: (error: UpdateError) => void
    let resolveCaller!: (value: PosixUpdateResult) => void
    const outcome = new Promise<PosixUpdateResult>(
      /* 逻辑结果与事务实际退出分别跟踪。 */ (resolve, reject) => {
        resolveCaller = resolve
        rejectCaller = reject
      }
    )
    const timer = setTimeout(
      /* 不强杀业务进程或释放未知 I/O 的锁。 */ () => {
        controller.abort()
        rejectCaller(new UpdateError('update_io_pending'))
      },
      budget
    )
    // 外部取消也只撤销向前推进；实际 I/O、回滚与原服务恢复仍持有全部租约。
    const cancel = () => {
      controller.abort()
      rejectCaller(new UpdateError('update_io_pending'))
    }
    if (callerSignal?.aborted) {
      clearTimeout(timer)
      throw new UpdateError('update_io_pending')
    }
    callerSignal?.addEventListener('abort', cancel, { once: true })
    const task = this.#execute(
      network,
      plan,
      platform,
      controller.signal,
      /* 立即报告已保护的失败，但不能因此结束持锁作用域。 */ (error) => {
        controller.abort()
        rejectCaller(error)
      }
    )
    activeTransactions.add(task)
    this.#pending.add(task)
    // 只有实际作用域退出才撤销后台所有权。
    const settled = () => {
      activeTransactions.delete(task)
      this.#pending.delete(task)
    }
    void task.then(settled, settled)
    void task.then(resolveCaller, /* 仅真实事务退出才将其失败交给调用方。 */ (error) => rejectCaller(failure(error)))
    try {
      return await outcome
    } finally {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', cancel)
    }
  }

  // 事务只使用固定本地文件名及既有服务原语；不可恢复时保留恢复记录、旧版本和服务租约。
  async #execute(
    network: UpdateNetwork,
    plan: UpdatePlan,
    platform: UpdatePlatform,
    signal: AbortSignal,
    protectedFailure: (error: UpdateError) => void
  ): Promise<PosixUpdateResult> {
    const files = this.#options.files ?? posixFiles
    const run = this.#options.runner ?? runSystemCommand
    let installation: PosixInstallation | undefined
    let lock: string | undefined
    let lockIdentity: Awaited<ReturnType<typeof files.lstat>> | undefined
    let directory: string | undefined
    let directoryHandle: FileHandle | undefined
    let candidate: string | undefined
    let backup: string | undefined
    let currentCandidate: FileIdentity | undefined
    const owned = new Set<string>()
    let sequence = 0
    let armed = false
    let committed = false
    let recoveryRequired = false
    let rolledBackVerified = false
    let writePending: Promise<void> | undefined
    let saveRecovery: (() => Promise<void>) | undefined
    // 取消只阻止继续向前推进；回滚使用独立安全路径，不因调用方超时而半途放弃。
    const live = () => {
      if (signal.aborted) {
        throw new UpdateError('update_io_pending')
      }
    }
    // 计划不能被缓存或伪造后绕过官方最新稳定发行；下载后、停止服务前再次核对当前资产绑定。
    const currentRelease = async () => {
      live()
      const current = await checkForUpdate(network, plan.currentVersion, plan.platform)
      if (
        current.status !== 'available' ||
        current.tag !== plan.tag ||
        current.commit !== plan.commit ||
        current.targetVersion !== plan.targetVersion ||
        JSON.stringify(current.asset) !== JSON.stringify(plan.asset)
      ) {
        throw new UpdateError('invalid_manifest')
      }
    }
    // 不允许 cleanup 关闭仍在写的句柄；即使网络 race 超时也等待真实 consumer 静止。
    const quietWrite = async () => {
      if (writePending) {
        protectedFailure(new UpdateError('update_io_pending'))
        await Promise.allSettled([writePending])
      }
    }
    // 永久保护已无法证明恢复成功的安装；调用方收到非零，后台不释放可被复用的角色锁。
    const protect = async (): Promise<never> => {
      if (recoveryRequired) {
        throw new ServiceError('service_recovery_required')
      }
      recoveryRequired = true
      protectedFailure(new UpdateError('update_recovery_required'))
      try {
        await saveRecovery?.()
      } catch {
        /* 原有阶段记录、旧版和锁仍必须保留。 */
      }
      // 此处没有未静止 I/O；持久锁保护名称，显式关闭句柄不会使下一实例可用。
      for (const handle of [directoryHandle, installation?.file, installation?.parent]) {
        try {
          await closeOwnedHandle(handle)
        } catch {
          /* close 失败由专用所有权集合保护，不能删除锁。 */
        }
      }
      directoryHandle = undefined
      throw new ServiceError('service_recovery_required')
    }
    // 只释放自己持有且身份未变的锁；恢复保护状态保持全部资源。
    const releaseResources = async (): Promise<void> => {
      if (!recoveryRequired) {
        await closeOwnedHandle(directoryHandle)
        await closeOwnedHandle(installation?.file)
        await closeOwnedHandle(installation?.parent)
        if (lock && lockIdentity) {
          const current = await files.lstat(lock)
          if (current.isSymbolicLink() || current.dev !== lockIdentity.dev || current.ino !== lockIdentity.ino) {
            throw new UpdateError('update_cleanup_failed')
          }
          await files.rmdir(lock)
        }
      }
    }
    try {
      live()
      await currentRelease()
      // 旧版硬链接备份存在时 nlink 会增加；先识别固定安装锁，不把并发更新误报为损坏程序。
      const requested = this.#options.executable
      if (isAbsolute(requested) && normalize(requested) === requested) {
        const suffix = createHash('sha256').update(requested).digest('hex').slice(0, 24)
        try {
          await files.lstat(join(dirname(requested), `.rovloom-update-${suffix}.lock`))
          throw new UpdateError('update_busy')
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
            throw error
          }
        }
      }
      installation = await openInstallation(this.#options.executable, plan.currentVersion, platform, files, run)
      live()
      const suffix = createHash('sha256').update(installation.executable).digest('hex').slice(0, 24)
      lock = join(installation.directory, `.rovloom-update-${suffix}.lock`)
      try {
        await files.mkdir(lock, { mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') {
          throw new UpdateError('update_busy')
        }
        throw error
      }
      lockIdentity = await files.lstat(lock)
      await installation.parent.sync()
      live()
      return await this.#options.services.withBinaryUpdate(
        installation.executable,
        /* 文件交换、回滚和角色恢复完整处于两个原角色锁内。 */ async (session) => {
          if (
            session.snapshots.some(
              /* 运行中的角色必须有真实业务就绪验证器。 */ (snapshot) => snapshot.state === 'running'
            ) &&
            !this.#options.verifyRoleReady
          ) {
            throw new UpdateError('replacement_unavailable')
          }
          // 原子更新恢复记录；记录先 fsync，再允许触发与之对应的受控副作用。
          const journal = async (phase: JournalPhase) => {
            const temporary = `journal-${sequence++}.tmp`
            const file = await files.open(join(directory!, temporary), 'wx', 0o600)
            owned.add(temporary)
            try {
              await file.writeFile(
                JSON.stringify({
                  schemaVersion: 1,
                  phase,
                  executable: installation!.executable,
                  currentVersion: plan.currentVersion,
                  targetVersion: plan.targetVersion,
                  tag: plan.tag,
                  commit: plan.commit,
                  original: installation!.identity,
                  candidate: currentCandidate ?? null,
                  roles: session.snapshots
                }) + '\n'
              )
              await file.sync()
            } finally {
              await closeOwnedHandle(file)
            }
            await files.rename(join(directory!, temporary), join(directory!, 'journal.json'))
            owned.delete(temporary)
            owned.add('journal.json')
            await directoryHandle!.sync()
          }
          // 保护失败优先保留已有证据，再尽力记录明确恢复状态；写记录本身也不得提前释放锁。
          saveRecovery = /* 持久标记当前受保护的恢复事务。 */ () => journal('recovery_required')
          // 验证路径当前仍是已知 inode 和原始字节，不把同名异物覆盖成旧版本。
          const matches = async (path: string, identity: FileIdentity): Promise<boolean> => {
            let stat
            try {
              stat = await files.lstat(path, { bigint: true })
            } catch (error) {
              if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
                return false
              }
              throw error
            }
            if (
              !stat.isFile() ||
              stat.isSymbolicLink() ||
              String(stat.dev) !== identity.dev ||
              String(stat.ino) !== identity.ino ||
              Number(stat.uid) !== identity.uid ||
              Number(stat.gid) !== identity.gid ||
              (Number(stat.mode) & 0o7777) !== identity.mode ||
              Number(stat.size) !== identity.size
            ) {
              return false
            }
            const file = await files.open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
            try {
              return (
                sameInode(stat, await file.stat({ bigint: true })) && (await handleDigest(file)) === identity.sha256
              )
            } finally {
              await closeOwnedHandle(file)
            }
          }
          // 就绪验证只来自受信角色宿主；回滚不使用已取消的前进 signal。
          const restore = async (version: string, rollback: boolean) => {
            const recovery = new AbortController()
            const cancellation = rollback ? recovery.signal : signal
            await session.restore(
              version,
              /* 逐角色验证指定版本业务可用。 */ async (spec, expected) => {
                await this.#options.verifyRoleReady!(spec, expected, cancellation)
              },
              cancellation
            )
          }
          // 精确清理自己的事务文件；未知状态保留恢复证据和角色租约。
          const cleanupTransaction = async (): Promise<void> => {
            if (!recoveryRequired) {
              // 若目标已变成未知 inode，不能删除唯一旧版，也不能覆盖外部替换；保留记录及租约。
              if (!committed && !rolledBackVerified && owned.has('previous')) {
                try {
                  if (!(await matches(installation!.executable, installation!.identity))) {
                    await protect()
                  }
                } catch {
                  await protect()
                }
              }
              try {
                if (directory) {
                  const entries = await files.readdir(directory)
                  if (entries.some(/* 不递归删除未知文件、配置或数据。 */ (name) => !owned.has(name))) {
                    throw new UpdateError('update_cleanup_failed')
                  }
                  for (const name of owned) {
                    try {
                      await files.unlink(join(directory, name))
                    } catch (error) {
                      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
                        throw error
                      }
                    }
                  }
                  await directoryHandle?.sync()
                  await closeOwnedHandle(directoryHandle)
                  directoryHandle = undefined
                  await files.rmdir(directory)
                  directory = undefined
                  await installation!.parent.sync()
                }
              } catch {
                // 恢复前或未提交时不能失去唯一旧版/恢复记录，也不能释放角色租约让服务误启。
                if (armed && !committed && !rolledBackVerified) {
                  return await protect()
                }
                throw new UpdateError('update_cleanup_failed')
              }
            }
          }
          try {
            live()
            directory = await files.mkdtemp(join(installation!.directory, `.rovloom-update-${suffix}-`))
            directoryHandle = await files.open(
              directory,
              constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
            )
            candidate = join(directory, 'candidate')
            backup = join(directory, 'previous')
            const output = await files.open(
              candidate,
              constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
              0o600
            )
            owned.add('candidate')
            try {
              await downloadUpdate(
                network,
                plan,
                /* Promise 覆盖真实短写循环，不丢弃迟到写入状态。 */ (chunk, cancelled) => {
                  // 原生 write 不可强退，退出后还要等待其 Promise，不能让 cleanup 提前重用资源。
                  const write = async () => {
                    let offset = 0
                    while (offset < chunk.length) {
                      live()
                      cancelled.throwIfAborted()
                      const { bytesWritten } = await output.write(chunk, offset, chunk.length - offset)
                      if (!bytesWritten) {
                        throw new UpdateError('staging_failed')
                      }
                      offset += bytesWritten
                    }
                  }
                  const pending = write()
                  writePending = pending
                  // 只有真实写入静止才撤销记录。
                  const settled = () => {
                    if (writePending === pending) {
                      writePending = undefined
                    }
                  }
                  void pending.then(settled, settled)
                  return pending
                }
              )
              await output.sync()
              const created = await output.stat({ bigint: true })
              if (
                created.uid !== BigInt(installation!.identity.uid) ||
                created.gid !== BigInt(installation!.identity.gid)
              ) {
                await output.chown(installation!.identity.uid, installation!.identity.gid)
              }
              await output.chmod(installation!.identity.mode)
              const stat = await output.stat({ bigint: true })
              if (
                stat.uid !== BigInt(installation!.identity.uid) ||
                stat.gid !== BigInt(installation!.identity.gid) ||
                (Number(stat.mode) & 0o7777) !== installation!.identity.mode ||
                Number(stat.size) !== plan.asset.size
              ) {
                throw new UpdateError('unsafe_installation')
              }
              await nativeHeader(output, platform)
              await output.sync()
              // 网络摘要不能证明文件系统实际写入字节；执行候选或停止角色前核验持有句柄的落盘内容。
              const storedDigest = await handleDigest(output)
              if (storedDigest !== plan.asset.sha256) {
                throw new UpdateError('checksum_mismatch')
              }
              currentCandidate = Object.freeze({
                dev: String(stat.dev),
                ino: String(stat.ino),
                uid: Number(stat.uid),
                gid: Number(stat.gid),
                mode: Number(stat.mode) & 0o777,
                size: Number(stat.size),
                sha256: storedDigest
              })
            } finally {
              await quietWrite()
              await closeOwnedHandle(output)
            }
            live()
            await probeVersion(candidate, plan.targetVersion, run)
            await currentRelease()
            await protectedExecutablePath(installation!.executable, platform, files, run)
            await assertOriginal(installation!, files, false)
            await journal('backing_up')
            try {
              await files.link(installation!.executable, backup!)
              owned.add('previous')
            } catch (error) {
              // link 可能先落盘再报告失败；只有已核对原 inode/字节的备份才可进入清理集合。
              if (await matches(backup!, installation!.identity)) {
                owned.add('previous')
              }
              throw error
            }
            await directoryHandle!.sync()
            await assertOriginal(installation!, files, true)
            await journal('prepared')
            // 子目录内记录持久化并不能持久化父目录中的事务入口；停服前同步父目录。
            await installation!.parent.sync()
            live()
            await journal('quiescing')
            armed = true
            await session.quiesce()
            await journal('quiesced')
            live()
            await assertOriginal(installation!, files, true)
            await session.assertQuiescent()
            await protectedExecutablePath(installation!.executable, platform, files, run, 2)
            await journal('replacing')
            live()
            await files.rename(candidate!, installation!.executable)
            owned.delete('candidate')
            await installation!.parent.sync()
            if (!(await matches(installation!.executable, currentCandidate!))) {
              throw new UpdateError('target_changed')
            }
            await journal('replaced')
            live()
            await journal('restoring')
            await restore(plan.targetVersion, false)
            await probeVersion(installation!.executable, plan.targetVersion, run)
            // 业务就绪可能跨越任意异步等待；提交前重新证明目标仍是本事务的候选及访问边界。
            await protectedExecutablePath(installation!.executable, platform, files, run)
            if (!(await matches(installation!.executable, currentCandidate!))) {
              throw new UpdateError('target_changed')
            }
            live()
            await journal('committed')
            committed = true
            return Object.freeze({ status: 'updated' as const, version: plan.targetVersion })
          } catch (error) {
            await quietWrite()
            if (armed) {
              try {
                // 角色可能已使用新 binary 恢复，文件回滚前先复用原后端再次核实静止。
                await session.quiesce()
                try {
                  await journal('rolling_back')
                } catch {
                  /* 元数据失败不能阻止恢复原程序。 */
                }
                if (!(await matches(installation!.executable, installation!.identity))) {
                  if (
                    !currentCandidate ||
                    !(await matches(installation!.executable, currentCandidate)) ||
                    !(await matches(backup!, installation!.identity))
                  ) {
                    return await protect()
                  }
                  await files.rename(backup!, installation!.executable)
                  owned.delete('previous')
                  await installation!.parent.sync()
                }
                await protectedExecutablePath(
                  installation!.executable,
                  platform,
                  files,
                  run,
                  owned.has('previous') ? 2 : 1
                )
                await probeVersion(installation!.executable, plan.currentVersion, run)
                await restore(plan.currentVersion, true)
                await protectedExecutablePath(
                  installation!.executable,
                  platform,
                  files,
                  run,
                  owned.has('previous') ? 2 : 1
                )
                if (!(await matches(installation!.executable, installation!.identity))) {
                  return await protect()
                }
                try {
                  await journal('rolled_back')
                } catch {
                  /* 已验证恢复，不把记录写失败转为成功。 */
                }
              } catch (recoveryError) {
                if (recoveryError instanceof ServiceError && recoveryError.code === 'service_recovery_required') {
                  throw recoveryError
                }
                return await protect()
              }
              rolledBackVerified = true
              throw new UpdateError('update_rolled_back')
            }
            throw error
          } finally {
            await cleanupTransaction()
          }
        }
      )
    } catch (error) {
      throw failure(error)
    } finally {
      await releaseResources()
    }
  }
}

// 工厂只接受受信宿主已选定的安装及服务管理器；没有任意 URL、脚本、PID 或 apply 入口。
export function createPosixUpdater(options: PosixUpdateOptions): PosixUpdater {
  return PosixUpdater.create(options)
}
