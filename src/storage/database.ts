// 业务账本的 SQLite 连接：同一 SQL 文本复用已准备的语句。
import { DatabaseSync, type StatementSync } from 'node:sqlite'

// 缓存上限：动态拼接的 SQL 不会让缓存无限增长，超出后照常准备但不再缓存。
const MAX_STATEMENTS = 512

/** 热路径（读取门禁、连接核验）每次都重新解析同一批 SQL，实测约占 call_get CPU 的 10%；语句只用 get/all/run，可安全复用。 */
export class CachedDatabase extends DatabaseSync {
  readonly #statements = new Map<string, StatementSync>()

  override prepare(sql: string): StatementSync {
    let statement = this.#statements.get(sql)
    if (!statement) {
      statement = super.prepare(sql)
      if (this.#statements.size < MAX_STATEMENTS) {
        this.#statements.set(sql, statement)
      }
    }
    return statement
  }

  override close(): void {
    this.#statements.clear()
    super.close()
  }
}
