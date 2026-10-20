/** 使用自有合成 workspace 验证有期限 token 写入；复用已有原生安装、Wire/Store 链和唯一发送账本。 */
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { HerdrInstallation } from '../../src/connector/herdr/installation.js'
import { exchangeHerdr, herdrDeadline, withHerdrSocket } from '../../src/connector/herdr/io.js'
import { readLinuxPeer } from '../../src/connector/local/linux-peer.js'
import { boundedJson, contractRef, fields, object, parseJson } from '../../src/wire/index.js'
import type { JsonObject } from '../../src/wire/types.js'
import { createHerdrWorkflowHost } from '../../test/connector/herdr/workflow-host.js'
import { until } from '../../test/transport/helpers.js'

type Host = Awaited<ReturnType<typeof createHerdrWorkflowHost>>
// 这里只选择本验收的合成值，不限制产品的 source、token 名称、长度或 TTL。
const method = 'workspace.report_metadata'
const source = 'owned-metadata-regression'
const token = 'metadata_note'
export type MetadataNativeCheck = { name: string; passed: boolean; details?: unknown }
export type MetadataNativeDiagnostics = {
  stage: string
  ttl_ms?: number
  settlement_ms?: number
  initial_read_ms?: number
  expiry_observed_ms?: number
}
/** 只为本次验收直接创建或读取自有 workspace；产品允许集仍由现有工厂与当前权限决定。 */
async function fixtureRequest(installation: HerdrInstallation, request: JsonObject): Promise<JsonObject> {
  const scope = herdrDeadline(undefined, 5000)
  try {
    const native: JsonObject = { ...request, id: 'owned-metadata-fixture' }
    const params = object(native.params)
    if (native.method === 'workspace.create') {
      assert.deepEqual(params, {
        cwd: installation.config.cwd,
        label: 'synthetic-metadata',
        focus: false
      })
    } else {
      assert.equal(native.method, 'workspace.get')
      fields(params, ['workspace_id'])
      assert.equal(typeof params.workspace_id, 'string')
    }
    const schemas = installation.record().schemas
    assert(schemas.request(native))
    const bytes = await withHerdrSocket(
      installation.assert(undefined, true),
      scope.signal,
      /** fixture 也核对实际同一 socket peer，不用文件或消息 PID 建立来源。 */ async (socket) => {
        const peer = readLinuxPeer(socket)
        installation.assert(peer, true)
        return exchangeHerdr(
          socket,
          scope.signal,
          /** 只发送上述固定 fixture 请求，并在实际写入前再查安装来源。 */ () => ({
            bytes: Buffer.from(boundedJson(native) + '\n'),
            beforeWrite: /** 保护本次自有实例，不探测其它 session。 */ () => {
              installation.assert(peer)
            }
          })
        )
      }
    )
    const response = object(parseJson(bytes))
    assert(schemas.response(response))
    assert.equal(response.id, native.id)
    assert(!Object.hasOwn(response, 'error'))
    return response
  } finally {
    scope.close()
  }
}

/** 使用当前 provider 工厂的唯一 Store 准入与结果端口；不读取数据库正文或构造原生许可。 */
async function runtimeRequest(host: Host, request: JsonObject): Promise<JsonObject> {
  return host.runtime.runAuthenticated(
    host.caller_identity,
    /** 保留本次已认证 caller 作用域。 */ async () => {
      const admitted = host.runtime.admit({
        target: host.target,
        native_request: { method: String(request.method), params: object(request.params) },
        options: {
          binding_revision: host.binding_revision,
          contract_ref: contractRef(host.installation.record().wire.source),
          validation: 'strict',
          deadline: Date.now() + 30_000
        }
      })
      assert.equal(admitted.created, true)
      await until(
        /** 只认真实 Wire/Store 已提交的响应。 */ () => {
          const call = host.runtime.get(admitted.call.call_id)
          assert(!['outcome_unknown', 'not_dispatched'].includes(call.state))
          return call.state === 'responded'
        },
        30_000
      )
      const handle = host.runtime.results.open(admitted.call.call_id)
      const page = host.runtime.results.read(handle.result_id, 0, 65_536)
      assert.equal(page.eof, true)
      const response = object(JSON.parse(Buffer.from(page.data, 'base64').toString('utf8')))
      assert.equal(typeof response.id, 'string')
      return response
    }
  )
}

