// 合成 OpenCode JSON 事件仅验证验收器和会话驱动，不启动 Agent、不调用模型或声称真实链路通过。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  agentArguments,
  conversationPrompts,
  readAgentCall,
  verifyConversation
} from '../../e2e/agent-conversation.mjs'
import { httpFixture } from './http-fixture.ts'

const target = { machine_id: 'synthetic_machine', provider_id: 'synthetic_herdr', profile: 'session', session: 'test' }
const nonce = 'synthetic_context_0123456789'
const model = 'ds/deepseek-flash'
const contract = 'a'.repeat(64)

function fixture(round, sessionID = 'ses_synthetic') {
  const call_id = `synthetic_call_${round}`
  const result_id = `synthetic_result_${round}`
  const bytes = Buffer.from(JSON.stringify({ id: round, result: { type: 'pong', version: 'synthetic-version' } }))
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const result = { result_id, bytes: bytes.length, sha256 }
  const binding = { target, provider_kind: 'herdr', binding_revision: 1, contract_ref: contract }
  const events = []
  const event = (type, part) => {
    events.push({
      type,
      sessionID,
      part: { sessionID, messageID: `synthetic_message_${round}`, id: `part_${round}_${events.length}`, ...part }
    })
  }
  const tool = (name, input, data) =>
    event('tool_use', {
      type: 'tool',
      tool: `rovloom_${name}`,
      callID: `tool_${round}_${events.length}`,
      state: { status: 'completed', input, output: JSON.stringify({ data }) }
    })
  tool('machines_list', {}, { items: [{ machine_id: target.machine_id }] })
  tool(
    'providers_list',
    { machine_id: target.machine_id },
    { items: [{ ...target, kind: 'herdr', enabled: true, binding_revision: 1 }] }
  )
  tool(
    'runtime_discover',
    { target, expected_binding_revision: 1, limit: 100 },
    { items: [{ method: 'ping', contract_ref: contract }] }
  )
  tool(
    'runtime_describe',
    { target, expected_binding_revision: 1, method: 'ping' },
    { method: 'ping', contract_ref: contract }
  )
  tool(
    'runtime_call',
    {
      target,
      expected_binding_revision: 1,
      contract_ref: contract,
      native_request: { method: 'ping', params: {} },
      deadline: Date.now() + 60_000,
      wait_ms: 500
    },
    { ...binding, call_id, state: 'dispatching' }
  )
  tool('runtime_call_get', { call_id, wait_ms: 200 }, { ...binding, call_id, state: 'responded', result })
  const split = 12
  tool(
    'runtime_result_read',
    { result_id, max_bytes: 16384 },
    {
      result_id,
      encoding: 'base64',
      total_bytes: bytes.length,
      chunk: bytes.subarray(0, split).toString('base64'),
      eof: false,
      next_cursor: 'synthetic_cursor',
      sha256
    }
  )
  tool(
    'runtime_result_read',
    { result_id, max_bytes: 16384, cursor: 'synthetic_cursor' },
    {
      result_id,
      encoding: 'base64',
      total_bytes: bytes.length,
      chunk: bytes.subarray(split).toString('base64'),
      eof: true,
      sha256
    }
  )
  event('text', { type: 'text', text: `RESULT version=synthetic-version context=${round === 1 ? 'stored' : nonce}` })
  event('step_finish', { type: 'step-finish', reason: 'stop' })
  return { events, bytes, view: { ...binding, call_id, state: 'responded', result } }
}

async function exercise(change = () => {}) {
  const first = fixture(1)
  const second = fixture(2)
  const turns = []
  const reads = []
  change(first, second)
  const result = await verifyConversation({
    target,
    nonce,
    runTurn: async (prompt, sessionID) => {
      turns.push({ prompt, sessionID })
      const selected = turns.length === 1 ? first : second
      return selected.stdout ?? selected.events.map((event) => JSON.stringify(event)).join('\n')
    },
    readCall: async (callID) => {
      reads.push(callID)
      const selected = callID === first.view.call_id ? first : second
      return { view: selected.view, bytes: selected.bytes }
    }
  })
  return { result, turns, reads }
}

test('synthetic driver reuses the exact session; recall nonce is only supplied in the first prompt', async () => {
  const { result, turns, reads } = await exercise()
  assert.equal(result.rounds, 2)
  assert.equal(result.session_reused, true)
  assert.deepEqual(reads, ['synthetic_call_1', 'synthetic_call_2'])
  assert.equal(turns[0].sessionID, undefined)
  assert.equal(turns[1].sessionID, 'ses_synthetic')
  assert(turns[0].prompt.includes(nonce))
  assert(!turns[1].prompt.includes(nonce))
  const args = agentArguments(model, turns[1].prompt, turns[1].sessionID)
  assert.deepEqual(args.slice(0, 7), ['run', '--format', 'json', '--model', model, '--session', 'ses_synthetic'])
  assert(!args.includes('--continue'))
  assert.equal(args.at(-1), turns[1].prompt)
  assert(!args.join(' ').includes(nonce))
  assert.deepEqual(
    conversationPrompts(target, nonce),
    turns.map((turn) => turn.prompt)
  )
})

