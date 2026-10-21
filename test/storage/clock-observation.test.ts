// 验证账本读路径只推进内存时钟高水位且不写库；写事务与关闭持久高水位，回退仍拒绝并降级。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { Store } from '../../src/store.js'
import { clockWrites } from './clock-write-helpers.js'

/** 返回测试自有连接，用于核对实际持久锚点。 */
function database(store: Store): DatabaseSync {
  return (store as unknown as { db: DatabaseSync }).db
}

test(
  '读取时钟只采样宿主时间，不产生任何 metadata 写入',
  /** SQL 计数只覆盖显式时钟读取。 */ () => {
    let now = 100
    let samples = 0
    const store = new Store(
      ':memory:',
      /** 每次调用独立计数，防止优化缓存宿主时间。 */ () => {
        samples++
        return now
      }
    )
    try {
      const sampled = samples
      const first = clockWrites(store, () => [store.clock(), store.clock()])
      assert.deepEqual(first, { result: [100, 100], updates: 0 })
      now = 101
      assert.deepEqual(
        clockWrites(store, () => [store.clock(), store.clock()]),
        { result: [101, 101], updates: 0 }
      )
      now = 103
      assert.deepEqual(
        clockWrites(store, () => store.clock()),
        { result: 103, updates: 0 }
      )
      assert.equal(samples - sampled, 5)
    } finally {
      store.close()
    }
  }
)

test(
  '读路径内存高水位阻止时钟回退并锁存降级',
  /** 回退不依赖数据库锚点。 */ () => {
    let now = 100
    const store = new Store(':memory:', /** 返回可回退的测试时钟。 */ () => now)
    try {
      now = 101
      assert.equal(store.clock(), 101)
      now = 100
      assert.throws(() => store.clock(), /clock_untrusted/)
      assert.equal(store.health().mode, 'storage_degraded')
    } finally {
      store.close()
    }
  }
)

test(
  '写事务持久时钟高水位',
  /** 事务提交前统一写入，不在读路径写。 */ () => {
    let now = 100
    const store = new Store(':memory:', /** 推进后由写事务持久。 */ () => now)
    try {
      now = 150
      store.register('persisted')
      assert.equal(database(store).prepare('SELECT clock FROM metadata').get()!.clock, 150)
    } finally {
      store.close()
    }
  }
)

test(
  '仅由读推进的时钟在关闭时持久，重开后回退仍被拒绝',
  /** 使用真实私有磁盘目录验证跨实例高水位。 */ () => {
    const root = mkdtempSync(join(tmpdir(), 'rovloom-clock-'))
    const state = join(root, 'state')
    mkdirSync(state, { mode: 0o700 })
    const path = join(state, 'db')
    let now = 100
    let store: Store | undefined
    try {
      store = new Store(path, /** 首次打开后仅通过读取推进时间。 */ () => now)
      now = 101
      assert.equal(store.clock(), 101)
      store.close()
      store = new Store(path, /** 重开仍使用前一实例的可信时刻。 */ () => now)
      assert.equal(store.clock(), 101)
      store.close()
      now = 100
      store = new Store(path, /** 模拟关闭后宿主时间回退。 */ () => now)
      const rolledBack = store
      assert.throws(() => rolledBack.clock(), /clock_untrusted/)
      assert.equal(store.health().mode, 'storage_degraded')
    } finally {
      store?.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
)
