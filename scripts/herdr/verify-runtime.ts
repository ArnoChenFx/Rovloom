/** 自有真实 Herdr 的 MCP stdio 工作流验收；报告只写 checkout 外，不读取用户模型凭据。 */
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fields, object, sha, uint, validateTarget } from '../../src/wire/index.js'
import { MAX_RESULT_BYTES, toolNames } from '../../src/mcp/index.js'
import { HERDR_WORKFLOW_METHODS } from '../../src/connector/herdr/methods.js'
import type { JsonObject } from '../../src/wire/types.js'
import { privateFile, privatePath } from '../../src/storage/files.js'
import { readOpenCodeTurn } from './conversation.js'
import type { OpenCodeTurn } from './conversation.js'

/** 只输出稳定诊断码，防止异常堆栈或第三方配置进入公共输出。 */
function failureCode(error: unknown): string {
  if (error instanceof Error && /^[a-z][a-z0-9_]{0,95}$/.test(error.message)) {
    return error.message
  }
  return error instanceof assert.AssertionError ? 'workflow_assertion_failed' : 'workflow_failed'
}

/** 统一envelope的结构化/text副本须相等；工具拒绝与结果字节中的原生error保持边界。 */
export function toolBody(result: unknown): JsonObject {
  const envelope = object(result)
  const content = envelope.content
  if (!Array.isArray(content) || content.length !== 1 || object(content[0]).type !== 'text') {
    throw new Error('workflow_mcp_envelope_invalid')
  }
  const body = object(JSON.parse(String(object(content[0]).text)))
  assert.deepEqual(body, envelope.structuredContent)
  if (envelope.isError) {
    throw new Error(String(object(body.gateway_error).code || 'workflow_gateway_error'))
  }
  return object(body.data)
}

/** 有界观察所属资源，不因短等到期重派发原调用。 */
async function waitFor(test: () => boolean | Promise<boolean>, milliseconds: number, interval = 100): Promise<void> {
  const end = performance.now() + milliseconds
  while (performance.now() < end) {
    if (await test()) {
      return
    }
    await pause(interval)
  }
  throw new Error('workflow_observation_timeout')
}

/** 分页只走真实结果权限端口；不直接读取 Store 正文或数据库。 */
export async function readRuntimeResponse(client: Pick<Client, 'callTool'>, body: JsonObject): Promise<JsonObject> {
  if (body.content_delivery !== 'result_handle') {
    throw new Error('workflow_native_content_unavailable')
  }
  const handle = object(body.result)
  let cursor: string | undefined
  const cursors = new Set<string>()
  const pages: Buffer[] = []
  let bytes = 0
  for (;;) {
    const page = toolBody(
      await client.callTool({
        name: 'runtime_result_read',
        arguments: {
          result_id: handle.result_id,
          ...(cursor ? { cursor } : {}),
          max_bytes: MAX_RESULT_BYTES
        }
      })
    )
    assert.equal(page.result_id, handle.result_id)
    assert.equal(page.encoding, 'base64')
    assert.equal(page.total_bytes, handle.bytes)
    assert.equal(page.sha256, handle.sha256)
    assert.equal(page.expires_at, handle.expires_at)
    const part = Buffer.from(String(page.chunk), 'base64')
    assert(part.byteLength > 0 && part.byteLength <= MAX_RESULT_BYTES)
    pages.push(part)
    bytes += part.length
    if (bytes > 1_048_576) {
      throw new Error('workflow_native_result_too_large')
    }
    if (page.eof === true) {
      const raw = Buffer.concat(pages)
      assert.equal(raw.byteLength, handle.bytes)
      assert.equal(createHash('sha256').update(raw).digest('hex'), handle.sha256)
      assert.equal(page.next_cursor, undefined)
      return object(JSON.parse(raw.toString('utf8')))
    }
    if (typeof page.next_cursor !== 'string' || cursors.has(page.next_cursor)) {
      throw new Error('workflow_result_cursor_invalid')
    }
    cursor = page.next_cursor
    cursors.add(cursor)
  }
}