for (const round of [1, 2]) {
  for (const whitespace of ['', ' \n\t']) {
    test(`synthetic round ${round} rejects RESULT before the last tool with ${JSON.stringify(whitespace)} after it`, async () => {
      await assert.rejects(
        exercise((a, b) => {
          const sample = round === 1 ? a : b
          const reply = sample.events.at(-2)
          const early = structuredClone(reply)
          early.part.id += '_before_last_tool'
          sample.events.splice(
            sample.events.findLastIndex((event) => event.type === 'tool_use'),
            0,
            early
          )
          reply.part.text = whitespace
        }),
        /agent_reply_missing/u
      )
    })
  }
}

test('synthetic final answer permits planning before tools and whitespace after a valid post-tool reply', async () => {
  const { result, reads } = await exercise((a, b) => {
    for (const sample of [a, b]) {
      const before = structuredClone(sample.events.at(-2))
      before.part.id += '_planning'
      before.part.text = 'Planning before the tools is not the final answer.'
      sample.events.unshift(before)
      const after = structuredClone(sample.events.at(-2))
      after.part.id += '_trailing_whitespace'
      after.part.text = ' \n\t'
      sample.events.splice(-1, 0, after)
    }
  })
  assert.equal(result.rounds, 2)
  assert.deepEqual(reads, ['synthetic_call_1', 'synthetic_call_2'])
})

const corruptions = {
  'RESULT text without tool events': (a) => {
    a.events = a.events.filter((e) => e.type !== 'tool_use')
  },
  'raw RESULT spoof': (a) => {
    a.stdout = 'RESULT version=synthetic-version context=stored'
  },
  'RESULT hidden in tool output': (a) => {
    a.events = a.events.filter((e) => e.type !== 'text')
  },
  'tool error with correct RESULT': (a) => {
    a.events[4].part.state.status = 'error'
  },
  'gateway error inside completed tool': (a) => {
    a.events[4].part.state.output = JSON.stringify({ gateway_error: { code: 'forbidden' } })
  },
  'unapproved tool': (a) => {
    a.events[0].part.tool = 'bash'
  },
  'missing describe': (a) => {
    a.events.splice(3, 1)
  },
  'wrong target': (a) => {
    a.events[4].part.state.input.target = { ...target, provider_id: 'other' }
  },
  'wrong binding': (a) => {
    a.events[4].part.state.input.expected_binding_revision = 2
  },
  'wrong contract': (a) => {
    a.events[4].part.state.input.contract_ref = 'b'.repeat(64)
  },
  'non-ping native action': (a) => {
    a.events[4].part.state.input.native_request.method = 'workspace.create'
  },
  'duplicate native submit': (a) => {
    a.events.splice(5, 0, structuredClone(a.events[4]))
  },
  'unrelated call query': (a) => {
    a.events[5].part.state.input.call_id = 'unrelated'
  },
  'unknown outcome': (a) => {
    const output = JSON.parse(a.events[5].part.state.output)
    output.data.state = 'outcome_unknown'
    a.events[5].part.state.output = JSON.stringify(output)
  },
  'unrelated retained result': (a) => {
    a.events[6].part.state.input.result_id = 'unrelated'
  },
  'missing result page': (a) => {
    a.events.splice(7, 1)
  },
  'wrong result cursor': (a) => {
    a.events[7].part.state.input.cursor = 'other'
  },
  'corrupt result bytes': (a) => {
    const output = JSON.parse(a.events[7].part.state.output)
    output.data.chunk = Buffer.from('bad').toString('base64')
    a.events[7].part.state.output = JSON.stringify(output)
  },
  'independent call state disagrees': (a) => {
    a.view.state = 'outcome_unknown'
  },
  'independent result bytes disagree': (a) => {
    a.bytes = Buffer.from('different')
  },
  'independent target disagrees': (a) => {
    a.view.target = { ...target, session: 'other' }
  },
  'tool events out of order': (a) => {
    ;[a.events[3], a.events[4]] = [a.events[4], a.events[3]]
  },
  'different second session': (_, b) => {
    for (const e of b.events) {
      e.sessionID = 'ses_other'
      e.part.sessionID = 'ses_other'
    }
  },
  'part session drift': (_, b) => {
    b.events[0].part.sessionID = 'ses_other'
  },
  'missing session identity': (_, b) => {
    for (const e of b.events) {
      delete e.sessionID
      delete e.part.sessionID
    }
  },
  'first-round events replayed': (a, b) => {
    b.events = structuredClone(a.events)
    b.events.at(-2).part.text = `RESULT version=synthetic-version context=${nonce}`
  },
  'wrong recalled context': (_, b) => {
    b.events.at(-2).part.text = 'RESULT version=synthetic-version context=forgotten'
  },
  'missing clean finish': (a) => {
    a.events.pop()
  },
  'error after correct RESULT': (a) => {
    a.events.push({ type: 'error', sessionID: 'ses_synthetic', error: 'synthetic_failure' })
  },
  'tool output truncation': (a) => {
    a.events[6].part.state.metadata = { truncated: true }
  }
}
for (const [name, change] of Object.entries(corruptions)) {
  test(`synthetic acceptance rejects ${name}`, async () => {
    await assert.rejects(exercise(change))
  })
}

