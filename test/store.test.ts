import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { authorize, canonical, validateRequest, validateTarget } from '../src/contracts.js'
import type { Target, Policy } from '../src/contracts.js'

function connected(store: Store, name = 'linux') {
  const m = store.register(name)
  const enrollment = store.issueEnrollment(m.machine_id)
  const device = store.redeem(enrollment)
  const epoch = store.connect(m.machine_id, device.credential)
  const target: Target = { machine_id: m.machine_id, profile: 'session', session: 'test' }
  return { ...device, epoch, target, enrollment }
}

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
  const s = new Store(':memory:')
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
  const s = new Store(':memory:')
  try {
    const d = connected(s)
    const request = { method: 'pane.read', params: { pane: 3, lines: 10 } }
    const call = s.createCall('alice', d.target, request, 'k')
    const again = s.createCall('alice', d.target, { params: { lines: 10, pane: 3 }, method: 'pane.read' }, 'k')
    assert.equal(again.call_id, call.call_id)
    assert.throws(() => s.createCall('alice', { ...d.target, session: 'other' }, request, 'k'), /request_key_conflict/)
    assert.notEqual(s.createCall('bob', d.target, request, 'k').call_id, call.call_id)
    assert.throws(() => s.call('bob', call.call_id), /call_not_found/)
    const attempt = s.dispatch('alice', call.call_id, d.epoch)
    const native = { id: 'native', error: { code: 'conflict', data: { revision: 14 } } }
    s.receive(d.machine_id, call.call_id, attempt, d.epoch, native)
    assert.deepEqual(JSON.parse(s.call('alice', call.call_id).response!), native)
    assert.throws(() => s.dispatch('alice', call.call_id, d.epoch), /dispatch_rejected/)
    s.revoke(d.machine_id)
    assert.throws(() => s.call('alice', call.call_id), /call_not_found/)
  } finally {
    s.close()
  }
})

test('two machines with pane 3 never accept each other responses; disconnect is unknown, no replay', () => {
  const s = new Store(':memory:')
  try {
    const a = connected(s, 'a'),
      b = connected(s, 'b')
    const req = { method: 'pane.read', params: { pane: 3 } }
    const c = s.createCall('alice', a.target, req, 'k')
    const unsent = s.createCall('alice', a.target, req)
    const attempt = s.dispatch('alice', c.call_id, a.epoch)
    assert.throws(() => s.receive(b.machine_id, c.call_id, attempt, b.epoch, {}), /stale_response/)
    s.disconnect(a.machine_id, a.epoch)
    assert.equal(s.call('alice', c.call_id).state, 'outcome_unknown')
    assert.equal(s.call('alice', unsent.call_id).state, 'not_dispatched')
    const next = s.connect(a.machine_id, a.credential)
    assert.throws(() => s.receive(a.machine_id, c.call_id, attempt, a.epoch, {}), /stale_response/)
    assert.throws(() => s.dispatch('alice', c.call_id, next), /dispatch_rejected/)
    assert.throws(() => s.dispatch('alice', unsent.call_id, next), /dispatch_rejected/)
    assert.equal(s.createCall('alice', a.target, req, 'k').state, 'outcome_unknown')
    s.disconnect(a.machine_id, next)
    assert.throws(() => s.createCall('alice', a.target, req), /machine_offline/)
  } finally {
    s.close()
  }
})

test('disk recovery marks offline, never replays, excludes plaintext secrets, enforces writer lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'luvus-mcp-'))
  const path = join(dir, 'state.sqlite')
  let s = new Store(path)
  try {
    const d = connected(s)
    const req = { method: 'pane.read' }
    const pending = s.createCall('alice', d.target, req)
    const sent = s.createCall('alice', d.target, req)
    s.dispatch('alice', sent.call_id, d.epoch)
    assert.throws(() => new Store(path), /EEXIST/)
    assert.equal(statSync(path).mode & 0o777, 0o600)
    s.close()
    const bytes = readFileSync(path)
    assert.equal(bytes.includes(Buffer.from(d.credential)), false)
    assert.equal(bytes.includes(Buffer.from(d.enrollment)), false)
    s = new Store(path)
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
