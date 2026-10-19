/** 仅保存语言与主题两项本地偏好；不读取或持久化身份、token、快照及其它应用存储。 */
import type { UiLanguage } from './i18n.js'

export type UiTheme = 'light' | 'dark'
export type LanguageChoice = UiLanguage | 'system'
export type ThemeChoice = UiTheme | 'system'
export const LANGUAGE_KEY = 'rovloom.webui.language'
export const THEME_KEY = 'rovloom.webui.theme'
export type PreferenceKey = typeof LANGUAGE_KEY | typeof THEME_KEY
export interface PreferenceHost {
  /** 返回浏览器按优先级排列的语言，仅用于选择展示词典。 */
  languages(): readonly string[]
  /** 查询当前系统主题，不影响任何管理读取。 */
  dark(): boolean
  /** 仅读取上述两项偏好，异常由控制器安全回退。 */
  read(key: PreferenceKey): string | null
  /** 只保存已验证的固定枚举值，存储失败时仍保留当前页选择。 */
  write(key: PreferenceKey, value: LanguageChoice | ThemeChoice): void
  /** 订阅浏览器语言与系统主题变化，返回清理方法。 */
  subscribe(changed: () => void): () => void
}
export type UiPreferences = Readonly<{
  languageChoice: LanguageChoice
  themeChoice: ThemeChoice
  language: UiLanguage
  theme: UiTheme
}>

/** 优先使用浏览器支持的中/英文语言；其它语言回退 English，不推测用户身份。 */
export function browserLanguage(languages: readonly string[]): UiLanguage {
  for (const language of languages) {
    if (/^zh(?:-|$)/iu.test(language)) {
      return 'zh-CN'
    }
    if (/^en(?:-|$)/iu.test(language)) {
      return 'en'
    }
  }
  return 'en'
}

/** 验证语言偏好；存储内任意其它内容都不能进入 DOM 或配置。 */
function languageChoice(value: unknown): LanguageChoice {
  return value === 'zh-CN' || value === 'en' ? value : 'system'
}

/** 验证主题偏好，默认跟随系统且不把未知值写到 class/style。 */
function themeChoice(value: unknown): ThemeChoice {
  return value === 'light' || value === 'dark' ? value : 'system'
}

const browserHost: PreferenceHost = {
  /** 查询浏览器语言，缺省时由纯解析器选择 English。 */
  languages: () => (navigator.languages?.length ? navigator.languages : [navigator.language]),
  /** 主题查询不可用时保持可读浅色，不阻断页面。 */
  dark: () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches,
  /** localStorage getter/getItem 均可能因隐私策略抛错，统一在调用边界捕获。 */
  read: (key) => window.localStorage.getItem(key),
  /** 不写 sessionStorage 或任何管理数据，只持久化固定偏好值。 */
  write: (key, value) => window.localStorage.setItem(key, value),
  /** 保持系统主题和浏览器语言的动态默认值，并支持完整卸载。 */
  subscribe: (changed) => {
    const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null
    window.addEventListener('languagechange', changed)
    media?.addEventListener('change', changed)
    return /* 页面卸载后不再接收语言或主题变化。 */ () => {
      window.removeEventListener('languagechange', changed)
      media?.removeEventListener('change', changed)
    }
  }
}

/** 持有非敏感偏好与系统观察；只在有效展示状态变化时通知，不触发读取或导航。 */
export function createUiPreferences(changed: (state: UiPreferences) => void, host: PreferenceHost = browserHost) {
  /** 存储缺失、非法或被禁用都只影响偏好，不影响设备查看和授权。 */
  function read(key: PreferenceKey): string | null {
    try {
      return host.read(key)
    } catch {
      return null
    }
  }
  let language = languageChoice(read(LANGUAGE_KEY))
  let theme = themeChoice(read(THEME_KEY))
  let disposed = false

  /** 每次按当前系统偏好解析默认值，保留手动选择，不读浏览器墙钟。 */
  function resolve(): UiPreferences {
    return Object.freeze({
      languageChoice: language,
      themeChoice: theme,
      language: language === 'system' ? browserLanguage(host.languages()) : language,
      theme: theme === 'system' ? (host.dark() ? 'dark' : 'light') : theme
    })
  }
  let state = resolve()

  /** 状态相同不重新渲染，手动主题不会被系统事件覆盖。 */
  function sync(): void {
    if (disposed) {
      return
    }
    const next = resolve()
    if (
      next.languageChoice !== state.languageChoice ||
      next.themeChoice !== state.themeChoice ||
      next.language !== state.language ||
      next.theme !== state.theme
    ) {
      state = next
      changed(state)
    }
  }
  const unsubscribe = host.subscribe(sync)

  /** 保存失败不撤回本页选择，不重试或写其它存储。 */
  function save(key: PreferenceKey, value: LanguageChoice | ThemeChoice): void {
    try {
      host.write(key, value)
    } catch {
      /* 浏览器隐私/配额限制只使偏好在下次加载时回到默认。 */
    }
  }
  return {
    /** 返回不可变展示设置，不包含后台上下文。 */
    state: () => state,
    /** 非法控件值不改变已选语言，也不写入存储。 */
    setLanguage(value: string): void {
      if (disposed || !['system', 'zh-CN', 'en'].includes(value)) {
        return
      }
      language = languageChoice(value)
      save(LANGUAGE_KEY, language)
      sync()
    },
    /** 非法控件值不进入主题属性或存储。 */
    setTheme(value: string): void {
      if (disposed || !['system', 'light', 'dark'].includes(value)) {
        return
      }
      theme = themeChoice(value)
      save(THEME_KEY, theme)
      sync()
    },
    sync,
    /** 幂等取消系统观察，不改写偏好或其它浏览器内容。 */
    dispose(): void {
      if (!disposed) {
        disposed = true
        unsubscribe()
      }
    }
  }
}
