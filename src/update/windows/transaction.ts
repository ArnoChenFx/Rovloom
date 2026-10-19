// Windows 固定 helper 闭环：自身取得全部锁，证明直接父退出后才替换；不执行下载脚本或接管任意 PID。
import { spawn } from 'node:child_process'
import { win32 } from 'node:path'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import { parseReleaseJson } from '../../release/contract.js'
import { ServiceManager } from '../../service/manager.js'
import { ServiceError, type ServiceSpec } from '../../service/types.js'
import { runSystemCommand } from '../../service/runner.js'
import { UpdateError, updateExitCode, type UpdateErrorCode } from '../contract.js'
import { downloadUpdate } from '../download.js'
import { checkForUpdate, validateDownloadPlan, type UpdatePlan } from '../plan.js'
import type { UpdateNetwork } from '../network.js'
import { WindowsBoundParent, nativeWindowsParent } from './parent.js'
import {
  WINDOWS_HELPER_COMMAND,
  openWindowsJob,
  parseWindowsTicket,
  sealWindowsJob,
  type WindowsFileIdentity,
  type WindowsHelperReceipt,
  type WindowsHelperTicket
} from './protocol.js'
import {
  WindowsPathLease,
  WindowsCandidateWriter,
  cloneWindowsCandidate,
  moveWindowsExecutable,
  readWindowsExecutable,
  writeWindowsReceipt,
  writeWindowsRecord
} from './files.js'

export type WindowsUpdateResult = Readonly<{ status: 'handoff_pending'; transactionId: string; receipt: string }>
export type WindowsHelperHost = UpdateNetwork & {
  services: ServiceManager
  verifyRoleReady?: (spec: ServiceSpec, version: string, signal: AbortSignal) => Promise<void>
  input: Readable
  output: Writable
  write(message: string): void
}
const frameCodes: readonly UpdateErrorCode[] = [
  'permission_denied',
  'update_busy',
  'replacement_unavailable',
  'update_recovery_required',
  'candidate_unusable',
  'checksum_mismatch',
  'invalid_manifest',
  'update_io_pending',
  'staging_failed',
  'update_rolled_back'
]

// 限定公开错误，不把系统脚本输出、配置路径或底层异常传给父端。
function failure(error: unknown): UpdateError {
  if (error instanceof UpdateError && frameCodes.includes(error.code)) {
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
  }
  return new UpdateError('staging_failed')
}

// 交接只认可本次 stdin secret 对固定字段的 MAC；这不是发行者认证。
function frame(
  ticket: WindowsHelperTicket,
  digest: string,
  state: 'ready' | 'failed',
  code: UpdateErrorCode | null
): string {
  const value = { state, transactionId: ticket.transactionId, jobSha256: digest, code }
  const payload = JSON.stringify(value)
  return (
    JSON.stringify({
      ...value,
      mac: createHmac('sha256', Buffer.from(ticket.secret, 'hex')).update(payload).digest('hex')
    }) + '\n'
  )
}

