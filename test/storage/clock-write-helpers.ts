// 只在自有测试 Store 的单个同步范围统计真实 metadata 时钟 SQL；不修改全局 SQLite 或产品时钟。
import type { DatabaseSync } from 'node:sqlite'
import type { Store } from '../../src/store.js'

/** 保留原 SQLite 接收者与参数，finally 恢复该测试实例，不把 time 的事务内早退算作写入。 */
export function clockWrites<T>(store: Store, operation: () => T): { result: T; updates: number } {
  const db = (store as unknown as { db: DatabaseSync }).db
  const prepare = db.prepare
  let updates = 0
  db.prepare = /** 只有实际执行原时钟 UPDATE 的 run 才增加计数。 */ (...args) => {
    const statement = prepare.apply(db, args)
    if (args[0] !== 'UPDATE metadata SET clock=?') {
      return statement
    }
    return new Proxy(statement, {
      /** 所有方法仍在原 statement 上执行，避免 Proxy 改变 SQLite 内部接收者。 */
      get(target, key) {
        const value = Reflect.get(target, key, target)
        if (key === 'run') {
          return /** 精确计量真实 SQL 写入，不改变提交或结果。 */ (...values: unknown[]) => {
            updates++
            return Reflect.apply(value, target, values)
          }
        }
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  }
  try {
    return { result: operation(), updates }
  } finally {
    db.prepare = prepare
  }
}
