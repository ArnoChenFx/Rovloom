import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonical } from '../src/contracts.js'
import type { Policy, Target } from '../src/contracts.js'
import { Store } from '../src/store.js'
import { Router } from '../src/router.js'

test('bounded canonical JSON rejects cycles, sparse arrays, getters, excessive depth and size', () => {
  const cycle: unknown[] = []
  cycle.push(cycle)
  // Intentionally sparse to exercise rejection of array holes.
  // oxlint-disable-next-line unicorn/no-new-array
  const sparse = new Array(2)
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
  for (let i = 0; i < 66; i++) deep = { deep }
  assert.throws(() => canonical(deep), /json_limit/)
  const shared = { a: 1 }
  assert.equal(canonical([shared, shared]), '[{"a":1},{"a":1}]')
})

test('router reauthorizes reads, dispatch and cancellation against both current policies', () => {
  const s = new Store(':memory:')
  try {
    const m = s.register('router')
    const d = s.redeem(s.issueEnrollment(m.machine_id))
    const epoch = s.connect(m.machine_id, d.credential)
    const policy: Policy = {
      machines: [m.machine_id],
      sessions: ['explicit'],
      methods: ['pane.read'],
      host: false
    }
    let local = policy
    const router = new Router(s, () => local)
    const principal = { id: 'alice', policy }
    const target: Target = { machine_id: m.machine_id, profile: 'session', session: 'explicit' }
    const call = router.create(principal, target, { method: 'pane.read' })
    assert.deepEqual(JSON.parse(call.target_json!), target)
    assert.equal(call.method, 'pane.read')
    assert.throws(() => router.create(principal, target, { method: 'pane.run' }), /forbidden/)
    local = { ...policy, methods: [] }
    assert.throws(() => router.get(principal, call.call_id), /forbidden/)
    assert.throws(() => router.dispatch(principal, call.call_id, epoch), /forbidden/)
    assert.throws(() => router.cancel(principal, call.call_id), /forbidden/)
    local = policy
    assert.equal(router.cancel(principal, call.call_id).state, 'not_dispatched')
    assert.throws(() => router.get({ ...principal, id: 'bob' }, call.call_id), /call_not_found/)
  } finally {
    s.close()
  }
})

test('acceptance fencing, deadlines and cancellation never report native rollback', () => {
  let now = 0
  const s = new Store(':memory:', () => now)
  try {
    const m = s.register('deadline')
    const d = s.redeem(s.issueEnrollment(m.machine_id))
    const epoch = s.connect(m.machine_id, d.credential)
    const target: Target = { machine_id: m.machine_id, profile: 'host' }
    const pending = s.createCall('p', target, { method: 'host.capabilities' }, undefined, 10)
    const sent = s.createCall('p', target, { method: 'host.capabilities' }, undefined, 10)
    const attempt = s.dispatch('p', sent.call_id, epoch)
    assert.throws(() => s.accepted(m.machine_id, sent.call_id, 'wrong', epoch), /stale_acceptance/)
    s.accepted(m.machine_id, sent.call_id, attempt, epoch)
    assert.equal(s.call('p', sent.call_id).state, 'connector_accepted')
    now = 10
    assert.throws(() => s.dispatch('p', pending.call_id, epoch), /dispatch_rejected/)
    s.expire()
    assert.equal(s.call('p', pending.call_id).state, 'not_dispatched')
    assert.equal(s.call('p', sent.call_id).state, 'outcome_unknown')
    assert.throws(() => s.receive(m.machine_id, sent.call_id, attempt, epoch, {}), /stale_response/)
    const cancel = s.createCall('p', target, { method: 'host.capabilities' })
    s.dispatch('p', cancel.call_id, epoch)
    assert.equal(s.stop('p', cancel.call_id).state, 'outcome_unknown')
  } finally {
    s.close()
  }
})

test('unknown database version is rejected before schema mutation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'luvus-version-'))
  const path = join(dir, 'db')
  try {
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE metadata(version INTEGER); INSERT INTO metadata VALUES (999)')
    db.close()
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
