/** 用自有合成 SQLite 核对独立 OpenCode 存储证据，不调用模型或证明真实两轮通过。 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { OpenCodeTurnError, readOpenCodeTurn } from '../../../scripts/herdr/conversation.js'

const session = 'ses_owned'
const prompt = 'Remember N4Q7 exactly.'

/** 仅创建本测试拥有的数据库，形状对应官方 message/part row 与 data 分离存储。 */
function fixture(context: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-conversation-'))
  const database = join(root, 'opencode.db')
  const db = new DatabaseSync(database)
  db.exec(`
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, data TEXT NOT NULL);
  `)
  context.after(
    /** 所有成功和失败路径都只清理本测试创建的文件。 */ () => {
      db.close()
      rmSync(root, { recursive: true, force: true })
    }
  )
  /** 以官方 row/data 分离方式记录消息，不把测试 JSON 身份当作可信 row。 */
  function message(id: string, data: Record<string, unknown>, time = 1, ownSession = session): void {
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(id, ownSession, time, JSON.stringify(data))
  }
  /** 按原生 part ID 顺序存放文本或其它 part，允许用反例主动构造损坏归属。 */
  function part(id: string, messageId: string, data: Record<string, unknown>, ownSession = session): void {
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').run(id, messageId, ownSession, JSON.stringify(data))
  }
  /** 写入普通用户消息，其文本须与调用者本轮 prompt 精确相同。 */
  function user(id = 'msg_user', text = prompt, time = 1): void {
    message(
      id,
      { role: 'user', time: { created: time }, agent: 'build', model: { providerID: 'owned', modelID: 'local' } },
      time
    )
    part('prt_' + id, id, { type: 'text', text })
  }
  /** 写入仅供测试的已完成 assistant，成本和模型字段只是原始存储值。 */
  function assistant(id = 'msg_assistant', parent = 'msg_user', data: Record<string, unknown> = {}, time = 2): void {
    message(
      id,
      {
        role: 'assistant',
        parentID: parent,
        time: { created: time, completed: time + 1 },
        finish: 'stop',
        cost: 0.25,
        providerID: 'owned',
        modelID: 'local',
        ...data
      },
      time
    )
  }
  /** 重复观察同一明确数据库，不扫描默认目录或选择其它 session。 */
  function read(excluded?: readonly string[]) {
    return readOpenCodeTurn({ database, session_id: session, prompt, excluded_message_ids: excluded })
  }
  return { root, database, db, message, part, user, assistant, read }
}

/** 只接纳指定稳定码，同时断言错误不会携带合成正文或数据库文件名。 */
function rejected(operation: () => unknown, code: string): void {
  assert.throws(
    operation,
    /** 底层 SQL/JSON/模型异常都不能成为公共诊断正文。 */ (error: unknown) => {
      assert(error instanceof OpenCodeTurnError)
      assert.equal(error.code, code)
      assert.equal(error.message, code)
      return true
    }
  )
}

test(
  '缺失明确数据库为pending且不会创建文件；相对路径和目录拒绝',
  /** 自有路径无隐式发现。 */ (context) => {
    const f = fixture(context)
    const missing = join(f.root, 'not-created.db')
    const names = readdirSync(f.root)
    assert.equal(readOpenCodeTurn({ database: missing, session_id: session, prompt }), undefined)
    assert.deepEqual(readdirSync(f.root), names)
    rejected(
      /** SQLite 特殊路径不能触发内存库或隐式创建。 */ () =>
        readOpenCodeTurn({ database: ':memory:', session_id: session, prompt }),
      'opencode_turn_options_invalid'
    )
    rejected(
      /** 调用者给出的目录不能当作数据库。 */ () => readOpenCodeTurn({ database: f.root, session_id: session, prompt }),
      'opencode_turn_database_invalid'
    )
  }
)

