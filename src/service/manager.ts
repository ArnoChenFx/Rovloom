// 对三平台实施统一的有界幂等生命周期；所有变更仅作用于项目角色注册。
import { isRole, manifest, validateSpec } from './spec.js'
import {
  ServiceError,
  type ServiceBackend,
  type ServiceRequest,
  type ServiceResult,
  type ServiceSnapshot,
  type ServiceSpec,
  type ServiceRole
} from './types.js'

export type ServiceUpdateSession = {
  readonly snapshots: readonly Readonly<ServiceSnapshot>[]
  // 保留注册、自启和配置，仅停止本次安装的受控角色并核实静止。
  quiesce(): Promise<void>
  // 替换前后逐次检查原身份、自启和静止证明。
  assertQuiescent(): Promise<void>
  // 只恢复原本运行的角色，独立验证监管稳定及业务就绪；尝试恢复全部角色后才报告失败。
  restore(
    version: string,
    ready: (spec: ServiceSpec, version: string) => Promise<void>,
    signal?: AbortSignal
  ): Promise<void>
}

export type ServiceClock = {
  // 使用单调时钟计算总超时，避免墙钟校正延长操作。
  now(): number
  // 按有界间隔等待下一次系统状态观测。
  wait(milliseconds: number): Promise<void>
}
const clock: ServiceClock = {
  now: /* 读取单调时间。 */ () => performance.now(),
  wait: /* 用短计时器交还事件循环。 */ (ms) =>
    new Promise(/* 结束一次轮询间隔。 */ (resolve) => setTimeout(resolve, ms))
}

export class ServiceManager {
  // 绑定显式后端与时钟；导入或构造本身不操作操作系统。
  constructor(
    private readonly backend: ServiceBackend,
    private readonly time: ServiceClock = clock
  ) {}

  // 每次观测重新核对注册身份，避免等待期间覆盖或删除其它注册。
  private async observe(spec: ServiceSpec): Promise<ServiceSnapshot> {
    const state = await this.backend.inspect(spec.role)
    if (!state || manifest(state.spec) !== manifest(spec)) {
      throw new ServiceError('service_conflict')
    }
    return state
  }

  // 等待进程监管状态连续稳定至少一秒；这不冒充应用健康或就绪探针。
  private async settle(spec: ServiceSpec, running: boolean): Promise<ServiceSnapshot> {
    const deadline = this.time.now() + 30000
    let stableSince: number | undefined
    while (this.time.now() < deadline) {
      const snapshot = await this.observe(spec)
      const reached = running
        ? snapshot.state === 'running'
        : snapshot.state === 'stopped' || snapshot.state === 'failed'
      if (running && snapshot.state === 'failed') {
        throw new ServiceError('service_start_failed', snapshot.exitCode)
      }
      if (reached) {
        stableSince ??= this.time.now()
        if (!running || this.time.now() - stableSince >= 1000) {
          return snapshot
        }
      } else {
        stableSince = undefined
      }
      await this.time.wait(250)
    }
    throw new ServiceError(running ? 'service_start_failed' : 'service_timeout')
  }

  // 同时持有两个既有角色锁；Windows helper 自己取得并持有到父退出后的替换/恢复结束，不转交锁。
  async withBinaryUpdate<T>(executable: string, operation: (session: ServiceUpdateSession) => Promise<T>): Promise<T> {
    await this.backend.authorize()
    return this.backend.lock(
      'gateway',
      /* 所有更新都按固定角色顺序取锁，避免死锁。 */ async () =>
        this.backend.lock(
          'connector',
          /* 两个锁完整包围快照、静止、替换与恢复。 */ async () => {
            let active = true
            const snapshots: Readonly<ServiceSnapshot>[] = []
            for (const role of ['gateway', 'connector'] as const satisfies readonly ServiceRole[]) {
              const current = await this.backend.inspect(role)
              if (!current || current.spec.executable !== executable) {
                continue
              }
              if (
                !['running', 'stopped'].includes(current.state) ||
                (this.backend.platform === 'darwin' &&
                  ((current.state === 'stopped' && current.loaded) ||
                    (current.state === 'running' && !current.enabled)))
              ) {
                // macOS 已撤自启的活 job 不能在 bootout 后等价 bootstrap；拒绝先停后无法恢复。
                throw new ServiceError('service_busy')
              }
              const spec = Object.freeze(validateSpec(current.spec))
              await this.backend.preflight(spec)
              snapshots.push(Object.freeze({ ...current, spec }))
            }
            // 会话能力只在持锁作用域有效，不能在 finally 解锁后继续操作服务。
            const assertActive = () => {
              if (!active) {
                throw new ServiceError('service_conflict')
              }
            }
            // 原声明、自启与控制记录不能在更新中被重写或清空。
            const observe = async (snapshot: Readonly<ServiceSnapshot>) => {
              assertActive()
              const current = await this.observe(snapshot.spec)
              if (current.enabled !== snapshot.enabled) {
                throw new ServiceError('service_conflict')
              }
              return current
            }
            const session: ServiceUpdateSession = {
              snapshots: Object.freeze(snapshots),
              // 即使原本停止，也取消潜在待启动 Job；不调用 enable/remove 或注销注册。
              quiesce: async () => {
                assertActive()
                let failure: unknown
                for (const snapshot of snapshots) {
                  try {
                    await observe(snapshot)
                    await this.backend.stop(snapshot.spec)
                    await this.settle(snapshot.spec, false)
                  } catch (error) {
                    failure ??= error
                  }
                }
                try {
                  await session.assertQuiescent()
                } catch (error) {
                  failure ??= error
                }
                if (failure) {
                  throw failure
                }
              },
              // 原生 inspect 对 stopped/failed 的 PID、Job 和来源证明保持有效。
              assertQuiescent: async () => {
                for (const snapshot of snapshots) {
                  const current = await observe(snapshot)
                  if (!['stopped', 'failed'].includes(current.state)) {
                    throw new ServiceError('service_conflict')
                  }
                }
                assertActive()
              },
              // 对每个角色尽力恢复；应用探针与监管稳定分别验证，不用 running 冒充业务就绪。
              restore: async (version, ready, signal) => {
                assertActive()
                let failure: unknown
                for (const snapshot of snapshots) {
                  try {
                    signal?.throwIfAborted()
                    const current = await observe(snapshot)
                    if (!['running', 'stopped', 'failed'].includes(current.state)) {
                      throw new ServiceError('service_conflict')
                    }
                    if (snapshot.state === 'running') {
                      if (current.state !== 'running') {
                        await this.backend.preflight(snapshot.spec)
                        signal?.throwIfAborted()
                        await this.backend.start(snapshot.spec)
                      }
                      await this.settle(snapshot.spec, true)
                      signal?.throwIfAborted()
                      await ready(snapshot.spec, version)
                    } else {
                      if (!['stopped', 'failed'].includes(current.state)) {
                        await this.backend.stop(snapshot.spec)
                        await this.settle(snapshot.spec, false)
                      }
                      if ((await observe(snapshot)).state !== 'stopped') {
                        throw new ServiceError('service_conflict')
                      }
                    }
                  } catch (error) {
                    failure ??= error
                  }
                }
                // 全部业务探针结束后重新检查每个原角色，不能忽略探针后退出或后续角色恢复期间的状态变化。
                for (const snapshot of snapshots) {
                  try {
                    if ((await observe(snapshot)).state !== snapshot.state) {
                      throw new ServiceError(snapshot.state === 'running' ? 'service_start_failed' : 'service_conflict')
                    }
                  } catch (error) {
                    failure ??= error
                  }
                }
                if (failure) {
                  throw failure
                }
              }
            }
            try {
              return await operation(session)
            } finally {
              active = false
            }
          }
        )
    )
  }

