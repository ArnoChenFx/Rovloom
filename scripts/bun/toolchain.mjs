// 核验 Bun 满足 package.json 声明的最低版本，并报告运行时、SQLite 和 TypeScript 版本。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

// 比较点分数字版本，忽略预发布后缀。
function atLeast(actual, minimum) {
  const a = actual.split('-')[0].split('.').map(Number)
  const m = minimum.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (m[i] ?? 0)) {
      return (a[i] ?? 0) > (m[i] ?? 0)
    }
  }
  return true
}

// 检查运行时不低于声明的最低版本，读取版本信息并始终关闭临时数据库。
export function toolchain() {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url)))
  const minimum = pkg.engines.bun.replace(/^>=/, '')
  assert(atLeast(process.versions.bun, minimum), `Bun ${minimum} or newer is required`)
  const db = new DatabaseSync(':memory:')
  try {
    return {
      runtime: 'Bun',
      version: process.versions.bun,
      revision: Bun.revision,
      execPath: process.execPath,
      nodeCompatibilityVersion: process.version,
      sqlite: db.prepare('SELECT sqlite_version() AS version').get().version,
      typescript: JSON.parse(readFileSync(new URL('../../node_modules/typescript/package.json', import.meta.url)))
        .version
    }
  } finally {
    db.close()
  }
}

if (import.meta.main) {
  console.log(JSON.stringify(toolchain(), null, 2))
}