/** 所有原生参数都取自当前完整 Target 与真实创建结果，不猜测 workspace/pane/Agent 身份。 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      binary: { type: 'string' },
      report: { type: 'string' },
      opencode: { type: 'string' },
      'agent-config': { type: 'string' },
      model: { type: 'string' }
    }
  })
  const checkout = resolve(fileURLToPath(new URL('../..', import.meta.url)))
  for (const value of [values.binary, values.report]) {
    if (!value || !isAbsolute(value)) {
      throw new Error('provide_absolute_binary_and_new_report')
    }
  }
  if (existsSync(values.report!) || resolve(values.report!).startsWith(checkout + '/')) {
    throw new Error('report_must_be_new_and_outside_checkout')
  }
  const withAgent = Boolean(values.opencode || values['agent-config'] || values.model)
  if (
    withAgent &&
    (!values.opencode ||
      !isAbsolute(values.opencode) ||
      !values['agent-config'] ||
      !isAbsolute(values['agent-config']) ||
      !values.model)
  ) {
    throw new Error('agent_requires_explicit_binary_private_config_and_model')
  }
  if (withAgent) {
    privatePath(values['agent-config']!)
    privateFile(values['agent-config']!)
    if (resolve(values['agent-config']!).startsWith(checkout + '/')) {
      throw new Error('agent_config_must_be_outside_checkout')
    }
  }
  const root = mkdtempSync('/workspace/herdr-workflow-')
  chmodSync(root, 0o700)
  const instanceRoot = join(root, 'instance')
  mkdirSync(instanceRoot, { mode: 0o700 })
  const hostReport = join(root, 'host-report.json')
  const client = new Client({ name: 'rovloom-owned-workflow', version: '0.1.0' }, { capabilities: {} })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      '--no-env-file',
      join(checkout, 'test/connector/herdr/workflow-server.ts'),
      '--binary',
      values.binary!,
      '--root',
      instanceRoot,
      '--report',
      hostReport,
      ...(values.opencode ? ['--opencode', values.opencode] : [])
    ],
    cwd: checkout,
    env: { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root, LANG: 'C.UTF-8' },
    stderr: 'pipe'
  })
  let stderrBytes = 0
  let startupStage = 'sdk_connect'
  let fixtureDiagnostics = ''
  transport.stderr?.on(
    'data',
    /** 没有模型配置时只保留自有 fixture 的启动错误，含模型时始终只计数。 */ (data) => {
      stderrBytes += data.length
      if (!withAgent) {
        fixtureDiagnostics += Buffer.from(data).toString('utf8').slice(0, 8192)
      }
    }
  )
  const checks: { name: string; passed: boolean; details?: unknown }[] = []
  const calls: JsonObject[] = []
  let failure: string | undefined
  let hostSummary: JsonObject | undefined
  let target: unknown
  let revision: unknown
  let contract: unknown
  let conversations: unknown
  let twoTurnsVerified = false

  /** 前端短等和原截止分离；只按原 call_id 查询，保留真实原生 ID、结果和 error。 */
  async function native(method: string, params: JsonObject, timeout = 30_000): Promise<JsonObject> {
    const request = { method, params }
    let body = toolBody(
      await client.callTool({
        name: 'runtime_call',
        arguments: {
          target,
          expected_binding_revision: revision,
          contract_ref: contract,
          native_request: request,
          deadline: Date.now() + timeout,
          wait_ms: 1000,
          validation: 'strict'
        }
      })
    )
    const callId = body.call_id
    const end = performance.now() + timeout + 3000
    while (['created', 'dispatching', 'connector_accepted'].includes(String(body.state))) {
      if (performance.now() >= end) {
        throw new Error('workflow_call_observation_timeout')
      }
      body = toolBody(
        await client.callTool({ name: 'runtime_call_get', arguments: { call_id: callId, wait_ms: 1000 } })
      )
    }
    if (body.state !== 'responded') {
      throw new Error('workflow_call_did_not_respond')
    }
    const raw = await readRuntimeResponse(client, body)
    calls.push({ request, call: body, native_response: raw })
    if (raw.error) {
      const code = object(raw.error).code
      throw new Error(typeof code === 'string' && /^[a-z][a-z0-9_]{0,95}$/.test(code) ? code : 'workflow_native_error')
    }
    return object(raw.result)
  }

  try {
    await client.connect(transport)
    startupStage = 'sdk_tools'
    const names: string[] = []
    let toolCursor: string | undefined
    let toolPages = 0
    do {
      const page = await client.listTools(toolCursor ? { cursor: toolCursor } : undefined)
      names.push(...page.tools.map(/** 目录只核对固定通用工具，不扩张为原生方法工具。 */ (tool) => tool.name))
      toolCursor = page.nextCursor
      toolPages++
      assert(toolPages <= 3)
    } while (toolCursor)
    assert.deepEqual(names, toolNames())
    assert.equal(toolPages, 3)
    const bootstrapPath = join(instanceRoot, 'mcp-target.json')
    privateFile(bootstrapPath)
    const bootstrap = object(JSON.parse(readFileSync(bootstrapPath, 'utf8')))
    fields(bootstrap, ['target', 'binding_revision', 'contract_ref'])
    validateTarget(bootstrap.target)
    uint(bootstrap.binding_revision, true)
    sha(bootstrap.contract_ref)
    target = bootstrap.target
    revision = bootstrap.binding_revision
    contract = bootstrap.contract_ref
    const provider = toolBody(
      await client.callTool({
        name: 'providers_get',
        arguments: { machine_id: object(target).machine_id, provider_id: object(target).provider_id }
      })
    )
    assert.equal(provider.kind, 'herdr')
    assert.equal(provider.binding_revision, revision)
    const methods: JsonObject[] = []
    let methodCursor: string | undefined
    const methodCursors = new Set<string>()
    do {
      const page = toolBody(
        await client.callTool({
          name: 'runtime_discover',
          arguments: {
            target,
            expected_binding_revision: revision,
            limit: 20,
            ...(methodCursor ? { cursor: methodCursor } : {})
          }
        })
      )
      assert(Array.isArray(page.items))
      for (const item of page.items) {
        const summary = object(item)
        assert(!Object.hasOwn(summary, 'params_schema'))
        methods.push(summary)
      }
      methodCursor = page.next_cursor as string | undefined
      if (methodCursor) {
        assert(typeof methodCursor === 'string' && !methodCursors.has(methodCursor))
        methodCursors.add(methodCursor)
      }
    } while (methodCursor)
    assert.deepEqual(
      methods.map(/** 只对照现行固定允许集，缺页或重复方法都不能通过验收。 */ (entry) => entry.method).sort(),
      [...HERDR_WORKFLOW_METHODS].sort()
    )
    assert(
      methods.some(
        /** 真实目录须包含后续使用的原生方法，不猜测或补造描述。 */ (entry) => entry.method === 'agent.prompt'
      )
    )
    const described = toolBody(
      await client.callTool({
        name: 'runtime_describe',
        arguments: { target, expected_binding_revision: revision, method: 'agent.prompt' }
      })
    )
    assert.equal(described.contract_ref, contract)
    checks.push({
      name: 'official_sdk_stdio_discovery_and_native_schema',
      passed: true,
      details: { target, revision, described }
    })
    startupStage = 'native_workflow'
    await native('ping', {})
    await native('workspace.list', {})
    const environment: JsonObject = values.opencode
      ? {
          PATH: dirname(values.opencode) + ':/usr/bin:/bin',
          OPENCODE_CONFIG: values['agent-config'],
          OPENCODE_CONFIG_DIR: join(instanceRoot, 'h', '.config', 'opencode'),
          OPENCODE_TUI_CONFIG: join(instanceRoot, 'h', '.config', 'opencode', 'tui.jsonc'),
          OPENCODE_DB: join(instanceRoot, 'opencode.db'),
          OPENCODE_DISABLE_PROJECT_CONFIG: '1',
          OPENCODE_DISABLE_AUTOUPDATE: '1',
          OPENCODE_DISABLE_MODELS_FETCH: '1'
        }
      : {}
    const created = await native('workspace.create', { label: 'owned-workflow', focus: false, env: environment })
    const workspaceId = object(created.workspace).workspace_id
    const paneId = object(created.root_pane).pane_id
    await native('workspace.rename', { workspace_id: workspaceId, label: 'owned-renamed' })
    await native('workspace.focus', { workspace_id: workspaceId })
    const workspace = await native('workspace.get', { workspace_id: workspaceId })
    assert.equal(object(workspace.workspace).label, 'owned-renamed')
    const tabCreated = await native('tab.create', { workspace_id: workspaceId, label: 'owned-tab', focus: false })
    const tabId = object(tabCreated.tab).tab_id
    const splitRoot = object(tabCreated.root_pane).pane_id
    await native('tab.rename', { tab_id: tabId, label: 'owned-tab-renamed' })
    await native('tab.focus', { tab_id: tabId })
    await native('tab.get', { tab_id: tabId })
    await native('tab.list', { workspace_id: workspaceId })
    await native('pane.split', { target_pane_id: splitRoot, direction: 'right', focus: false })
    await native('pane.rename', { pane_id: splitRoot, label: 'owned-pane' })
    await native('pane.focus', { pane_id: splitRoot })
    await native('pane.get', { pane_id: splitRoot })
    await native('pane.list', { workspace_id: workspaceId })
    await native('pane.process_info', { pane_id: splitRoot })
    checks.push({ name: 'native_workspace_tab_pane_management', passed: true })
    const terminalMarker = randomBytes(8).toString('hex')
    await native('pane.send_text', { pane_id: splitRoot, text: "printf '%s%s\\n' 'owned-' '" + terminalMarker + "'" })
    await native('pane.send_keys', { pane_id: splitRoot, keys: ['Enter'] })
    await waitFor(
      /** 预期串从未原样出现在命令中；仅观察自己 pane 的 visible 输出。 */ async () => {
        const read = await native('pane.read', {
          pane_id: splitRoot,
          source: 'visible',
          format: 'text',
          strip_ansi: true
        })
        return String(object(read.read).text).includes('owned-' + terminalMarker)
      },
      10_000,
      1000
    )
    checks.push({ name: 'native_terminal_input_and_independent_output', passed: true })
    await native('agent.list', {})
    if (withAgent) {
      const name = 'owned-agent'
      await native('pane.focus', { pane_id: paneId })
      const started = await native(
        'agent.start',
        {
          name,
          kind: 'opencode',
          pane_id: paneId,
          args: ['--model', values.model],
          timeout_ms: 30_000
        },
        40_000
      )
      const startedAgent = object(started.agent)
      await waitFor(
        /** 启动提交与交互就绪分开观察，不把 launch_pending 当作回答。 */ async () => {
          const state = object((await native('agent.get', { target: name })).agent)
          assert.equal(state.terminal_id, startedAgent.terminal_id)
          return state.interactive_ready === true
        },
        40_000,
        1000
      )
      const marker = randomBytes(8).toString('hex')
      const expected = [...marker].reverse().join('')
      const firstPrompt =
        'Remember this private test marker for our next turn: ' + marker + '. Reply only SAVED. Do not use tools.'
      const firstCall = await native(
        'agent.prompt',
        {
          target: name,
          text: firstPrompt,
          wait: { until: ['idle', 'done', 'blocked'], timeout_ms: 90_000 }
        },
        100_000
      )
      let session: JsonObject | undefined
      await waitFor(
        /** conversation ID 必须来自实际加载的官方 hook，不调用 report_agent_session 伪造。 */ async () => {
          const state = object((await native('agent.get', { target: name })).agent)
          if (!state.agent_session) {
            return false
          }
          session = object(state.agent_session)
          assert.equal(state.terminal_id, startedAgent.terminal_id)
          assert.equal(session.source, 'herdr:opencode')
          assert.equal(session.agent, 'opencode')
          assert.equal(session.kind, 'id')
          return typeof session.value === 'string' && session.value.length > 0
        },
        15_000,
        1000
      )
      const selectedSession = session!
      const database = join(instanceRoot, 'opencode.db')
      let firstTurn: OpenCodeTurn | undefined
      await waitFor(
        /** 只读自有 DB 的实际 parent/message/text；原生状态不能替代本轮回答。 */ () => {
          firstTurn = readOpenCodeTurn({ database, session_id: String(selectedSession.value), prompt: firstPrompt })
          return firstTurn !== undefined
        },
        100_000
      )
      assert.match(firstTurn!.text, /SAVED/)
      const beforeSecond = object((await native('agent.get', { target: name })).agent)
      assert.deepEqual(beforeSecond.agent_session, selectedSession)
      const secondPrompt =
        'Output only the reverse of the marker I asked you to remember in my previous turn. Do not use tools.'
      assert.equal(secondPrompt.includes(marker) || secondPrompt.includes(expected), false)
      const secondCall = await native(
        'agent.prompt',
        {
          target: name,
          text: secondPrompt,
          wait: { until: ['idle', 'done', 'blocked'], timeout_ms: 90_000 }
        },
        100_000
      )
      let secondTurn: OpenCodeTurn | undefined
      await waitFor(
        /** 第二轮必须是新 user/assistant ID，同一真实 conversation 且 parent 精确关联本轮。 */ () => {
          secondTurn = readOpenCodeTurn({
            database,
            session_id: String(selectedSession.value),
            prompt: secondPrompt,
            excluded_message_ids: [firstTurn!.user_message_id, firstTurn!.assistant_message_id]
          })
          return secondTurn !== undefined
        },
        100_000
      )
      assert.equal(secondTurn!.text.trim(), expected)
      const afterSecond = object((await native('agent.get', { target: name })).agent)
      assert.deepEqual(afterSecond.agent_session, selectedSession)
      for (const field of ['terminal_id', 'name', 'agent']) {
        assert.equal(afterSecond[field], beforeSecond[field])
      }
      assert.notEqual(firstTurn!.assistant_message_id, secondTurn!.assistant_message_id)
      const prompts = calls.filter(
        /** 唯一呼叫身份直接来自两次真实 Store 与原生响应。 */ (entry) =>
          object(entry.request).method === 'agent.prompt'
      )
      assert.equal(prompts.length, 2)
      assert.notEqual(object(prompts[0]!.call).call_id, object(prompts[1]!.call).call_id)
      assert.notEqual(object(prompts[0]!.native_response).id, object(prompts[1]!.native_response).id)
      conversations = {
        session: selectedSession,
        first_prompt: firstPrompt,
        second_prompt: secondPrompt,
        first_turn: firstTurn,
        second_turn: secondTurn,
        first_native_result: firstCall,
        second_native_result: secondCall,
        before_second: beforeSecond,
        after_second: afterSecond
      }
      twoTurnsVerified = true
      checks.push({ name: 'same_native_conversation_two_independent_real_turns', passed: true })
    }
    assert.equal(typeof paneId, 'string')
    const beforeClose = await native('pane.list', { workspace_id: workspaceId })
    if (!Array.isArray(beforeClose.panes)) {
      throw new Error('workflow_owned_pane_inventory_invalid')
    }
    for (const pane of beforeClose.panes) {
      await native('pane.process_info', { pane_id: object(pane).pane_id })
    }
    await native('tab.close', { tab_id: tabId })
    await native('workspace.close', { workspace_id: workspaceId })
    checks.push({ name: 'owned_native_lifecycle_close', passed: true })
  } catch (error) {
    failure = failureCode(error)
  } finally {
    try {
      await client.notification({ method: 'notifications/rovloom_fixture_finish' })
      await waitFor(/** owner 清理完成后才让 SDK 终止 stdio 子进程。 */ () => existsSync(hostReport), 40_000)
      hostSummary = object(JSON.parse(readFileSync(hostReport, 'utf8')))
    } catch {
      failure ??= 'workflow_host_cleanup_report_missing'
    }
    await client.close()
    if (
      hostSummary &&
      Object.values(object(hostSummary.cleanup)).every(
        /** PID 数量为计数，其余清理字段都须为 true。 */ (value) => typeof value === 'number' || value === true
      )
    ) {
      rmSync(root, { recursive: true })
    } else {
      failure ??= 'workflow_owned_cleanup_incomplete'
    }
    const report = {
      pass: !failure,
      acceptance: withAgent ? 'full_agent_workflow' : 'management_only',
      two_turns_verified: twoTurnsVerified,
      checks,
      failure,
      calls,
      conversations,
      host: hostSummary,
      stderr_bytes: stderrBytes,
      startup_stage: startupStage,
      fixture_diagnostics: withAgent ? undefined : fixtureDiagnostics,
      temporary_root_removed: !existsSync(root)
    }
    writeFileSync(values.report!, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    console.log(
      JSON.stringify({
        pass: report.pass,
        acceptance: report.acceptance,
        two_turns_verified: report.two_turns_verified,
        failure,
        checks: checks.length,
        report_sha256: createHash('sha256').update(readFileSync(values.report!)).digest('hex')
      })
    )
    if (failure) {
      process.exitCode = 1
    }
  }
}

if (import.meta.main) {
  await main()
}
