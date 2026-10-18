import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/store.js'
import type { StoreOptions } from '../../src/store.js'
import { nativeBackend } from './native-backend.js'
import { management } from './helpers.js'

function fixture(overrides: StoreOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-completion-budget-'))
  const path = join(root, 'db')
  const store = new Store(path, () => 100, { management, ...overrides })
  const native = nativeBackend(store)
  const inspect = new DatabaseSync(path, { readOnly: true })
  return {
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

for (const retention of [{ audit_bytes: 4500 }, { call_metadata_bytes: 2044 }]) {
  test(`real native dispatch protects completion subquota ${JSON.stringify(retention)}`, () => {
    const f = fixture({ retention })
    try {
      const call = f.native.create()
      assert.throws(() => f.native.dispatch(call.call_id), /storage_degraded/)
      assert.equal(f.native.state.sends, 0)
      const stored = f.inspect.prepare('SELECT state,reserved,attempt_id FROM calls WHERE call_id=?').get(call.call_id)!
      assert.equal(stored.state, 'created')
      assert.equal(stored.reserved, 0)
      assert.equal(stored.attempt_id, null)
    } finally {
      f.close()
    }
  })
}

for (const retention of [{ audit_bytes: 14_000 }, { call_metadata_bytes: 4100 }]) {
  test(`serialized competing dispatches cannot reuse subquota ${JSON.stringify(retention)}`, async () => {
    const f = fixture({ retention })
    try {
      const first = f.native.create()
      const second = f.native.create()
      const results = await Promise.allSettled(
        [first, second].map((call) => Promise.resolve().then(() => f.native.dispatch(call.call_id)))
      )
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
      assert.equal(f.native.state.sends, 1)
      assert.equal(
        f.inspect.prepare('SELECT SUM(reserved) n FROM calls').get()!.n,
        f.store.limits.attempt_reserve_bytes
      )
      assert.equal(f.inspect.prepare("SELECT COUNT(*) n FROM calls WHERE state='created'").get()!.n, 1)
      assert(auditBytes(f.inspect) <= f.store.limits.audit_bytes)
    } finally {
      f.close()
    }
  })
}
for (const retention of [{ audit_bytes: 18_000 }, { call_metadata_bytes: 4500 }]) {
  test(`accepted and terminal commits release only their own subquota ${JSON.stringify(retention)}`, () => {
    const f = fixture({ retention })
    try {
      const first = f.native.create()
      const second = f.native.create()
      const binding = f.native.dispatch(first.call_id)
      f.store.accepted(binding)
      f.store.stop('synthetic', first.call_id)
      assert.equal(f.native.respond(binding).state, 'responded')
      assert.equal(f.inspect.prepare('SELECT reserved FROM calls WHERE call_id=?').get(first.call_id)!.reserved, 0)
      const next = f.native.dispatch(second.call_id)
      assert.equal(f.native.respond(next).state, 'responded')
      assert.equal(f.native.state.sends, 2)
      assert.equal(f.inspect.prepare('SELECT SUM(reserved) n FROM calls').get()!.n, 0)
      assert(auditBytes(f.inspect) <= f.store.limits.audit_bytes)
    } finally {
      f.close()
    }
  })
}

test('failed evidence commit preserves both outstanding obligations and cannot free another dispatch slot', () => {
  let fail = false
  const f = fixture({
    fault: (point) => {
      if (fail && point === 'evidence_commit') {
        throw Error('synthetic write failure')
      }
    }
  })
  try {
    const first = f.native.create()
    const second = f.native.create()
    const a = f.native.dispatch(first.call_id)
    const b = f.native.dispatch(second.call_id)
    const before = f.inspect.prepare('SELECT call_id,state,reserved FROM calls ORDER BY call_id').all()
    const auditBefore = f.inspect.prepare('SELECT COUNT(*) n FROM audit').get()!.n
    fail = true
    assert.throws(() => f.native.respond(a), /storage_degraded/)
    assert.deepEqual(f.inspect.prepare('SELECT call_id,state,reserved FROM calls ORDER BY call_id').all(), before)
    assert.equal(f.inspect.prepare('SELECT COUNT(*) n FROM audit').get()!.n, auditBefore)
    fail = false
    f.store.resumeStorage()
    f.native.respond(a)
    assert.equal(
      f.inspect.prepare('SELECT reserved FROM calls WHERE call_id=?').get(second.call_id)!.reserved,
      f.store.limits.attempt_reserve_bytes
    )
    f.native.respond(b)
    assert.equal(f.inspect.prepare('SELECT SUM(reserved) n FROM calls').get()!.n, 0)
  } finally {
    f.close()
  }
})
