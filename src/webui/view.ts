/** 管理页直接渲染共享管理 DTO；不补造未核实状态，也不建立另一套管理协议。 */
import type { DeviceSnapshot, ManagementStatus, Page, PermissionSnapshot, ProviderSnapshot } from '../mcp/management.js'
import type { ReaderState } from './reader.js'

/** 仅组合一次页面读取，所有业务对象仍是共享 DTO。 */
export interface PageView {
  status: ManagementStatus
  devices: Page<DeviceSnapshot>
  device: DeviceSnapshot | null
  providers: Page<ProviderSnapshot>
  permissions: PermissionSnapshot | null
  providersProblem: 'forbidden' | 'unavailable' | null
}
export type PageRoute = { machineId: string | null; cursor: string | null; providerCursor: string | null }

const connectionNames = {
  connecting: '连接中',
  reconnecting: '重新握手中',
  online: '在线',
  degraded: '连接降级',
  offline: '离线'
}
const authenticationNames = {
  pending: '等待认证',
  authenticated: '已认证',
  failed: '认证失败',
  expired: '认证过期',
  revoked: '身份已撤销'
}
const runtimeNames = {
  ready: '运行观测就绪',
  unreachable: '不可达',
  binding_mismatch: '配置不一致',
  migration_unresolved: '来源待核实'
}
const problemNames: Record<NonNullable<ReaderState<PageView>['problem']>, string> = {
  unauthenticated: '管理会话未登录或已过期。请通过受保护的管理员入口重新登录。',
  forbidden: '当前管理员没有此范围的查看权限。',
  conflict: '观测范围或版本已变化，请刷新。',
  unavailable: '管理读取尚不可用，请检查 Gateway 的受保护管理接线。',
  invalid_response: '管理响应未通过展示边界校验。',
  timeout: '读取超过 5 秒。当前显示不是实时状态。',
  cancelled: '已取消本次读取。'
}

/** 创建节点，所有后端文本通过 textContent 转义。 */
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag)
  result.textContent = text
  result.className = className
  return result
}

/** 显示共享 DTO 的可信服务时间，缺失不使用客户端时间填充。 */
function timestamp(value: number | null): string {
  return value === null ? '尚无可信观测' : new Date(value).toISOString().replace('T', ' ').replace('.000Z', ' UTC')
}

/** 年龄仅由服务时间与读取后的单调经过时间计算。 */
function age(value: number | null, serverNow: number): string {
  return value === null ? '尚无可信心跳' : `${Math.max(0, Math.floor((serverNow - value) / 1_000))} 秒前`
}

/** 渲染只含文本的键值信息。 */
function facts(rows: [string, string][]): HTMLElement {
  const result = node('dl', '', 'facts')
  for (const [label, value] of rows) {
    result.append(node('dt', label), node('dd', value))
  }
  return result
}

/** 创建文字与颜色并用的状态标签。 */
function badge(text: string, tone = 'neutral'): HTMLElement {
  return node('span', text, `badge ${tone}`)
}

/** 编码明确 machine_id 和不透明分页游标，不携带身份或秘密。 */
export function routeHref(route: PageRoute): string {
  const parameters = new URLSearchParams()
  if (route.machineId !== null) {
    parameters.set('machine', route.machineId)
  }
  if (route.cursor !== null) {
    parameters.set('cursor', route.cursor)
  }
  if (route.providerCursor !== null) {
    parameters.set('providers', route.providerCursor)
  }
  return `#${parameters.toString()}`
}

