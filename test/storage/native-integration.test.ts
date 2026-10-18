import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/store.js'
import { commitLuvusResponse } from '../../src/integration/persistence.js'
import { management, responseFrame } from './helpers.js'
import { nativeBackend } from './native-backend.js'

test('real NativeValidator and Wire adapter commit a late response through the durable SQLite backend', () => {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-native-ledger-'))
  let now = 100
  const store = new Store(join(root, 'db'), () => now, { management })
  try {
    const native = nativeBackend(store)
    const call = native.create({ timeoutMs: 10 })
    const binding = native.dispatch(call.call_id)
    assert.equal(native.state.sends, 1)
    now = 110
    store.expire()
    const frame = responseFrame(binding, { result: { id: 'task-created' } })
    const result = commitLuvusResponse(store, native.adapter, frame)
    assert.equal(result.state, 'responded')
    assert.equal(JSON.parse(result.response!).result.id, 'task-created')
    const duplicate = commitLuvusResponse(store, native.adapter, frame)
    assert.equal(duplicate.call_id, call.call_id)
    assert.throws(() => store.dispatch('synthetic', call.call_id, native.device.epoch), /dispatch_rejected/)
    const events = store.auditRecords()
    assert.equal(events.filter((event) => event.action === 'dispatching').length, 1)
    assert.equal(events.filter((event) => event.action === 'late_evidence').length, 1)
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})
