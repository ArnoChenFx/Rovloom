// 只在自有空白Luvus实例与临时合成身份上验收公开main的双角色和HTTP MCP，不读取用户会话或伪造原生回复。
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { createServer, connect } from 'node:net'
import { once } from 'node:events'
import { join, isAbsolute, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { setTimeout } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  openGatewayState,
  initializeManagedLuvusRoot,
  LUVUS_OPERATION_METHODS,
  DEVELOPMENT_LUVUS_SHA256
} from '../../src/runtime/index.ts'
import { saveCredential } from '../../src/transport/index.ts'
import { configTemplate, CLI_ERROR_CODES } from '../../src/cli/config.ts'
import { runFixedProcess } from '../../src/connector/luvus/io.ts'
import { localLimits } from '../../src/connector/luvus/local.ts'
import { LuvusAdapterError } from '../../src/connector/luvus/types.ts'
import { FIXED_LUVUS_SCHEMA_SHA256 } from '../../src/runtime/native-control.ts'
import { MANAGED_LUVUS_CLASSIFICATION, MANAGED_LUVUS_REVISION } from '../../src/runtime/native-source.ts'
import {
  LUVUS_FLOW_CALL_LIMIT,
  LUVUS_FLOW_INTENT_MS,
  LUVUS_FLOW_METHODS,
  verifyLuvusMcpOperations
} from './luvus-sdk-flow.mjs'
import { luvusOperationValidation } from '../../src/runtime/luvus-operations.ts'
import { NativeFlowError } from '../../test/mcp/native-conversation.ts'
import { createManagedSmokeCleanup } from '../runtime/managed-smoke-cleanup.mjs'
import { prepareIsolatedOpenCode } from '../runtime/opencode-smoke-setup.mjs'

// 仅接纳固定官方binary和显式私有临时父目录；没有用户配置、token或远端URL参数。
function options() {
  const { values } = parseArgs({
    options: {
      binary: { type: 'string' },
      'opencode-binary': { type: 'string' },
      'built-cli': { type: 'boolean' },
      'standalone-cli': { type: 'boolean' },
      'minimum-native': { type: 'boolean' },
      'remote-gateway': { type: 'boolean' },
      'temporary-parent': { type: 'string' },
      'acknowledge-nonproduction': { type: 'boolean' }
    }
  })
  assert(values['acknowledge-nonproduction'])
  assert(!(values['built-cli'] && values['standalone-cli']))
  assert(!(values['minimum-native'] && values['opencode-binary']))
  for (const value of [
    values.binary,
    values['temporary-parent'],
    ...(values['opencode-binary'] ? [values['opencode-binary']] : [])
  ]) {
    assert(value && isAbsolute(value) && normalize(value) === value)
  }
  return values
}

// 由内核选取回环端口，不接触其它用户listener或预设端口。
async function port() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const value = server.address().port
  server.close()
  await once(server, 'close')
  return value
}

