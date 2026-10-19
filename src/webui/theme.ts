/** CSS前同步恢复固定主题偏好；不挂载页面、读取身份、订阅事件或请求管理API。 */
import { THEME_KEY, themeChoice } from './preferences.js'

let saved: string | null = null
try {
  saved = window.localStorage.getItem(THEME_KEY)
} catch {
  /* 存储不可用时仍在首次绘制前跟随系统。 */
}
const theme = themeChoice(saved)
// 未手选时保留CSS的动态系统默认值，主模块延迟期间也能响应系统主题变化。
if (theme !== 'system') {
  document.documentElement.dataset.theme = theme
}