// helper 的唯一输入是两个有界行帧；EOF/错误不能成为 commit 或父退出证明。
class InputFrames {
  #buffer = Buffer.alloc(0)
  #queue: Buffer[] = []
  #total = 0
  #frames = 0
  #ended = false
  #pending: { resolve(value: Buffer): void; reject(error: unknown): void } | undefined
  // 只订阅本 helper 的 stdin，不打开外部 IPC 名称或套接字。
  constructor(private readonly input: Readable) {
    input.on('data', this.data)
    input.on('end', this.end)
    input.on('error', this.end)
  }
  // 两帧合计受限，任意多余帧或巨型字段在解析前拒绝。
  private data = (bytes: Buffer) => {
    this.#total += bytes.length
    if (this.#total > 49152) {
      this.end()
      this.input.destroy()
      return
    }
    this.#buffer = Buffer.concat([this.#buffer, bytes])
    for (let at = this.#buffer.indexOf(10); at >= 0; at = this.#buffer.indexOf(10)) {
      this.#frames++
      this.#queue.push(this.#buffer.subarray(0, at))
      this.#buffer = this.#buffer.subarray(at + 1)
      if (this.#frames > 2) {
        this.end()
        this.input.destroy()
        return
      }
    }
    if (this.#pending && this.#queue.length) {
      const pending = this.#pending
      this.#pending = undefined
      pending.resolve(this.#queue.shift()!)
    }
  }
  // 半帧、管道关闭和任何输入错误只使尚未提交的事务失败。
  private end = () => {
    this.#ended = true
    this.#pending?.reject(new UpdateError('update_io_pending'))
    this.#pending = undefined
  }
  // 每次只存在一个有界等待；取消后关闭本输入，不留下会偷取后续帧的后台读取。
  async next(signal: AbortSignal): Promise<Buffer> {
    if (signal.aborted) {
      throw new UpdateError('update_io_pending')
    }
    const value = this.#queue.shift()
    if (value !== undefined) {
      return value
    }
    if (this.#ended || this.#pending) {
      throw new UpdateError('update_io_pending')
    }
    // 取消只结束当前输入等待，不释放正在工作的文件事务。
    const stop = () => {
      this.end()
      this.input.destroy()
    }
    signal.addEventListener('abort', stop, { once: true })
    try {
      return await new Promise<Buffer>(
        /* 保存唯一读取等待，不伪造 EOF 后的成功。 */ (resolve, reject) => {
          this.#pending = { resolve, reject }
        }
      )
    } finally {
      signal.removeEventListener('abort', stop)
    }
  }
  // 释放监听并关闭自有管道；不关闭文件/角色锁或任何外部进程。
  close(): void {
    this.end()
    this.input.off('data', this.data)
    this.input.off('end', this.end)
    this.input.off('error', this.end)
    this.input.destroy()
  }
}

// 版本探针在大小/摘要/PE 检查之后才执行，输出须严格匹配产品契约。
async function version(executable: string, expected: string): Promise<void> {
  const result = await runSystemCommand({ executable, args: ['--version'], timeout: 10000 })
  if (result.code !== 0 || result.stdout !== '' || result.stderr !== `Rovloom ${expected}\n`) {
    throw new UpdateError('candidate_unusable')
  }
}

// 原文件/候选均逐字段比对，不以文件名相同代替对象和实际字节证明。
function same(actual: WindowsFileIdentity, expected: WindowsFileIdentity): boolean {
  return (
    actual.volume === expected.volume &&
    actual.fileId === expected.fileId &&
    actual.size === expected.size &&
    actual.sha256 === expected.sha256 &&
    actual.security === expected.security
  )
}

// 每个 helper 在下载后及父退出后重读官方稳定计划，拒绝过期 tag/commit/资产。
async function currentRelease(network: UpdateNetwork, plan: UpdatePlan): Promise<void> {
  const current = await checkForUpdate(network, plan.currentVersion, plan.platform)
  if (current.status !== 'available' || JSON.stringify(current) !== JSON.stringify(plan)) {
    throw new UpdateError('invalid_manifest')
  }
}

export class WindowsUpdater {
  // 安装路径只能由可信宿主绑定，执行时还须等于内核报告的当前映像。
  private constructor(private readonly executable: string) {}
  // 创建不联网、不操作安装或系统服务。
  static create(options: Readonly<{ executable: string }>): WindowsUpdater {
    return new WindowsUpdater(options.executable)
  }