/** 经生产调用链执行写入，再从独立实际连接核对状态；Ok 与状态是否改变分别验证。 */
export async function verifyWorkspaceMetadata(
  installation: HerdrInstallation,
  host: Host,
  root: string,
  checks: MetadataNativeCheck[],
  diagnostics: MetadataNativeDiagnostics
) {
  diagnostics.stage = 'create_owned_workspace'
  const created = await fixtureRequest(installation, {
    method: 'workspace.create',
    params: { cwd: installation.config.cwd, label: 'synthetic-metadata', focus: false }
  })
  const createdResult = object(created.result)
  const workspace = object(createdResult.workspace)
  const workspaceId = String(workspace.workspace_id)
  assert(workspaceId.length > 0)
  await until(
    /** 只等待自己创建的合成终端，不枚举进程。 */ () => {
      try {
        return Number(readFileSync(join(root, 'terminal.pid'), 'utf8')) > 0
      } catch {
        return false
      }
    },
    5000
  )
  const original = await fixtureRequest(installation, {
    method: 'workspace.get',
    params: { workspace_id: workspaceId }
  })
  const beforeWorkspace = object(object(original.result).workspace)
  const beforeClaims = host.claimCount()
  const captures: { request: JsonObject; response: JsonObject }[] = []

  /** 所有数据都是本次合成输入；每次派发仍经真实 Router/Wire/Store/claim，而非 fixtureRequest。 */
  async function patch(value: string | null, seq: number, ttl_ms = 60_000, id = workspaceId) {
    const request = {
      method,
      params: {
        workspace_id: id,
        source,
        tokens: { [token]: value },
        seq,
        ttl_ms
      }
    }
    const response = await runtimeRequest(host, request)
    captures.push({ request: { ...request, id: response.id! }, response })
    return { response }
  }

  /** 独立读取当前自有 workspace token，不把 Store 的 Ok 证据当作应用成功确认。 */
  async function current() {
    const response = await fixtureRequest(installation, {
      method: 'workspace.get',
      params: { workspace_id: workspaceId }
    })
    return object(object(response.result).workspace)
  }

  diagnostics.stage = 'set_clear_sequence'
  const first = await patch('synthetic-one', 1)
  assert.deepEqual(first.response, { id: first.response.id, result: { type: 'ok' } })
  assert.deepEqual(object((await current()).tokens), { [token]: 'synthetic-one' })
  const duplicate = await patch('synthetic-conflict', 1)
  assert.deepEqual(duplicate.response, { id: duplicate.response.id, result: { type: 'ok' } })
  assert.deepEqual(object((await current()).tokens), { [token]: 'synthetic-one' })
  await patch(null, 2)
  assert.deepEqual(object((await current()).tokens ?? {}), {})
  await patch('synthetic-after-clear-stale', 1)
  assert.deepEqual(object((await current()).tokens ?? {}), {})
  checks.push({ name: 'metadata_set_clear_and_native_sequence_noop', passed: true })

  // 原生 TTL 从处理时开始，完整 Wire/Store 回执及再次核验安装均耗时；记录观察窗口，先证明存在再等待消失。
  diagnostics.stage = 'ttl_initial_presence'
  diagnostics.ttl_ms = 5000
  const ttlStarted = performance.now()
  await patch('synthetic-short', 3, diagnostics.ttl_ms)
  diagnostics.settlement_ms = Math.round(performance.now() - ttlStarted)
  const initialTokens = object((await current()).tokens ?? {})
  diagnostics.initial_read_ms = Math.round(performance.now() - ttlStarted)
  assert.deepEqual(initialTokens, { [token]: 'synthetic-short' })
  diagnostics.stage = 'ttl_eventual_expiry'
  const expiresBy = Date.now() + 10_000
  while (Object.hasOwn(object((await current()).tokens ?? {}), token)) {
    assert(Date.now() < expiresBy, 'metadata_expiry_not_observed')
    await new Promise(/** 给原生共享清扫循环让出时间，不声称期限瞬间精确消失。 */ (resolve) => setTimeout(resolve, 25))
  }
  diagnostics.expiry_observed_ms = Math.round(performance.now() - ttlStarted)
  diagnostics.stage = 'retained_sequence_and_native_error'
  await patch('synthetic-stale-after-expiry', 3)
  assert.deepEqual(object((await current()).tokens ?? {}), {})
  await patch('synthetic-new-sequence', 4)
  assert.deepEqual(object((await current()).tokens), { [token]: 'synthetic-new-sequence' })
  const missing = await patch('synthetic-missing', 5, 60_000, 'wZZZZZZZZZZZZ')
  assert.equal(object(missing.response.error).code, 'workspace_not_found')
  assert.equal(host.claimCount(), beforeClaims + 8)
  checks.push({ name: 'metadata_eventual_expiry_retained_sequence_and_native_error', passed: true })

  diagnostics.stage = 'unchanged_state_and_zero_input'
  const afterWorkspace = await current()
  const { tokens: _beforeTokens, ...beforeState } = beforeWorkspace
  const { tokens: _afterTokens, ...afterState } = afterWorkspace
  assert.deepEqual(afterState, beforeState)
  assert.equal(Number(readFileSync(join(root, 'terminal.input.bytes'), 'utf8')), 0)
  checks.push({ name: 'metadata_owned_workspace_state_and_zero_synthetic_input', passed: true })

  diagnostics.stage = 'invalid_parameter_denials'
  const valid = { workspace_id: workspaceId, source, tokens: { [token]: 'synthetic' }, seq: 6, ttl_ms: 1000 }
  const claimsBeforeRejected = host.claimCount()
  for (const params of [
    { ...valid, seq: -1 },
    { ...valid, ttl_ms: 0 },
    { ...valid, ttl_ms: 86_400_001 },
    { ...valid, source: 7 },
    { ...valid, tokens: { invalid: 7 } }
  ]) {
    await assert.rejects(
      /** 只测试当前完整安装 schema 拒绝的形式，不恢复旧产品参数子集。 */ () =>
        runtimeRequest(host, { method, params }),
      /herdr_native_request_invalid/
    )
  }
  assert.equal(host.claimCount(), claimsBeforeRejected)
  checks.push({ name: 'metadata_schema_invalid_parameters_rejected_without_claim', passed: true })
  diagnostics.stage = 'complete'
  return { captures, workspace_id: workspaceId, calls: 8, scope: 'synthetic_owned_workspace_only' }
}

