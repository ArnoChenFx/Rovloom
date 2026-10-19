/** 单文件设施探针，验证 Worker、资源和 SQLite；不是替代产品 CLI 或管理 HTTP 服务。 */
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { loadEmbeddedManagementAssets } from 'rovloom:management-assets'

const worker = new Worker(new URL('./probe-worker.mjs', import.meta.url))
let helper
try {
  helper = await new Promise(
    /* 只接受编译进同一 executable 的 Worker 回复，任何加载失败直接失败。 */ (resolve, reject) => {
      worker.onmessage = /* 交付受控 helper 标记。 */ (event) => resolve(event.data)
      worker.onerror = /* 让 Worker 缺包或初始化错误传播到进程。 */ (event) => reject(new Error(event.message))
      worker.postMessage(null)
    }
  )
} finally {
  await worker.terminate()
}
assert.equal(helper, 'embedded-worker-helper')
const assets = []
for (const [path, bytes] of loadEmbeddedManagementAssets()) {
  assets.push({ path, sha256: createHash('sha256').update(bytes).digest('hex') })
}
const db = new DatabaseSync(':memory:')
try {
  assert.equal(db.prepare('SELECT 42 AS answer').get().answer, 42)
} finally {
  db.close()
}
console.log(JSON.stringify({ scope: 'packaging-probe', helper, assets, sqlite: 'pass' }))
