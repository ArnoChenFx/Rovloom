/** 实际 Store 变化和故障事务核对计数；独立 SUM 是测试 oracle，不用于热路径。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/store.js'
import { GatewayError } from '../../src/contracts.js'
import { assertUsage } from '../../src/storage/budget.js'
import { inspectStorage } from '../../src/storage/inspect.js'
import { management, connected, options, respond } from './helpers.js'

/** 对实际文件另开只读连接，核对 UTF-8 字节、收尾预约和级联结果删除。 */
function usage(path: string) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    assertUsage(db)
    return { ...db.prepare('SELECT content_bytes,result_bytes,reserved_bytes FROM storage_usage').get()! }
  } finally {
    db.close()
  }
}

test('usage survives response, discard, snapshot, reopen and TTL deletion without reviving content', () => {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-usage-'))
  const state = join(root, 'state')
  const backups = join(root, 'backups')
  mkdirSync(state, { mode: 0o700 })
  mkdirSync(backups, { mode: 0o700 })
  const path = join(state, 'gateway.db')
  let now = 100
  let store = new Store(path, () => now, { management, backupDirectory: backups })
  try {
    const device = connected(store)
    const call = store.createCall('alice', device.target, { method: 'ping', params: { text: '你好😀' } }, options())
    assert(Number(usage(path).content_bytes) > 0)
    const binding = store.dispatch('alice', call.call_id, device.epoch)
    assert.equal(usage(path).reserved_bytes, store.limits.attempt_reserve_bytes)
    respond(store, binding, { result: { text: '响应😀' } }, now)
    assert.equal(usage(path).reserved_bytes, 0)
    store.saveResult('alice', call.call_id)
    assert(Number(usage(path).result_bytes) > 0)
    const snapshot = join(backups, 'snapshot.db')
    store.backup(snapshot)
    assert.deepEqual(usage(snapshot), { content_bytes: 0, result_bytes: 0, reserved_bytes: 0 })
    const original = usage(path)
    assert(Number(original.content_bytes) > 0)
    store.close()
    store = new Store(path, () => now, { management, backupDirectory: backups })
    assert.deepEqual(usage(path), original)
    store.discardResponse('alice', call.call_id)
    assert.deepEqual(usage(path), { content_bytes: 0, result_bytes: 0, reserved_bytes: 0 })
    store.connect(device.machine_id, device.credential)
    const pending = store.createCall('alice', device.target, { method: 'ping', params: {} }, options())
    assert.equal(pending.state, 'created')
    now += store.limits.metadata_ttl
    store.expire()
    assert.deepEqual(usage(path), { content_bytes: 0, result_bytes: 0, reserved_bytes: 0 })
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('usage updates roll back with a rejected call and corrupt counters fail startup and read-only inspection', () => {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-usage-rollback-'))
  const path = join(root, 'gateway.db')
  let abort = false
  const store = new Store(path, () => 100, {
    management,
    fault: () => {
      if (abort) {
        throw new GatewayError('synthetic_abort')
      }
    }
  })
  try {
    const device = connected(store)
    const before = usage(path)
    abort = true
    assert.throws(
      () => store.createCall('alice', device.target, { method: 'ping', params: { text: '回滚😀' } }, options()),
      /synthetic_abort/
    )
    assert.deepEqual(usage(path), before)
    abort = false
    const call = store.createCall('alice', device.target, { method: 'ping' }, options())
    const registered = usage(path)
    abort = true
    assert.throws(() => store.dispatch('alice', call.call_id, device.epoch), /synthetic_abort/)
    assert.deepEqual(usage(path), registered)
    assert.equal(store.call('alice', call.call_id).state, 'created')
    store.close()
    const db = new DatabaseSync(path)
    db.exec('UPDATE storage_usage SET content_bytes=content_bytes+1')
    db.close()
    assert.throws(() => new Store(path, () => 100), /database_integrity_failed/)
    assert.throws(() => inspectStorage(path), /database_integrity_failed/)
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('TTL clears retained result usage and missing accounting triggers fail closed even at zero usage', () => {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-usage-expiry-'))
  const path = join(root, 'gateway.db')
  let now = 100
  const store = new Store(path, () => now, { management, retention: { result_ttl: 100 } })
  try {
    const device = connected(store)
    const call = store.createCall('alice', device.target, { method: 'ping' }, options())
    const binding = store.dispatch('alice', call.call_id, device.epoch)
    respond(store, binding, { result: { text: '到期😀' } }, now)
    store.saveResult('alice', call.call_id)
    assert(Number(usage(path).result_bytes) > 0)
    now += 100
    store.expire()
    assert.equal(store.call('alice', call.call_id).content_status, 'expired')
    assert.deepEqual(usage(path), { content_bytes: 0, result_bytes: 0, reserved_bytes: 0 })
    store.close()
    const db = new DatabaseSync(path)
    db.exec('DROP TRIGGER calls_usage_insert')
    db.close()
    assert.throws(() => new Store(path, () => now), /database_integrity_failed/)
    assert.throws(() => inspectStorage(path), /database_integrity_failed/)
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('metadata expiry cascades a still-retained result and its counters in the same transaction', () => {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-usage-cascade-'))
  const path = join(root, 'gateway.db')
  let now = 100
  const store = new Store(path, () => now, { management, retention: { metadata_ttl: 100, result_ttl: 1000 } })
  try {
    const device = connected(store)
    const call = store.createCall('alice', device.target, { method: 'ping' }, options())
    respond(store, store.dispatch('alice', call.call_id, device.epoch), { result: { text: '级联😀' } }, now)
    store.saveResult('alice', call.call_id)
    assert(Number(usage(path).result_bytes) > 0)
    now += 100
    store.expire()
    assert.deepEqual(usage(path), { content_bytes: 0, result_bytes: 0, reserved_bytes: 0 })
    assert.throws(() => store.call('alice', call.call_id), /call_not_found/)
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})
