// 源码集成测试自行构建真实管理页，不依赖本机残留 dist 或其它测试的执行顺序。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export function buildManagementAssets(): void {
  const result = spawnSync(
    process.execPath,
    ['--no-env-file', '-e', "import { buildWebui } from './scripts/bun/webui.mjs'; await buildWebui('dist/webui')"],
    { cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8' }
  )
  assert.equal(result.status, 0, result.stderr || 'management assets build failed')
}
