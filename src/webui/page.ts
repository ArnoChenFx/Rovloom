/** 挂载内置管理页面并管理导航/可见性资源；读取适配层不接收浏览器自报管理员身份。 */
import { createSnapshotReader, ReadError, type ReadClock, type SnapshotReader, type TimedSnapshot } from './reader.js'
import { parseRoute, renderPage, type PageRoute, type PageView } from './view.js'
import { checkPage } from './validate.js'
import type { ReaderState } from './reader.js'
import { createLocalizer } from './i18n.js'
import { createUiPreferences, type UiPreferences } from './preferences.js'
import { createPreferenceControl } from './preference-control.js'
import { createPairingProgress } from './pairing-progress.js'
import { createDeviceActions } from './device-actions.js'
import type { ManagementWriteTransport, DeviceManagementIntent } from './write-contract.js'

/** 接入共享管理读取后的页面投影函数；不是授权接口，不能代替每次后端鉴权。 */
export type PageRead = (route: Readonly<PageRoute>, signal: AbortSignal) => Promise<TimedSnapshot<PageView>>

/** 创建固定的页面节点，不把任何身份、秘密或设备输入写进 HTML 字符串。 */
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text: string,
  className = ''
): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag)
  result.textContent = text
  result.className = className
  return result
}

/** 默认入口在共享读取/认证接线完成前明确不可用，永不回退到测试 fixture。 */
export async function unavailableRead(): Promise<never> {
  throw new ReadError('unavailable')
}

