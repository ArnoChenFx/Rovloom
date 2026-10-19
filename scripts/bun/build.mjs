/** 构建 Bun 模块与内置管理页静态资源，清除旧输出；不启动 Gateway/Connector 或注入测试数据。 */
import { copyFileSync, rmSync } from 'node:fs'
import { toolchain } from './toolchain.mjs'

toolchain()
rmSync(new URL('../../dist/', import.meta.url), { recursive: true, force: true })
const result = await Bun.build({
  entrypoints: [
    'src/contracts.ts',
    'src/store.ts',
    'src/router.ts',
    'src/protocol.ts',
    'src/native-contract/index.ts',
    'src/wire/index.ts',
    'src/integration/luvus-wire.ts',
    'src/integration/persistence.ts',
    'src/transport/index.ts',
    'src/connector/herdr/readonly.ts',
    'src/webui/index.ts',
    'src/admin/index.ts'
  ],
  outdir: 'dist/src',
  root: 'src',
  target: 'bun',
  format: 'esm',
  packages: 'external',
  splitting: true,
  sourcemap: 'external'
})
if (!result.success) {
  throw new AggregateError(result.logs, 'Bun build failed')
}
const browser = await Bun.build({
  entrypoints: ['src/webui/browser.ts', 'src/webui/index.ts'],
  root: 'src/webui',
  outdir: 'dist/webui',
  target: 'browser',
  format: 'esm',
  splitting: true,
  sourcemap: 'external'
})
if (!browser.success) {
  throw new AggregateError(browser.logs, 'Management UI build failed')
}
for (const asset of ['index.html', 'manage.css']) {
  copyFileSync(`src/webui/${asset}`, `dist/webui/${asset}`)
}
// 应用标与横版全名图各自保留受管原图；原字节和背景直接进入产物，不依赖文档站点。
for (const asset of ['rovloom-mark-orange.png', 'rovloom-logo.png']) {
  copyFileSync(`docs/assets/brand/${asset}`, `dist/webui/${asset}`)
}
console.log(
  `Built ${result.outputs.length} Bun ESM files/maps and ${browser.outputs.length} browser files/maps; management listener requires host service and trusted session adapter`
)
