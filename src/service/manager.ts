// 对三平台实施统一的有界幂等生命周期；所有变更仅作用于项目角色注册。
import { isRole, manifest, validateSpec } from './spec.js'
import {
  ServiceError,
  type ServiceBackend,
  type ServiceRequest,
  type ServiceResult,
  type ServiceSnapshot,
  type ServiceSpec
} from './types.js'

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

  // 安装和卸载只控制未来开机启动；运行中撤销自启保留控制记录，只有显式 stop/restart 能停止实例。
  async execute(request: ServiceRequest): Promise<ServiceResult> {
    if (!isRole(request.role) || !['install', 'uninstall', 'start', 'restart', 'stop'].includes(request.action)) {
      throw new ServiceError('invalid_arguments')
    }
    await this.backend.authorize()
    return this.backend.lock(
      request.role,
      /* 在角色锁内完成整个状态转换。 */ async () => {
        let current = await this.backend.inspect(request.role)
        let changed = false
        let stopRequested = false
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
              await this.backend.stop(spec)
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
            ? this.backend.platform === 'win32'
              ? 'task_termination'
              : 'signal_then_kill'
            : 'not_requested'
        }
      }
    )
  }
}
