/** 挂载内置管理页面并管理导航/可见性资源；读取适配层不接收浏览器自报管理员身份。 */
import { createSnapshotReader, ReadError, type ReadClock, type SnapshotReader, type TimedSnapshot } from './reader.js'
import { parseRoute, renderPage, type PageRoute, type PageView } from './view.js'
import { checkPage } from './validate.js'

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
export function mountWebUi(root: HTMLElement, read: PageRead = unavailableRead, clock?: ReadClock): () => void {
  const header = element('header', '', 'topbar')
  const brand = element('a', '', 'brand')
  brand.href = '#'
  brand.setAttribute('aria-label', 'Rovloom，返回设备列表')
  const logo = element('img', '', 'brand-logo')
  logo.src = './rovloom-mark-orange.png'
  logo.alt = 'Rovloom'
  logo.width = 48
  logo.height = 48
  brand.append(logo)
  const title = element('span', '设备与连接管理', 'muted')
  const toolbar = element('div', '', 'toolbar')
  const refresh = element('button', '刷新')
  refresh.type = 'button'
  const cancel = element('button', '取消读取')
  cancel.type = 'button'
  const indicator = element('span', '', 'muted')
  indicator.setAttribute('role', 'status')
  indicator.setAttribute('aria-live', 'polite')
  const content = element('main', '', 'content')
  content.id = 'management-content'
  content.tabIndex = -1
  refresh.setAttribute('aria-controls', content.id)
  cancel.setAttribute('aria-controls', content.id)
  toolbar.append(refresh, cancel, indicator)
  header.append(brand, title, toolbar)
  const skip = element('a', '跳到管理内容', 'skip-link')
  skip.href = '#management-content'
  const footer = element(
    'footer',
    '只读管理切片 · 所有管理变更尚未接入 · 每次读取须由后端验证当前管理员与目标权限',
    'muted'
  )
  root.replaceChildren(skip, header, content, footer)
  document.title = 'Rovloom 管理'
  let route = parseRoute(location.hash)
  let reader: SnapshotReader<PageView>
  let disposed = false

  /** 每个路由拥有独立 reader，拒绝旧机器或旧分页响应写入新页面。 */
  function start(): void {
    const current = { ...route }
    reader = createSnapshotReader(
      /** 调用已有授权读取的展示适配层；不传 principal、credential 或 approved 标志。 */
      async (signal) => checkPage(await read(current, signal), current),
      /** 更新稳定工具栏，并保留内容中当前键盘焦点。 */
      (state) => {
        refresh.disabled =
          state.pending ||
          state.problem === 'unauthenticated' ||
          state.problem === 'forbidden' ||
          state.problem === 'not_found'
        cancel.disabled = !state.pending
        indicator.textContent = state.pending
          ? '正在读取…'
          : state.snapshot
            ? state.stale
              ? '快照已过期'
              : '只读快照'
            : '无可用快照'
        content.setAttribute('aria-busy', String(state.pending))
        renderPage(content, state, current)
      },
      clock
    )
    if (document.visibilityState === 'hidden') {
      reader.visible(false)
      renderPage(content, reader.state(), current)
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

  /** 哈希导航、后退与分页都先清理旧路由资源，再获取新目标。 */
  function navigate(): void {
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
    reader.visible(document.visibilityState !== 'hidden')
  }

  /** BFCache 恢复时新建 reader，清除先前会话的所有状态。 */
  function show(event: PageTransitionEvent): void {
    if (event.persisted) {
      reader.dispose()
      route = parseRoute(location.hash)
      start()
    }
  }

  /** 页面离开时销毁在途请求及定时器，后退不会重复任何写入。 */
  function hide(): void {
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
    skip.removeEventListener('click', skipContent)
    refresh.removeEventListener('click', refreshPage)
    cancel.removeEventListener('click', cancelRead)
    window.removeEventListener('hashchange', navigate)
    document.removeEventListener('visibilitychange', visibility)
    window.removeEventListener('pageshow', show)
    window.removeEventListener('pagehide', hide)
    root.replaceChildren()
  }

  skip.addEventListener('click', skipContent)
  refresh.addEventListener('click', refreshPage)
  cancel.addEventListener('click', cancelRead)
  window.addEventListener('hashchange', navigate)
  document.addEventListener('visibilitychange', visibility)
  window.addEventListener('pageshow', show)
  window.addEventListener('pagehide', hide)
  start()
  return dispose
}
