/** 内置页面的默认浏览器入口：共享管理读取未接线时仅显示不可用壳，不导入 fixture。 */
import { mountWebUi } from './page.js'

const root = document.getElementById('rovloom-management')
if (root) {
  mountWebUi(root)
}