test(
  '成功必须关联同session精确用户prompt和stop子消息，原文字段保留且不写库',
  /** 独立存储证据不是模型账单。 */ (context) => {
    const f = fixture(context)
    f.user()
    f.part('prt_user_reminder', 'msg_user', { type: 'text', text: 'system reminder', synthetic: true })
    f.assistant()
    f.part('prt_a', 'msg_assistant', { type: 'reasoning', text: 'not an answer' })
    f.part('prt_b', 'msg_assistant', { type: 'text', text: 'Stored ' })
    f.part('prt_c', 'msg_assistant', { type: 'text', text: 'N4Q7.\n' })
    const before = readFileSync(f.database)
    assert.deepEqual(f.read(), {
      session_id: session,
      user_message_id: 'msg_user',
      assistant_message_id: 'msg_assistant',
      text: 'Stored N4Q7.\n',
      cost: 0.25,
      provider_id: 'owned',
      model_id: 'local',
      time_created: 2,
      time_completed: 3,
      finish: 'stop'
    })
    assert.deepEqual(readFileSync(f.database), before)
  }
)

test(
  '新轮仍pending时不回退旧轮；已排除的用户和assistant均不能复用',
  /** 相同prompt也须选择最新原消息。 */ (context) => {
    const f = fixture(context)
    f.user('msg_old_user', prompt, 1)
    f.assistant('msg_old_answer', 'msg_old_user', {}, 2)
    f.part('prt_old', 'msg_old_answer', { type: 'text', text: 'older answer' })
    f.user('msg_new_user', prompt, 10)
    assert.equal(f.read(), undefined)
    f.assistant('msg_new_answer', 'msg_new_user', {}, 11)
    f.part('prt_new', 'msg_new_answer', { type: 'text', text: 'new answer' })
    assert.equal(f.read()?.assistant_message_id, 'msg_new_answer')
    assert.equal(f.read(['msg_new_answer']), undefined)
    assert.equal(f.read(['msg_new_user']), undefined)
  }
)

test(
  '错误session、另一用户parent和仅相似prompt不能串成轮次',
  /** 位置和终端显示不能代替精确归属。 */ (context) => {
    const f = fixture(context)
    f.user()
    f.assistant('msg_wrong_parent', 'msg_other_user')
    f.part('prt_wrong_parent', 'msg_wrong_parent', { type: 'text', text: 'wrong turn' })
    f.message('msg_foreign', { role: 'assistant', parentID: 'msg_user' }, 3, 'ses_other')
    f.part('prt_foreign', 'msg_foreign', { type: 'text', text: 'wrong session' }, 'ses_other')
    assert.equal(f.read(), undefined)
    assert.equal(readOpenCodeTurn({ database: f.database, session_id: session, prompt: prompt + ' ' }), undefined)
  }
)

test(
  '合成或忽略的用户文本不算prompt，合成assistant文本也不算回答',
  /** 不把系统提醒或回显充当模型输出。 */ (context) => {
    const f = fixture(context)
    f.message('msg_user', { role: 'user', time: { created: 1 } })
    f.part('prt_user', 'msg_user', { type: 'text', text: prompt, synthetic: true })
    f.assistant()
    f.part('prt_answer', 'msg_assistant', { type: 'text', text: 'synthetic answer', ignored: true })
    assert.equal(f.read(), undefined)
    f.db
      .prepare('UPDATE part SET data = ? WHERE id = ?')
      .run(JSON.stringify({ type: 'text', text: prompt }), 'prt_user')
    rejected(/** 被忽略的文本不能使完成行变成成功回答。 */ () => f.read(), 'opencode_turn_no_answer')
  }
)

