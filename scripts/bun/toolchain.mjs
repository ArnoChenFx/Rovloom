import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

export function toolchain() {
  assert.equal(process.versions.bun, '1.4.3', 'Use the exact Bun version in .bun-version')
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url)))
  assert.equal(pkg.packageManager, 'bun@1.4.3')
  assert.equal(readFileSync(new URL('../../.bun-version', import.meta.url), 'utf8').trim(), '1.4.3')
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
