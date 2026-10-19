// 在自有受控官方实例上独立复核稳定 ID 原生语义；不作为 Gateway/Wire 或模型对话验收。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { isAbsolute, join, normalize } from 'node:path'
import { parseArgs } from 'node:util'
import {
  initializeManagedLuvusRoot,
  startManagedLuvus,
  DEVELOPMENT_LUVUS_SHA256,
  validateLuvusOperationParams
} from '../../dist/src/runtime/index.js'
import { createNativeValidator } from '../../dist/src/native-contract/index.js'
import { createManagedSmokeCleanup } from './managed-smoke-cleanup.mjs'
import { verifyStableLuvusSelection } from './luvus-stable-selection.mjs'

/** 只消费明确的官方安装路径和本轮私有临时父目录，不读取产品配置、用户 HOME 或 Agent 设置。 */
function argumentsForSmoke() {
  const { values } = parseArgs({
    options: {
      binary: { type: 'string' },
      'temporary-parent': { type: 'string' },
      'acknowledge-nonproduction': { type: 'boolean' }
    }
  })
  if (!values['acknowledge-nonproduction']) {
    throw new Error('nonproduction_acknowledgement_required')
  }
  for (const path of [values.binary, values['temporary-parent']]) {
    if (!path || !isAbsolute(path) || normalize(path) !== path) {
      throw new Error('canonical_absolute_path_required')
    }
  }
  return values
}
const paths = argumentsForSmoke()
const root = mkdtempSync(join(paths['temporary-parent'], '.rovloom-luvus-stable-'))
const cleanup = createManagedSmokeCleanup(root)
let nativeRoot
let native
let stage = 'initialize'
let report
let count = 0
let nativeError
let schemaError
try {
  for (const name of ['home', 'state', 'project', 'project-a', 'project-c', 'control']) {
    mkdirSync(join(root, name), { mode: 0o700 })
  }
  for (const name of ['config', 'data', 'cache', 'runtime']) {
    mkdirSync(join(root, 'home', name), { mode: 0o700 })
  }
  const config = {
    target: {
      machine_id: 'stable_machine',
      provider_id: 'stable_provider',
      profile: 'session',
      session: 'stable_isolated'
    },
    binding_revision: 1,
    config_ref: 'stable_config',
    binary: paths.binary,
    binary_sha256: DEVELOPMENT_LUVUS_SHA256,
    state_root: join(root, 'state'),
    home: join(root, 'home'),
    cwd: join(root, 'project'),
    transport: 'ipc'
  }
  nativeRoot = await initializeManagedLuvusRoot({
    record_path: join(root, 'control', 'root.json'),
    config,
    custody_policy: { scopes: ['read'], methods: ['automation.list'], max_token_ttl_s: 120 }
  })
  native = await startManagedLuvus(nativeRoot)
  const validator = createNativeValidator(native.contract.compiled)
  const environment = {
    PATH: '/usr/bin:/bin',
    HOME: config.home,
    XDG_CONFIG_HOME: join(config.home, 'config'),
    XDG_DATA_HOME: join(config.home, 'data'),
    XDG_CACHE_HOME: join(config.home, 'cache'),
    XDG_RUNTIME_DIR: join(config.home, 'runtime'),
    LUVUS_HOME: config.state_root,
    SHELL: '/bin/sh',
    LANG: 'C.UTF-8'
  }
  /** 固定官方 proxy 每项只发一次；有界读取完整原帧、核 ID 和安装 schema，不生成 Gateway 认证或 claim。 */
  async function rpc(method, params = {}) {
    stage = method
    nativeError = undefined
    schemaError = undefined
    validateLuvusOperationParams(method, params)
    assert.equal(native.ready(), true)
    const id = 'stable-' + ++count
    let bytes
    try {
      bytes = execFileSync(config.binary, ['--session', config.target.session, 'uhp', 'proxy'], {
        cwd: config.cwd,
        env: environment,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        input: JSON.stringify({ id, method, params }) + '\n',
        timeout: 10000,
        maxBuffer: 1048576
      })
    } catch (error) {
      if (!error.stdout?.length || error.signal) {
        throw new Error('stable_native_proxy_failed')
      }
      bytes = error.stdout
    }
    const response = JSON.parse(bytes.toString('utf8'))
    nativeError =
      typeof response.error?.code === 'string' && /^[a-z_]{1,64}$/.test(response.error.code)
        ? response.error.code
        : undefined
    assert.equal(response.id, id)
    const shape = validator.checkResponseShape(response)
    schemaError = shape.ok ? undefined : shape.error.code
    assert.equal(shape.ok, true)
    assert.equal(native.ready(), true)
    return response
  }
  const agents = await rpc('agent.list')
  assert(!agents.error && Array.isArray(agents.result.agents))
  const sessions = await rpc('agent.sessions')
  assert(!sessions.error)
  const missing = await rpc('agent.get', { target: 'never-created-isolated-agent' })
  assert(missing.error && typeof missing.error.code === 'string')
  const stable = await verifyStableLuvusSelection(rpc, {
    project: config.cwd,
    projectA: join(root, 'project-a'),
    projectC: join(root, 'project-c')
  })
  report = {
    kind: 'official_luvus_stable_selection_native_only',
    passed: true,
    checks: [
      'controlled_blank_instance',
      'native_agent_discovery',
      'native_agent_sessions',
      'missing_agent_native_error'
    ],
    stable_selection: stable,
    native_rpc: count,
    official_native: '0.14.3',
    agent_count: agents.result.agents.length,
    model_requests: 0,
    tokens_issued: 0,
    gateway_wire_exercised: false,
    conversation: 'not_exercised',
    user_sessions_used: false
  }
} catch (error) {
  cleanup.observeFailure(error)
  console.error(
    JSON.stringify({
      stage,
      code: 'stable_native_verification_failed',
      native_rpc: count,
      native_error_code: nativeError,
      schema_error_code: schemaError,
      assertion: error?.code === 'ERR_ASSERTION'
    })
  )
  process.exitCode = 1
} finally {
  for (const operation of [
    /** 真实 child 退出必须确认；失败仍继续释放 root handle，但保留 owner 证据。 */ async () => native?.close(),
    /** 最后释放本轮 root handle，不清除尚未确认退出的进程锁。 */ () => nativeRoot?.close()
  ]) {
    try {
      await operation()
    } catch (error) {
      cleanup.cleanupFailure(error)
      process.exitCode = 1
    }
  }
  const result = cleanup.finish()
  if (result.cleanup_pending) {
    console.error(JSON.stringify({ stage: 'cleanup', ...result }))
    process.exitCode = 1
  }
}
if (report && process.exitCode !== 1) {
  console.log(JSON.stringify(report))
}
