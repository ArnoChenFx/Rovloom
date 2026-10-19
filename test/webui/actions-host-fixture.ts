/** 仅显式本地页面验收使用：真实临时 Store/写服务/会话 handler，读观测标为合成且不连用户设备。 */
import { createHash, randomUUID } from 'node:crypto'
import { setup } from '../admin/write-helpers.js'
import { StoreManagementWriteService } from '../../src/admin/write-service.js'
import { createManagementHandler } from '../../src/admin/write-http.js'
import { createManagementSessionAdapter } from '../../src/admin/session-adapter.js'
import { fixtureReply, fixtureDevice } from './fixtures.js'
import type { GatewayManagementService, DeviceSnapshot } from '../../src/mcp/management.js'

const actionFixtureCsrf = 'd'.repeat(43)
const cookie = 'SYNTHETIC_PAGE_COOKIE_' + 'c'.repeat(40)

/** 构造一次测试拥有的真实后端；不会从磁盘或生产身份读取任何材料。 */
export function createActionsHostFixture(origin: string) {
  const f = setup(undefined, {
    management: /** 仅允许自建临时设备的受保护测试签发。 */ () => ({
      actor: 'fixture_admin',
      confirmation_id: randomUUID()
    })
  })
  const devices = [f.store.register('owned_page_a'), f.store.register('owned_page_b')]
  for (const device of devices) {
    const enrollment = f.store.issueEnrollment(device.machine_id)
    const paired = f.store.redeem(enrollment)
    f.store.connect(device.machine_id, paired.credential)
    f.store.defineProvider({
      machine_id: device.machine_id,
      provider_id: 'fixture-provider',
      kind: 'luvus',
      config_ref: 'synthetic',
      binding_revision: 1,
      enabled: true
    })
    f.grant(
      { action: 'devices_read', machine_id: device.machine_id },
      { action: 'permissions_read', machine_id: device.machine_id },
      { action: 'providers_read', machine_id: device.machine_id, provider_id: 'fixture-provider' },
      ...(['devices_rename', 'devices_disconnect', 'devices_revoke'] as const).map(
        /** 精确授予本次临时设备操作。 */ (action) => ({ action, machine_id: device.machine_id })
      )
    )
  }
  f.grant({ action: 'gateway_read' })
  let time = 1000
  let offset = 0
  let mode = 'normal'
  const calls: string[] = []
  let release: (() => void) | undefined
  /** 合成后端使用同一单调推进的时钟，过期只由明确测试命令提前推进。 */
  function sync(): void {
    const next = Date.now() + offset
    f.advance(next - time)
    time = next
  }
  sync()
  const expiry = time + 300_000
  const adapter = createManagementSessionAdapter({
    identities: f.identities,
    origin,
    cookie_name: 'fixture_admin',
    now: /** 同一临时后端时间。 */ () => f.store.clock(),
    sessions: {
      identities: f.identities,
      /** 只识别当前fixture cookie，不从浏览器身份字段制造管理员。 */
      async resolveCookie(value) {
        return value === cookie && mode !== '401'
          ? {
              caller: { principal_id: 'fixture_admin' },
              session_ref: 'fixture_session',
              expires_at: expiry,
              csrf_sha256: createHash('sha256').update(actionFixtureCsrf).digest('hex')
            }
          : null
      }
    }
  })
  const reads: GatewayManagementService = {
    /** 读投影明确为测试数据；写入结果和 revision/epoch 来自同一真实 Store。 */
    async execute(operation, args, context) {
      sync()
      const result: any = fixtureReply(operation as never, args as never)
      const generation = f.store.health().generation
      if (operation === 'status') {
        return { ...result, server_time: time, observed_at: time, recovery_generation: generation } as never
      }
      /** 只投影持久事实，未接真实transport/native的字段保持未知。 */
      async function device(id: string): Promise<DeviceSnapshot> {
        const row = f.store.machine(id)
        const fence = await service.execute('write_state_get', { machine_id: id }, context)
        return {
          ...fixtureDevice(id),
          name: row.name,
          persisted_state: row.status as DeviceSnapshot['persisted_state'],
          resource_revision: fence.resource_revision,
          observed_at: mode === 'stale_device' ? time - 60_000 : time,
          connection: { verification: 'unverified', reason_code: 'backend_unavailable' },
          authentication: { verification: 'unverified', reason_code: 'backend_unavailable' }
        }
      }
      if (operation === 'devices_list') {
        return { items: await Promise.all(devices.map(/** 当前临时设备列表。 */ (d) => device(d.machine_id))) } as never
      }
      if (operation === 'devices_get') {
        return (await device((args as { machine_id: string }).machine_id)) as never
      }
      if (operation === 'providers_list') {
        return { items: [] } as never
      }
      if (operation === 'permissions_get') {
        return {
          ...result,
          recovery_generation: generation,
          observed_at: time,
          expires_at: time + 30_000,
          decisions: ['devices_read', 'devices_rename', 'devices_disconnect', 'devices_revoke'].map(
            /** 只提示fixture已经授予的范围。 */ (action) => ({ action, allowed: true, reason_code: 'allowed' })
          )
        } as never
      }
      return result
    }
  }
  const service = new StoreManagementWriteService({
    store: f.store,
    identities: adapter.identities,
    reads,
    transport: { /** 没有真实socket，回执必须保守保留物理效果未确认。 */ refresh() {} }
  })
  const handler = createManagementHandler({
    origin,
    service,
    authenticate: adapter.authenticate,
    verifyCsrf: adapter.verifyCsrf
  })
  return {
    cookie: 'fixture_admin=' + cookie + '; HttpOnly; SameSite=Strict; Path=/',
    bootstrap: { csrf: actionFixtureCsrf, expires_at: expiry },
    /** 实际请求走同一现有会话/CSRF handler；网络故障只注入在受控边界。 */
    async fetch(request: Request) {
      sync()
      const operation = new URL(request.url).pathname.split('/').at(-1)!
      calls.push(operation)
      if (mode === 'prepare_error' && operation === 'confirmations_create') {
        return new Response('{"error":"backend_unavailable"}', {
          status: 503,
          headers: { 'content-type': 'application/json' }
        })
      }
      if (
        (mode === 'hold_confirm' && operation === 'confirmations_confirm') ||
        (mode === 'hold_write' && operation.startsWith('devices_'))
      ) {
        await new Promise<void>(
          /** 迟到交付由测试明确释放。 */ (resolve) => {
            release = resolve
          }
        )
      }
      const response = await handler.fetch(request)
      if (mode === 'hold_read' && request.method === 'GET' && /\/devices\/[^/]+$/.test(new URL(request.url).pathname)) {
        mode = 'normal'
        await new Promise<void>(
          /** 暂缓一次旧设备快照，后续新读不受阻。 */ (resolve) => {
            release = resolve
          }
        )
      }
      if (mode === 'hold_reply' && operation.startsWith('devices_')) {
        await new Promise<void>(
          /** 提交后暂缓回执，用于取消/导航后的原回执核对。 */ (resolve) => {
            release = resolve
          }
        )
      }
      if (mode === 'lost_reply' && operation.startsWith('devices_')) {
        return new Response('lost', { status: 503 })
      }
      return response
    },
    /** 测试控制仅在显式fixture服务可达；不提供任何生产管理端点。 */
    async control(request: Request) {
      if (request.method === 'POST') {
        if (request.headers.get('origin') !== origin) {
          return new Response('forbidden', { status: 403 })
        }
        const value = (await request.json()) as { mode?: string; advance?: number }
        if (value.mode) {
          mode = value.mode
        }
        if (value.advance) {
          offset += value.advance
          sync()
        }
        if (mode === 'release') {
          mode = 'normal'
          release?.()
          release = undefined
        }
      }
      return Response.json({
        devices: devices.map(
          /** 只输出公开字段，凭据及其摘要也不进入测试页面。 */ (d) => {
            const row = f.store.machine(d.machine_id)
            return { machine_id: row.machine_id, name: row.name, status: row.status }
          }
        ),
        calls,
        held: !!release,
        mode
      })
    },
    /** 只销毁本进程的临时Store/等待，不影响用户Gateway或设备。 */
    close() {
      release?.()
      handler.stop()
      f.close()
    }
  }
}
