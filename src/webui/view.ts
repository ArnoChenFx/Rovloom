/** 管理页直接渲染共享管理 DTO；不补造未核实状态，也不建立另一套管理协议。 */
import type { DeviceSnapshot, ManagementStatus, ManagementReply, PermissionSnapshot } from '../mcp/management.js'
import type { ReaderState } from './reader.js'
import { createLocalizer, type Localizer, type MessageKey } from './i18n.js'

/** 仅组合一次页面读取，所有业务对象仍是共享 DTO。 */
export interface PageView {
  status: ManagementStatus
  devices: ManagementReply['devices_list']
  device: DeviceSnapshot | null
  providers: ManagementReply['providers_list']
  permissions: PermissionSnapshot | null
  providersProblem: 'forbidden' | 'unavailable' | null
}
export type PageRoute = { machineId: string | null; cursor: string | null; providerCursor: string | null }
type PageSection = { heading: HTMLElement; body: HTMLElement }

const connectionNames = {
  connecting: 'connection.connecting',
  reconnecting: 'connection.reconnecting',
  online: 'connection.online',
  degraded: 'connection.degraded',
  offline: 'connection.offline'
} as const satisfies Record<string, MessageKey>
const authenticationNames = {
  pending: 'authentication.pending',
  authenticated: 'authentication.authenticated',
  failed: 'authentication.failed',
  expired: 'authentication.expired',
  revoked: 'authentication.revoked'
} as const satisfies Record<string, MessageKey>
const runtimeNames = {
  ready: 'runtime.ready',
  unreachable: 'runtime.unreachable',
  binding_mismatch: 'runtime.binding_mismatch',
  migration_unresolved: 'runtime.migration_unresolved'
} as const satisfies Record<string, MessageKey>
const readinessNames = {
  ready: 'readiness.ready',
  unavailable: 'readiness.unavailable',
  unverified: 'readiness.unverified'
} as const satisfies Record<string, MessageKey>
const componentNames = {
  available: 'component.available',
  degraded: 'component.degraded',
  quarantined: 'component.quarantined',
  unavailable: 'component.unavailable',
  unverified: 'component.unverified'
} as const satisfies Record<string, MessageKey>
const persistedNames = {
  pending: 'persisted.pending',
  offline: 'persisted.offline',
  online: 'persisted.online',
  revoked: 'persisted.revoked'
} as const satisfies Record<string, MessageKey>
const problemNames: Record<NonNullable<ReaderState<PageView>['problem']>, MessageKey> = {
  unauthenticated: 'error.unauthenticated',
  forbidden: 'error.forbidden',
  not_found: 'error.not_found',
  conflict: 'error.conflict',
  unavailable: 'error.unavailable',
  invalid_response: 'error.invalid_response',
  timeout: 'error.timeout',
  cancelled: 'error.cancelled'
}

/** 创建节点，所有后端文本通过 textContent 转义。 */
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag)
  result.textContent = text
  result.className = className
  return result
}