/** 建立页面壳、手动刷新/取消与单路由 reader，返回幂等卸载函数。 */
export function mountWebUi(
  root: HTMLElement,
  read: PageRead = unavailableRead,
  clock?: ReadClock,
  management?: ManagementWriteTransport
): () => void {
  const header = element('header', '', 'topbar')
  const brand = element('a', '', 'brand')
  brand.href = '#'
  const logo = element('img', '', 'brand-logo')
  logo.src = './rovloom-mark-transparent.png'
  logo.alt = 'Rovloom'
  logo.width = 48
  logo.height = 48
  brand.append(logo, element('span', 'Rovloom', 'brand-name'))
  const title = element('span', '', 'brand-context')
  const preferencesBar = element('div', '', 'preferences')
  const commandbar = element('nav', '', 'commandbar')
  const sectionLink = element('a', '', 'section-nav')
  sectionLink.href = '#'
  const toolbar = element('div', '', 'toolbar')
  const refresh = element('button', '')
  refresh.type = 'button'
  const cancel = element('button', '')
  cancel.type = 'button'
  const indicator = element('span', '', 'read-indicator')
  indicator.setAttribute('role', 'status')
  indicator.setAttribute('aria-live', 'polite')
  const content = element('main', '', 'content')
  content.id = 'management-content'
  content.tabIndex = -1
  refresh.setAttribute('aria-controls', content.id)
  cancel.setAttribute('aria-controls', content.id)
  const language = createPreferenceControl(
    'language',
    [
      ['system', 'language.system'],
      ['zh-CN', 'language.chinese'],
      ['en', 'language.english']
    ],
    /** 语言选择只保存现有展示枚举，不触发设备读取。 */ (value) => preferences.setLanguage(value)
  )
  const theme = createPreferenceControl(
    'theme',
    [
      ['system', 'theme.system'],
      ['light', 'theme.light'],
      ['dark', 'theme.dark']
    ],
    /** 主题选择只更新本页样式与既有偏好。 */ (value) => preferences.setTheme(value)
  )
  preferencesBar.append(language.root, theme.root)
  toolbar.append(indicator, refresh, cancel)
  commandbar.append(sectionLink, toolbar)
  header.append(brand, title, preferencesBar)
  const skip = element('a', '', 'skip-link')
  skip.href = '#management-content'
  const footer = element('footer', '', 'muted')
  root.replaceChildren(skip, header, commandbar, content, footer)
  let route = parseRoute(location.hash)
  let reader: SnapshotReader<PageView>
  let disposed = false
  let i18n = createLocalizer('en')
  const pairing = management
    ? createPairingProgress({
        transport: management,
        /** 取消申请与其它管理动作共用同一个确认/未知回执实例。 */
        cancel(machine_id, pairing_id, trigger) {
          actions?.open({ action: 'pairing_cancel', machine_id, pairing_id }, trigger)
        },
        /** 失效会话清空整个页面，进度403则由局部控件说明。 */
        authorizationLost() {
          reader.dispose()
          actions?.clear()
          pairing?.clear()
          paint({ snapshot: null, pending: false, stale: true, ageMs: 0, problem: 'unauthenticated' }, route)
        }
      })
    : undefined
  const actions = management
    ? createDeviceActions({
        transport: management,
        /** 持久提交后销毁旧在途读取，再取当前目标；迟到旧快照不能覆盖真实变更。 */
        committed(machineId) {
          if (!disposed && (route.machineId === machineId || route.machineId === null)) {
            reader.dispose()
            start()
          }
        },
        /** 注册回执仅携带原申请引用，不自动获取新设备权限。 */
        pairingCreated(machine, id) {
          pairing?.open(machine, id)
        },
        /** 写请求发现会话/权限失效时同样清空读数据，不能让旧页面继续操作。 */
        authorizationLost(problem) {
          if (disposed) {
            return
          }
          reader.dispose()
          actions?.clear()
          pairing?.clear()
          paint({ snapshot: null, pending: false, stale: true, ageMs: 0, problem }, route)
        }
      })
    : undefined
  if (actions) {
    footer.before(actions.region, pairing!.region)
  }

  /** 稳定工具栏与当前快照重新本地化；不替换 reader、路由、等待信号或时间锚点。 */
  function paint(state: ReaderState<PageView>, current: PageRoute): void {
    refresh.disabled = state.pending || ['unauthenticated', 'forbidden', 'not_found'].includes(state.problem ?? '')
    cancel.disabled = !state.pending
    indicator.textContent = i18n.t(
      state.pending
        ? 'reader.pending'
        : state.snapshot
          ? state.stale
            ? 'reader.stale'
            : 'reader.snapshot'
          : 'reader.empty'
    )
    content.setAttribute('aria-busy', String(state.pending))
    indicator.dataset.state = state.pending ? 'pending' : state.stale ? 'stale' : state.snapshot ? 'current' : 'empty'
    sectionLink.setAttribute('aria-current', current.machineId === null ? 'page' : 'location')
    if (['unauthenticated', 'forbidden', 'not_found'].includes(state.problem ?? '')) {
      actions?.clear()
      pairing?.clear()
    }
    actions?.update(
      i18n,
      !!state.snapshot && !state.stale && state.snapshot.value.status.mode === 'active',
      state.snapshot ? state.snapshot.observedAt + state.ageMs : undefined
    )
    pairing?.update(
      i18n,
      !!state.snapshot && !state.stale && state.snapshot.value.status.mode === 'active',
      state.snapshot ? state.snapshot.observedAt + state.ageMs : undefined
    )
    renderPage(content, state, current, i18n, !!actions)
  }

  /** 偏好仅改变文案与 CSS 主题；标题、语言和无障碍名称随词典同步。 */
  function applyPreferences(state: UiPreferences): void {
    const languageChanged = i18n.language !== state.language
    if (languageChanged) {
      i18n = createLocalizer(state.language)
    }
    const { t } = i18n
    document.documentElement.lang = state.language
    document.documentElement.dataset.theme = state.theme
    document.title = t('app.title')
    brand.setAttribute('aria-label', t('app.navigation'))
    title.textContent = t('app.console')
    sectionLink.textContent = t('devices.heading')
    commandbar.setAttribute('aria-label', t('app.subtitle'))
    refresh.textContent = t('action.refresh')
    cancel.textContent = t('action.cancel')
    skip.textContent = t('app.skip')
    footer.textContent = t(actions ? 'app.managedFooter' : 'app.footer')
    language.update(i18n, state.languageChoice)
    theme.update(i18n, state.themeChoice)
    if (languageChanged && reader) {
      paint(reader.state(), route)
    }
  }
  const preferences = createUiPreferences(applyPreferences)
  applyPreferences(preferences.state())

  /** 每个路由拥有独立 reader，拒绝旧机器或旧分页响应写入新页面。 */
  function start(): void {
    const current = { ...route }
    reader = createSnapshotReader(
      /** 调用已有授权读取的展示适配层；不传 principal、credential 或 approved 标志。 */
      async (signal) => checkPage(await read(current, signal), current),
      /** 读取生命周期更新使用当前词典，不续期或改变授权结果。 */
      (state) => paint(state, current),
      clock
    )
    if (document.visibilityState === 'hidden') {
      reader.visible(false)
      paint(reader.state(), current)
    } else {
      void reader.refresh()
    }
  }

  /** 跳转主内容时保留当前机器路由，避免刷新后丢失目标。 */
  function skipContent(event: MouseEvent): void {
    event.preventDefault()
    content.focus()
  }

  /** 手动刷新只读快照，重复点击由 reader 合并。 */
  function refreshPage(): void {
    void reader.refresh()
  }

  /** 取消本次读取不会发起设备操作，也不等待迟到响应。 */
  function cancelRead(): void {
    reader.cancel()
  }

  /** 只接收实际启用的设备入口和当前读模型目标，不消费浏览器自报身份。 */
  function deviceAction(event: MouseEvent): void {
    const button =
      event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>(
            'button[data-device-action],button[data-provider-action],button[data-pairing-action]'
          )
        : null
    if (!actions || !button || button.disabled || !content.contains(button)) {
      return
    }
    const snapshot = reader.state()
    const page = snapshot.snapshot?.value
    if (!page || snapshot.stale || page.status.mode !== 'active') {
      return
    }
    if (button.dataset.pairingAction === 'lookup') {
      pairing?.open(page.device?.machine_id)
      return
    }
    if (button.dataset.pairingAction === 'create') {
      const value: DeviceManagementIntent = page.device
        ? { action: 'pairing_create', machine_id: page.device.machine_id, policy_ref: '' }
        : { action: 'pairing_create', name: '', labels: [], policy_ref: '' }
      if (page.device && page.device.persisted_state !== 'pending') {
        return
      }
      actions.open(value, button)
      return
    }
    const device = page.device
    if (!device || route.machineId !== device.machine_id) {
      return
    }
    if (button.dataset.providerAction === 'disable') {
      const provider = page.providers.items.find(
        /** 仅从当前已授权实例页选取目标。 */ (item) => item.provider_id === button.dataset.providerId
      )
      if (provider?.enabled) {
        actions.open(
          {
            action: 'provider_disable',
            machine_id: device.machine_id,
            provider_id: provider.provider_id,
            kind: provider.kind,
            expected_binding_revision: provider.binding_revision
          },
          button
        )
      }
      return
    }
    const action = button.dataset.deviceAction
    if (action === 'device_rename') {
      actions.open({ action, machine_id: device.machine_id, name: device.name }, button)
    }
    if (action === 'device_disconnect' || action === 'device_revoke') {
      actions.open({ action, machine_id: device.machine_id }, button)
    }
  }

  /** 哈希导航、后退与分页都先清理旧路由资源，再获取新目标。 */
  function navigate(): void {
    actions?.suspend()
    pairing?.suspend()
    language.close()
    theme.close()
    if (location.hash === '#management-content') {
      content.focus()
      return
    }
    reader.dispose()
    route = parseRoute(location.hash)
    start()
    content.focus({ preventScroll: true })
  }

  /** 后台暂停轮询并取消在途读取，前台立即按原页面范围刷新。 */
  function visibility(): void {
    if (document.visibilityState === 'hidden') {
      actions?.suspend()
      pairing?.suspend()
    }
    reader.visible(document.visibilityState !== 'hidden')
  }

  /** BFCache 恢复时新建 reader，清除先前会话的所有状态。 */
  function show(event: PageTransitionEvent): void {
    if (event.persisted) {
      reader.dispose()
      preferences.sync()
      route = parseRoute(location.hash)
      start()
    }
  }

  /** 页面离开时销毁在途请求及定时器，后退不会重复任何写入。 */
  function hide(): void {
    actions?.suspend()
    pairing?.suspend()
    language.close()
    theme.close()
    reader.dispose()
    content.replaceChildren()
  }

  /** 永久卸载移除所有宿主监听器并清空 DOM/内存。 */
  function dispose(): void {
    if (disposed) {
      return
    }
    disposed = true
    reader.dispose()
    actions?.dispose()
    pairing?.dispose()
    content.removeEventListener('click', deviceAction)
    skip.removeEventListener('click', skipContent)
    refresh.removeEventListener('click', refreshPage)
    cancel.removeEventListener('click', cancelRead)
    language.dispose()
    theme.dispose()
    preferences.dispose()
    window.removeEventListener('hashchange', navigate)
    document.removeEventListener('visibilitychange', visibility)
    window.removeEventListener('pageshow', show)
    window.removeEventListener('pagehide', hide)
    root.replaceChildren()
  }

  skip.addEventListener('click', skipContent)
  refresh.addEventListener('click', refreshPage)
  cancel.addEventListener('click', cancelRead)
  content.addEventListener('click', deviceAction)
  window.addEventListener('hashchange', navigate)
  document.addEventListener('visibilitychange', visibility)
  window.addEventListener('pageshow', show)
  window.addEventListener('pagehide', hide)
  start()
  return dispose
}
