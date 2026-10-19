/** 创建仅影响展示偏好的图标选择器；固定 SVG 不加载外部资源，也不接触管理身份或读取状态。 */
import type { Localizer, MessageKey } from './i18n.js'

const paths = {
  language: 'M2 5h12M7 2h1M12 5c-1 6-4 9-8 11M5 8c2 4 4 6 7 8M13 22l5-11 5 11M15 18h6',
  system: 'M3 4h18v12H3zM8 21h8M12 16v5',
  light:
    'M16 12a4 4 0 1 0-8 0 4 4 0 0 0 8 0M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5',
  dark: 'M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z'
}

/** 生成固定线条图标，辅助技术只读取按钮名称与当前选择。 */
function icon(name: keyof typeof paths): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.7')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', paths[name])
  svg.append(path)
  return svg
}

/** 创建可键盘展开、选择和关闭的图标按钮；调用方负责保存已有偏好枚举。 */
export function createPreferenceControl(
  kind: 'language' | 'theme',
  choices: ReadonlyArray<readonly [string, MessageKey]>,
  onChoose: (value: string) => void
) {
  const root = document.createElement('div')
  root.className = 'preference'
  root.dataset.preference = kind
  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.className = 'preference-trigger'
  trigger.setAttribute('aria-expanded', 'false')
  const current = document.createElement('span')
  current.className = 'visually-hidden'
  current.id = `rovloom-${kind}-current`
  trigger.setAttribute('aria-describedby', current.id)
  const panel = document.createElement('div')
  panel.className = 'preference-panel'
  panel.id = `rovloom-${kind}-choices`
  panel.hidden = true
  panel.setAttribute('role', 'group')
  trigger.setAttribute('aria-controls', panel.id)
  const buttons = choices.map(
    /** 固定选项使用真实按钮，支持触屏和原生 Tab 顺序。 */ ([value]) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.choice = value
      panel.append(button)
      return button
    }
  )
  root.append(trigger, current, panel)

  /** 收起选项；显式取消和完成选择时将焦点交回稳定图标按钮。 */
  function close(restoreFocus = false): void {
    panel.hidden = true
    trigger.setAttribute('aria-expanded', 'false')
    if (restoreFocus) {
      trigger.focus()
    }
  }

  /** 鼠标和键盘激活共享一个选择路径，重复打开不产生后台请求。 */
  function click(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target.closest('button') : null
    if (target === trigger) {
      panel.hidden = !panel.hidden
      trigger.setAttribute('aria-expanded', String(!panel.hidden))
    } else if (target instanceof HTMLButtonElement && buttons.includes(target)) {
      onChoose(target.dataset.choice!)
      close(true)
    }
  }

  /** 按方向键打开或移动选项；Esc 在展开期间关闭并恢复入口焦点。 */
  function keydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && !panel.hidden) {
      event.preventDefault()
      close(true)
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      return
    }
    event.preventDefault()
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End' || (index < 0 && event.key === 'ArrowUp')
          ? buttons.length - 1
          : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
    panel.hidden = false
    trigger.setAttribute('aria-expanded', 'true')
    buttons[next]!.focus()
  }

  /** 点击或移动焦点到外部即收起，避免遮挡内容或留下多个展开选择器。 */
  function outside(event: Event): void {
    if (event.target instanceof Node && !root.contains(event.target)) {
      close()
    }
  }

  /** 更新翻译、当前状态和主题图标，不替换按钮或改变其键盘焦点。 */
  function update(i18n: Localizer, value: string): void {
    const label = i18n.t(kind === 'language' ? 'language.label' : 'theme.label')
    trigger.setAttribute('aria-label', label)
    panel.setAttribute('aria-label', label)
    for (let index = 0; index < buttons.length; index++) {
      const [choice, key] = choices[index]!
      const button = buttons[index]!
      button.textContent = i18n.t(key)
      button.setAttribute('aria-pressed', String(choice === value))
      if (choice === value) {
        current.textContent = i18n.t(key)
      }
    }
    trigger.title = `${label}: ${current.textContent}`
    trigger.replaceChildren(
      icon(kind === 'language' ? 'language' : value === 'dark' ? 'dark' : value === 'light' ? 'light' : 'system')
    )
  }

  /** 卸载时移除外部监听器，销毁后不会再响应键盘或影响其它页面。 */
  function dispose(): void {
    root.removeEventListener('click', click)
    root.removeEventListener('keydown', keydown)
    document.removeEventListener('pointerdown', outside)
    document.removeEventListener('focusin', outside)
    close()
  }
  root.addEventListener('click', click)
  root.addEventListener('keydown', keydown)
  document.addEventListener('pointerdown', outside)
  document.addEventListener('focusin', outside)
  return { root, update, close, dispose }
}
