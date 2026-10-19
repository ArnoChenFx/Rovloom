/** 独立核对自有 OpenCode 1.19.3 SQLite 消息证据；不是模型账单、Herdr receipt 或两轮成功声明。 */
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseJson } from '../../src/wire/validation.js'

export type OpenCodeTurnOptions = Readonly<{
  database: string
  session_id: string
  prompt: string
  excluded_message_ids?: readonly string[]
}>
export type OpenCodeTurn = Readonly<{
  session_id: string
  user_message_id: string
  assistant_message_id: string
  text: string
  cost: number
  provider_id: string
  model_id: string
  time_created: number
  time_completed: number
  finish: 'stop'
}>

/** 验收只输出固定诊断码，不把数据库路径、prompt、模型响应或底层 SQL 错误带入异常。 */
export class OpenCodeTurnError extends Error {
  /** 固定码同时作为异常正文，调用者不需要解析底层 SQL 或模型错误。 */
  constructor(public readonly code: string) {
    super(code)
    this.name = 'OpenCodeTurnError'
  }
}

type RecordValue = Record<string, unknown>
type Message = { id: string; session_id: string; time_created: number; info: RecordValue }
const MAX_MESSAGES = 2048
const MAX_PARTS = 1024

/** 对不成立的证据约束返回稳定拒绝，不从类似字段或状态推断成功。 */
function requireEvidence(condition: unknown, code = 'opencode_turn_record_invalid'): asserts condition {
  if (!condition) {
    throw new OpenCodeTurnError(code)
  }
}

/** 消息 ID 和模型标识保持原字符串，仅要求非空；不自行生成或归一化身份。 */
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
}

