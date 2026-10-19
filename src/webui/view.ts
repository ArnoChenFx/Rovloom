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

/** 列表只展示后端返回的授权页，不将页长宣称为设备总数。 */
function deviceList(page: PageView, freshness: Freshness): HTMLElement {
  const { i18n } = freshness
  const { t } = i18n
  const section = node('section')
  section.append(
    node('h1', t('devices.heading')),
    node('p', t('devices.description'), 'muted'),
    unavailableActions('list', i18n)
  )
  if (page.devices.items.length === 0) {
    section.append(node('div', t('devices.empty'), 'empty'))
  }
  const list = node('ul', '', 'device-list')
  for (const device of page.devices.items) {
    const row = node('li', '', 'device-card')
    const link = node('a', device.name, 'device-name')
    link.href = routeHref({ machineId: device.machine_id, cursor: null, providerCursor: null })
    row.append(link, node('code', device.machine_id), deviceBadges(device, freshness))
    row.append(
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
    const heartbeat = device.connection.verification === 'verified' ? device.connection.value.last_heartbeat_at : null
    row.append(
      node(
        'p',
        t('devices.heartbeat', { age: i18n.age(heartbeat, freshness.now), time: i18n.timestamp(heartbeat) }),
        'muted'
      )
    )
    row.append(node('p', t('devices.observed', { time: observationTime(device.observed_at, freshness) }), 'muted'))
    row.append(
      node(
        'p',
        t('devices.connectionObserved', {
          time: observationTime(
            device.connection.verification === 'verified' ? device.connection.observed_at : null,
            freshness
          )
        }),
        'muted'
      )
    )
    row.append(
      node(
        'p',
        t('devices.authObserved', {
          time: observationTime(
            device.authentication.verification === 'verified' ? device.authentication.observed_at : null,
            freshness
          )
        }),
        'muted'
      )
    )
    list.append(row)
  }
  section.append(list)
  if (page.devices.next_cursor !== undefined) {
    const next = node('a', t('devices.next'), 'button-link')
    next.href = routeHref({ machineId: null, cursor: page.devices.next_cursor, providerCursor: null })
    section.append(next)
  }
  return section
}

/** 已配置 provider 的启停、readiness 与原生观测分别来自共享 DTO。 */
function providerList(page: PageView, device: DeviceSnapshot, freshness: Freshness): HTMLElement {
  const { i18n } = freshness
  const { t } = i18n
  const section = node('section')
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
    row.append(node('h3', `${provider.kind === 'luvus' ? 'Luvus' : 'Herdr'} · ${provider.provider_id}`))
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
    row.append(
      badge(
        registryCurrent
          ? provider.enabled
            ? t('providers.enabled')
            : t('providers.disabled')
          : t('providers.enabledHistory', { state: t(provider.enabled ? 'providers.enabled' : 'providers.disabled') }),
        registryCurrent ? 'neutral' : 'warning'
      )
    )
    row.append(
      badge(
        provider.readiness === 'ready' && !ready
          ? t('providers.readyUnknown')
          : t(registryCurrent ? 'providers.readiness' : 'providers.readinessHistory', {
              state: t(readinessNames[provider.readiness])
            }),
        ready ? 'good' : 'warning'
      )
    )
    row.append(
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
    row.append(
      facts([
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
      ])
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
function deviceDetail(page: PageView, freshness: Freshness): HTMLElement {
  const { i18n } = freshness
  const { t } = i18n
  const section = node('section')
  const back = node('a', t('detail.back'), 'back-link')
  back.href = '#'
  section.append(back)
  const device = page.device
  if (!device) {
    section.append(node('h1', t('detail.unavailable')), node('p', t('detail.invisible')))
    return section
  }
  const connection = device.connection.verification === 'verified' ? device.connection : null
  const authentication = device.authentication.verification === 'verified' ? device.authentication : null
  section.append(node('h1', device.name), node('code', device.machine_id), deviceBadges(device, freshness))
  section.append(
    facts([
      [t('detail.persisted'), t(persistedNames[device.persisted_state])],
      [
        t('detail.labels'),
        device.labels === null ? t('value.notRecorded') : device.labels.join(' · ') || t('value.noLabels')
      ],
      [
        t('detail.revision'),
        device.resource_revision === null ? t('value.notProvided') : String(device.resource_revision)
      ],
      [t('detail.epoch'), connection?.value.connection_epoch_ref ?? t('value.noConnection')],
      [
        t('detail.heartbeat'),
        `${i18n.timestamp(connection?.value.last_heartbeat_at ?? null)} · ${i18n.age(connection?.value.last_heartbeat_at ?? null, freshness.now)}`
      ],
      [t('detail.observed'), observationTime(device.observed_at, freshness)],
      [t('detail.connectionObserved'), observationTime(connection?.observed_at ?? null, freshness)],
      [t('detail.authObserved'), observationTime(authentication?.observed_at ?? null, freshness)],
      [t('detail.connectionSource'), connection?.source ?? t('value.unverified')],
      [t('detail.authSource'), authentication?.source ?? t('value.unverified')],
      [
        t('detail.failure'),
        authentication?.value.last_failure
          ? `${i18n.reason(authentication.value.last_failure.reason_code)} · ${i18n.timestamp(authentication.value.last_failure.occurred_at)}`
          : t('value.noFailure')
      ]
    ])
  )
  section.append(node('p', t('detail.missing'), 'muted'))
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
  section.append(unavailableActions('device', i18n), providerList(page, device, freshness))
  return section
}

/** 渲染页面主体，并在年龄刷新时保留当前链接的键盘焦点。 */
export function renderPage(
  content: HTMLElement,
  state: ReaderState<PageView>,
  route: PageRoute,
  i18n: Localizer = createLocalizer('zh-CN')
): void {
  const { t } = i18n
  const focused =
    content.contains(document.activeElement) && document.activeElement instanceof HTMLAnchorElement
      ? document.activeElement.getAttribute('href')
      : null
  const view = document.createDocumentFragment()
  if (state.problem) {
    const message = node('p', t(problemNames[state.problem]), 'notice warning')
    message.setAttribute('role', 'status')
    view.append(message)
  }
  if (!state.snapshot) {
    view.append(node('h1', state.pending ? t('gateway.pending') : t('gateway.unavailable')))
    view.append(node('p', t('gateway.authorization'), 'muted'))
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
    gateway.append(node('h2', t('gateway.heading')))
    gateway.append(
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
    gateway.append(badge(state.stale ? t('reader.stale') : t('gateway.fresh'), state.stale ? 'warning' : 'neutral'))
    gateway.append(
      facts([
        [t('gateway.listener'), t('gateway.listenerUnknown')],
        [
          t('gateway.authentication'),
          snapshot.sessionExpiresAt === null
            ? t('gateway.sessionUnknown')
            : t('gateway.sessionUntil', { time: i18n.timestamp(snapshot.sessionExpiresAt) })
        ],
        [t('gateway.generation'), status.recovery_generation],
        [t('gateway.policy'), status.policy_revision],
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
      ])
    )
    if (status.mode !== 'active') {
      gateway.append(
        node(
          'p',
          status.mode === 'recovery_quarantined' ? t('gateway.recoveryNote') : t('gateway.degradedNote'),
          'notice warning'
        )
      )
    }
    view.append(gateway)
    if (status.mode !== 'recovery_quarantined') {
      view.append(route.machineId === null ? deviceList(page, freshness) : deviceDetail(page, freshness))
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
