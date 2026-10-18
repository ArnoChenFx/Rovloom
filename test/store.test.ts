import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { authorize, canonical, validateRequest, validateTarget } from '../src/contracts.js'
import type { Target, Policy } from '../src/contracts.js'
import { connected, management, options, respond } from './storage/helpers.js'

test('normalized names remain unique; rename preserves ID; IDs are not reused', () => {
  const s = new Store(':memory:')
  try {
    const m = s.register(' Linux ')
    assert.equal(m.name, 'linux')
    assert.throws(() => s.register('LINUX'))
    assert.equal(s.rename(m.machine_id, 'mac').machine_id, m.machine_id)
    assert.notEqual(s.register('linux').machine_id, m.machine_id)
    assert.throws(() => s.register('../escape'), /invalid_name/)
  } finally {
    s.close()
  }
})
test('enrollment expiration, one-time consumption and sibling-token invalidation', () => {
  let time = 100
  const s = new Store(':memory:', () => time)
  try {
    const m = s.register('a')
    const expired = s.issueEnrollment(m.machine_id, 1)
    time++
    assert.throws(() => s.redeem(expired), /invalid_enrollment/)
    const first = s.issueEnrollment(m.machine_id)
    const sibling = s.issueEnrollment(m.machine_id)
    s.redeem(first)
    assert.throws(() => s.redeem(first), /invalid_enrollment/)
    assert.throws(() => s.redeem(sibling), /invalid_enrollment/)
    assert.throws(() => s.issueEnrollment(m.machine_id), /invalid_machine_state/)
  } finally {
    s.close()
  }
})
test('identity authenticates credentials, rejects clones, fences old disconnect', () => {
  const s = new Store(':memory:', Date.now, { management })
  try {
    const d = connected(s)
    assert.throws(() => s.connect(d.machine_id, 'wrong'), /invalid_device_credential/)
    assert.throws(() => s.connect(d.machine_id, d.credential), /duplicate_device_connection/)
    s.disconnect(d.machine_id, d.epoch)
    const next = s.connect(d.machine_id, d.credential)
    assert.notEqual(next, d.epoch)
    s.disconnect(d.machine_id, d.epoch)
    assert.equal(s.machine(d.machine_id).status, 'online')
    s.revoke(d.machine_id)
    assert.throws(() => s.connect(d.machine_id, d.credential), /invalid_device_credential/)
  } finally {
    s.close()
  }
})
test('idempotency binds principal, entire target and canonical request; errors are preserved', () => {
  const s = new Store(':memory:', () => 100, { management })
  try {
    const d = connected(s)
    const scope = s.openHistory('alice', d.target, 1)
    const o = options({ history: { history_epoch: scope.history_epoch, client_request_key: 'k' } })
    const request = { method: 'pane.read', params: { pane: 3, lines: 10 } }
    const c = s.createCall('alice', d.target, request, o)
    assert.equal(
      s.createCall('alice', d.target, { params: { lines: 10, pane: 3 }, method: 'pane.read' }, o).call_id,
      c.call_id
    )
    assert.throws(() => s.createCall('alice', { ...d.target, session: 'other' }, request, o), /request_key_conflict/)
    assert.throws(() => s.createCall('bob', d.target, request, o), /dedup_history_unavailable/)
    assert.throws(() => s.call('bob', c.call_id), /call_not_found/)
    const b = s.dispatch('alice', c.call_id, d.epoch)
    respond(s, b, { error: { code: 'conflict', message: 'synthetic', data: { revision: 14 } } }, 100)
    assert.equal(JSON.parse(s.call('alice', c.call_id).response!).error.data.revision, 14)
    assert.throws(() => s.dispatch('alice', c.call_id, d.epoch), /dispatch_rejected/)
    s.revoke(d.machine_id)
    assert.throws(() => s.call('alice', c.call_id), /call_not_found/)
  } finally {
    s.close()
  }
})
test('two machines with pane 3 never accept each other responses; disconnect is unknown, no replay', () => {
  const s = new Store(':memory:', () => 100, { management })
  try {
    const a = connected(s, 'a')
    const b = connected(s, 'b')
    const req = { method: 'pane.read', params: { pane: 3 } }
    const scope = s.openHistory('alice', a.target, 1)
    const o = options({ history: { history_epoch: scope.history_epoch, client_request_key: 'k' } })
    const c = s.createCall('alice', a.target, req, o)
    const unsent = s.createCall('alice', a.target, req, options())
    const anchor = s.dispatch('alice', c.call_id, a.epoch)
    assert.throws(() => s.responseAnchor({ ...anchor, machine_id: b.machine_id }), /binding_mismatch/)
    s.disconnect(a.machine_id, a.epoch)
    assert.equal(s.call('alice', c.call_id).state, 'outcome_unknown')
    assert.equal(s.call('alice', unsent.call_id).state, 'not_dispatched')
    const next = s.connect(a.machine_id, a.credential)
    assert.throws(() => respond(s, anchor, { result: {} }, 100), /stale_response/)
    assert.throws(() => s.dispatch('alice', c.call_id, next), /dispatch_rejected/)
    assert.throws(() => s.dispatch('alice', unsent.call_id, next), /dispatch_rejected/)
    assert.equal(s.createCall('alice', a.target, req, o).state, 'outcome_unknown')
    s.disconnect(a.machine_id, next)
    assert.throws(() => s.createCall('alice', a.target, req, options()), /machine_offline/)
  } finally {
    s.close()
  }
})
test('disk recovery marks offline, never replays, excludes plaintext secrets, enforces writer lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rovloom-store-'))
  const path = join(dir, 'state.sqlite')
  let s = new Store(path, () => 100, { management })
  try {
    const d = connected(s)
    const pending = s.createCall('alice', d.target, { method: 'ping' }, options())
    const sent = s.createCall('alice', d.target, { method: 'ping' }, options())
    s.dispatch('alice', sent.call_id, d.epoch)
    assert.throws(() => new Store(path), /EEXIST/)
    assert.equal(statSync(path).mode & 0o777, 0o600)
    s.close()
    const bytes = readFileSync(path)
    assert(!bytes.includes(Buffer.from(d.credential)))
    assert(!bytes.includes(Buffer.from(d.enrollment)))
    s = new Store(path, () => 100, { management })
    assert.equal(s.machine(d.machine_id).status, 'offline')
    assert.equal(s.call('alice', pending.call_id).state, 'not_dispatched')
    assert.equal(s.call('alice', sent.call_id).state, 'outcome_unknown')
    s.connect(d.machine_id, d.credential)
  } finally {
    s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('explicit targets, JSON and reserved fields fail closed', () => {
  assert.throws(() => validateTarget({ machine_id: 'm', profile: 'session' } as Target), /session_required/)
  assert.throws(
    () => validateTarget({ machine_id: 'm', profile: 'host', session: 'x' } as unknown as Target),
    /invalid_profile/
  )
  assert.throws(() => validateRequest({ method: 'x', auth: 'secret' }), /reserved_request_field/)
  assert.throws(() => validateRequest({ method: 'x', id: 'caller' }), /reserved_request_field/)
  assert.throws(() => canonical({ value: NaN }), /invalid_json/)
  assert.throws(() => canonical({ value: undefined }), /invalid_json/)
})
test('caller and local policies intersect; unknown methods and Host default to deny', () => {
  // Native 层仍显式投影旧 profile Target，provider 隔离由 Router/Wire 独立校验。
  const target: Target = { machine_id: 'm', profile: 'session', session: 'test' }
  const allow: Policy = {
    machines: ['m'],
    sessions: ['test'],
    methods: ['pane.read'],
    host: false
  }
  authorize(target, 'pane.read', allow, allow)
  assert.throws(() => authorize(target, 'pane.run', allow, allow), /forbidden/)
  assert.throws(() => authorize(target, 'pane.read', allow, { ...allow, methods: [] }), /forbidden/)
  assert.throws(() => authorize({ machine_id: 'm', profile: 'host' }, 'pane.read', allow, allow), /forbidden/)
})
