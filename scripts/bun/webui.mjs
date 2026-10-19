/** 复用同一浏览器构建与品牌原图清单，供模块产物及单文件发行共同调用。 */
import { copyFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

/** 将管理页构建到显式目录；不启动 HTTP、不注入测试身份或业务数据。 */
export async function buildWebui(directory) {
  mkdirSync(directory, { recursive: true })
  const browser = await Bun.build({
    entrypoints: ['src/webui/browser.ts', 'src/webui/index.ts'],
    root: 'src/webui',
    outdir: directory,
    target: 'browser',
    format: 'esm',
    splitting: true,
    sourcemap: 'external'
  })
  if (!browser.success) {
    throw new AggregateError(browser.logs, 'Management UI build failed')
  }
  for (const asset of ['index.html', 'manage.css']) {
    copyFileSync(`src/webui/${asset}`, resolve(directory, asset))
  }
  for (const asset of ['rovloom-mark-orange.png', 'rovloom-logo.png']) {
    copyFileSync(`docs/assets/brand/${asset}`, resolve(directory, asset))
  }
  return browser.outputs.length
}
