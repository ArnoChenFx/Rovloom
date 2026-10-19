/** 为 Herdr 测试复用显式 harness 根或源码 checkout 父目录，保持生产路径权限检查。 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectHerdrPath } from '../../../src/connector/herdr/local.js'

/** 创建自有 0700 测试目录；显式根不可信时直接失败，不搜索其它路径或放宽祖先检查。 */
export function privateHerdrTestRoot(prefix: string): string {
  const parent = process.env.LUVUS_TEST_ROOT ?? fileURLToPath(new URL('../../../../', import.meta.url))
  const root = mkdtempSync(join(parent, prefix))
  try {
    inspectHerdrPath(root, 'directory')
    return root
  } catch (cause) {
    rmSync(root, { recursive: true, force: true })
    throw cause
  }
}
