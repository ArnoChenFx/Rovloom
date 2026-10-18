import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { lockedDependencies } from './lock.mjs'

const baselineBytes = readFileSync(process.argv[2])
const baseline = JSON.parse(baselineBytes)
const current = lockedDependencies()
const removed = [],
  retained = []
for (const [path, value] of Object.entries(baseline.packages)) {
  if (!path) continue
  const key = path.replaceAll('node_modules/', '')
  if (!current[key]) {
    assert(
      key === 'tsx' || key === 'esbuild' || key === 'fsevents' || key.startsWith('@esbuild/'),
      `unexpected removal: ${key}`
    )
    removed.push({ package: key, version: value.version, integrity: value.integrity })
    continue
  }
  assert.deepEqual(current[key], { version: value.version, integrity: value.integrity }, `${key} changed`)
  retained.push({ package: key, ...current[key] })
}
assert.equal(retained.length, Object.keys(current).length, 'new dependency introduced')
const report = {
  baseline: '4f963d1997751a4f392604cc060d0a99f157998a:package-lock.json',
  baselineSha256: createHash('sha256').update(baselineBytes).digest('hex'),
  retainedCount: retained.length,
  removedCount: removed.length,
  addedCount: 0,
  changedVersionOrIntegrityCount: 0,
  retained,
  removed
}
if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ retained: retained.length, removed: removed.length, added: 0, changed: 0 }))