/** 严格对象不能是数组或 null，底层 JSON 的重复键、深度及字节由共用解析器限制。 */
function record(value: unknown): RecordValue {
  requireEvidence(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as RecordValue
}

/** 只读数据库内的 JSON 不允许宽松修复；解析错误也不回显原文。 */
function document(value: unknown): RecordValue {
  requireEvidence(typeof value === 'string')
  try {
    return record(parseJson(value))
  } catch {
    throw new OpenCodeTurnError('opencode_turn_record_invalid')
  }
}

/** row 是官方主键和归属来源；data 若重复身份字段也必须同值。 */
function sameIdentity(data: RecordValue, key: string, expected: string): void {
  requireEvidence(!Object.hasOwn(data, key) || data[key] === expected)
}

/** 固定读取官方 message/part 表的必要列，不查询其它目录、会话表或模型配置。 */
function schema(database: DatabaseSync): void {
  const expected = {
    message: { id: 'TEXT', session_id: 'TEXT', time_created: 'INTEGER', data: 'TEXT' },
    part: { id: 'TEXT', message_id: 'TEXT', session_id: 'TEXT', data: 'TEXT' }
  }
  for (const [table, columns] of Object.entries(expected)) {
    const entry = database.prepare('SELECT type FROM sqlite_schema WHERE name = ?').get(table)
    requireEvidence(entry?.type === 'table', 'opencode_turn_schema_invalid')
    const actual = database.prepare(`PRAGMA table_info("${table}")`).all()
    for (const [name, type] of Object.entries(columns)) {
      requireEvidence(
        actual.some(
          /** 必要列须与官方 SQLite 形状一致，额外原生列保留。 */ (column) =>
            column.name === name && column.type === type
        ),
        'opencode_turn_schema_invalid'
      )
    }
  }
}

/** 对指定消息读取有序 text，拒绝跨 session/消息混接，忽略 reasoning/tool/synthetic/ignored 内容。 */
function textParts(database: DatabaseSync, message: Message): string {
  const parts = database
    .prepare('SELECT id, message_id, session_id, data FROM part WHERE message_id = ? ORDER BY id LIMIT ?')
    .all(message.id, MAX_PARTS + 1)
  requireEvidence(parts.length <= MAX_PARTS, 'opencode_turn_limit')
  const texts: string[] = []
  for (const part of parts) {
    requireEvidence(identifier(part.id) && part.message_id === message.id && part.session_id === message.session_id)
    const data = document(part.data)
    sameIdentity(data, 'id', part.id)
    sameIdentity(data, 'messageID', message.id)
    sameIdentity(data, 'sessionID', message.session_id)
    requireEvidence(identifier(data.type))
    if (data.type !== 'text') {
      continue
    }
    requireEvidence(typeof data.text === 'string')
    for (const flag of ['synthetic', 'ignored']) {
      requireEvidence(!Object.hasOwn(data, flag) || typeof data[flag] === 'boolean')
    }
    if (data.synthetic !== true && data.ignored !== true) {
      texts.push(data.text)
    }
  }
  return texts.join('')
}

/** 在同一只读快照内核对最新精确 prompt 及其真实成功子消息，不把旧轮结果用于新 pending 轮次。 */
function inspect(database: DatabaseSync, options: OpenCodeTurnOptions): OpenCodeTurn | undefined {
  schema(database)
  const rows = database
    .prepare(
      'SELECT id, session_id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT ?'
    )
    .all(options.session_id, MAX_MESSAGES + 1)
  requireEvidence(rows.length <= MAX_MESSAGES, 'opencode_turn_limit')
  const messages: Message[] = rows.map(
    /** 主键、session 和时间列均来自实际 row，不接受 JSON 覆盖。 */ (row) => {
      requireEvidence(
        identifier(row.id) &&
          row.session_id === options.session_id &&
          Number.isSafeInteger(row.time_created) &&
          (row.time_created as number) >= 0
      )
      const info = document(row.data)
      sameIdentity(info, 'id', row.id)
      sameIdentity(info, 'sessionID', options.session_id)
      requireEvidence(info.role === 'user' || info.role === 'assistant')
      const time = record(info.time)
      requireEvidence(Number.isSafeInteger(time.created) && (time.created as number) >= 0)
      if (info.role === 'assistant') {
        requireEvidence(identifier(info.parentID))
      }
      return { id: row.id, session_id: options.session_id, time_created: row.time_created as number, info }
    }
  )
  const excluded = new Set(options.excluded_message_ids)
  const user = messages.find(
    /** 只匹配真正用户文本；附带的合成提醒不能充当原 prompt。 */ (message) =>
      message.info.role === 'user' && textParts(database, message) === options.prompt
  )
  if (!user || excluded.has(user.id)) {
    return undefined
  }
  const assistant = messages.find(
    /** 绑定同一用户主键，不以相邻行、终端输出或 Agent 状态关联轮次。 */ (message) =>
      message.info.role === 'assistant' &&
      message.info.parentID === user.id &&
      message.info.summary !== true &&
      !excluded.has(message.id)
  )
  if (!assistant) {
    return undefined
  }
  const info = assistant.info
  requireEvidence(!Object.hasOwn(info, 'summary') || typeof info.summary === 'boolean')
  requireEvidence(!Object.hasOwn(info, 'error'), 'opencode_turn_failed')
  const time = record(info.time)
  requireEvidence(Number.isSafeInteger(time.created) && (time.created as number) >= 0)
  if (time.completed === undefined) {
    return undefined
  }
  requireEvidence(Number.isSafeInteger(time.completed) && (time.completed as number) > 0)
  // tool-calls 是原生中间步骤，后续可能还有 assistant 消息，不能作为成功也不提前宣称失败。
  if (info.finish === 'tool-calls') {
    return undefined
  }
  requireEvidence(info.finish === 'stop', 'opencode_turn_not_successful')
  requireEvidence(
    typeof info.cost === 'number' &&
      Number.isFinite(info.cost) &&
      info.cost >= 0 &&
      identifier(info.providerID) &&
      identifier(info.modelID)
  )
  const text = textParts(database, assistant)
  requireEvidence(text.trim().length > 0 && text.trim() !== options.prompt.trim(), 'opencode_turn_no_answer')
  return Object.freeze({
    session_id: options.session_id,
    user_message_id: user.id,
    assistant_message_id: assistant.id,
    text,
    cost: info.cost,
    provider_id: info.providerID,
    model_id: info.modelID,
    time_created: time.created as number,
    time_completed: time.completed as number,
    finish: 'stop'
  })
}

/** 仅打开调用者明确给出的自有绝对 OPENCODE_DB；不存在为 pending，其余错误只给固定码。 */
export function readOpenCodeTurn(options: OpenCodeTurnOptions): OpenCodeTurn | undefined {
  requireEvidence(
    options &&
      typeof options.database === 'string' &&
      isAbsolute(options.database) &&
      identifier(options.session_id) &&
      typeof options.prompt === 'string' &&
      options.prompt.trim().length > 0 &&
      (options.excluded_message_ids === undefined ||
        (Array.isArray(options.excluded_message_ids) && options.excluded_message_ids.every(identifier))),
    'opencode_turn_options_invalid'
  )
  try {
    requireEvidence(statSync(options.database).isFile(), 'opencode_turn_database_invalid')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw error instanceof OpenCodeTurnError ? error : new OpenCodeTurnError('opencode_turn_database_unavailable')
  }
  let database: DatabaseSync | undefined
  let transaction = false
  let result: OpenCodeTurn | undefined
  let failure: OpenCodeTurnError | undefined
  try {
    database = new DatabaseSync(options.database, { readOnly: true })
    database.exec('PRAGMA query_only = ON; BEGIN')
    transaction = true
    result = inspect(database, options)
  } catch (error) {
    failure = error instanceof OpenCodeTurnError ? error : new OpenCodeTurnError('opencode_turn_database_unavailable')
  } finally {
    // Bun 的 close 可以延迟到 statement 回收；显式结束读事务，不能让下一轮模型写入等待锁。
    if (database) {
      try {
        if (transaction) {
          database.exec('ROLLBACK')
        }
      } catch {
        failure ??= new OpenCodeTurnError('opencode_turn_database_unavailable')
      }
      try {
        database.close()
      } catch {
        failure ??= new OpenCodeTurnError('opencode_turn_database_unavailable')
      }
    }
  }
  if (failure) {
    throw failure
  }
  return result
}