  // 安装和卸载只控制未来开机启动；运行中撤销自启保留控制记录，只有显式 stop/restart 能停止实例。
  async execute(request: ServiceRequest): Promise<ServiceResult> {
    if (!isRole(request.role) || !['install', 'uninstall', 'start', 'restart', 'stop'].includes(request.action)) {
      throw new ServiceError('invalid_arguments')
    }
    await this.backend.authorize(request.role)
    return this.backend.lock(
      request.role,
      /* 在角色锁内完成整个状态转换。 */ async () => {
        let current = await this.backend.inspect(request.role)
        let changed = false
        let stopRequested = false
        let gracefulStop = false
        if (request.action === 'install') {
          if (!request.spec) {
            throw new ServiceError('invalid_arguments')
          }
          const spec = validateSpec(request.spec)
          if (spec.role !== request.role || spec.platform !== this.backend.platform) {
            throw new ServiceError('invalid_arguments')
          }
          await this.backend.preflight(spec)
          if (current && manifest(current.spec) !== manifest(spec)) {
            throw new ServiceError('service_conflict')
          }
          if (!current) {
            await this.backend.create(spec)
            changed = true
          }
          if (!current?.enabled) {
            await this.backend.enable(spec, true)
            changed = true
          }
          current = await this.observe(spec)
          if (!current.enabled) {
            throw new ServiceError('system_command_failed')
          }
        } else if (!current) {
          if (request.action === 'start' || request.action === 'restart') {
            throw new ServiceError('service_not_installed')
          }
        } else {
          const spec = current.spec
          if (request.action === 'uninstall') {
            if (current.enabled) {
              await this.backend.enable(spec, false)
              changed = true
            }
            current = await this.observe(spec)
            if (current.enabled) {
              throw new ServiceError('system_command_failed')
            }
            // Linux 卸载始终保留声明，避免等待依赖的 boot Job 在观察与删除之间启动并失去控制记录。
            if (this.backend.platform !== 'linux' && ['stopped', 'failed'].includes(current.state)) {
              if (await this.backend.remove(spec)) {
                current = undefined
                changed = true
              } else {
                current = await this.observe(spec)
              }
            }
          } else {
            if (
              request.action !== 'start' &&
              (!['stopped', 'failed'].includes(current.state) ||
                (request.action === 'stop' && !current.enabled && ['darwin', 'linux'].includes(this.backend.platform)))
            ) {
              // 撤销自启后，Linux 显式 stop 仍须取消待启动 Job；macOS 则释放 loaded job。卸载分支不走这里。
              stopRequested = true
              gracefulStop = (await this.backend.stop(spec, request.action === 'restart')) === 'graceful_request'
              current = await this.settle(spec, false)
              changed = true
            }
            if (request.action === 'start' || request.action === 'restart') {
              if (current.state !== 'running') {
                await this.backend.preflight(spec)
                await this.backend.start(spec)
                changed = true
              }
              current = await this.settle(spec, true)
            } else if (!current.enabled) {
              // 用户已明确停止且自启已撤销时，才尝试回收不再承载实例的控制记录。
              if (await this.backend.remove(spec)) {
                current = undefined
                changed = true
              } else {
                current = await this.observe(spec)
              }
            }
          }
        }
        return {
          action: request.action,
          role: request.role,
          changed,
          state: current?.state ?? 'absent',
          bootEnabled: current?.enabled ?? false,
          controlRetained: current !== undefined,
          readiness: 'not_checked',
          stopMode: stopRequested
            ? gracefulStop
              ? 'graceful_request'
              : this.backend.platform === 'win32'
                ? 'task_termination'
                : 'signal_then_kill'
            : 'not_requested'
        }
      }
    )
  }
}
