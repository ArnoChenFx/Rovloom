/** 真实浏览器交互的隔离测试入口，仅注入展示投影，不模拟后端授权成功。 */
import { mountWebUi, ReadError, type PageRead, type TimedSnapshot, type PageView } from '../../src/webui/index.js'
import { fixtureReply } from './fixtures.js'
import { createManagementPageRead } from '../../src/webui/read.js'

type FixtureMode =
  | 'normal'
  | 'hold'
  | '401'
  | '403'
  | '503'
  | 'quarantine'
  | 'degraded'
  | 'partial'
  | 'empty'
  | 'stale'
  | 'expired'
  | 'wrong_machine'
  | 'unverified'
  | 'heartbeat'
  | 'reconnecting'

declare global {
  interface Window {
    webUiFixture: {
      mode: FixtureMode
      reads: number
      aborted: number
      pending: { resolve: (value: TimedSnapshot<PageView>) => void; snapshot: TimedSnapshot<PageView> }[]
      dispose: () => void
      release: () => void
    }
  }
}

const fixture = {
  mode: 'normal' as FixtureMode,
  reads: 0,
  aborted: 0,
  pending: [] as { resolve: (value: TimedSnapshot<PageView>) => void; snapshot: TimedSnapshot<PageView> }[],
  /** 初始占位，挂载后替换为真实资源清理函数。 */
  dispose: () => {},
  /** 允许测试在导航或取消后交付旧投影。 */
  release: () => {
    for (const entry of fixture.pending.splice(0)) {
      entry.resolve(entry.snapshot)
    }
  }
}
window.webUiFixture = fixture

/** 根据显式测试模式读取 fixture；所有异常均为合成状态。 */
/** 复用与生产宿主相同的只读组合逻辑，替换的仅为共享 DTO 数据来源。 */
const baseRead = createManagementPageRead(async (name, args) => fixtureReply(name, args))

/** 调整隔离测试情景，不实现或绕过后台管理员授权。 */
const read: PageRead = async (route, signal) => {
  fixture.reads++
  signal.addEventListener(
    'abort',
    /** 统计页面是否清理读取资源。 */
    () => {
      fixture.aborted++
    },
    { once: true }
  )
  if (fixture.mode === '401') {
    throw new ReadError('unauthenticated')
  }
  if (fixture.mode === '403') {
    throw new ReadError('forbidden')
  }
  if (fixture.mode === '503') {
    throw new Error('fixture-secret-never-render-this')
  }
  const result = await baseRead(route, signal)
  if (fixture.mode === 'hold') {
    return new Promise(
      /** 故意不响应取消，检验迟到保护。 */
      (resolve) => {
        fixture.pending.push({ resolve, snapshot: result })
      }
    )
  }
  if (fixture.mode === 'quarantine') {
    result.value.status.mode = 'recovery_quarantined'
  }
  if (fixture.mode === 'degraded') {
    result.value.status.mode = 'storage_degraded'
  }
  if (fixture.mode === 'partial') {
    result.value.providersProblem = 'unavailable'
    result.value.providers = { items: [] }
  }
  if (fixture.mode === 'empty') {
    result.value.devices = { items: [] }
  }
  if (fixture.mode === 'stale') {
    result.observedAt -= 20_000
  }
  if (fixture.mode === 'expired') {
    result.sessionExpiresAt = result.serverTime
  }
  if (fixture.mode === 'wrong_machine' && result.value.device) {
    result.value.device.machine_id = 'fixture-wrong-machine'
  }
  if (fixture.mode === 'quarantine') {
    result.value.devices = { items: [] }
    result.value.device = null
    result.value.providers = { items: [] }
    result.value.permissions = null
  }
  if (fixture.mode === 'unverified') {
    for (const device of [...result.value.devices.items, ...(result.value.device ? [result.value.device] : [])]) {
      device.connection = { verification: 'unverified', reason_code: 'backend_unavailable' }
      device.authentication = { verification: 'unverified', reason_code: 'not_recorded' }
    }
  }
  if (fixture.mode === 'heartbeat' && result.value.device) {
    result.value.device.connection = {
      verification: 'verified',
      source: 'gateway_transport',
      observed_at: result.serverTime,
      value: { state: 'offline', connection_epoch_ref: null, last_heartbeat_at: result.serverTime - 60_000 }
    }
    result.value.device.authentication = {
      verification: 'verified',
      source: 'gateway_transport',
      observed_at: result.serverTime,
      value: {
        state: 'expired',
        last_failure: { reason_code: 'heartbeat_timeout', occurred_at: result.serverTime - 1000 }
      }
    }
  }
  if (fixture.mode === 'reconnecting' && result.value.device?.connection.verification === 'verified') {
    result.value.device.connection.value.state = 'reconnecting'
    result.value.device.authentication = { verification: 'unverified', reason_code: 'not_recorded' }
  }
  return result
}

const root = document.getElementById('rovloom-management')
if (root) {
  fixture.dispose = mountWebUi(root, read)
  const notice = document.createElement('p')
  notice.textContent = '隔离测试 fixture：以下展示不代表真实管理后端、管理员授权或设备链路完成。'
  notice.setAttribute('role', 'note')
  document.body.prepend(notice)
}
