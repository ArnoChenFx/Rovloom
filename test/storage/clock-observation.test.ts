// 验证账本逐次核对可信时钟，只持久新的高水位，且回退与必要写入失败仍拒绝并降级。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { Store } from '../../src/store.js'
import { clockWrites } from './clock-write-helpers.js'

/** 返回测试自有连接，用于核对实际持久锚点和注入局部 SQL 故障。 */
function database(store: Store): DatabaseSync {
  return (store as unknown as { db: DatabaseSync }).db
}

test(
  '相同毫秒重复读不写时钟，每个新高水位只写一次且每次仍读取宿主时间',
  /** SQL 计数只覆盖显式时钟读取，不把事务提交或后台维护计作重复写入。 */ () => {
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
      const first = clockWrites(store, /** 已持久的初始时刻可直接复用。 */ () => [store.clock(), store.clock()])
      assert.deepEqual(first, { result: [100, 100], updates: 0 })
      now = 101
      const next = clockWrites(
        store,
        /** 跨毫秒先持久一次，后续读取保留同一高水位。 */ () => [store.clock(), store.clock()]
      )
      assert.deepEqual(next, { result: [101, 101], updates: 1 })
      now = 103
      const later = clockWrites(store, /** 跳过的毫秒无需补写，但新值必须即时持久。 */ () => store.clock())
      assert.deepEqual(later, { result: 103, updates: 1 })
      assert.equal(samples - sampled, 5)
      assert.equal(database(store).prepare('SELECT clock FROM metadata').get()!.clock, 103)
    } finally {
      store.close()
    }
  }
)

test(
  '重复读仍核对数据库锚点，外部下调不能抹掉已观察的高水位',
  /** 外部变更只用于注入异常；不把测试连接当作受支持的多 writer 接口。 */ () => {
    let now = 100
    const store = new Store(':memory:', /** 返回可回退的测试时钟。 */ () => now)
    const db = database(store)
    try {
      now = 101
      assert.equal(store.clock(), 101)
      db.prepare('UPDATE metadata SET clock=?').run(100)
      const restored = clockWrites(store, /** 同毫秒也应重新读取数据库并修复落后的持久锚点。 */ () => store.clock())
      assert.deepEqual(restored, { result: 101, updates: 1 })
      assert.equal(db.prepare('SELECT clock FROM metadata').get()!.clock, 101)
      db.prepare('UPDATE metadata SET clock=?').run(100)
      now = 100
      assert.throws(/** 内存高水位独立阻止外部锚点下调后回退。 */ () => store.clock(), /clock_untrusted/)
      assert.equal(store.health().mode, 'storage_degraded')
    } finally {
      store.close()
    }
  }
)

test(
  '数据库锚点外部前移后，相同宿主毫秒仍必须拒绝并锁存降级',
  /** 不允许只比较进程内缓存而跳过数据库高水位。 */ () => {
    const store = new Store(':memory:', /** 保持同一毫秒以暴露持久锚点缓存。 */ () => 100)
    try {
      assert.equal(store.clock(), 100)
      database(store).prepare('UPDATE metadata SET clock=?').run(101)
      assert.throws(/** 原值即使已读取过，也不得越过新持久高水位。 */ () => store.clock(), /clock_untrusted/)
      assert.equal(store.health().mode, 'storage_degraded')
    } finally {
      store.close()
    }
  }
)

test(
  '必要时钟写入失败仍降级，不把已持久的同毫秒重复读当作写探针',
  /** 真实 SQLite 触发器只破坏 clock UPDATE，保留模式锁存与清理。 */ () => {
    let now = 100
    const store = new Store(':memory:', /** 推进后才要求新的持久写入。 */ () => now)
    const db = database(store)
    try {
      db.exec(`CREATE TEMP TRIGGER fail_clock BEFORE UPDATE OF clock ON metadata
        BEGIN SELECT RAISE(ABORT, 'synthetic_clock_write_failure'); END`)
      assert.deepEqual(
        clockWrites(store, /** 已持久的时刻无需重复 UPDATE。 */ () => store.clock()),
        {
          result: 100,
          updates: 0
        }
      )
      now = 101
      assert.throws(/** 新时刻必须成功持久，否则返回稳定的降级错误。 */ () => store.clock(), /storage_degraded/)
      assert.equal(db.prepare('SELECT clock FROM metadata').get()!.clock, 100)
      assert.equal(store.health().mode, 'storage_degraded')
      assert.throws(/** 必要写入失败后不得继续接纳业务写事务。 */ () => store.expire(), /storage_degraded/)
    } finally {
      store.close()
    }
  }
)

test(
  '仅由读推进的时钟跨重开仍持久，相同值无重复写，回退继续拒绝',
  /** 使用真实私有磁盘目录验证进程内去重不削弱跨实例的持久高水位。 */ () => {
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
      const reopened = store
      assert.deepEqual(
        clockWrites(reopened, /** 持久值等于宿主时间时不再写同值。 */ () => reopened.clock()),
        {
          result: 101,
          updates: 0
        }
      )
      store.close()
      now = 100
      store = new Store(path, /** 模拟关闭后宿主时间回退。 */ () => now)
      const rolledBack = store
      assert.throws(/** 首次读取即应发现前一实例已经持久的高水位。 */ () => rolledBack.clock(), /clock_untrusted/)
      assert.equal(store.health().mode, 'storage_degraded')
    } finally {
      store?.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
)
