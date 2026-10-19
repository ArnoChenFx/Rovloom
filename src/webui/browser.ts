/** 内置页面只请求同源管理读取；宿主未接线时明确不可用，不导入 fixture 或自报身份。 */
import { mountWebUi } from './page.js'
import { createManagementPageRead } from './read.js'
import { createManagementHttpRead } from './http-client.js'

const root = document.getElementById('rovloom-management')
if (root) {
  mountWebUi(root, createManagementPageRead(createManagementHttpRead()))
}