/** 拒绝重复/超限导航字段，不保留隐式当前机器。 */
export function parseRoute(hash: string): PageRoute {
  const empty: PageRoute = { machineId: null, cursor: null, providerCursor: null }
  // 两个 1024 字符字段经 UTF-8 百分号编码最多约 18 KiB；编码前后预算保持一致。
  if (hash.length > 20_000) {
    return empty
  }
  const parameters = new URLSearchParams(hash.replace(/^#/, ''))
  for (const key of ['machine', 'cursor', 'providers']) {
    if (parameters.getAll(key).length > 1 || (parameters.get(key)?.length ?? 0) > 1_024) {
      return empty
    }
  }
  const machineId = parameters.get('machine') || null
  return {
    machineId,
    cursor: machineId ? null : parameters.get('cursor') || null,
    providerCursor: machineId ? parameters.get('providers') || null : null
  }
}

/** 分开显示持久状态、可信连接和认证；持久撤销不能被旧认证覆盖。 */
function deviceBadges(device: DeviceSnapshot): HTMLElement {
  const result = node('div', '', 'badges')
  if (device.persisted_state === 'revoked') {
    result.append(badge('身份已撤销', 'danger'), badge('旧连接与认证记录不能恢复授权'))
    return result
  }
  if (device.persisted_state === 'pending') {
    result.append(badge('待配对'))
  }
  result.append(
    device.connection.verification === 'verified'
      ? badge(
          connectionNames[device.connection.value.state],
          device.connection.value.state === 'online' ? 'good' : 'neutral'
        )
      : badge(`连接未核实 · ${device.connection.reason_code}`, 'warning')
  )
  result.append(
    device.authentication.verification === 'verified'
      ? badge(
          authenticationNames[device.authentication.value.state],
          ['failed', 'expired', 'revoked'].includes(device.authentication.value.state) ? 'danger' : 'neutral'
        )
      : badge(`认证未核实 · ${device.authentication.reason_code}`, 'warning')
  )
  result.append(badge('设备 ready 尚无独立观测'))
  return result
}

/** 只展示未接后端操作的含义，不提交确认或变更。 */
function unavailableActions(kind: 'device' | 'provider' | 'list'): HTMLElement {
  const section = node('section', '', 'actions')
  const noteId = `unavailable-${kind}`
  const note = node('p', '受保护的管理确认与后端变更尚未接入，以下操作不可用。', 'muted')
  note.id = noteId
  section.append(note)
  const labels =
    kind === 'list'
      ? ['新建设备 / 配对申请']
      : kind === 'provider'
        ? ['禁用 / 重新启用 provider']
        : ['改名 / 标签', '配对 / 重新配对', '断开当前连接', '撤销设备身份']
  for (const label of labels) {
    const button = node('button', label)
    button.type = 'button'
    button.disabled = true
    button.setAttribute('aria-describedby', noteId)
    section.append(button)
  }
  if (kind === 'device') {
    section.append(
      node(
        'p',
        '断开仅关闭指定连接，保留设备授权，Connector 可以主动重连。撤销将持久拒绝旧身份，并影响全部 providers。在途工作可能仍执行，结果保持未确认。',
        'muted'
      )
    )
  }
  return section
}

/** 列表只展示后端返回的授权页，不将页长宣称为设备总数。 */
function deviceList(page: PageView, state: ReaderState<PageView>, serverNow: number): HTMLElement {
  const section = node('section')
  section.append(
    node('h1', '设备'),
    node('p', '设备身份、连接与 runtime providers 分开观测。', 'muted'),
    unavailableActions('list')
  )
  if (page.devices.items.length === 0) {
    section.append(node('div', '此范围尚无设备。由受保护的本机管理渠道建立配对申请后再刷新。', 'empty'))
  }
  const list = node('ul', '', 'device-list')
  for (const device of page.devices.items) {
    const row = node('li', '', 'device-card')
    const link = node('a', device.name, 'device-name')
    link.href = routeHref({ machineId: device.machine_id, cursor: null, providerCursor: null })
    row.append(link, node('code', device.machine_id), deviceBadges(device))
    row.append(
      node(
        'p',
        device.labels === null ? '标签未记录' : device.labels.length ? device.labels.join(' · ') : '无标签',
        'muted'
      )
    )
    const heartbeat = device.connection.verification === 'verified' ? device.connection.value.last_heartbeat_at : null
    row.append(node('p', `最近心跳：${age(heartbeat, serverNow)} · Gateway 接收 ${timestamp(heartbeat)}`, 'muted'))
    row.append(node('p', `${state.stale ? '过期观测' : '状态观测'}：${timestamp(device.observed_at)}`, 'muted'))
    list.append(row)
  }
  section.append(list)
  if (page.devices.next_cursor !== undefined) {
    const next = node('a', '下一页设备', 'button-link')
    next.href = routeHref({ machineId: null, cursor: page.devices.next_cursor, providerCursor: null })
    section.append(next)
  }
  return section
}

/** 已配置 provider 的启停、readiness 与原生观测分别来自共享 DTO。 */
function providerList(page: PageView, machineId: string): HTMLElement {
  const section = node('section')
  section.append(
    node('h2', 'Runtime providers'),
    node('p', '仅展示此设备当前获授权的已配置实例；实例故障不等于整机离线。', 'muted')
  )
  if (page.providersProblem) {
    section.append(
      node(
        'p',
        page.providersProblem === 'forbidden'
          ? '没有 provider 查看权限。'
          : 'Provider 读取暂不可用，设备观测仍单独展示。',
        'notice warning'
      )
    )
    return section
  }
  if (page.providers.items.length === 0) {
    section.append(node('p', '此范围没有可展示的 provider。', 'empty'))
  }
  for (const provider of page.providers.items) {
    const row = node('article', '', 'provider-card')
    row.append(node('h3', `${provider.kind === 'luvus' ? 'Luvus' : 'Herdr'} · ${provider.provider_id}`))
    row.append(badge(provider.enabled ? '已启用' : '已禁用'))
    row.append(
      badge(
        `管理 readiness：${provider.readiness}`,
        provider.readiness === 'ready' && provider.enabled ? 'good' : 'warning'
      )
    )
    row.append(
      provider.runtime.verification === 'verified'
        ? badge(runtimeNames[provider.runtime.value.state])
        : badge(`运行状态未核实 · ${provider.runtime.reason_code}`, 'warning')
    )
    const runtime = provider.runtime.verification === 'verified' ? provider.runtime : null
    row.append(
      facts([
        ['Binding revision', String(provider.binding_revision)],
        ['Config 安全引用', provider.config_ref ?? '未核实'],
        ['契约引用', runtime?.value.contract_ref ?? '未核实，不授予执行许可'],
        [
          'Binary / schema 摘要',
          runtime ? `${runtime.value.binary_sha256 ?? '未核实'} / ${runtime.value.schema_sha256 ?? '未核实'}` : '未核实'
        ],
        ['分类 revision', runtime?.value.classification_revision ?? '未核实'],
        ['已核实传输', runtime?.value.supported_transports.join(' · ') || '未核实'],
        ['观测来源', runtime?.source ?? '未核实'],
        ['状态观测', timestamp(provider.observed_at)],
        ['原生观测', timestamp(runtime?.observed_at ?? null)]
      ])
    )
    section.append(row)
  }
  section.append(unavailableActions('provider'))
  if (page.providers.next_cursor !== undefined) {
    const next = node('a', '下一页 providers', 'button-link')
    next.href = routeHref({ machineId, cursor: null, providerCursor: page.providers.next_cursor })
    section.append(next)
  }
  return section
}

/** 详情只使用该 machine_id 的共享快照，未提供的配对/ready/重连信息明确未知。 */
function deviceDetail(page: PageView, serverNow: number): HTMLElement {
  const section = node('section')
  const back = node('a', '← 设备列表', 'back-link')
  back.href = '#'
  section.append(back)
  const device = page.device
  if (!device) {
    section.append(node('h1', '设备详情不可用'), node('p', '目标不存在或当前范围不可见。'))
    return section
  }
  const connection = device.connection.verification === 'verified' ? device.connection : null
  const authentication = device.authentication.verification === 'verified' ? device.authentication : null
  section.append(node('h1', device.name), node('code', device.machine_id), deviceBadges(device))
  section.append(
    facts([
      ['持久登记状态（非实时依据）', device.persisted_state],
      ['标签', device.labels === null ? '未记录' : device.labels.join(' · ') || '无标签'],
      ['资源 revision', device.resource_revision === null ? '未提供' : String(device.resource_revision)],
      ['Connection epoch 安全引用', connection?.value.connection_epoch_ref ?? '未核实 / 无当前连接'],
      [
        '最近心跳（Gateway 接收）',
        `${timestamp(connection?.value.last_heartbeat_at ?? null)} · ${age(connection?.value.last_heartbeat_at ?? null, serverNow)}`
      ],
      ['状态观测时间', timestamp(device.observed_at)],
      ['连接观测来源', connection?.source ?? '未核实'],
      ['认证观测来源', authentication?.source ?? '未核实'],
      [
        '最近失败代码',
        authentication?.value.last_failure
          ? `${authentication.value.last_failure.reason_code} · ${timestamp(authentication.value.last_failure.occurred_at)}`
          : '未记录 / 未核实'
      ]
    ])
  )
  section.append(
    node(
      'p',
      '当前共享读取未提供配对进度、设备 ready 证明、最近连接/重连时间或 OS/version；不从历史状态推测。Enrollment 和设备凭据仅通过受保护本机渠道交付及安全输入。',
      'muted'
    )
  )
  if (page.permissions) {
    const expired = serverNow >= page.permissions.expires_at
    section.append(
      node(
        'p',
        expired
          ? '权限提示已过期，等待刷新；它不授予后端权限。'
          : `短期权限提示有效至 ${timestamp(page.permissions.expires_at)}；每次操作仍须后端重新验证。`,
        'muted'
      )
    )
  }
  section.append(unavailableActions('device'), providerList(page, device.machine_id))
  return section
}

/** 渲染页面主体，并在年龄刷新时保留当前链接的键盘焦点。 */
export function renderPage(content: HTMLElement, state: ReaderState<PageView>, route: PageRoute): void {
  const focused =
    content.contains(document.activeElement) && document.activeElement instanceof HTMLAnchorElement
      ? document.activeElement.getAttribute('href')
      : null
  const view = document.createDocumentFragment()
  if (state.problem) {
    const message = node('p', problemNames[state.problem], 'notice warning')
    message.setAttribute('role', 'status')
    view.append(message)
  }
  if (!state.snapshot) {
    view.append(node('h1', state.pending ? '正在读取管理状态…' : '管理状态不可用'))
    view.append(node('p', '管理员身份与管理权限由独立的受保护后端验证。登录入口尚未接入时，设备数据不可用。', 'muted'))
  } else {
    const snapshot = state.snapshot
    const page = snapshot.value
    const status = page.status
    const serverNow = snapshot.observedAt + state.ageMs
    const gateway = node('section', '', 'gateway')
    gateway.append(node('h2', 'Gateway 状态'))
    gateway.append(
      badge(
        status.mode === 'active'
          ? '正常模式'
          : status.mode === 'recovery_quarantined'
            ? '恢复隔离 · 仅诊断'
            : '存储降级 · 只读',
        status.mode === 'active' ? 'good' : 'warning'
      )
    )
    gateway.append(badge(state.stale ? '快照已过期' : '快照有效', state.stale ? 'warning' : 'neutral'))
    gateway.append(
      facts([
        ['管理监听', '尚未接入实际管理 listener；共享状态接口未提供监听范围'],
        [
          '管理员认证',
          snapshot.sessionExpiresAt === null
            ? '每次读取重新验证；此接口未提供会话期限'
            : `会话期限 ${timestamp(snapshot.sessionExpiresAt)}`
        ],
        ['恢复代次', status.recovery_generation],
        ['管理策略 revision', status.policy_revision],
        [
          'Store / Transport / Native',
          `${status.components.store} / ${status.components.transport} / ${status.components.native}`
        ],
        ['快照观测', `${timestamp(snapshot.observedAt)} · ${Math.floor(state.ageMs / 1_000)} 秒前`]
      ])
    )
    if (status.mode !== 'active') {
      gateway.append(
        node(
          'p',
          status.mode === 'recovery_quarantined'
            ? '当前仅显示获授权的最小恢复诊断。旧连接和认证均不能作为当前状态；请使用独立受保护本机恢复流程。'
            : '当前禁止管理写入；持久撤销等操作可能尚未生效，请使用受保护本机诊断。',
          'notice warning'
        )
      )
    }
    view.append(gateway)
    if (status.mode !== 'recovery_quarantined') {
      view.append(route.machineId === null ? deviceList(page, state, serverNow) : deviceDetail(page, serverNow))
    }
  }
  content.replaceChildren(view)
  if (focused !== null) {
    for (const link of content.querySelectorAll('a')) {
      if (link.getAttribute('href') === focused) {
        link.focus({ preventScroll: true })
        break
      }
    }
  }
}
