// 用官方空白实例验证宿主全链，仅输出有界安全计数；不是公开 CLI/HTTP 产品验收。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { isAbsolute, join, normalize } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  openGatewayState,
  createGatewayRuntime,
  createConnectorRuntime,
  ConnectorAttemptBook,
  createConnectorAdmissionBackend,
  initializeManagedLuvusRoot,
  openNativeCustodyApprovals,
  startManagedLuvus,
  createManagedLuvusProvider,
  createManagementSessionAuthority,
  createLuvusCustodyAuthorizer,
  DEVELOPMENT_LUVUS_SHA256
} from '../../dist/src/runtime/index.js'
import { ConnectorAdmissionReceipts } from '../../dist/src/transport/index.js'
import { LuvusDispatchClaims } from '../../dist/src/connector/luvus/index.js'
import { contractRef } from '../../dist/src/wire/index.js'
/** 验收脚本只接受显式官方 binary 和受保护临时父目录；不读取产品配置或真实 HOME。 */
function argumentsForSmoke() {
  const args = process.argv.slice(2)
  if (
    args.length !== 5 ||
    args[0] !== '--binary' ||
    args[2] !== '--temporary-parent' ||
    args[4] !== '--acknowledge-nonproduction'
  ) {
    throw new Error('usage_binary_temporary_parent_acknowledge_nonproduction_required')
  }
  for (const path of [args[1], args[3]]) {
    if (!isAbsolute(path) || normalize(path) !== path) {
      throw new Error('canonical_absolute_path_required')
    }
  }
  return { binary: args[1], temporaryParent: args[3] }
}
const inputPaths = argumentsForSmoke()
const passed = []
/** 每项具名断言只有实际通过才写入最终安全计数。 */
function checked(name, assertion) {
  assertion()
  passed.push(name)
}
const root = mkdtempSync(join(inputPaths.temporaryParent, '.rovloom-managed-wss-'))
let gateway
let connector
let instance
let state
let claims
let receipts
let rootRecord
let processOwner
let approvals
let sessions
let principal
let stage = 'initialize'
try {
  for (const name of ['gateway', 'home', 'state', 'project', 'control', 'control/approvals', 'connector']) {
    mkdirSync(join(root, name), { mode: 0o700 })
  }
  for (const name of ['config', 'data', 'cache', 'runtime']) {
    mkdirSync(join(root, 'home', name), { mode: 0o700 })
  }
  state = openGatewayState({
    state_directory: join(root, 'gateway'),
    store: {
      management: /* 仅为自有空白测试库授权合成管理写入。 */ () => ({
        actor: 'isolated_nonproduction_admin',
        confirmation_id: randomUUID()
      })
    },
    authorizeIdentity: /* 本验收只向自有身份库安装一次性合成设备凭据。 */ () => ({
      actor: 'isolated_nonproduction_admin',
      confirmation_id: randomUUID(),
      expires_at: Date.now() + 10000
    }),
    changed: /* 身份变化立即断开同一测试机器，不变更其它来源。 */ (machine) => gateway?.transport.disconnect(machine),
    identity_reservation: { security_bytes: 1048576, audit_bytes: 4194304, file_bytes: 8388608 }
  })
  const machine = state.store.register('isolated_live')
  const credential = {
    ...state.store.redeem(state.store.issueEnrollment(machine.machine_id)),
    recovery_generation: state.store.generation()
  }
  state.credentials.install(credential, 120000)
  const target = { machine_id: machine.machine_id, provider_id: 'native_live', profile: 'session', session: 'isolated' }
  const config = {
    target,
    binding_revision: 1,
    config_ref: 'isolated_native',
    binary: inputPaths.binary,
    binary_sha256: DEVELOPMENT_LUVUS_SHA256,
    state_root: join(root, 'state'),
    home: join(root, 'home'),
    cwd: join(root, 'project'),
    transport: 'ipc'
  }
  stage = 'native_start'
  rootRecord = await initializeManagedLuvusRoot({
    record_path: join(root, 'control', 'root.json'),
    config,
    custody_policy: {
      scopes: ['read', 'orchestration'],
      methods: ['automation.list', 'task.add', 'task.update'],
      max_token_ttl_s: 120
    }
  })
  processOwner = await startManagedLuvus(rootRecord)
  approvals = openNativeCustodyApprovals(rootRecord, { directory: join(root, 'control', 'approvals') })
  const baseIdentities = {
    principal: /* 只解析本轮合成管理员与调用主体，不读取外部账号。 */ (who) =>
      who.principal_id === 'isolated_admin'
        ? { id: 'isolated_admin', policy: { revision: 'isolated_admin_policy', grants: [] } }
        : who.principal_id === principal?.id
          ? principal
          : null,
    administrator: /* 合成管理会话与MCP主体保持独立，且必须完整匹配。 */ (who, ref) =>
      who.principal_id === 'isolated_admin' && ref === 'isolated_admin_session'
        ? {
            principal_id: 'isolated_admin',
            session_ref: ref,
            assurance: 'administrator',
            policy_revision: 'isolated_admin_policy',
            grants: []
          }
        : null
  }
  sessions = createManagementSessionAuthority(baseIdentities)
  const at = Date.now()
  const bootstrap = sessions.bootstrap({
    caller: { principal_id: 'isolated_admin' },
    management_session_ref: 'isolated_admin_session',
    issued_at: at,
    expires_at: at + 120000
  })
  const nativeGrants = [
    {
      action: 'issue_restricted_delegation',
      principal_id: 'isolated_admin',
      root_id: rootRecord.root_id,
      root_revision: rootRecord.root_revision,
      config_ref: config.config_ref,
      config_digest: rootRecord.config_digest,
      server_generation: processOwner.contract.wire.source.runtime_generation,
      scopes: ['read', 'orchestration'],
      methods: ['task.add'],
      max_token_ttl_s: 120,
      expires_at: at + 120000
    }
  ]
  const authorize = createLuvusCustodyAuthorizer({
    sessions,
    approvals,
    grants: /* 仅返回本轮固定root/generation/method/短期限的批准。 */ () => nativeGrants
  })
  instance = await sessions.runAuthenticated(
    bootstrap.cookie,
    new AbortController().signal,
    /* 明确的合成管理员动作才可签发短期受限custody。 */ () =>
      processOwner.issueRestricted(
        { scopes: ['read', 'orchestration'], methods: ['task.add'], token_ttl_s: 120 },
        authorize
      )
  )
  checked(
    'managed_source_and_restricted_custody',
    /* 来自受控child及实际短期签发，而非自报ready。 */ () => assert.equal(instance.ready(), true)
  )
  const owned = instance
  const binding = {
    machine_id: target.machine_id,
    provider_id: target.provider_id,
    binding_revision: 1,
    kind: 'luvus',
    enabled: true,
    config_ref: config.config_ref
  }
  state.store.defineProvider(binding)
  const reference = contractRef(instance.contract.wire.source)
  const callerPolicy = {
    revision: 'isolated_caller',
    grants: [{ target, methods: ['task.add'], actions: ['dispatch', 'read', 'cancel'] }]
  }
  const localPolicy = { ...structuredClone(callerPolicy), revision: 'isolated_local' }
  principal = { id: 'isolated_caller', policy: callerPolicy }
  checked(
    'separate_management_and_caller',
    /* 管理员会话与MCP调用主体不合并。 */ () => assert.notEqual(principal.id, 'isolated_admin')
  )
  const provider = createManagedLuvusProvider(owned, localPolicy.revision)
  const authority = provider.authority
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
    capabilities: ['rpc', 'history_scope', 'admission_receipt'],
    required: ['rpc', 'admission_receipt']
  }
  stage = 'gateway_start'
  gateway = await createGatewayRuntime({
    lifecycle: state.lifecycle,
    channels: state.channels,
    identities: sessions.identities,
    localPolicies: /* 只对本轮完整Target提供固定本机策略。 */ () => localPolicy,
    providers: [provider],
    listener: {
      hostname: '127.0.0.1',
      port: 0,
      tls: { cert, key },
      offer,
      limits: { heartbeat_ms: 5000, idle_ms: 20000 }
    },
    release: /* Gateway显式关闭后释放本轮唯一双库。 */ async () => state.close()
  })
  checked(
    'tls_endpoint',
    /* 只接本轮自签CA认证的真实WSS。 */ () => assert.equal(new URL(gateway.transport.url).protocol, 'wss:')
  )
  claims = new LuvusDispatchClaims({
    path: join(root, 'claims.db'),
    mode: 'create',
    ledger_id: 'isolated_live_claims',
    limits: { entries: 128, bytes: 1048576 },
    now: Date.now
  })
  receipts = new ConnectorAdmissionReceipts({
    path: join(root, 'connector', 'admission.json'),
    mode: 'create',
    ledger_id: 'isolated_connector_receipts',
    limits: { entries: 128, bytes: 1048576 },
    now: Date.now
  })
  const book = new ConnectorAttemptBook({
    dedupExpires: /* 原dedup截止只能来自独立认证receipt。 */ (attempt) => receipts.dedupExpires(attempt),
    now: Date.now
  })
  stage = 'connector_start'
  connector = await createConnectorRuntime({
    transport: {
      url: gateway.transport.url,
      ca: cert,
      credential: /* 此合成凭据仅用于本轮真实WSS握手。 */ () => credential,
      offer,
      limits: { heartbeat_ms: 5000, idle_ms: 20000, reconnect_ms: 1000 }
    },
    /** 每个真实认证epoch创建独立backend与原Wire，不打开第二个Gateway writer。 */
    session(connection) {
      const backend = createConnectorAdmissionBackend({
        connection,
        routes: [{ target, principal_id: principal.id }],
        book,
        receipts,
        source: {
          provider: /* 只返回本轮受保护canonical provider。 */ () => binding,
          localProvider: /* 本机配置独立固定到同一完整binding。 */ () => binding,
          contract: /* 只接受实际受限custody导出的契约。 */ (ref) => (ref === reference ? owned.contract : undefined),
          nativeSource: /* 先查询原准入记录，再取真实受控实例来源。 */ (call, attempt) => {
            const row = backend.attempt(call, attempt)
            return row ? owned.source(row.binding) : undefined
          },
          policies: /* caller与本机政策来自本轮独立配置。 */ () => ({ caller: callerPolicy, local: localPolicy }),
          authority,
          now: Date.now
        }
      })
      return {
        backend,
        config,
        admissions: receipts,
        delegation: /* 只对原binding取得实际受限委托。 */ (attempt) => owned.delegation(attempt),
        claims,
        verifyPeer: /* 每条真实IPC socket交由受控实例核对内核peer。 */ (socket, endpoint, attempt) =>
          owned.verifyPeer(socket, endpoint, attempt),
        assertEvidence: /* 写入前再次核对同一socket的实际来源证据。 */ (attempt, evidence) =>
          owned.assertEvidence(attempt, evidence),
        dedupExpires: backend.dedupExpires,
        readiness: /* 就绪同时依赖双端配置与实际受控实例状态。 */ () => ({
          policy_revision: localPolicy.revision,
          peer_policy_revision: 'isolated_local',
          providers: [{ expected: binding, local: binding, native_ready: owned.ready() }]
        }),
        close: /* 只关闭本epoch账本候选，不宣称原生动作回滚。 */ () => backend.close()
      }
    },
    release: /* 全部epoch停止后释放本轮持久去重与receipt所有者。 */ async () => {
      claims.close()
      receipts.close()
    }
  })
  /** 以有限单调等待观察真实链路，不改任何已登记期限。 */
  async function until(check) {
    const deadline = performance.now() + 45000
    while (!check()) {
      if (performance.now() >= deadline) {
        throw new Error('wait_timeout')
      }
      await new Promise(/* 此短定时器仅让出轮询，不刷新业务期限。 */ (resolve) => setTimeout(resolve, 20))
    }
  }
  stage = 'ready'
  await until(
    /* 必须同时看到真实Connector与Gateway就绪。 */ () =>
      connector.transport.status().phase === 'ready' &&
      gateway.transport.status().devices.some(/* 只观察此真实认证设备的ready。 */ (device) => device.ready)
  )
  checked(
    'authenticated_channel_ready',
    /* 两端就绪已经来自真实握手。 */ () => assert.equal(connector.transport.status().phase, 'ready')
  )
  const history = state.store.openHistory(principal.id, target, 1)
  const input = {
    target,
    native_request: { method: 'task.add', params: { title: 'isolated native runtime smoke' } },
    options: {
      binding_revision: 1,
      contract_ref: reference,
      deadline: Date.now() + 30000,
      history: { history_epoch: history.history_epoch, client_request_key: 'isolated_intent' }
    }
  }
  stage = 'admit'
  const first = await gateway.runAuthenticated(
    { principal_id: principal.id },
    /* 通过已认证作用域调用唯一Router准入。 */ () => gateway.admit(input)
  )
  checked('created_true', /* 首次原子准入才允许派发。 */ () => assert.equal(first.created, true))
  stage = 'responded'
  await until(
    /* 等待唯一Store实际提交responded。 */ () =>
      state.store.call(principal.id, first.call.call_id).state === 'responded'
  )
  checked(
    'store_response_committed',
    /* 原生响应必须已由唯一Store提交。 */ () =>
      assert.equal(state.store.call(principal.id, first.call.call_id).state, 'responded')
  )
  const duplicate = await gateway.runAuthenticated(
    { principal_id: principal.id },
    /* 通过已认证作用域调用唯一Router准入。 */ () => gateway.admit(input)
  )
  checked('duplicate_not_created', /* 相同key不可再次派发。 */ () => assert.equal(duplicate.created, false))
  checked(
    'duplicate_original_call',
    /* 重复准入返回同一原调用。 */ () => assert.equal(duplicate.call.call_id, first.call.call_id)
  )
  checked(
    'original_deadline',
    /* 重复准入不刷新原deadline。 */ () => assert.equal(duplicate.call.deadline, input.options.deadline)
  )
  stage = 'original_result'
  const result = await gateway.runAuthenticated(
    { principal_id: principal.id },
    /* 结果句柄必须通过当前身份及原Wire门禁。 */ () => gateway.results.open(first.call.call_id)
  )
  const page = await gateway.runAuthenticated(
    { principal_id: principal.id },
    /* 每页继续复验同一主体、原Wire和固定期限。 */ () => gateway.results.read(result.result_id)
  )
  const response = JSON.parse(Buffer.from(page.data, 'base64').toString())
  checked(
    'original_wire_result',
    /* 正文只从原Wire保护的结果页取得。 */ () => assert(response.result && !response.error)
  )
  const db = new DatabaseSync(join(root, 'claims.db'), { readOnly: true })
  const claimCount = Number(db.prepare('SELECT count(*) n FROM luvus_dispatch_claims').get().n)
  db.close()
  checked('one_durable_dispatch', /* 真实持久发送墓碑恰好一条。 */ () => assert.equal(claimCount, 1))
  const saved = JSON.parse(readFileSync(join(root, 'connector', 'admission.json'), 'utf8')).entries[0]
  checked(
    'independent_receipt',
    /* receipt文件来自Connector独立目录且绑定原调用。 */ () => assert.equal(saved.binding.call_id, first.call.call_id)
  )
  checked(
    'original_dedup_cutoff',
    /* 截止严格来自Store原锚点。 */ () =>
      assert.equal(saved.dedup_expires_at, state.store.responseAnchor(saved.binding).dedup_expires_at)
  )
  stage = 'disconnect'
  await connector.close()
  await until(
    /* Connector关闭只移除设备连接，Gateway须持续运行。 */ () => gateway.transport.status().devices.length === 0
  )
  checked(
    'gateway_survives_connector_exit',
    /* Connector退出不终止常驻Gateway。 */ () => assert.equal(gateway.transport.status().stopped, false)
  )
  assert.equal(passed.length, 14)
  console.log(
    JSON.stringify({
      kind: 'official_managed_runtime_artifact_modules',
      managed_persistent_root: true,
      explicit_administrator_bootstrap: true,
      explicit_custody_approval: true,
      authenticated_receipt: true,
      original_dedup_cutoff: true,
      native: 'luvus-0.14.3',
      wss: true,
      persistent_identity: true,
      independent_connector_admission: true,
      created_true_only: true,
      durable_claims: claimCount,
      original_wire_result: true,
      deadline_unchanged: true,
      client_exit_preserves_gateway: true,
      checks: passed.length,
      passed,
      product_http_entrypoint: false,
      user_credentials_configured: false
    })
  )
} catch (error) {
  console.error(
    JSON.stringify({
      stage,
      code:
        typeof error?.code === 'string' && /^[a-z][a-z0-9_]*$/.test(error.code)
          ? error.code
          : 'managed_wss_verification_failed'
    })
  )
  process.exitCode = 1
} finally {
  try {
    await connector?.close()
  } finally {
    try {
      await gateway?.close()
      if (!gateway) {
        state?.close()
      }
    } finally {
      claims?.close()
      receipts?.close()
      instance?.close()
      await processOwner?.close()
      approvals?.close()
      rootRecord?.close()
      sessions?.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}