test('CLI rejects unapproved or implicit-model runs before opening MCP_CONFIG or spawning a model', () => {
  const script = fileURLToPath(new URL('../../e2e/agent-session.mjs', import.meta.url))
  for (const args of [[], ['synthetic-opencode'], ['--allow-model-requests', 'synthetic-opencode']]) {
    const child = spawnSync(process.execPath, ['--no-env-file', script, ...args], {
      env: { MCP_CONFIG: '/nonexistent/synthetic-mcp.json', DEEPSEEK_API_KEY: 'SYNTHETIC_KEY_MUST_NOT_APPEAR' },
      encoding: 'utf8',
      timeout: 5000
    })
    assert.equal(child.status, 1)
    assert.match(child.stderr, /Explicit model\/budget authorization required/u)
    assert(!child.stderr.includes('ENOENT'))
    assert(!child.stderr.includes('SYNTHETIC_KEY_MUST_NOT_APPEAR'))
    assert.equal(child.stdout, '')
  }
})

test('synthetic pending states poll the same call without a second native submit', async () => {
  await exercise((a) => {
    const submitted = JSON.parse(a.events[4].part.state.output)
    submitted.data.state = 'created'
    submitted.data.contract_ref = null
    a.events[4].part.state.output = JSON.stringify(submitted)
    const pending = structuredClone(a.events[5])
    pending.part.id += '_pending'
    pending.part.callID += '_pending'
    const output = JSON.parse(pending.part.state.output)
    output.data.state = 'connector_accepted'
    delete output.data.result
    pending.part.state.output = JSON.stringify(output)
    a.events.splice(5, 0, pending)
  })
})

test('CLI configuration failure is sanitized and stops before connection or model startup', () => {
  const script = fileURLToPath(new URL('../../e2e/agent-session.mjs', import.meta.url))
  const child = spawnSync(
    process.execPath,
    ['--no-env-file', script, '--allow-model-requests', '/nonexistent/synthetic-opencode', model],
    {
      env: { MCP_CONFIG: '/nonexistent/synthetic-mcp.json', DEEPSEEK_API_KEY: 'SYNTHETIC_KEY_MUST_NOT_APPEAR' },
      encoding: 'utf8',
      timeout: 5000
    }
  )
  assert.equal(child.status, 1)
  assert.equal(child.stdout, '')
  assert.deepEqual(JSON.parse(child.stderr), {
    ok: false,
    phase: 'prepare',
    outcome: 'unconfirmed',
    automatic_retry: false
  })
})

test('driver does not retry a failed model turn or continue after unconfirmed evidence', async () => {
  for (const stage of ['turn', 'independent_read']) {
    let turns = 0
    const a = fixture(1)
    await assert.rejects(
      verifyConversation({
        target,
        nonce,
        runTurn: async () => {
          turns++
          if (stage === 'turn') {
            throw new Error('synthetic_turn_failure')
          }
          return a.events.map((event) => JSON.stringify(event)).join('\n')
        },
        readCall: async () => {
          throw new Error('synthetic_read_failure')
        }
      }),
      /synthetic_(turn|read)_failure/u
    )
    assert.equal(turns, 1)
  }
})

