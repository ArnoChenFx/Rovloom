import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../src/store.js'
import { Router } from '../src/router.js'
import { connected, management, options, policy, respond } from './storage/helpers.js'

test('results enforce ownership, policy, quota, TTL and byte-perfect pagination', () => {
  let now = 100
  const s = new Store(':memory:', () => now, { management })
  try {
    const d = connected(s)
    let local = policy(d.target, true)
    const router = new Router(s, () => local)
    const p = { id: 'alice', policy: policy(d.target) }
    const c = router.create(p, d.target, { method: 'pane.read' }, options())
    assert.throws(() => router.saveResult(p, c.call_id), /result_not_ready/)
    const binding = router.dispatch(p, c.call_id, d.epoch)
    respond(s, binding, { result: { text: '你好'.repeat(100) } }, now)
    assert.throws(() => s.saveResult(p.id, c.call_id, 100, 1), /result_quota/)
    const meta = s.saveResult(p.id, c.call_id, 100)
    const chunks: Buffer[] = []
    let cursor = 0
    while (true) {
      const page = router.readResult(p, meta.result_id, cursor, 7)
      chunks.push(Buffer.from(page.data, 'base64'))
      cursor = page.next_cursor
      if (page.eof) {
        break
      }
    }
    assert.equal(JSON.parse(Buffer.concat(chunks).toString()).result.text, '你好'.repeat(100))
    assert.throws(() => router.readResult({ ...p, id: 'bob' }, meta.result_id), /call_not_found/)
    assert.throws(() => router.readResult(p, meta.result_id, -1), /invalid_result_cursor/)
    local = { ...local, grants: [] }
    assert.throws(() => router.readResult(p, meta.result_id), /forbidden/)
    local = policy(d.target, true)
    now = 200
    assert.throws(() => router.readResult(p, meta.result_id), /result_not_found/)
    const next = router.saveResult(p, c.call_id)
    s.revoke(d.machine_id)
    assert.throws(() => router.readResult(p, next.result_id), /result_not_found/)
  } finally {
    s.close()
  }
})
test('unreleased v1 v2 v3 schemas are rejected without migration or source mutation', () => {
  for (const version of [1, 2, 3]) {
    const dir = mkdtempSync(join(tmpdir(), 'rovloom-legacy-'))
    const path = join(dir, 'db')
    try {
      const db = new DatabaseSync(path)
      db.exec(
        `CREATE TABLE metadata(version INTEGER); INSERT INTO metadata VALUES(${version}); CREATE TABLE calls(response TEXT); INSERT INTO calls VALUES('synthetic-secret')`
      )
      db.close()
      chmodSync(path, 0o600)
      const before = readFileSync(path)
      assert.throws(() => new Store(path), /unsupported_database_version/)
      assert.deepEqual(readFileSync(path), before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})
