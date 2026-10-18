import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonical } from '../src/contracts.js'
import { Store } from '../src/store.js'
import { Router } from '../src/router.js'
import { connected, management, options, policy } from './storage/helpers.js'

test('bounded canonical JSON rejects cycles, sparse arrays, getters, excessive depth and size', () => {
  const cycle: unknown[] = []
  cycle.push(cycle)
  const sparse = Array.from({ length: 2 })
  delete sparse[0]
  for (const value of [
    cycle,
    sparse,
    {
      get secret() {
        throw Error('getter executed')
      }
    },
    'x'.repeat(1_048_577)
  ]) {
    assert.throws(() => canonical(value), /invalid_json|json_limit/)
  }
  let deep: unknown = null
  for (let i = 0; i < 66; i++) {
    deep = { deep }
  }
  assert.throws(() => canonical(deep), /json_limit/)
  const shared = { a: 1 }
  assert.equal(canonical([shared, shared]), '[{"a":1},{"a":1}]')
})
test('router reauthorizes reads, dispatch and cancellation against both current policies', () => {
  const s = new Store(':memory:', () => 100, { management })
  try {
    const d = connected(s)
    const caller = policy(d.target)
    let local = policy(d.target, true)
    const router = new Router(s, () => local)
    const principal = { id: 'alice', policy: caller }
    const c = router.create(principal, d.target, { method: 'pane.read' }, options())
    assert.deepEqual(JSON.parse(c.target_json), d.target)
    assert.equal(c.method, 'pane.read')
    assert.throws(() => router.create(principal, d.target, { method: 'pane.run' }, options()), /forbidden/)
    local = { ...local, grants: [] }
    assert.throws(() => router.get(principal, c.call_id), /forbidden/)
    assert.throws(() => router.dispatch(principal, c.call_id, d.epoch), /forbidden/)
    assert.throws(() => router.cancel(principal, c.call_id), /forbidden/)
    local = policy(d.target, true)
    assert.equal(router.cancel(principal, c.call_id).state, 'not_dispatched')
    assert.throws(() => router.get({ ...principal, id: 'bob' }, c.call_id), /call_not_found/)
  } finally {
    s.close()
  }
})
test('acceptance fencing, deadlines and cancellation never report native rollback', () => {
  let now = 100
  const s = new Store(':memory:', () => now, { management })
  try {
    const d = connected(s)
    const pending = s.createCall('alice', d.target, { method: 'ping' }, options({ timeoutMs: 10 }))
    const sent = s.createCall('alice', d.target, { method: 'ping' }, options({ timeoutMs: 10 }))
    const b = s.dispatch('alice', sent.call_id, d.epoch)
    assert.throws(() => s.accepted({ ...b, attempt_id: 'wrong' }), /binding_mismatch/)
    s.accepted(b)
    assert.equal(s.call('alice', sent.call_id).state, 'connector_accepted')
    now = 110
    assert.throws(() => s.dispatch('alice', pending.call_id, d.epoch), /dispatch_rejected/)
    s.expire()
    assert.equal(s.call('alice', pending.call_id).state, 'not_dispatched')
    assert.equal(s.call('alice', sent.call_id).state, 'outcome_unknown')
    const cancel = s.createCall('alice', d.target, { method: 'ping' }, options())
    s.dispatch('alice', cancel.call_id, d.epoch)
    assert.equal(s.stop('alice', cancel.call_id).state, 'outcome_unknown')
  } finally {
    s.close()
  }
})
test('unknown database version is rejected before schema mutation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rovloom-version-'))
  const path = join(dir, 'db')
  try {
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE metadata(version INTEGER); INSERT INTO metadata VALUES(999)')
    db.close()
    chmodSync(path, 0o600)
    assert.throws(() => new Store(path), /unsupported_database_version/)
    const check = new DatabaseSync(path)
    assert.deepEqual(
      check
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name),
      ['metadata']
    )
    check.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