test(
  '无completed和tool-calls保持pending，error或完成但无stop不能成功',
  /** 原生完成状态与成功回答分开检查。 */ (context) => {
    const f = fixture(context)
    f.user()
    f.assistant('msg_assistant', 'msg_user', { time: { created: 2 } })
    f.part('prt_answer', 'msg_assistant', { type: 'text', text: 'partial' })
    assert.equal(f.read(), undefined)
    for (const finish of ['length', 'error', null]) {
      f.db
        .prepare('UPDATE message SET data = ? WHERE id = ?')
        .run(
          JSON.stringify({ role: 'assistant', parentID: 'msg_user', time: { created: 2, completed: 3 }, finish }),
          'msg_assistant'
        )
      rejected(/** 已完成但没有stop的响应不作为成功证据。 */ () => f.read(), 'opencode_turn_not_successful')
    }
    f.db.prepare('UPDATE message SET data = ? WHERE id = ?').run(
      JSON.stringify({
        role: 'assistant',
        parentID: 'msg_user',
        time: { created: 2, completed: 3 },
        finish: 'tool-calls'
      }),
      'msg_assistant'
    )
    assert.equal(f.read(), undefined)
    f.db.prepare('UPDATE message SET data = ? WHERE id = ?').run(
      JSON.stringify({
        role: 'assistant',
        parentID: 'msg_user',
        time: { created: 2 },
        error: { name: 'APIError', data: { message: 'synthetic-private-error' } }
      }),
      'msg_assistant'
    )
    rejected(/** 有错误即拒绝且不泄露原生错误正文。 */ () => f.read(), 'opencode_turn_failed')
  }
)

test(
  'summary、reasoning和纯prompt回显不能通过回答校验',
  /** 无per-turn receipt时至少要求真实关联回答文本。 */ (context) => {
    const f = fixture(context)
    f.user()
    f.assistant('msg_summary', 'msg_user', { summary: true })
    f.part('prt_summary', 'msg_summary', { type: 'text', text: 'conversation summary' })
    assert.equal(f.read(), undefined)
    f.assistant('msg_answer', 'msg_user', {}, 4)
    f.part('prt_answer', 'msg_answer', { type: 'text', text: ' ' + prompt + '\n' })
    rejected(/** 纯回显即使标stop也不能当作回答。 */ () => f.read(), 'opencode_turn_no_answer')
  }
)

test(
  '跨session part和JSON内冲突身份必须拒绝',
  /** 消息表和part表不能拼接其它会话内容。 */ (context) => {
    const f = fixture(context)
    f.user()
    f.assistant()
    f.part('prt_answer', 'msg_assistant', { type: 'text', text: 'answer' }, 'ses_other')
    rejected(/** part外键之外还须核对原session。 */ () => f.read(), 'opencode_turn_record_invalid')
    f.db
      .prepare('UPDATE part SET session_id = ?, data = ? WHERE id = ?')
      .run(session, JSON.stringify({ type: 'text', text: 'answer', messageID: 'msg_other' }), 'prt_answer')
    rejected(/** data内的消息归属不能覆盖row主键。 */ () => f.read(), 'opencode_turn_record_invalid')
  }
)

test(
  '缺表列、坏JSON和非法完成成本字段只返回固定拒绝码',
  /** 损坏存储不是pending或模型成功。 */ (context) => {
    const f = fixture(context)
    f.user()
    f.assistant('msg_assistant', 'msg_user', { cost: null })
    rejected(/** 非数值成本不能进入证据返回。 */ () => f.read(), 'opencode_turn_record_invalid')
    f.db.prepare('UPDATE message SET data = ? WHERE id = ?').run('{"role":"assistant","role":"user"}', 'msg_assistant')
    rejected(/** 歧义JSON不能选择有利的最后一个字段。 */ () => f.read(), 'opencode_turn_record_invalid')
    f.db.exec('ALTER TABLE part RENAME COLUMN data TO body')
    rejected(/** 必需列缺失须按schema拒绝，不能继续宽松读取。 */ () => f.read(), 'opencode_turn_schema_invalid')
    f.db.exec('DROP TABLE part')
    rejected(/** schema缺失不能被当成模型还未回答。 */ () => f.read(), 'opencode_turn_schema_invalid')
    const invalid = join(f.root, 'invalid.db')
    writeFileSync(invalid, 'synthetic-private-invalid-database')
    rejected(
      /** SQLite底层异常不回显文件正文。 */ () => readOpenCodeTurn({ database: invalid, session_id: session, prompt }),
      'opencode_turn_database_unavailable'
    )
  }
)