/** 渲染只含文本的键值信息。 */
function facts(rows: [string, string][], variant = ''): HTMLElement {
  const result = node('dl', '', `facts ${variant}`)
  for (const [label, value] of rows) {
    const item = node('div', '', 'fact')
    item.append(node('dt', label), node('dd', value))
    result.append(item)
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

/** 各层观测共享服务时间和单调经过时间，但分别保留自己的观测时点。 */
interface Freshness {
  now: number
  staleAfter: number
  pageStale: boolean
  i18n: Localizer
}

/** 新 status 只更新当前时间，不续期旧设备、认证或原生观测。 */
function current(observedAt: number, freshness: Freshness): boolean {
  return !freshness.pageStale && freshness.now - observedAt < freshness.staleAfter
}

/** 同时显示每层原始时间、年龄和过期标记；未知没有可补造的时间。 */
function observationTime(observedAt: number | null, freshness: Freshness): string {
  const { i18n } = freshness
  const { t } = i18n
  if (observedAt === null) {
    return t('value.unverified')
  }
  return t('time.observed', {
    time: i18n.timestamp(observedAt),
    age: i18n.age(observedAt, freshness.now),
    expired: current(observedAt, freshness) ? '' : t('time.expiredSuffix')
  })
}

/** 列表用真实年龄紧凑对齐，过期/未知常驻；绝对时刻保留在标题及设备详情，不续期观测。 */
function listObservation(
  key: 'devices.observed' | 'devices.connectionObserved' | 'devices.authObserved',
  observedAt: number | null,
  freshness: Freshness
): HTMLElement {
  const { i18n } = freshness
  const time =
    observedAt === null
      ? i18n.t('time.noObservation')
      : `${i18n.age(observedAt, freshness.now)}${current(observedAt, freshness) ? '' : i18n.t('time.expiredSuffix')}`
  const result = node('p', i18n.t(key, { time }), 'muted')
  result.title = i18n.t(key, { time: observationTime(observedAt, freshness) })
  return result
}

/** Provider 的绿色就绪提示还要求当前设备、连接与认证观测均有效。 */
function currentDeviceLink(device: DeviceSnapshot, freshness: Freshness): boolean {
  return (
    device.persisted_state === 'online' &&
    current(device.observed_at, freshness) &&
    device.connection.verification === 'verified' &&
    current(device.connection.observed_at, freshness) &&
    device.connection.value.state === 'online' &&
    device.authentication.verification === 'verified' &&
    current(device.authentication.observed_at, freshness) &&
    device.authentication.value.state === 'authenticated'
  )
}

/** 分开显示持久状态、连接与认证；过期的已验证来源仅可作为历史，不呈绿色在线。 */
function deviceBadges(device: DeviceSnapshot, freshness: Freshness): HTMLElement {
  const { i18n } = freshness
  const { t } = i18n
  const result = node('div', '', 'badges')
  const deviceCurrent = current(device.observed_at, freshness)
  if (!deviceCurrent) {
    result.append(badge(t('device.expired'), 'warning'))
  }
  if (device.persisted_state === 'revoked') {
    result.append(
      badge(
        deviceCurrent ? t('authentication.revoked') : t('device.revokedHistory'),
        deviceCurrent ? 'danger' : 'warning'
      ),
      badge(t('device.oldRecords'))
    )
    return result
  }
  if (device.persisted_state === 'pending') {
    result.append(
      badge(deviceCurrent ? t('device.pending') : t('device.pendingHistory'), 'warning'),
      badge(t('device.pendingUnverified'), 'warning')
    )
    return result
  }
  const connection = device.connection
  const authenticationCurrent =
    device.authentication.verification === 'verified' &&
    current(device.authentication.observed_at, freshness) &&
    device.authentication.value.state === 'authenticated'
  if (connection.verification === 'verified') {
    const ownCurrent = current(connection.observed_at, freshness)
    result.append(
      deviceCurrent && ownCurrent
        ? connection.value.state === 'online' && !authenticationCurrent
          ? badge(t('device.onlineAuthUnknown'), 'warning')
          : badge(t(connectionNames[connection.value.state]), connection.value.state === 'online' ? 'good' : 'neutral')
        : badge(
            t('device.lastState', {
              label: t(ownCurrent ? 'device.connectionParentExpired' : 'device.connectionExpired'),
              state: t(connectionNames[connection.value.state])
            }),
            'warning'
          )
    )
  } else {
    result.append(badge(t('device.connectionUnknown', { reason: i18n.reason(connection.reason_code) }), 'warning'))
  }
  const authentication = device.authentication
  if (authentication.verification === 'verified') {
    const ownCurrent = current(authentication.observed_at, freshness)
    result.append(
      deviceCurrent && ownCurrent
        ? badge(
            t(authenticationNames[authentication.value.state]),
            ['failed', 'expired', 'revoked'].includes(authentication.value.state) ? 'danger' : 'neutral'
          )
        : badge(
            t('device.lastState', {
              label: t(ownCurrent ? 'device.authParentExpired' : 'device.authExpired'),
              state: t(authenticationNames[authentication.value.state])
            }),
            'warning'
          )
    )
  } else {
    result.append(badge(t('device.authUnknown', { reason: i18n.reason(authentication.reason_code) }), 'warning'))
  }
  result.append(badge(t('device.readyUnknown')))
  return result
}

/** 只展示未接后端操作的含义，不提交确认或变更。 */
function unavailableActions(kind: 'device' | 'provider' | 'list', i18n: Localizer): HTMLElement {
  const { t } = i18n
  const section = node('section', '', 'actions')
  const noteId = `unavailable-${kind}`
  const note = node('p', t('actions.unavailable'), 'muted')
  note.id = noteId
  section.append(note)
  const labels =
    kind === 'list'
      ? [t('actions.register')]
      : kind === 'provider'
        ? [t('actions.provider')]
        : [t('actions.rename'), t('actions.pair'), t('actions.disconnect'), t('actions.revoke')]
  for (const label of labels) {
    const button = node('button', label)
    button.type = 'button'
    button.disabled = true
    button.setAttribute('aria-describedby', noteId)
    section.append(button)
  }
  if (kind === 'device') {
    section.append(node('p', t('actions.effect'), 'muted'))
  }
  return section
}

/** 只按当前可信展示范围启用三个入口；权限提示不代替写服务的每次授权。 */
function deviceActions(page: PageView, freshness: Freshness, connected: boolean): HTMLElement {
  const section = unavailableActions('device', freshness.i18n)
  if (!connected) {
    return section
  }
  section.querySelector('p')!.textContent = freshness.i18n.t('actions.available')
  const permission = page.permissions
  const allowed =
    permission &&
    page.device &&
    current(page.device.observed_at, freshness) &&
    current(permission.observed_at, freshness) &&
    freshness.now < permission.expires_at
  const actions = ['device_rename', null, 'device_disconnect', 'device_revoke'] as const
  const grants = ['devices_rename', '', 'devices_disconnect', 'devices_revoke']
  const buttons = section.querySelectorAll('button')
  for (let index = 0; index < actions.length; index++) {
    const action = actions[index]
    if (!action) {
      continue
    }
    const button = buttons[index]!
    button.dataset.deviceAction = action
    button.disabled =
      !allowed ||
      !permission.decisions.some(
        /** 权限仅作入口提示，服务端逐请求重验。 */ (decision) =>
          decision.action === grants[index] && decision.allowed && decision.reason_code === 'allowed'
      )
  }
  return section
}

/** 列表只展示后端返回的授权页，不将页长宣称为设备总数。 */
function deviceList(page: PageView, freshness: Freshness): PageSection {
  const { i18n } = freshness
  const { t } = i18n
  const heading = node('header', '', 'page-heading')
  heading.append(node('h1', t('devices.heading')), node('p', t('devices.description'), 'muted'))
  const section = node('section', '', 'devices-section')
  if (page.devices.items.length === 0) {
    const empty = node('div', '', 'empty')
    empty.append(node('h2', t('devices.emptyHeading')), node('p', t('devices.empty'), 'muted'))
    section.append(empty)
  }
  const columns = node('div', '', 'device-columns')
  columns.setAttribute('aria-hidden', 'true')
  for (const key of ['devices.identity', 'devices.health', 'devices.activity', 'devices.observations'] as const) {
    columns.append(node('span', t(key)))
  }
  if (page.devices.items.length) {
    section.append(columns)
  }
  const list = node('ul', '', 'device-list')
  list.setAttribute('aria-label', t('devices.heading'))
  for (const device of page.devices.items) {
    const row = node('li', '', 'device-card')
    const identity = node('div', '', 'device-identity')
    const link = node('a', device.name, 'device-name')
    link.href = routeHref({ machineId: device.machine_id, cursor: null, providerCursor: null })
    identity.append(link, node('code', device.machine_id))
    identity.append(
      node(
        'p',
        device.labels === null
          ? t('value.noLabelRecord')
          : device.labels.length
            ? device.labels.join(' · ')
            : t('value.noLabels'),
        'muted'
      )
    )
    const health = node('div', '', 'device-health')
    health.append(node('span', t('devices.health'), 'cell-label'), deviceBadges(device, freshness))
    const heartbeat = device.connection.verification === 'verified' ? device.connection.value.last_heartbeat_at : null
    const activity = node('div', '', 'device-activity')
    activity.append(node('span', t('devices.activity'), 'cell-label'))
    activity.append(
      node('strong', heartbeat === null ? t('time.noHeartbeat') : i18n.age(heartbeat, freshness.now), 'activity-age')
    )
    activity.append(node('p', t('devices.received', { time: i18n.timestamp(heartbeat) }), 'muted'))
    const observations = node('div', '', 'device-observations')
    observations.append(node('span', t('devices.observations'), 'cell-label'))
    observations.append(listObservation('devices.observed', device.observed_at, freshness))
    observations.append(
      listObservation(
        'devices.connectionObserved',
        device.connection.verification === 'verified' ? device.connection.observed_at : null,
        freshness
      )
    )
    observations.append(
      listObservation(
        'devices.authObserved',
        device.authentication.verification === 'verified' ? device.authentication.observed_at : null,
        freshness
      )
    )
    row.append(identity, health, activity, observations)
    list.append(row)
  }
  section.append(list)
  section.append(unavailableActions('list', i18n))
  if (page.devices.next_cursor !== undefined) {
    const next = node('a', t('devices.next'), 'button-link')
    next.href = routeHref({ machineId: null, cursor: page.devices.next_cursor, providerCursor: null })
    section.append(next)
  }
  return { heading, body: section }
}

/** 已配置 provider 的启停、readiness 与原生观测分别来自共享 DTO。 */
function providerList(page: PageView, device: DeviceSnapshot, freshness: Freshness): HTMLElement {
  const { i18n } = freshness
  const { t } = i18n
  const section = node('section', '', 'providers-section')
  section.append(node('h2', t('providers.heading')), node('p', t('providers.description'), 'muted'))
  if (page.providersProblem) {
    section.append(
      node(
        'p',
        page.providersProblem === 'forbidden' ? t('providers.forbidden') : t('providers.unavailable'),
        'notice warning'
      )
    )
    return section
  }
  if (page.providers.items.length === 0) {
    section.append(node('p', t('providers.empty'), 'empty'))
  }
  for (const provider of page.providers.items) {
    const row = node('article', '', 'provider-card')
    const header = node('header', '', 'provider-heading')
    header.append(node('h3', `${provider.kind === 'luvus' ? 'Luvus' : 'Herdr'} · ${provider.provider_id}`))
    const states = node('div', '', 'provider-states')
    const registryCurrent = current(provider.observed_at, freshness)
    const runtime = provider.runtime.verification === 'verified' ? provider.runtime : null
    const runtimeCurrent = runtime !== null && current(runtime.observed_at, freshness)
    const ready =
      registryCurrent &&
      provider.enabled &&
      provider.readiness === 'ready' &&
      runtimeCurrent &&
      runtime.value.state === 'ready' &&
      currentDeviceLink(device, freshness)
    states.append(
      badge(
        registryCurrent
          ? provider.enabled
            ? t('providers.enabled')
            : t('providers.disabled')
          : t('providers.enabledHistory', { state: t(provider.enabled ? 'providers.enabled' : 'providers.disabled') }),
        registryCurrent ? 'neutral' : 'warning'
      )
    )
    states.append(
      badge(
        provider.readiness === 'ready' && !ready
          ? t('providers.readyUnknown')
          : t(registryCurrent ? 'providers.readiness' : 'providers.readinessHistory', {
              state: t(readinessNames[provider.readiness])
            }),
        ready ? 'good' : 'warning'
      )
    )
    states.append(
      runtime
        ? badge(
            runtimeCurrent
              ? t(runtimeNames[runtime.value.state])
              : t('providers.runtimeHistory', { state: t(runtimeNames[runtime.value.state]) }),
            runtimeCurrent ? 'neutral' : 'warning'
          )
        : badge(
            t('providers.runtimeUnknown', {
              reason: i18n.reason(
                provider.runtime.verification === 'unverified' ? provider.runtime.reason_code : 'not_recorded'
              )
            }),
            'warning'
          )
    )
    header.append(states)
    row.append(header)
    row.append(
      facts(
        [
          [t('providers.bindingRevision'), String(provider.binding_revision)],
          [t('providers.configRef'), provider.config_ref ?? t('value.unverified')],
          [
            runtimeCurrent ? t('providers.contractRef') : t('providers.contractHistory'),
            runtime?.value.contract_ref ?? t('value.noExecutionPermission')
          ],
          [
            t('providers.digests'),
            runtime
              ? `${runtime.value.binary_sha256 ?? t('value.unverified')} / ${runtime.value.schema_sha256 ?? t('value.unverified')}`
              : t('value.unverified')
          ],
          [t('providers.classification'), runtime?.value.classification_revision ?? t('value.unverified')],
          [
            runtimeCurrent ? t('providers.transports') : t('providers.transportsHistory'),
            runtime?.value.supported_transports.join(' · ') || t('value.unverified')
          ],
          [t('providers.source'), runtime?.source ?? t('value.unverified')],
          [t('providers.observed'), observationTime(provider.observed_at, freshness)],
          [t('providers.nativeObserved'), observationTime(runtime?.observed_at ?? null, freshness)]
        ],
        'provider-facts'
      )
    )
    section.append(row)
  }
  section.append(unavailableActions('provider', i18n))
  if (page.providers.next_cursor !== undefined) {
    const next = node('a', t('providers.next'), 'button-link')
    next.href = routeHref({ machineId: device.machine_id, cursor: null, providerCursor: page.providers.next_cursor })
    section.append(next)
  }
  return section
}

/** 详情只使用该 machine_id 的共享快照，未提供的配对/ready/重连信息明确未知。 */
function deviceDetail(page: PageView, freshness: Freshness, management = false): PageSection {
  const { i18n } = freshness
  const { t } = i18n
  const section = node('section', '', 'device-detail')
  const heading = node('header', '', 'page-heading')
  const back = node('a', t('detail.back'), 'back-link')
  back.href = '#'
  heading.append(back)
  const device = page.device
  if (!device) {
    heading.append(node('h1', t('detail.unavailable')))
    section.append(node('p', t('detail.invisible'), 'empty'))
    return { heading, body: section }
  }
  const connection = device.connection.verification === 'verified' ? device.connection : null
  const authentication = device.authentication.verification === 'verified' ? device.authentication : null
  heading.append(node('h1', device.name), node('code', device.machine_id))
  const layout = node('div', '', 'detail-layout')
  const registration = node('section', '', 'detail-registration')
  registration.append(node('h2', t('detail.identityHeading')))
  registration.append(
    facts([
      [t('detail.persisted'), t(persistedNames[device.persisted_state])],
      [
        t('detail.labels'),
        device.labels === null ? t('value.notRecorded') : device.labels.join(' · ') || t('value.noLabels')
      ],
      [
        t('detail.revision'),
        device.resource_revision === null ? t('value.notProvided') : String(device.resource_revision)
      ]
    ])
  )
  const connectionSection = node('section', '', 'detail-connection')
  connectionSection.append(node('h2', t('detail.connectionHeading')), deviceBadges(device, freshness))
  connectionSection.append(
    facts([
      [t('detail.epoch'), connection?.value.connection_epoch_ref ?? t('value.noConnection')],
      [
        t('detail.heartbeat'),
        `${i18n.timestamp(connection?.value.last_heartbeat_at ?? null)} · ${i18n.age(connection?.value.last_heartbeat_at ?? null, freshness.now)}`
      ],
      [
        t('detail.failure'),
        authentication?.value.last_failure
          ? `${i18n.reason(authentication.value.last_failure.reason_code)} · ${i18n.timestamp(authentication.value.last_failure.occurred_at)}`
          : t('value.noFailure')
      ]
    ])
  )
  const observations = node('section', '', 'detail-observation')
  observations.append(node('h2', t('detail.observationHeading')))
  observations.append(
    facts([
      [t('detail.observed'), observationTime(device.observed_at, freshness)],
      [t('detail.connectionObserved'), observationTime(connection?.observed_at ?? null, freshness)],
      [t('detail.authObserved'), observationTime(authentication?.observed_at ?? null, freshness)],
      [t('detail.connectionSource'), connection?.source ?? t('value.unverified')],
      [t('detail.authSource'), authentication?.source ?? t('value.unverified')]
    ])
  )
  layout.append(connectionSection, registration, observations)
  section.append(layout, node('p', t('detail.missing'), 'context-note'))
  if (page.permissions) {
    const expired = !current(page.permissions.observed_at, freshness) || freshness.now >= page.permissions.expires_at
    section.append(
      node(
        'p',
        expired
          ? t('detail.permissionExpired')
          : t('detail.permissionUntil', { time: i18n.timestamp(page.permissions.expires_at) }),
        'muted'
      )
    )
  }
  section.append(providerList(page, device, freshness), deviceActions(page, freshness, management))
  return { heading, body: section }
}

/** 同一路由按结构同步安全构造的节点，年龄更新不替换正在点击或聚焦的控件。 */
function syncChildren(parent: Node, desired: Node): void {
  const children = Array.from(desired.childNodes)
  for (let index = 0; index < children.length; index++) {
    const next = children[index]!
    const current = parent.childNodes[index]
    if (!current) {
      parent.appendChild(next)
    } else if (current.nodeType === Node.TEXT_NODE && next.nodeType === Node.TEXT_NODE) {
      if (current.nodeValue !== next.nodeValue) {
        current.nodeValue = next.nodeValue
      }
    } else if (
      current instanceof Element &&
      next instanceof Element &&
      current.tagName === next.tagName &&
      (current.tagName !== 'A' || current.getAttribute('href') === next.getAttribute('href'))
    ) {
      for (const attribute of Array.from(current.attributes)) {
        if (!next.hasAttribute(attribute.name)) {
          current.removeAttribute(attribute.name)
        }
      }
      for (const attribute of Array.from(next.attributes)) {
        if (current.getAttribute(attribute.name) !== attribute.value) {
          current.setAttribute(attribute.name, attribute.value)
        }
      }
      syncChildren(current, next)
    } else {
      parent.replaceChild(next, current)
    }
  }
  while (parent.childNodes.length > children.length) {
    parent.removeChild(parent.lastChild!)
  }
}

/** 渲染页面主体；同一路由保留交互节点，换目标时清除旧节点与焦点关联。 */
export function renderPage(
  content: HTMLElement,
  state: ReaderState<PageView>,
  route: PageRoute,
  i18n: Localizer = createLocalizer('zh-CN'),
  management = false
): void {
  const { t } = i18n
  const focused =
    content.contains(document.activeElement) && document.activeElement instanceof HTMLAnchorElement
      ? document.activeElement.getAttribute('href')
      : null
  const metadataWasOpen = content.querySelector<HTMLDetailsElement>('.gateway-metadata')?.open ?? false
  const metadataHadFocus =
    content.contains(document.activeElement) && document.activeElement?.matches('.gateway-metadata > summary')
  const view = document.createDocumentFragment()
  if (state.problem) {
    const message = node('p', t(problemNames[state.problem]), 'notice warning')
    message.setAttribute('role', 'status')
    view.append(message)
  }
  if (!state.snapshot) {
    const empty = node('section', '', `state-panel ${state.pending ? 'loading' : 'unavailable'}`)
    const symbol = node('span', state.pending ? '' : '!', 'state-symbol')
    symbol.setAttribute('aria-hidden', 'true')
    empty.append(symbol, node('h1', state.pending ? t('gateway.pending') : t('gateway.unavailable')))
    empty.append(node('p', t('gateway.authorization'), 'muted'))
    view.append(empty)
  } else {
    const snapshot = state.snapshot
    const page = snapshot.value
    const status = page.status
    const freshness: Freshness = {
      now: snapshot.observedAt + state.ageMs,
      staleAfter: status.stale_after_ms,
      pageStale: state.stale,
      i18n
    }
    const gateway = node('section', '', 'gateway')
    const gatewayHeading = node('div', '', 'gateway-heading')
    gatewayHeading.append(node('h2', t('gateway.heading')))
    gatewayHeading.append(
      badge(
        status.mode === 'active'
          ? state.stale
            ? t('gateway.activeHistory')
            : t('gateway.active')
          : status.mode === 'recovery_quarantined'
            ? t('gateway.quarantined')
            : t('gateway.degraded'),
        status.mode === 'active' && !state.stale ? 'good' : 'warning'
      )
    )
    gatewayHeading.append(
      badge(state.stale ? t('reader.stale') : t('gateway.fresh'), state.stale ? 'warning' : 'neutral')
    )
    gateway.append(gatewayHeading)
    gateway.append(
      facts(
        [
          [t('gateway.listener'), t('gateway.listenerUnknown')],
          [
            t('gateway.authentication'),
            snapshot.sessionExpiresAt === null
              ? t('gateway.sessionUnknown')
              : t('gateway.sessionUntil', { time: i18n.timestamp(snapshot.sessionExpiresAt) })
          ],
          [
            t('gateway.components'),
            `${t(componentNames[status.components.store])} / ${t(componentNames[status.components.transport])} / ${t(componentNames[status.components.native])}`
          ],
          [
            t('gateway.observed'),
            t('time.observed', {
              time: i18n.timestamp(snapshot.observedAt),
              age: i18n.age(snapshot.observedAt, snapshot.observedAt + state.ageMs),
              expired: ''
            })
          ]
        ],
        'gateway-facts'
      )
    )
    const metadata = node('details', '', 'gateway-metadata')
    metadata.open = metadataWasOpen
    metadata.append(node('summary', t('gateway.metadata')))
    metadata.append(
      facts([
        [t('gateway.generation'), status.recovery_generation],
        [t('gateway.policy'), status.policy_revision]
      ])
    )
    gateway.append(metadata)
    if (status.mode !== 'active') {
      gateway.append(
        node(
          'p',
          status.mode === 'recovery_quarantined' ? t('gateway.recoveryNote') : t('gateway.degradedNote'),
          'notice warning'
        )
      )
    }
    if (status.mode !== 'recovery_quarantined') {
      const section =
        route.machineId === null
          ? deviceList(page, freshness)
          : deviceDetail(page, freshness, management && status.mode === 'active' && !state.stale)
      view.append(section.heading, gateway, section.body)
    } else {
      view.append(node('h1', t('gateway.heading')), gateway)
    }
  }
  const identity = routeHref(route)
  if (content.dataset.route === identity) {
    syncChildren(content, view)
  } else {
    content.replaceChildren(view)
    content.dataset.route = identity
  }
  if (focused !== null) {
    for (const link of content.querySelectorAll('a')) {
      if (link.getAttribute('href') === focused) {
        link.focus({ preventScroll: true })
        break
      }
    }
  } else if (metadataHadFocus) {
    content.querySelector<HTMLElement>('.gateway-metadata > summary')?.focus({ preventScroll: true })
  }
}