for (const mode of ['valid', 'unknown', 'encoding', 'result_id', 'digest', 'bytes', 'cursor', 'gateway_error']) {
  test(`independent SDK reader with synthetic service: ${mode}`, async () => {
    const sample = fixture(1)
    const reads = []
    const h = httpFixture({
      execute: async (name, args) => {
        reads.push({ name, args })
        if (name === 'runtime_call_get') {
          assert.equal(args.call_id, sample.view.call_id)
          return { data: mode === 'unknown' ? { ...sample.view, state: 'outcome_unknown' } : sample.view }
        }
        assert.equal(name, 'runtime_result_read', 'independent reader must never submit a new native request')
        assert.equal(args.result_id, sample.view.result.result_id)
        if (mode === 'gateway_error') {
          throw new Error('synthetic_service_failure')
        }
        const start = args.cursor ? 12 : 0
        const end = args.cursor ? sample.bytes.length : 12
        const page = {
          result_id: args.result_id,
          encoding: 'base64',
          chunk: sample.bytes.subarray(start, end).toString('base64'),
          eof: !!args.cursor,
          next_cursor: 'synthetic_cursor',
          total_bytes: sample.bytes.length,
          sha256: sample.view.result.sha256
        }
        if (mode === 'encoding') {
          page.encoding = 'utf8'
        }
        if (mode === 'result_id') {
          page.result_id = 'unrelated'
        }
        if (mode === 'digest') {
          page.sha256 = 'b'.repeat(64)
        }
        if (mode === 'bytes') {
          page.total_bytes++
        }
        if (mode === 'cursor') {
          page.eof = false
        }
        return { data: page }
      }
    })
    try {
      await h.client.connect(h.transport)
      if (mode === 'valid') {
        const actual = await readAgentCall(h.client, sample.view.call_id)
        assert.deepEqual(actual, { view: sample.view, bytes: sample.bytes })
        assert.deepEqual(
          reads.map((read) => read.name),
          ['runtime_call_get', 'runtime_result_read', 'runtime_result_read']
        )
        assert.equal(reads[1].args.cursor, undefined)
        assert.equal(reads[2].args.cursor, 'synthetic_cursor')
      } else {
        await assert.rejects(readAgentCall(h.client, sample.view.call_id), /independent_/u)
      }
    } finally {
      await h.close()
    }
  })
}

for (const mode of ['empty_pages', 'page_limit', 'total_deadline', 'unresponsive']) {
  test(`independent SDK reader bounded synthetic service: ${mode}`, async () => {
    const sample = fixture(1)
    let pages = 0
    let release
    const stalled = new Promise((resolve) => {
      release = resolve
    })
    const h = httpFixture({
      execute: async (name, args) => {
        if (name === 'runtime_call_get') {
          if (mode === 'unresponsive') {
            await stalled
          }
          return { data: sample.view }
        }
        assert.equal(name, 'runtime_result_read', 'bounded reader must never submit a native request')
        assert.equal(args.result_id, sample.view.result.result_id)
        pages++
        // 测试服务自己也有截止：旧验收器未拒绝时不能令回归永久挂住。
        assert(pages <= 129, 'synthetic_service_watchdog')
        if (mode === 'total_deadline') {
          await new Promise((resolve) => setTimeout(resolve, 35))
          const start = pages === 1 ? 0 : 12
          const end = pages === 1 ? 12 : sample.bytes.length
          return {
            data: {
              result_id: args.result_id,
              encoding: 'base64',
              chunk: sample.bytes.subarray(start, end).toString('base64'),
              eof: pages === 2,
              next_cursor: 'synthetic_cursor',
              total_bytes: sample.bytes.length,
              sha256: sample.view.result.sha256
            }
          }
        }
        return {
          data: {
            result_id: args.result_id,
            encoding: 'base64',
            chunk: mode === 'empty_pages' ? '' : 'YQ==',
            eof: false,
            next_cursor: `synthetic_cursor_${pages}`,
            total_bytes: sample.bytes.length,
            sha256: sample.view.result.sha256
          }
        }
      }
    })
    let watchdog
    try {
      await h.client.connect(h.transport)
      const pending = readAgentCall(
        h.client,
        sample.view.call_id,
        ['total_deadline', 'unresponsive'].includes(mode) ? { timeoutMs: 50 } : undefined
      )
      const expected =
        mode === 'empty_pages'
          ? /independent_page_no_progress/u
          : mode === 'page_limit'
            ? /independent_result_page_limit/u
            : /independent_read_timeout/u
      await assert.rejects(
        Promise.race([
          pending,
          new Promise((_, reject) => {
            watchdog = setTimeout(() => reject(new Error('synthetic_service_watchdog')), 2000)
          })
        ]),
        expected
      )
      if (mode === 'empty_pages') {
        assert.equal(pages, 1)
      }
      if (mode === 'page_limit') {
        assert.equal(pages, 128)
      }
    } finally {
      clearTimeout(watchdog)
      release()
      await h.close()
    }
  })
}