  // 父端只报告明确的非零待完成状态；它不能在自身退出前冒充 helper 已完成替换。
  async update(plan: UpdatePlan, signal?: AbortSignal): Promise<WindowsUpdateResult> {
    validateDownloadPlan(plan)
    if (plan.platform.os !== 'windows' || process.platform !== 'win32' || plan.platform.arch !== process.arch) {
      throw new UpdateError('unsupported_platform')
    }
    if (signal?.aborted) {
      throw new UpdateError('update_io_pending')
    }
    const parent = nativeWindowsParent.self()
    if (parent.image !== this.executable) {
      throw new UpdateError('unsafe_installation')
    }
    const arch = plan.platform.arch
    const original = readWindowsExecutable(this.executable, arch)
    await version(this.executable, plan.currentVersion)
    const lease = WindowsPathLease.acquire(this.executable)
    const transactionId = randomBytes(16).toString('hex')
    let closed = false
    try {
      const directory = lease.createDirectory(transactionId)
      const sealed = sealWindowsJob(plan, parent, original, { transactionId, directory: lease.identity(transactionId) })
      cloneWindowsCandidate(lease, transactionId, arch, original, 'helper.exe')
      const child = spawn(win32.join(directory, 'helper.exe'), [WINDOWS_HELPER_COMMAND], {
        shell: false,
        // Windows 必须独立于 producer 的进程生命周期；unref 仅撤销事件循环引用，不能代替 detached。
        detached: true,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'inherit'],
        env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot }
      })
      child.stdin.on('error', /* 自有管道失败由握手/写完成分支报告，不变成未处理事件。 */ () => {})
      // 只有受 MAC 保护的 ready 能提交交接；退出/EOF/超限/取消均不能成功。
      await new Promise<void>(
        /* 等待固定 helper 的有界 ready 帧，不等待或杀死任意 PID。 */ (resolve, reject) => {
          let bytes = Buffer.alloc(0)
          let done = false
          // 一次握手只能结算一次；超时不伪造 helper 已退出。
          const stop = (error?: unknown) => {
            if (done) {
              return
            }
            done = true
            clearTimeout(timer)
            signal?.removeEventListener('abort', cancel)
            if (error) {
              child.stdin.destroy()
              reject(error)
            } else {
              resolve()
            }
          }
          // 取消后关闭自有 stdin，helper 在 commit 前只能拒绝。
          const cancel = () => stop(new UpdateError('update_io_pending'))
          const timer = setTimeout(cancel, 180000)
          signal?.addEventListener('abort', cancel, { once: true })
          child.once(
            'error',
            /* 只映射启动错误，不回显路径或原始消息。 */ () => stop(new UpdateError('replacement_unavailable'))
          )
          child.once(
            'close',
            /* ready 之前真实 close 只能判失败；ready 后的最终状态由持久回执报告。 */ () =>
              stop(new UpdateError('staging_failed'))
          )
          child.stdout.on(
            'data',
            /* 先限长，再核对完整封闭帧及本次字节 MAC。 */ (chunk: Buffer) => {
              if (done) {
                return
              }
              bytes = Buffer.concat([bytes, chunk])
              if (bytes.length > 2048) {
                stop(new UpdateError('invalid_manifest'))
                return
              }
              if (!bytes.includes(10)) {
                return
              }
              try {
                if (bytes.at(-1) !== 10 || bytes.indexOf(10) !== bytes.length - 1) {
                  throw new UpdateError('invalid_manifest')
                }
                const value = parseReleaseJson(bytes.subarray(0, -1), 2048) as Record<string, unknown>
                if (
                  Object.keys(value).sort().join(',') !== 'code,jobSha256,mac,state,transactionId' ||
                  value.transactionId !== transactionId ||
                  value.jobSha256 !== sealed.digest ||
                  !['ready', 'failed'].includes(value.state as string) ||
                  typeof value.mac !== 'string' ||
                  !/^[0-9a-f]{64}$/u.test(value.mac) ||
                  (value.state === 'ready' ? value.code !== null : !frameCodes.includes(value.code as UpdateErrorCode))
                ) {
                  throw new UpdateError('invalid_manifest')
                }
                const expected = frame(
                  sealed.ticket,
                  sealed.digest,
                  value.state as 'ready' | 'failed',
                  value.code as UpdateErrorCode | null
                )
                const mac = (JSON.parse(expected) as { mac: string }).mac
                if (!timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(value.mac, 'hex'))) {
                  throw new UpdateError('invalid_manifest')
                }
                if (value.state === 'failed') {
                  throw new UpdateError(value.code as UpdateErrorCode)
                }
                stop()
              } catch (error) {
                stop(error)
              }
            }
          )
          child.stdin.write(
            JSON.stringify({ ticket: sealed.ticket, envelope: Buffer.from(sealed.bytes).toString('base64') }) + '\n'
          )
        }
      )
      lease.close()
      closed = true
      await new Promise<void>(
        /* stdin 真正完成提交后才把待完成状态交给唯一 CLI。 */ (resolve, reject) =>
          child.stdin.end(
            'commit\n',
            /* 真实写完成才允许父端返回待完成。 */ () => {
              if (child.stdin.errored) {
                reject(new UpdateError('update_io_pending'))
              } else {
                resolve()
              }
            }
          )
      )
      child.stdout.destroy()
      child.unref()
      return Object.freeze({ status: 'handoff_pending', transactionId, receipt: win32.join(directory, 'receipt.json') })
    } finally {
      if (!closed) {
        lease.close()
      }
    }
  }
}

