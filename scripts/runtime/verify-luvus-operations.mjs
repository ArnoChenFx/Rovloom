// 在自有官方 Luvus 实例上贯通窗口/pane/Agent 操作的真实 WSS 请求与结果；不接入用户会话或伪造 Agent。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { isAbsolute, join, normalize } from 'node:path'
import { parseArgs } from 'node:util'
import { createManagedSmokeCleanup } from './managed-smoke-cleanup.mjs'
import { prepareIsolatedOpenCode } from './opencode-smoke-setup.mjs'
import { verifyStableLuvusSelection } from './luvus-stable-selection.mjs'
import {
  openGatewayState,
  initializeManagedLuvusRoot,
  createGatewayRuntime,
  createConnectorRuntime,
  createLuvusProductionSources,
  LUVUS_OPERATION_METHODS,
  luvusOperationValidation,
  MANAGED_LUVUS_REVISION,
  MANAGED_LUVUS_CLASSIFICATION,
  DEVELOPMENT_LUVUS_SHA256
} from '../../dist/src/runtime/index.js'
import { contractRef, hash } from '../../dist/src/wire/index.js'

/** 只接受明确的官方 binary 与受保护临时父目录，不读取产品配置或现有用户 HOME。 */
function argumentsForSmoke() {
  const { values } = parseArgs({
    options: {
      binary: { type: 'string' },
      'opencode-binary': { type: 'string' },
      'stable-selection': { type: 'boolean' },
      'remote-gateway': { type: 'boolean' },
      'gateway-schema-bundle': { type: 'string' },
      'temporary-parent': { type: 'string' },
      'acknowledge-nonproduction': { type: 'boolean' }
    }
  })
  if (!values['acknowledge-nonproduction']) {
    throw new Error('nonproduction_acknowledgement_required')
  }
  if (values['stable-selection'] && values['opencode-binary']) {
    throw new Error('stable_selection_cannot_start_agent')
  }
  if (!!values['remote-gateway'] !== !!values['gateway-schema-bundle']) {
    throw new Error('remote_gateway_schema_required')
  }
  for (const path of [
    values.binary,
    values['temporary-parent'],
    ...(values['opencode-binary'] ? [values['opencode-binary']] : []),
    ...(values['gateway-schema-bundle'] ? [values['gateway-schema-bundle']] : [])
  ]) {
    if (!path || !isAbsolute(path) || normalize(path) !== path) {
      throw new Error('canonical_absolute_path_required')
    }
  }
  return values
}
const paths = argumentsForSmoke()
// 验收本身也使用短私有 root 名，避免官方长路径别名落到受保护 state_root 之外；不放宽原检查。
const root = mkdtempSync(join(paths['temporary-parent'], '.rvop-'))
const cleanup = createManagedSmokeCleanup(root)
const checks = []
const timings = []
const observedCalls = new Map()
const observedClaims = new WeakSet()
const observedSockets = new WeakSet()
/** 仅记录本轮实际 call/attempt；不输出身份，也不把 socket 写出等同于原生执行。 */
function observe(callId, event, attemptId) {
  assert.equal(typeof callId, 'string')
  let row = observedCalls.get(callId)
  if (!row) {
    row = { created: 0, confirmed_claims: 0, native_write_calls: 0, original_result_frames: 0 }
    observedCalls.set(callId, row)
  }
  if (attemptId !== undefined) {
    assert.equal(typeof attemptId, 'string')
    if (row.attempt_id !== undefined) {
      assert.equal(row.attempt_id, attemptId)
    }
    row.attempt_id = attemptId
  }
  row[event]++
}
/** 只观察本轮工厂资源，保留 claims 私有品牌、原 backend、实际 socket 和全部认证检查。 */
function observeSession(resource) {
  if (!observedClaims.has(resource.claims)) {
    observedClaims.add(resource.claims)
    const originalClaim = resource.claims.claim
    resource.claims.claim = /** 原 claim 成功返回已包含 COMMIT 后独立读回确认；失败不计数。 */ function (...args) {
      const result = Reflect.apply(originalClaim, this, args)
      observe(args[0].call_id, 'confirmed_claims', args[0].attempt_id)
      return result
    }
  }
  const originalVerify = resource.verifyPeer
  resource.verifyPeer = /** 同一 socket 的原内核 peer 核验成功后才安装本轮观察器。 */ async function (...args) {
    const result = await Reflect.apply(originalVerify, this, args)
    const [socket, , binding] = args
    if (!observedSockets.has(socket)) {
      observedSockets.add(socket)
      const originalWrite = socket.write
      socket.write = /** 原 write 正常返回才计一次；保留接收者、参数、返回值及背压语义。 */ function (...writeArgs) {
        const written = Reflect.apply(originalWrite, this, writeArgs)
        observe(binding.call_id, 'native_write_calls', binding.attempt_id)
        return written
      }
    }
    return result
  }
  return resource
}
/** 固定空白拓扑必须实际逐 call、逐 attempt 各一次；不能从 helper 预期调用数推算证据。 */
function stableObservations() {
  assert.equal(observedCalls.size, 58)
  const counts = { created: 0, confirmed_claims: 0, native_write_calls: 0, original_result_frames: 0 }
  for (const row of observedCalls.values()) {
    assert.equal(typeof row.attempt_id, 'string')
    for (const event of Object.keys(counts)) {
      assert.equal(row[event], 1)
      counts[event] += row[event]
    }
  }
  return { ...counts, per_call_attempt_once: true }
}
let state
let nativeRoot
let gatewayResources
let connectorResources
let gateway
let connector
let stage = 'initialize'
let report
let lastNativeError
let agentInputOutput
let stableSelection
try {
  for (const name of [
    'gateway',
    'home',
    'state',
    'project',
    'control',
    'connector',
    ...(paths['stable-selection'] ? ['project-a', 'project-c'] : [])
  ]) {
    mkdirSync(join(root, name), { mode: 0o700 })
  }
  for (const name of ['config', 'data', 'cache', 'runtime']) {
    mkdirSync(join(root, 'home', name), { mode: 0o700 })
  }
  state = openGatewayState({
    state_directory: join(root, 'gateway'),
    store: {
      management: /* 仅初始化本轮合成设备和精确 provider。 */ () => ({
        actor: 'isolated_operations_admin',
        confirmation_id: randomUUID()
      })
    },
    changed: /* 身份变化仍关闭同一实际设备连接。 */ (machine) => gateway?.transport.disconnect(machine)
  })
  const machine = state.store.register('isolated_operations')
  const credential = {
    ...state.store.redeem(state.store.issueEnrollment(machine.machine_id)),
    recovery_generation: state.store.generation()
  }
  const target = {
    machine_id: machine.machine_id,
    provider_id: 'luvus_operations',
    profile: 'session',
    session: 'isolated_operations'
  }
  const config = {
    target,
    binding_revision: 1,
    config_ref: 'isolated_operations',
    binary: paths.binary,
    binary_sha256: DEVELOPMENT_LUVUS_SHA256,
    state_root: join(root, 'state'),
    home: join(root, 'home'),
    cwd: join(root, 'project'),
    transport: 'ipc'
  }
  // 保留既有 root 格式；本轮 Owner 路径不发行 token，也不消费此旧有限签发配置。
  nativeRoot = await initializeManagedLuvusRoot({
    record_path: join(root, 'control', 'root.json'),
    config,
    custody_policy: { scopes: ['read'], methods: ['automation.list'], max_token_ttl_s: 120 }
  })
  if (paths['opencode-binary']) {
    stage = 'prepare_isolated_opencode'
    await prepareIsolatedOpenCode({
      binary: paths['opencode-binary'],
      home: config.home,
      state_root: config.state_root
    })
  }
  const caller = {
    id: 'isolated_operations_caller',
    policy: {
      revision: 'operations_caller1',
      grants: [{ target, methods: [...LUVUS_OPERATION_METHODS], actions: ['dispatch', 'read', 'cancel'] }]
    }
  }
  const local = { ...structuredClone(caller.policy), revision: 'operations_local1' }
  const sources = createLuvusProductionSources()
  const ownerReference = {
    reference: config.config_ref,
    value: {
      kind: 'luvus',
      authentication: 'local_owner',
      native: {
        mode: 'managed',
        root_record: join(root, 'control', 'root.json'),
        expected_root_id: nativeRoot.root_id,
        expected_root_revision: nativeRoot.root_revision
      },
      peer_policy_revision: local.revision,
      principal_id: caller.id,
      policies: { caller: caller.policy, local },
      storage_mode: 'create'
    }
  }
  stage = 'connector_production_source'
  connectorResources = await sources.connector({ state_dir: join(root, 'connector') }, [ownerReference])
  stage = 'gateway_production_attach'
  const attachReference = structuredClone(ownerReference)
  attachReference.value.native.mode = 'attach'
  let gatewayReference = attachReference
  if (paths['remote-gateway']) {
    const schema = readFileSync(paths['gateway-schema-bundle'], 'utf8')
    gatewayReference = {
      reference: config.config_ref,
      value: {
        kind: 'luvus',
        authentication: 'remote_connector',
        binding: {
          machine_id: target.machine_id,
          provider_id: target.provider_id,
          kind: 'luvus',
          config_ref: config.config_ref,
          binding_revision: config.binding_revision,
          enabled: true
        },
        target,
        peer_policy_revision: local.revision,
        contract: {
          binary_version: '0.14.3',
          binary_sha256: config.binary_sha256,
          schema_sha256: hash(schema),
          adapter_revision: MANAGED_LUVUS_REVISION,
          classification_revision: MANAGED_LUVUS_CLASSIFICATION,
          schema_bundle: schema
        },
        raw_grant: { principal_id: caller.id, methods: [...LUVUS_OPERATION_METHODS] }
      }
    }
  }
  gatewayResources = await sources.gateway({ state_dir: join(root, 'gateway') }, [gatewayReference])
  const provider = gatewayResources.providers[0]
  state.store.defineProvider(provider.binding)
  checks.push('concrete_production_factories')
  execFileSync(
    '/usr/bin/openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=isolated-loopback',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
      '-keyout',
      join(root, 'loopback.key'),
      '-out',
      join(root, 'loopback.crt')
    ],
    { stdio: 'ignore' }
  )
  const cert = readFileSync(join(root, 'loopback.crt'), 'utf8')
  const key = readFileSync(join(root, 'loopback.key'), 'utf8')
  const offer = {
    major: 2,
    minor: 0,
    capabilities: ['rpc'],
    required: ['rpc']
  }
  gateway = await createGatewayRuntime({
    lifecycle: state.lifecycle,
    channels: state.channels,
    identities: {
      principal: /* 仅本轮合成 caller 可以调用。 */ (who) => (who.principal_id === caller.id ? caller : null),
      administrator: /* 普通操作不提供管理员产品。 */ () => null
    },
    localPolicies: /* 只返回本轮完整 Target 策略。 */ () => local,
    providers: gatewayResources.providers,
    listener: { hostname: '127.0.0.1', port: 0, tls: { cert, key }, offer },
    release: /* 设备通道关闭后先释放实际 attach，再释放同一 Store。 */ async () => {
      try {
        await gatewayResources.release()
      } finally {
        state.close()
      }
    }
  })
  connector = await createConnectorRuntime({
    ...connectorResources,
    session: /** 真实认证 epoch 仍由原工厂构建；稳定选择模式只附加本轮资源观察。 */ (connection) => {
      const resource = connectorResources.session(connection)
      return paths['stable-selection'] ? observeSession(resource) : resource
    },
    transport: { url: gateway.transport.url, ca: cert, credential: /* 只使用本轮配对凭据。 */ () => credential, offer }
  })
  /** 只等待观察结果，不刷新任何业务 deadline。 */
  async function until(check) {
    const end = performance.now() + 45000
    while (!check()) {
      if (performance.now() >= end) {
        throw new Error('operations_wait_timeout')
      }
      await new Promise(/* 短轮询让出事件循环。 */ (resolve) => setTimeout(resolve, 20))
    }
  }
  await until(
    /* 两端都经过实际认证后才调用。 */ () =>
      connector.transport.status().phase === 'ready' &&
      gateway.transport.status().devices.some(/* 此实际设备必须 ready。 */ (device) => device.ready)
  )
  const connection = gateway.transport.currentConnection(target.machine_id)
  assert(connection)
  state.store.assertConnection(connection)
  const catalog = await gateway.runAuthenticated(
    { principal_id: caller.id },
    /* 使用同一当前主体和实际 epoch，不从展示状态生成来源。 */ () => gateway.catalog.resolve(target, caller)
  )
  assert(catalog)
  const reference = contractRef(catalog.record.wire.source)
  assert.equal(catalog.source.binding.connection_epoch, connection.connection_epoch)
  assert.equal(catalog.source.binding.server_generation, catalog.record.wire.source.runtime_generation)
  checks.push('catalog_uses_actual_authenticated_epoch')
  /** 每次原参数经唯一 Router/Wire/native/result 门禁，保留原生 result/error 不改写。 */
  async function rpc(method, params) {
    const started = performance.now()
    lastNativeError = undefined
    stage = method + ':admit'
    const admitted = await gateway.runAuthenticated(
      { principal_id: caller.id },
      /* 只对本次显式操作准入一次。 */ () =>
        gateway.admit({
          target,
          native_request: { method, params },
          options: {
            binding_revision: 1,
            contract_ref: reference,
            validation: luvusOperationValidation(method),
            deadline: Date.now() + 30000
          }
        })
    )
    assert.equal(admitted.created, true)
    if (paths['stable-selection']) {
      observe(admitted.call.call_id, 'created')
    }
    stage = method + ':response'
    await until(
      /* 等待唯一 Store 原生响应提交，未知不自动重放。 */ () => {
        const call = state.store.call(caller.id, admitted.call.call_id)
        if (call.state === 'outcome_unknown') {
          throw new Error('operations_outcome_unknown')
        }
        return call.state === 'responded'
      }
    )
    stage = method + ':result_open'
    const result = await gateway.runAuthenticated(
      { principal_id: caller.id },
      /* 当前 caller 打开原 Wire 结果。 */ () => gateway.results.open(admitted.call.call_id)
    )
    let offset = 0
    const chunks = []
    while (true) {
      stage = method + ':result_read'
      const page = await gateway.runAuthenticated(
        { principal_id: caller.id },
        /* 每页继续通过原门禁。 */ () => gateway.results.read(result.result_id, offset, 4096)
      )
      chunks.push(Buffer.from(page.data, 'base64'))
      if (page.eof) {
        break
      }
      offset = page.next_cursor
    }
    const frame = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (paths['stable-selection']) {
      observe(admitted.call.call_id, 'original_result_frames')
    }
    stage = method + ':native_result'
    timings.push({ method, elapsed_ms: Math.round(performance.now() - started) })
    lastNativeError =
      typeof frame.error?.code === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(frame.error.code)
        ? frame.error.code
        : undefined
    return frame
  }
  const snapshot = await rpc('session.snapshot', {})
  assert(!snapshot.error)
  checks.push('original_snapshot')
  const workspaces = await rpc('workspace.list', {})
  assert(!workspaces.error)
  checks.push('workspace_discovery')
  const tabs = await rpc('tab.list', {})
  assert(!tabs.error)
  checks.push('tab_discovery')
  const panes = await rpc('pane.list', { all_tabs: true })
  assert(!panes.error)
  checks.push('pane_discovery')
  const rows = panes.result.panes
  assert(Array.isArray(rows) && rows.length > 0)
  const selected = rows[0]
  const pane = String(selected.pane)
  assert(/^[1-9][0-9]*$/.test(pane))
  const get = await rpc('pane.get', { pane })
  assert(!get.error)
  checks.push('explicit_pane_selection')
  const status = await rpc('pane.status', { pane })
  assert(!status.error)
  checks.push('native_pane_status')
  const rename = await rpc('pane.rename', { pane, name: 'isolated-native-selection' })
  assert(!rename.error)
  checks.push('native_pane_management')
  if (paths['opencode-binary']) {
    const start = await rpc('agent.start', {
      name: 'lab-opencode',
      kind: 'opencode',
      pane,
      args: ['--model', 'opencode/big-pickle', '--agent', 'build'],
      timeout_s: 5
    })
    assert(!start.error)
    checks.push('real_opencode_start_once')
  }
  const agents = await rpc('agent.list', {})
  assert(!agents.error && Array.isArray(agents.result.agents))
  checks.push('native_agent_discovery')
  const sessions = await rpc('agent.sessions', {})
  assert(!sessions.error)
  checks.push('native_agent_session_discovery')
  if (paths['opencode-binary']) {
    const selectedAgent = agents.result.agents.find(
      /* 只选择本次显式启动的同一 pane/名称，不从最近 Agent 推测。 */ (row) =>
        row.name === 'lab-opencode' && String(row.pane) === pane
    )
    assert(selectedAgent && selectedAgent.agent === 'opencode' && typeof selectedAgent.terminal_id === 'string')
    const selectedStatus = await rpc('agent.get', { target: 'lab-opencode' })
    assert(!selectedStatus.error)
    checks.push('real_agent_selected_native_status')
    const prompt = await rpc('agent.prompt', {
      target: 'lab-opencode',
      terminal_id: selectedAgent.terminal_id,
      text: 'Return exactly ROVLOOM_NATIVE_INPUT_PROBE. Do not run commands or access files.',
      strict: false
    })
    assert(!prompt.error && prompt.result.submitted === true)
    checks.push('real_agent_prompt_queued_once')
    const output = await rpc('agent.read', { target: 'lab-opencode', lines: 40, source: 'recent' })
    assert(!output.error && typeof output.result.text === 'string')
    assert.equal(output.result.terminal_id, selectedAgent.terminal_id)
    checks.push('real_agent_native_output_read')
    const after = await rpc('agent.list', {})
    const same = after.result.agents.find(
      /* 输入后仍要求原 pane、名称和终端身份；null session 保留未知。 */ (row) =>
        row.name === selectedAgent.name &&
        row.pane === selectedAgent.pane &&
        row.terminal_id === selectedAgent.terminal_id
    )
    assert(same)
    if (selectedAgent.session !== null && selectedAgent.session !== undefined) {
      assert.equal(same.session, selectedAgent.session)
    }
    checks.push('real_agent_input_output_keeps_identity')
    agentInputOutput = {
      queued: true,
      output_bytes: Buffer.byteLength(output.result.text),
      session_known: typeof same.session === 'string',
      native_state: same.status,
      native_state_source: same.state_source,
      model_reply_verified: false
    }
  }
  const missing = await rpc('agent.get', { target: 'never-created-isolated-agent' })
  assert(missing.error)
  checks.push('missing_agent_is_native_error')
  const again = await rpc('pane.list', { all_tabs: true })
  assert(!again.error)
  assert(
    again.result.panes.some(
      /* 同一原生 pane 不可换成最近对象。 */ (row) =>
        String(row.pane) === pane && row.terminal_id === selected.terminal_id
    )
  )
  checks.push('same_session_and_terminal_identity')
  if (paths['stable-selection']) {
    stage = 'stable_selection'
    stableSelection = await verifyStableLuvusSelection(rpc, {
      project: config.cwd,
      projectA: join(root, 'project-a'),
      projectC: join(root, 'project-c')
    })
    assert.equal(stableSelection.native_rpc, 47)
    assert.equal(stableSelection.checks.length, 27)
    assert.equal(timings.length, 58)
  }
  await connector.close()
  assert.equal(gateway.transport.status().stopped, false)
  checks.push('gateway_survives_connector_exit')
  assert.equal(gateway.transport.currentConnection(target.machine_id), undefined)
  assert.equal(provider.ready(), false)
  assert.equal(
    await gateway.runAuthenticated(
      { principal_id: caller.id },
      /* 断连和真实 native 退出后，旧目录不能继续交付来源。 */ () => gateway.catalog.resolve(target, caller)
    ),
    undefined
  )
  checks.push('disconnect_invalidates_catalog_and_native_source')
  report = {
    kind: 'official_luvus_operations_wss',
    gateway_source: paths['remote-gateway'] ? 'pinned_remote_authenticated_epoch' : 'local_attach',
    deployment: 'same_host_isolated_regression',
    passed: true,
    checks,
    timings,
    ...(stableSelection
      ? {
          stable_selection: stableSelection,
          native_rpc: timings.length,
          dispatch_observations: stableObservations(),
          model_requests: 0,
          tokens_issued: 0
        }
      : {}),
    agent_count: agents.result.agents.length,
    agent_state_source: 'native_response',
    conversation: agentInputOutput ? 'not_verified_native_input_output_only' : 'not_exercised_no_real_agent_configured',
    agent_input_output: agentInputOutput,
    user_sessions_used: false,
    paid_fallback: false
  }
} catch (error) {
  cleanup.observeFailure(error)
  console.error(
    JSON.stringify({
      stage,
      code:
        typeof error?.code === 'string'
          ? error.code
          : ['operations_wait_timeout', 'operations_outcome_unknown'].includes(error?.message)
            ? error.message
            : 'luvus_operations_failed',
      native_error_code: lastNativeError,
      timings
    })
  )
  process.exitCode = 1
} finally {
  for (const operation of [
    /* 先停止 Connector。 */ async () => connector?.close(),
    /* 再停止 Gateway。 */ async () => {
      await gateway?.close()
      if (!gateway) {
        state?.close()
      }
    },
    /* 工厂已交付但角色未创建时也释放持久记录及本轮实际 native child。 */ async () => connectorResources?.release(),
    /* Gateway 构造失败也释放本机只读 attach，不接管 native。 */ async () => gatewayResources?.release(),
    /* 最后释放root能力。 */ () => nativeRoot?.close()
  ]) {
    try {
      await operation()
    } catch (error) {
      cleanup.cleanupFailure(error)
      process.exitCode = 1
    }
  }
  const result = cleanup.finish()
  if (report) {
    report.cleanup = result
  }
  if (result.cleanup_pending) {
    console.error(JSON.stringify({ stage: 'cleanup', ...result }))
    process.exitCode = 1
  }
}
if (report && process.exitCode !== 1) {
  console.log(JSON.stringify(report))
}
