// 提供无系统副作用的服务模型及单调虚拟时钟，只用于测试状态转换。
import {
  ServiceError,
  type ServiceBackend,
  type ServicePlatform,
  type ServiceSnapshot,
  type ServiceSpec
} from '../../src/service/types.js'
import type { ServiceClock } from '../../src/service/manager.js'

// 为每个平台生成含空格和 Unicode 的独立非秘密配置引用。
export function sampleSpec(platform: ServicePlatform = 'linux'): ServiceSpec {
  return {
    version: 1,
    platform,
    role: 'connector',
    executable: platform === 'win32' ? 'C:\\Program Files\\Rovloom\\汉字.exe' : '/opt/Rovloom 汉字/rovloom',
    config: platform === 'win32' ? 'C:\\Rovloom 数据\\config.json' : '/var/lib/rovloom 汉字/config.json',
    directory: platform === 'win32' ? 'C:\\Rovloom 数据' : '/var/lib/rovloom 汉字',
    account: platform === 'win32' ? 'S-1-5-19' : 'rovloom'
  }
}

// 模拟后端只记录固定注册，不启动原生工具；可控制失败、竞态与延迟状态。
export function model(platform: ServicePlatform = 'linux') {
  let current: ServiceSnapshot | undefined
  let busy = false
  let now = 0
  const calls: string[] = []
  const failures = new Set<string>()
  const stuck = new Set<string>()
  // 为指定阶段注入稳定故障，保证断言能检查失败后的持久状态。
  function call(action: string) {
    calls.push(action)
    if (failures.has(action)) {
      throw new ServiceError('system_command_failed', 73)
    }
  }
  const backend: ServiceBackend = {
    platform,
    // 模拟角色锁，包含异步等待期间的并发拒绝。
    async lock(_role, operation) {
      if (busy) {
        throw new ServiceError('service_busy')
      }
      busy = true
      try {
        return await operation()
      } finally {
        busy = false
      }
    },
    authorize: /* 模拟权限检查，不触发真实提权。 */ async () => call('authorize'),
    preflight: /* 模拟受信宿主预检。 */ async () => call('preflight'),
    inspect: /* 返回当前模拟监管状态。 */ async () => {
      call('inspect')
      return current
    },
    create: /* 模拟只注册而不启动。 */ async (spec) => {
      call('create')
      current = { spec, state: 'stopped', enabled: false }
    },
    enable: /* 只改变模拟开机注册。 */ async (_spec, enabled) => {
      call(enabled ? 'enable' : 'disable')
      current!.enabled = enabled
    },
    start: /* 模拟正常启动或永远无法启动的监管器。 */ async () => {
      call('start')
      current!.state = stuck.has('start') ? 'stopped' : 'running'
    },
    stop: /* 模拟正常退出或停止超时。 */ async () => {
      call('stop')
      if (!stuck.has('stop')) {
        current!.state = 'stopped'
      }
    },
    remove: /* 仅删除模拟注册，不存在业务文件删除端口。 */ async () => {
      call('remove')
      current = undefined
      return true
    }
  }
  const clock: ServiceClock = {
    now: /* 读取确定性单调虚拟时钟。 */ () => now,
    wait: /* 推进虚拟时钟，不真实 sleep。 */ async (ms) => {
      now += ms
    }
  }
  return {
    backend,
    clock,
    calls,
    failures,
    stuck,
    get: /* 读取测试模型持久状态。 */ () => current,
    set: /* 注入预先存在的独立注册。 */ (value: ServiceSnapshot | undefined) => {
      current = value
    }
  }
}