// 唯一 CLI 先调用此窄接缝；不匹配时原样交还现有 parser，不接受 helper 路径/PID 参数。
export async function handleWindowsUpdateHelperCommand(
  args: readonly string[],
  host: WindowsHelperHost
): Promise<number | undefined> {
  if (args[0] !== WINDOWS_HELPER_COMMAND) {
    return undefined
  }
  if (args.length !== 1 || process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)) {
    return 2
  }
  const input = new InputFrames(host.input)
  const controller = new AbortController()
  const deadline = performance.now() + 180000
  // 未静止的 Promise 不能因事件循环暂空而使 helper 以默认零退出并丢失锁所有权。
  const ownership = setInterval(/* 只维持本 helper 生命周期，不查询或控制任何其它进程。 */ () => {}, 1000)
  const timer = setTimeout(
    /* 总期限只阻止向前推进，回滚使用独立恢复路径。 */ () => {
      controller.abort()
      process.exitCode = 4
    },
    180000
  )
  let lease: WindowsPathLease | undefined
  let parent: WindowsBoundParent | undefined
  let ticket: WindowsHelperTicket | undefined
  let digest = ''
  let sequence = 0
  let ready = false
  let retainLock = false
  let locked = false
  let exitCode = 4
  let versions: { current: string; target: string } | undefined
  let receipt:
    | ((state: WindowsHelperReceipt['state'], code?: WindowsHelperReceipt['code'], terminalExit?: number) => void)
    | undefined
  // 在所有前进边界检查期限；绝不因逻辑取消中断安全回滚或提前释放锁。
  const live = () => {
    if (controller.signal.aborted || performance.now() >= deadline) {
      throw new UpdateError('update_io_pending')
    }
  }
  // 小帧写入须观察真实流完成，输出失败不能被算成有效 ready。
  const send = async (text: string) =>
    new Promise<void>(
      /* 只写入本 helper 继承的专用 IPC 流。 */ (resolve, reject) =>
        host.output.write(text, /* 写失败不能当成 IPC 完成。 */ (error) => (error ? reject(error) : resolve()))
    )
  try {
    const initial = parseReleaseJson(Buffer.from(await input.next(controller.signal)), 49152) as Record<string, unknown>
    if (Object.keys(initial).sort().join(',') !== 'envelope,ticket' || typeof initial.envelope !== 'string') {
      throw new UpdateError('invalid_manifest')
    }
    ticket = parseWindowsTicket(Buffer.from(JSON.stringify(initial.ticket)))
    const bytes = Buffer.from(initial.envelope, 'base64')
    if (bytes.toString('base64') !== initial.envelope) {
      throw new UpdateError('invalid_manifest')
    }
    const opened = openWindowsJob(bytes, ticket)
    const job = opened.job
    if (!(host.services instanceof ServiceManager)) {
      throw new UpdateError('replacement_unavailable')
    }
    digest = opened.digest
    const plan = job.plan
    if (plan.platform.arch !== process.arch) {
      throw new UpdateError('unsupported_platform')
    }
    parent = WindowsBoundParent.bind(job.parent)
    lease = WindowsPathLease.acquire(job.parent.image)
    lease.adoptDirectory(job.transactionId, job.directory)
    const directory = lease.directory(job.transactionId)
    const helper = nativeWindowsParent.self()
    if (helper.image !== win32.join(directory, 'helper.exe')) {
      throw new UpdateError('unsafe_installation')
    }
    const helperFile = readWindowsExecutable(helper.image, plan.platform.arch)
    if (
      helperFile.volume !== job.original.volume ||
      helperFile.fileId === job.original.fileId ||
      helperFile.sha256 !== job.original.sha256 ||
      helperFile.size !== job.original.size ||
      helperFile.security !== job.original.security ||
      !same(readWindowsExecutable(job.parent.image, plan.platform.arch), job.original)
    ) {
      throw new UpdateError('target_changed')
    }
    lease.acquireInstallationLock()
    locked = true
    const held = lease
    // 回执不包含 secret、配置内容或原生错误原文；journal 另保留原角色引用和固定阶段。
    receipt = /* 只产生与当前封存作业绑定的固定状态回执。 */ (state, code = null, terminalExit?: number) =>
      writeWindowsReceipt(
        held,
        job.transactionId,
        ++sequence,
        Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            transactionId: job.transactionId,
            jobSha256: digest,
            sequence,
            state,
            code,
            exitCode:
              terminalExit ??
              (state === 'updated'
                ? 0
                : state === 'rolled_back'
                  ? 6
                  : state === 'recovery_required'
                    ? 7
                    : state === 'cleanup_required' || state === 'aborted'
                      ? 4
                      : null)
          })
        )
      )
    const completed = await host.services.withBinaryUpdate(
      job.parent.image,
      /* 所有文件推进和补偿都在既有双角色锁内。 */ async (session) => {
        if (
          session.snapshots.some(/* 运行角色必须有真正版本业务探针。 */ (snapshot) => snapshot.state === 'running') &&
          !host.verifyRoleReady
        ) {
          throw new UpdateError('replacement_unavailable')
        }
        let candidate: WindowsFileIdentity | undefined
        let armed = false
        let moved = false
        // 日志在每次破坏性步骤前落盘，恢复保护分支保留全部文件及安装/角色锁。
        const journal = (phase: string) =>
          writeWindowsRecord(
            held,
            job.transactionId,
            'journal',
            ++sequence,
            Buffer.from(
              JSON.stringify({
                schemaVersion: 1,
                job,
                jobSha256: digest,
                sequence,
                phase,
                candidate,
                roles: session.snapshots
              })
            )
          )
        // 业务就绪与监管稳定由既有 manager 分别验证，不用版本进程代替角色健康。
        const restore = (target: string, signal: AbortSignal) =>
          session.restore(
            target,
            /* 只把锁定快照交给可信运行时探针。 */ async (spec, expected) => {
              if (!host.verifyRoleReady) {
                throw new UpdateError('replacement_unavailable')
              }
              await host.verifyRoleReady(spec, expected, signal)
            }
          )
        try {
          live()
          await currentRelease(host, plan)
          live()
          const clone = cloneWindowsCandidate(held, job.transactionId, plan.platform.arch, job.original)
          const writer = WindowsCandidateWriter.open(held, job.transactionId, clone)
          try {
            await downloadUpdate(
              host,
              plan,
              /* 每片原生写完成才结算 sink；取消不释放仍活着的文件/角色租约。 */ async (chunk, signal) => {
                live()
                if (signal.aborted) {
                  throw new UpdateError('update_io_pending')
                }
                writer.write(chunk)
              }
            )
          } finally {
            writer.close()
          }
          candidate = readWindowsExecutable(win32.join(directory, 'candidate.exe'), plan.platform.arch)
          if (
            candidate.sha256 !== plan.asset.sha256 ||
            candidate.size !== plan.asset.size ||
            candidate.security !== job.original.security
          ) {
            throw new UpdateError('checksum_mismatch')
          }
          await version(win32.join(directory, 'candidate.exe'), plan.targetVersion)
          live()
          await currentRelease(host, plan)
          live()
          journal('prepared')
          receipt!('prepared')
          await send(frame(ticket!, digest, 'ready', null))
          ready = true
          if (!(await input.next(controller.signal)).equals(Buffer.from('commit'))) {
            throw new UpdateError('update_io_pending')
          }
          journal('awaiting_parent')
          await parent!.waitForExit(controller.signal)
          parent!.assertExited()
          journal('parent_exited')
          live()
          await currentRelease(host, plan)
          live()
          if (
            !same(readWindowsExecutable(job.parent.image, plan.platform.arch), job.original) ||
            !same(readWindowsExecutable(win32.join(directory, 'candidate.exe'), plan.platform.arch), candidate)
          ) {
            throw new UpdateError('target_changed')
          }
          journal('quiescing')
          armed = true
          await session.quiesce()
          live()
          await session.assertQuiescent()
          journal('preserving')
          receipt!('replacing')
          parent!.assertExited()
          if (!same(readWindowsExecutable(job.parent.image, plan.platform.arch), job.original)) {
            throw new UpdateError('target_changed')
          }
          moveWindowsExecutable(held, job.transactionId, 'preserve')
          moved = true
          if (!same(readWindowsExecutable(win32.join(directory, 'previous.exe'), plan.platform.arch), job.original)) {
            throw new UpdateError('target_changed')
          }
          journal('installing')
          live()
          moveWindowsExecutable(held, job.transactionId, 'install')
          journal('installed')
          receipt!('replaced')
          if (!same(readWindowsExecutable(job.parent.image, plan.platform.arch), candidate)) {
            throw new UpdateError('target_changed')
          }
          await version(job.parent.image, plan.targetVersion)
          live()
          journal('restoring')
          await restore(plan.targetVersion, controller.signal)
          live()
          if (!same(readWindowsExecutable(job.parent.image, plan.platform.arch), candidate)) {
            throw new UpdateError('target_changed')
          }
          await version(job.parent.image, plan.targetVersion)
          live()
          journal('committed')
          receipt!('updated')
          return 0
        } catch (error) {
          if (!armed) {
            receipt!('aborted', 'verification_failed', updateExitCode(failure(error)))
            throw error
          }
          try {
            journal('rolling_back')
            receipt!('rolling_back')
            await session.quiesce()
            await session.assertQuiescent()
            if (moved) {
              if (
                !same(readWindowsExecutable(win32.join(directory, 'previous.exe'), plan.platform.arch), job.original)
              ) {
                throw new UpdateError('target_changed')
              }
              let current: WindowsFileIdentity | undefined
              try {
                current = readWindowsExecutable(job.parent.image, plan.platform.arch)
              } catch (missing) {
                if (!(missing instanceof Error) || !('win32' in missing) || missing.win32 !== 2) {
                  throw missing
                }
              }
              if (current) {
                if (!candidate || !same(current, candidate)) {
                  throw new UpdateError('target_changed')
                }
                journal('rejecting')
                moveWindowsExecutable(held, job.transactionId, 'reject')
              }
              journal('restoring_original')
              moveWindowsExecutable(held, job.transactionId, 'restore')
            } else if (!same(readWindowsExecutable(job.parent.image, plan.platform.arch), job.original)) {
              throw new UpdateError('target_changed')
            }
            if (!same(readWindowsExecutable(job.parent.image, plan.platform.arch), job.original)) {
              throw new UpdateError('target_changed')
            }
            await version(job.parent.image, plan.currentVersion)
            await restore(plan.currentVersion, new AbortController().signal)
            journal('rolled_back')
            receipt!('rolled_back', 'verification_failed')
            return 6
          } catch {
            retainLock = true
            try {
              journal('recovery_required')
              receipt!('recovery_required', 'rollback_failed')
            } catch {
              /* 持久锁仍阻止误启动；写失败不能清除恢复保护。 */
            }
            throw new ServiceError('service_recovery_required')
          }
        }
      }
    )
    exitCode = completed
    versions = { current: plan.currentVersion, target: plan.targetVersion }
  } catch (error) {
    const normalized = failure(error)
    if (normalized.code === 'update_recovery_required') {
      retainLock = true
    }
    if (receipt && !retainLock) {
      try {
        receipt(
          'aborted',
          normalized.code === 'update_io_pending' ? 'parent_timeout' : 'verification_failed',
          updateExitCode(normalized)
        )
      } catch {
        /* 回执写失败仍非零，不覆盖恢复保护。 */
      }
    }
    if (ticket && digest && !ready) {
      try {
        await send(frame(ticket, digest, 'failed', normalized.code))
      } catch {
        /* 无法通知父端仍非零，不能编造成功握手。 */
      }
    }
    host.write(`update: ${normalized.code}\n`)
    exitCode = updateExitCode(normalized)
  } finally {
    clearTimeout(timer)
    let cleanupFailed = false
    try {
      input.close()
    } catch {
      cleanupFailed = true
    }
    try {
      parent?.close()
    } catch {
      cleanupFailed = true
    }
    if (!retainLock) {
      try {
        if (locked) {
          lease?.releaseInstallationLock()
        }
      } catch {
        cleanupFailed = true
      }
    }
    if ((cleanupFailed || (exitCode === 0 && performance.now() >= deadline)) && !retainLock) {
      exitCode = 4
      try {
        receipt?.('cleanup_required', 'receipt_failed')
      } catch {
        /* 写失败仍保留非零，不覆盖已有文件或配置。 */
      }
    }
    try {
      lease?.close()
    } catch {
      if (!retainLock) {
        exitCode = 4
      }
      host.write('update: cleanup_failed exit=4\n')
    }
    clearInterval(ownership)
  }
  if (versions) {
    host.write(
      `update: status=${exitCode === 0 ? 'updated' : exitCode === 6 ? 'rolled_back' : 'cleanup_required'} current=${versions.current} target=${versions.target} exit=${exitCode}\n`
    )
  }
  return exitCode
}

// 可信运行时绑定安装；真实执行仍由 WindowsUpdater 的本机身份与 helper 协议校验控制。
export function createWindowsUpdater(options: Readonly<{ executable: string }>): WindowsUpdater {
  return WindowsUpdater.create(options)
}