// 角色仅接收普通config路径；秘密只在自有私有文件与SDK内存头中，不进入argv或输出。
function start(role, config) {
  const entry = args['built-cli'] ? '../../dist/src/cli/main.js' : '../../src/cli/main.ts'
  const standalone = fileURLToPath(new URL('../../dist/release/bun-linux-x64/candidate/rovloom', import.meta.url))
  const child = spawn(
    args['standalone-cli'] ? standalone : process.execPath,
    [
      ...(args['standalone-cli'] ? [] : ['--no-env-file', fileURLToPath(new URL(entry, import.meta.url))]),
      role,
      '--config',
      config
    ],
    {
      env: { PATH: process.env.PATH ?? '', NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe']
    }
  )
  let out = ''
  let err = ''
  let spawnFailed = false
  child.once(
    'error',
    /* 错误原文不进入报告，只记录本次子进程未能正常启动。 */ () => {
      spawnFailed = true
    }
  )
  child.stdout.on(
    'data',
    /* 运行期间stdout必须保持为空。 */ (chunk) => {
      out = (out + chunk).slice(0, 65_536)
    }
  )
  child.stderr.on(
    'data',
    /* 原文只用于本地断言，不写入验收报告。 */ (chunk) => {
      err = (err + chunk).slice(0, 65_536)
    }
  )
  const closed = new Promise(
    /* 在启动即订阅close，不能晚绑定丢失真实退出。 */ (resolve) => child.once('close', resolve)
  )
  child.stdin.end()
  return {
    child,
    closed,
    output: /* 只供内部检查无秘密输出。 */ () => ({ out, err }),
    diagnostic: /* 只报告退出事实及CLI已定义固定码，不转发任意stderr正文。 */ () => ({
      role,
      exit_code: child.exitCode,
      signal: child.signalCode,
      spawn_failed: spawnFailed,
      stdout_bytes: Buffer.byteLength(out),
      stderr_bytes: Buffer.byteLength(err),
      cli_code: [...CLI_ERROR_CODES, 'runtime_failed'].find(
        /* 只接受整个stderr与现行固定码完全相等的输出。 */ (code) => err === code + '\n'
      )
    })
  }
}

// 有界观察实际CLI退出，不能以信号发出代替原生资源已释放。
async function stop(role, verify = true) {
  if (!role) {
    return
  }
  if (role.child.exitCode === null && role.child.signalCode === null) {
    role.child.kill('SIGTERM')
  }
  let timer
  try {
    const code = await Promise.race([
      role.closed,
      new Promise(
        /* 只拒绝等待，不按PID补杀或删除归属材料。 */ (_resolve, reject) => {
          timer = globalThis.setTimeout(
            /* 固定关闭观察沿用现行5秒预算。 */ () => reject(new Error('cli_close_pending')),
            5000
          )
        }
      )
    ])
    if (verify) {
      assert.equal(code, 0)
      assert.deepEqual(role.output(), { out: '', err: '' })
    }
  } finally {
    globalThis.clearTimeout(timer)
  }
}

// 只观察启动结果，既不重发业务输入也不刷新产品中的固定截止。
async function until(check, role) {
  const end = Date.now() + 45_000
  const controller = new AbortController()
  const remaining = /* 同一阶段的固定截止不能被探针重试延长。 */ () => Math.max(0, end - Date.now())
  const timer = globalThis.setTimeout(
    /* 终结正在执行的只读探针，保证finally仍有机会释放自有角色。 */ () => controller.abort('deadline'),
    remaining()
  )
  try {
    for (;;) {
      assert(role.child.exitCode === null && role.child.signalCode === null, 'cli_start_failed')
      assert(!controller.signal.aborted && remaining() > 0, 'cli_start_wait_expired')
      if (await check(controller.signal, remaining)) {
        return
      }
      await setTimeout(Math.min(100, remaining()), undefined, { signal: controller.signal })
    }
  } finally {
    globalThis.clearTimeout(timer)
    controller.abort('closed')
  }
}

const args = options()
const startedAt = performance.now()
const root = mkdtempSync(join(args['temporary-parent'], '.rovloom-cli-native-'))
const cleanup = createManagedSmokeCleanup(root)
const checks = []
const observations = []
const intentTimings = new Map()
let observationsTruncated = false
let stage = 'initialize'
let state
let nativeRoot
let gateway
let connector
let client
let report
try {
  for (const directory of ['gateway', 'connector', 'home', 'state', 'project', 'control']) {
    mkdirSync(join(root, directory), { mode: 0o700 })
  }
  for (const role of ['gateway', 'connector']) {
    mkdirSync(join(root, role, 'refs'), { mode: 0o700 })
  }
  for (const directory of ['config', 'data', 'cache', 'runtime']) {
    mkdirSync(join(root, 'home', directory), { mode: 0o700 })
  }
  state = openGatewayState({
    state_directory: join(root, 'gateway'),
    store: {
      management: /* 仅本轮临时身份fixture可建这一个设备/provider，不接入生产身份。 */ () => ({
        actor: 'cli_lab_fixture',
        confirmation_id: randomUUID()
      })
    },
    changed: /* 初始化在任何角色启动前完成，无设备连接可以断开。 */ () => {}
  })
  const machine = state.store.register('cli_native_lab')
  const credential = {
    ...state.store.redeem(state.store.issueEnrollment(machine.machine_id)),
    recovery_generation: state.store.generation()
  }
  const target = {
    machine_id: machine.machine_id,
    provider_id: 'cli_native_luvus',
    profile: 'session',
    session: 'cli_native_lab'
  }
  const config = {
    target,
    binding_revision: 1,
    config_ref: 'local_luvus',
    binary: args.binary,
    binary_sha256: DEVELOPMENT_LUVUS_SHA256,
    state_root: join(root, 'state'),
    home: join(root, 'home'),
    cwd: join(root, 'project'),
    transport: 'ipc'
  }
  stage = 'native_root'
  nativeRoot = await initializeManagedLuvusRoot({
    record_path: join(root, 'control', 'root.json'),
    config,
    custody_policy: { scopes: ['read'], methods: ['automation.list'], max_token_ttl_s: 120 }
  })
  if (args['opencode-binary']) {
    stage = 'prepare_isolated_opencode'
    prepareIsolatedOpenCode({ binary: args['opencode-binary'], home: config.home, state_root: config.state_root })
  }
  state.store.defineProvider({
    machine_id: target.machine_id,
    provider_id: target.provider_id,
    kind: 'luvus',
    config_ref: config.config_ref,
    binding_revision: 1,
    enabled: true
  })
  state.close()
  state = undefined
  const policy = {
    revision: 'cli_caller1',
    grants: [{ target, methods: [...LUVUS_OPERATION_METHODS], actions: ['dispatch', 'read', 'cancel'] }]
  }
  const local = { ...structuredClone(policy), revision: 'cli_local1' }
  const token = randomBytes(32).toString('base64url')
  const mcpPort = await port()
  let devicePort = await port()
  while (devicePort === mcpPort) {
    devicePort = await port()
  }
  const gatewayConfig = { ...configTemplate('gateway'), state_dir: join(root, 'gateway'), mcp_port: mcpPort }
  const connectorConfig = {
    ...configTemplate('connector'),
    state_dir: join(root, 'connector'),
    gateway_url: `wss://127.0.0.1:${devicePort}`,
    provider_config_refs: [config.config_ref]
  }
  const gatewayPath = join(root, 'gateway', 'role.json')
  const connectorPath = join(root, 'connector', 'role.json')
  // 所有文件只由此临时lab创建；角色正常启动仍只消费既有文件，不自动签发或注册。
  const write = /* 固定私有文件写入，不含shell或动态模块入口。 */ (path, value) =>
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 })
  write(gatewayPath, gatewayConfig)
  write(connectorPath, connectorConfig)
  write(join(root, 'gateway', 'runtime.json'), {
    schema_version: 1,
    role: 'gateway',
    authentication_ref: gatewayConfig.authentication_ref,
    device_listener: { hostname: '127.0.0.1', port: devicePort, tls_ref: 'device_tls' },
    provider_config_refs: [config.config_ref]
  })
  write(join(root, 'connector', 'runtime.json'), {
    schema_version: 1,
    role: 'connector',
    credential_ref: 'device',
    ca_ref: 'gateway',
    provider_config_refs: [config.config_ref]
  })
  write(join(root, 'gateway', 'refs', gatewayConfig.authentication_ref + '.json'), {
    schema_version: 1,
    kind: 'mcp-caller-source',
    resource: `http://127.0.0.1:${mcpPort}/mcp`,
    local_policy: local,
    callers: [
      {
        principal: { id: 'cli_lab_caller', policy },
        token_sha256: createHash('sha256').update(token).digest('hex'),
        issued_at: Date.now() - 1000,
        expires_at: Date.now() + 600_000
      }
    ]
  })
  const reference = {
    kind: 'luvus',
    authentication: 'local_owner',
    native: {
      mode: 'managed',
      root_record: join(root, 'control', 'root.json'),
      expected_root_id: nativeRoot.root_id,
      expected_root_revision: nativeRoot.root_revision
    },
    peer_policy_revision: local.revision,
    principal_id: 'cli_lab_caller',
    policies: { caller: policy, local },
    storage_mode: 'create'
  }
  write(join(root, 'connector', 'refs', config.config_ref + '.json'), reference)
  if (args['remote-gateway']) {
    const schema = readFileSync(new URL('../../test/fixtures/luvus/0.14.3/linux/schema-bundle.json', import.meta.url))
    assert.equal(createHash('sha256').update(schema).digest('hex'), FIXED_LUVUS_SCHEMA_SHA256)
    writeFileSync(join(root, 'gateway', 'refs', 'gateway_schema.json'), schema, { mode: 0o600 })
    const flowMethods = args['minimum-native']
      ? LUVUS_FLOW_METHODS.minimum
      : args['opencode-binary']
        ? LUVUS_FLOW_METHODS.agent
        : LUVUS_FLOW_METHODS.window
    const rawMethods = flowMethods.filter(
      /** raw权限来自此临时配置对当前caller/精确方法的显式批准，不把版本审核当授权。 */ (method) =>
        luvusOperationValidation(method) === 'raw-contract'
    )
    write(join(root, 'gateway', 'refs', config.config_ref + '.json'), {
      kind: 'luvus',
      authentication: 'remote_connector',
      binding: {
        machine_id: target.machine_id,
        provider_id: target.provider_id,
        kind: 'luvus',
        config_ref: config.config_ref,
        binding_revision: 1,
        enabled: true
      },
      target,
      peer_policy_revision: local.revision,
      ...(rawMethods.length ? { raw_grant: { principal_id: 'cli_lab_caller', methods: rawMethods } } : {}),
      contract: {
        binary_version: '0.14.3',
        binary_sha256: DEVELOPMENT_LUVUS_SHA256,
        schema_sha256: FIXED_LUVUS_SCHEMA_SHA256,
        adapter_revision: MANAGED_LUVUS_REVISION,
        classification_revision: MANAGED_LUVUS_CLASSIFICATION,
        schema_bundle_ref: 'gateway_schema'
      }
    })
  } else {
    write(join(root, 'gateway', 'refs', config.config_ref + '.json'), {
      ...reference,
      native: { ...reference.native, mode: 'attach' }
    })
  }
  nativeRoot.close()
  nativeRoot = undefined
  const certPath = join(root, 'gateway', 'refs', 'device_tls.cert.pem')
  const keyPath = join(root, 'gateway', 'refs', 'device_tls.key.pem')
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
      '/CN=cli-lab',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
      '-out',
      certPath,
      '-keyout',
      keyPath
    ],
    { stdio: 'ignore' }
  )
  chmodSync(certPath, 0o600)
  chmodSync(keyPath, 0o600)
  writeFileSync(join(root, 'connector', 'refs', 'gateway.ca.pem'), readFileSync(certPath), { mode: 0o600 })
  saveCredential(join(root, 'connector', 'refs', 'device.json'), credential)
  stage = 'connector_cli_start'
  connector = start('connector', connectorPath)
  await until(
    /* 只查询本轮精确HOME/state_root中的原生session，不访问用户会话。 */ async (signal) => {
      const result = await runFixedProcess(config, localLimits(), 'sessions', signal)
      if (result.exit_code !== 0) {
        return false
      }
      const value = JSON.parse(Buffer.from(result.stdout).toString('utf8'))
      return value.sessions.some(
        /* 这里只判断原生进程启动，不能当作Agent空闲/完成。 */ (row) =>
          row.name === target.session && row.running === true
      )
    },
    connector
  )
  stage = 'gateway_cli_start'
  gateway = start('gateway', gatewayPath)
  await until(
    /* TCP监听只用于开始正式SDK协商，不代表原生调用成功。 */ (signal) =>
      new Promise(
        /* 每次连接探针只拥有自己新建的socket。 */ (resolve) => {
          const socket = connect({ host: '127.0.0.1', port: mcpPort })
          const finish = /* 所有探针结局都移除阶段监听并关闭本次socket。 */ (ready) => {
            signal.removeEventListener('abort', abort)
            socket.destroy()
            resolve(ready)
          }
          const abort = /* 阶段到期只关闭这次探针，不停止产品listener。 */ () => finish(false)
          signal.addEventListener('abort', abort, { once: true })
          socket.once('connect', /* 临时探针只观察端口并立即释放socket。 */ () => finish(true))
          socket.once('error', /* 未启动时继续有界观察同一CLI。 */ () => finish(false))
          if (signal.aborted) {
            abort()
          }
        }
      ),
    gateway
  )
  client = new Client({ name: 'rovloom-real-cli-lab', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } }
    }),
    { timeout: 5000 }
  )
  stage = 'authenticated_catalog'
  await until(
    /* 只重读目录等待原WSS连接，绝不重发业务调用。 */ async (signal, remaining) => {
      const reply = CallToolResultSchema.parse(
        await client.callTool(
          { name: 'runtime_discover', arguments: { target, expected_binding_revision: 1, limit: 100 } },
          CallToolResultSchema,
          { signal, timeout: Math.min(5000, remaining()) }
        )
      )
      return !reply.isError && Array.isArray(reply.structuredContent?.data?.items)
    },
    gateway
  )
  checks.push('public_cli_roles_and_actual_authenticated_catalog')
  if (args['remote-gateway']) {
    checks.push('gateway_remote_pin_and_actual_connector_snapshot_without_native_reference')
  }
  const maximumNativeCalls = args['minimum-native']
    ? LUVUS_FLOW_CALL_LIMIT.minimum
    : args['opencode-binary']
      ? LUVUS_FLOW_CALL_LIMIT.agent
      : LUVUS_FLOW_CALL_LIMIT.window
  const flowStartedAt = performance.now()
  const flowDeadline = Date.now() + maximumNativeCalls * LUVUS_FLOW_INTENT_MS
  const flow = await verifyLuvusMcpOperations(client, {
    target,
    opencode: !!args['opencode-binary'],
    minimum: !!args['minimum-native'],
    signal: new AbortController().signal,
    deadline: flowDeadline,
    observe: /* 固定最多256条状态/耗时事件，不收集原生数据、关联ID或提示。 */ (event) => {
      if (observations.length === 256) {
        observations.splice(32, 1)
        observationsTruncated = true
      }
      observations.push({
        ...event,
        flow_elapsed_ms: Math.round(performance.now() - flowStartedAt),
        workflow_remaining_ms: Math.max(0, flowDeadline - Date.now()),
        method: LUVUS_OPERATION_METHODS.includes(stage) ? stage : undefined
      })
      if (Number.isInteger(event.intent_index) && event.intent_index >= 1 && event.intent_index <= maximumNativeCalls) {
        const timing = intentTimings.get(event.intent_index) ?? {
          intent_index: event.intent_index,
          method: stage,
          call_state_observed_ms: {}
        }
        if (event.stage === 'request' && event.tool === 'runtime_call') {
          timing.admission_request_ms = event.elapsed_ms
        }
        if (event.stage === 'call') {
          timing.call_state_observed_ms[event.state] ??= event.elapsed_ms
        }
        if (event.stage === 'request' && event.tool === 'runtime_result_read') {
          timing.first_result_read_request_ms ??= event.elapsed_ms
        }
        if (event.stage === 'result') {
          timing.result_verified_ms = event.elapsed_ms
          timing.result_bytes = event.result_bytes
          timing.result_pages = event.result_pages
        }
        intentTimings.set(event.intent_index, timing)
      }
      if (event.stage === 'result') {
        console.error(
          JSON.stringify({
            kind: 'native_cli_progress',
            method: stage,
            intent_index: event.intent_index,
            elapsed_ms: Math.round(performance.now() - flowStartedAt),
            result_bytes: event.result_bytes,
            result_pages: event.result_pages
          })
        )
      }
    },
    progress: /* 只保存固定RPC方法名作为失败阶段，原生正文不进入报告。 */ (method) => {
      stage = method
    }
  })
  checks.push(...flow.checks)
  await client.close()
  client = undefined
  assert.equal(gateway.child.exitCode, null)
  checks.push('gateway_survives_sdk_disconnect_and_stdin_eof')
  stage = 'connector_cli_close'
  await stop(connector)
  connector = undefined
  assert.equal(gateway.child.exitCode, null)
  checks.push('gateway_survives_connector_native_exit')
  stage = 'gateway_cli_close'
  await stop(gateway)
  gateway = undefined
  checks.push('actual_cli_close_and_empty_stdout')
  report = {
    kind: 'public_cli_luvus_native',
    passed: true,
    ...flow,
    checks,
    cli_entry: args['standalone-cli']
      ? 'standalone_unique_entry'
      : args['built-cli']
        ? 'built_unique_entry'
        : 'source_unique_entry',
    conversation_verified: false,
    user_sessions_used: false,
    deployment: 'same_machine_loopback',
    gateway_attaches_local_runtime: !args['remote-gateway'],
    cross_machine_verified: false,
    paid_fallback: false,
    budgets: {
      intent_ms: LUVUS_FLOW_INTENT_MS,
      sdk_deadline: 'intent_remaining',
      sdk_max_request_ms: LUVUS_FLOW_INTENT_MS,
      result_read_ms: 30_000,
      query_wait_ms: 0,
      maximum_native_calls: maximumNativeCalls,
      workflow_cap_ms: maximumNativeCalls * LUVUS_FLOW_INTENT_MS
    },
    observations,
    intent_timings: [...intentTimings.values()],
    observations_truncated: observationsTruncated
  }
} catch (error) {
  process.exitCode = 1
  console.error(
    JSON.stringify({
      kind: 'public_cli_luvus_native',
      passed: false,
      stage,
      elapsed_ms: Math.round(performance.now() - startedAt),
      observations,
      intent_timings: [...intentTimings.values()],
      observations_truncated: observationsTruncated,
      roles: [connector, gateway]
        .filter(Boolean)
        .map(/* 退出状态不包含请求、路径或秘密。 */ (role) => role.diagnostic()),
      assertion: error?.code === 'ERR_ASSERTION' ? 'lab_assertion_failed' : undefined,
      flow_code: error instanceof NativeFlowError ? error.message : undefined,
      flow_tool: error instanceof NativeFlowError ? error.tool : undefined,
      flow_rpc_code: error instanceof NativeFlowError ? error.rpcCode : undefined,
      flow_service_code: error instanceof NativeFlowError ? error.serviceCode : undefined,
      source_code: error instanceof LuvusAdapterError && /^[a-z_]{1,80}$/.test(error.code) ? error.code : undefined
    })
  )
} finally {
  await client?.close().catch(/* 失败仍继续回收本轮自有角色。 */ () => {})
  for (const role of [connector, gateway]) {
    try {
      // 非零退出影响验收结果；只有未确认退出才影响所有权清理，二者不能混为一谈。
      await stop(role, false)
    } catch (error) {
      cleanup.cleanupFailure(error)
      process.exitCode = 1
    }
  }
  state?.close()
  nativeRoot?.close()
  const result = cleanup.finish()
  if (result.cleanup_pending) {
    console.error(JSON.stringify({ stage: 'cleanup', ...result }))
    process.exitCode = 1
  }
  if (report && process.exitCode !== 1) {
    assert(!existsSync(root))
    console.log(
      JSON.stringify({ ...report, elapsed_ms: Math.round(performance.now() - startedAt), cleanup_confirmed: true })
    )
  }
}