/** 显式运行自有实例的 metadata 验收；不读取模型配置，报告和临时状态均在 checkout 外。 */
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { binary: { type: 'string' }, report: { type: 'string' } } })
  const checkout = resolve(import.meta.dir, '../..')
  assert(values.binary && isAbsolute(values.binary), 'absolute_binary_required')
  assert(values.report && isAbsolute(values.report), 'absolute_new_report_required')
  assert(
    !existsSync(values.report) && !resolve(values.report).startsWith(checkout + '/'),
    'new_external_report_required'
  )
  const root = mkdtempSync('/workspace/herdr-metadata-')
  chmodSync(root, 0o700)
  const checks: MetadataNativeCheck[] = []
  const diagnostics: MetadataNativeDiagnostics = { stage: 'start_owned_provider_host' }
  let host: Host | undefined
  let result: unknown
  let failure: string | undefined
  let cleanup: Awaited<ReturnType<Host['close']>> | undefined
  try {
    host = await createHerdrWorkflowHost({ root, binary: values.binary, synthetic_terminal: true })
    result = await verifyWorkspaceMetadata(host.installation, host, root, checks, diagnostics)
  } catch (error) {
    failure =
      error instanceof assert.AssertionError ? 'metadata_assertion_failed' : 'metadata_native_verification_failed'
  } finally {
    if (host) {
      try {
        cleanup = await host.close()
        assert(
          Object.values(cleanup).every(
            /** 计数只记录，全部清理布尔值必须成功。 */ (value) => typeof value === 'number' || value === true
          )
        )
        checks.push({ name: 'metadata_owned_provider_host_cleanup', passed: true })
      } catch {
        failure ??= 'metadata_owned_cleanup_failed'
      }
    }
    writeFileSync(
      values.report,
      JSON.stringify({ passed: !failure, checks, diagnostics, result, failure, cleanup }) + '\n',
      { mode: 0o600, flag: 'wx' }
    )
    if (cleanup && cleanup.owned_child_exited && cleanup.owned_terminals_reaped && cleanup.resources_closed) {
      rmSync(root, { recursive: true, force: true })
    }
  }
  console.log(JSON.stringify({ passed: !failure, checks: checks.length, diagnostics, failure }))
  if (failure) {
    process.exitCode = 1
  }
}

if (import.meta.main) {
  await main()
}
