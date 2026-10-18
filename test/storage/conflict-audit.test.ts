import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/store.js'
import type { StoreOptions } from '../../src/store.js'
import type { Row } from '../../src/storage/model.js'
import { completionReservation } from '../../src/storage/completion.js'
import { nativeBackend } from './native-backend.js'
import { management, responseFrame } from './helpers.js'
import { commitLuvusResponse } from '../../src/integration/persistence.js'

function fixture(overrides: StoreOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-conflict-audit-'))
  const path = join(root, 'db')
  const store = new Store(path, () => 100, { management, ...overrides })
  const native = nativeBackend(store)
  const inspect = new DatabaseSync(path, { readOnly: true })
  return {
    path,
    store,
    native,
    inspect,
    close() {
      inspect.close()
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}
function auditBytes(db: DatabaseSync) {
  return db
    .prepare('SELECT * FROM audit')
    .all()
    .reduce((total, row) => total + Buffer.byteLength(JSON.stringify(row)), 0)
}

test('real native same-anchor conflict persists one redacted audit and keeps the original result and dispatch count', () => {
  const f = fixture()
  try {
    const call = f.native.create()
    const binding = f.native.dispatch(call.call_id)
    f.native.respond(binding, { id: 'original', text: 'synthetic-first-secret' })
    const original = f.inspect.prepare('SELECT * FROM calls WHERE call_id=?').get(call.call_id)
    const before = f.inspect.prepare('SELECT COUNT(*) n FROM audit').get()!.n
    for (let i = 0; i < 8; i++) {
      assert.throws(
        () => f.native.respond(binding, { id: 'conflict', text: 'synthetic-conflict-secret-' + i }),
        /response_evidence_conflict/
      )
    }
    assert.equal(f.inspect.prepare('SELECT COUNT(*) n FROM audit').get()!.n, Number(before) + 1)
    const events = f.inspect.prepare("SELECT * FROM audit WHERE action='response_conflict'").all()
    assert.equal(events.length, 1)
    assert.equal(events[0]!.call_id, call.call_id)
    assert(!JSON.stringify(events).includes('synthetic-first-secret'))
    assert(!JSON.stringify(events).includes('synthetic-conflict-secret'))
    assert.deepEqual(f.inspect.prepare('SELECT * FROM calls WHERE call_id=?').get(call.call_id), original)
    assert.equal(f.native.state.sends, 1)
    assert.equal(f.store.health().mode, 'active')
    assert.equal(f.native.respond(binding, { id: 'original', text: 'synthetic-first-secret' }).state, 'responded')
  } finally {
    f.close()
  }
})

test('untrusted native source and invalid native ID are rejected without classifying them as trusted conflicts', () => {
  const f = fixture()
  try {
    const call = f.native.create()
    const binding = f.native.dispatch(call.call_id)
    f.native.respond(binding)
    f.native.state.sourceVerified = false
    assert.throws(() => f.native.respond(binding, { id: 'different' }), /native_source_untrusted/)
    f.native.state.sourceVerified = true
    assert.throws(
      () =>
        commitLuvusResponse(
          f.store,
          f.native.adapter,
          responseFrame(binding, { id: 'wrong-native-id', result: { id: 'different' } })
        ),
      /native_id_mismatch/
    )
    assert.equal(f.inspect.prepare("SELECT COUNT(*) n FROM audit WHERE action='response_conflict'").get()!.n, 0)
    assert.equal(f.store.health().mode, 'active')
  } finally {
    f.close()
  }
})

test('conflict audit commit failure reports degraded, rolls back the audit, and preserves the durable original response', () => {
  let fail = false
  const f = fixture({
    fault: (point) => {
      if (fail && point === 'before_commit') {
        throw Error('synthetic-private-error')
      }
    }
  })
  try {
    const call = f.native.create()
    const binding = f.native.dispatch(call.call_id)
    f.native.respond(binding)
    const original = f.inspect.prepare('SELECT * FROM calls WHERE call_id=?').get(call.call_id)
    const before = f.inspect.prepare('SELECT COUNT(*) n FROM audit').get()!.n
    fail = true
    assert.throws(
      () => f.native.respond(binding, { id: 'different' }),
      (error) => error instanceof Error && error.message === 'storage_degraded'
    )
    assert.equal(f.inspect.prepare('SELECT COUNT(*) n FROM audit').get()!.n, before)
    assert.deepEqual(f.inspect.prepare('SELECT * FROM calls WHERE call_id=?').get(call.call_id), original)
    assert.equal(f.store.health().mode, 'storage_degraded')
    fail = false
    f.store.resumeStorage()
    assert.throws(() => f.native.respond(binding, { id: 'different' }), /response_evidence_conflict/)
    assert.equal(f.inspect.prepare("SELECT COUNT(*) n FROM audit WHERE action='response_conflict'").get()!.n, 1)
  } finally {
    f.close()
  }
})

test('conflict audit cannot borrow another attempt reservation; the protected attempt can still finish after recovery', () => {
  const f = fixture({ retention: { audit_bytes: 18_000 } })
  try {
    const original = f.native.create()
    const first = f.native.dispatch(original.call_id)
    f.native.respond(first)
    const pending = f.native.create()
    const second = f.native.dispatch(pending.call_id)
    const reservation = completionReservation(
      f.inspect.prepare('SELECT * FROM calls WHERE call_id=?').get(pending.call_id) as Row,
      f.store.limits,
      f.store.generation()
    )
    let index = 0
    while (f.store.limits.audit_bytes - auditBytes(f.inspect) - reservation.audit > 900) {
      f.store.register('filler-' + index++)
    }
    const before = f.inspect.prepare('SELECT COUNT(*) n FROM audit').get()!.n
    assert.throws(() => f.native.respond(first, { id: 'conflict' }), /storage_degraded/)
    assert.equal(f.inspect.prepare('SELECT COUNT(*) n FROM audit').get()!.n, before)
    assert.equal(f.inspect.prepare("SELECT COUNT(*) n FROM audit WHERE action='response_conflict'").get()!.n, 0)
    assert.equal(
      f.inspect.prepare('SELECT reserved FROM calls WHERE call_id=?').get(pending.call_id)!.reserved,
      f.store.limits.attempt_reserve_bytes
    )
    f.store.resumeStorage()
    f.store.accepted(second)
    f.store.stop('synthetic', pending.call_id)
    assert.equal(f.native.respond(second).state, 'responded')
    assert.equal(f.inspect.prepare('SELECT SUM(reserved) n FROM calls').get()!.n, 0)
    assert(auditBytes(f.inspect) <= f.store.limits.audit_bytes)
  } finally {
    f.close()
  }
})
