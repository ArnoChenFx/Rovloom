/** 使用自有合成 workspace 验证有期限 token 写入；复用已有原生安装、Wire/Store 链和唯一发送账本。 */
import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { HerdrInstallation } from '../../src/connector/herdr/installation.js'
import { exchangeHerdr, herdrDeadline, withHerdrSocket } from '../../src/connector/herdr/io.js'
import { readLinuxPeer } from '../../src/connector/local/linux-peer.js'
import { HERDR_WORKSPACE_METADATA_SCOPE } from '../../src/connector/herdr/methods.js'
import { boundedJson, contractRef, fields, object, parseJson } from '../../src/wire/index.js'
import type { JsonObject } from '../../src/wire/types.js'
import type { createHerdrRuntimeChain } from '../../test/connector/herdr/runtime-chain.js'
import { until } from '../../test/transport/helpers.js'

type Chain = ReturnType<typeof createHerdrRuntimeChain>
export type MetadataNativeCheck = { name: string; passed: boolean; details?: unknown }
export type MetadataNativeDiagnostics = {
  stage: string
  ttl_ms?: number
  settlement_ms?: number
  initial_read_ms?: number
  expiry_observed_ms?: number
}
type ChildLibc = {
  symbols: {
    prctl(option: number, value: number, a: number, b: number, c: number): number
    waitpid(pid: number, status: number, flags: number): number
  }
}
type ChildFfi = {
  dlopen(path: string, symbols: Record<string, { args: string[]; returns: string }>): ChildLibc
  ptr(value: Uint8Array): number
}
let children: { ffi: ChildFfi; libc: ChildLibc } | undefined

/** 准备只计数、不解释输入的私有终端；这里只生成本次隔离实例的固定配置片段。 */
export function prepareMetadataTerminal(root: string): string {
  assert.equal(process.platform, 'linux')
  const ffi = createRequire(import.meta.url)('bun:ffi') as ChildFfi
  const libc = ffi.dlopen('libc.so.6', {
    prctl: { args: ['int', 'u64', 'u64', 'u64', 'u64'], returns: 'int' },
    waitpid: { args: ['int', 'ptr', 'int'], returns: 'int' }
  })
  // 本验收进程只接管自己新建实例的孤儿后代，避免将合成 shell 留给容器 init；不建立原生来源。
  assert.equal(libc.symbols.prctl(36, 1, 0, 0, 0), 0)
  children = { ffi, libc }
  const terminal = join(root, 'synthetic-terminal')
  copyFileSync(new URL('../../test/connector/herdr/terminal-fixture.py', import.meta.url), terminal)
  chmodSync(terminal, 0o700)
  return `[terminal]\ndefault_shell = ${JSON.stringify(terminal)}\nshell_mode = "non_login"\nnew_cwd = "current"\n`
}

/** server 关闭后仅 waitpid 已创建的合成 shell；不枚举 PID、不读取进程文件或给未知进程发信号。 */
export async function reapMetadataTerminal(root: string): Promise<boolean> {
  if (!children || !existsSync(join(root, 'terminal.pid'))) {
    return true
  }
  const pid = Number(readFileSync(join(root, 'terminal.pid'), 'utf8'))
  assert(Number.isSafeInteger(pid) && pid > 0)
  const { ffi, libc } = children
  const status = Buffer.alloc(4)
  try {
    await until(
      /** 只查询本合成子进程的退出，不用 liveness 查询建立任何授权。 */ () => {
        if (libc.symbols.waitpid(pid, ffi.ptr(status), 1) === pid) {
          return true
        }
        try {
          process.kill(pid, 0)
          return false
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === 'ESRCH'
        }
      },
      5000
    )
    return true
  } catch {
    return false
  } finally {
    assert.equal(libc.symbols.prctl(36, 0, 0, 0, 0), 0)
    children = undefined
  }
}

/** 仅创建自有固定标签 workspace 或读取其状态；这两项是验收 fixture 操作，不进入产品允许集。 */
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
      assert.match(String(params.workspace_id), new RegExp(HERDR_WORKSPACE_METADATA_SCOPE.workspace_id_pattern))
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

/** 经生产调用链执行写入，再从独立实际连接核对状态；Ok 与状态是否改变分别验证。 */
export async function verifyWorkspaceMetadata(
  installation: HerdrInstallation,
  chain: Chain,
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
  assert.match(workspaceId, new RegExp(HERDR_WORKSPACE_METADATA_SCOPE.workspace_id_pattern))
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
  const beforeClaims = chain.claimCount()
  const captures: { request: JsonObject; response: JsonObject }[] = []

  /** 所有数据都是本次合成输入；每次派发仍经真实 Router/Wire/Store/claim，而非 fixtureRequest。 */
  async function patch(value: string | null, seq: number, ttl_ms = 60_000, id = workspaceId) {
    const request = {
      method: HERDR_WORKSPACE_METADATA_SCOPE.method,
      params: {
        workspace_id: id,
        source: HERDR_WORKSPACE_METADATA_SCOPE.source,
        tokens: { [HERDR_WORKSPACE_METADATA_SCOPE.token]: value },
        seq,
        ttl_ms
      }
    }
    const result = await chain.request(request)
    captures.push({ request: { ...request, id: result.binding.native_request_id }, response: result.response })
    return result
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
  assert.deepEqual(first.response, { id: first.binding.native_request_id, result: { type: 'ok' } })
  assert.deepEqual(object((await current()).tokens), { rovloom_note: 'synthetic-one' })
  const duplicate = await patch('synthetic-conflict', 1)
  assert.deepEqual(duplicate.response, { id: duplicate.binding.native_request_id, result: { type: 'ok' } })
  assert.deepEqual(object((await current()).tokens), { rovloom_note: 'synthetic-one' })
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
  assert.deepEqual(initialTokens, { rovloom_note: 'synthetic-short' })
  diagnostics.stage = 'ttl_eventual_expiry'
  const expiresBy = Date.now() + 10_000
  while (Object.hasOwn(object((await current()).tokens ?? {}), HERDR_WORKSPACE_METADATA_SCOPE.token)) {
    assert(Date.now() < expiresBy, 'metadata_expiry_not_observed')
    await new Promise(/** 给原生共享清扫循环让出时间，不声称期限瞬间精确消失。 */ (resolve) => setTimeout(resolve, 25))
  }
  diagnostics.expiry_observed_ms = Math.round(performance.now() - ttlStarted)
  diagnostics.stage = 'retained_sequence_and_native_error'
  await patch('synthetic-stale-after-expiry', 3)
  assert.deepEqual(object((await current()).tokens ?? {}), {})
  await patch('synthetic-new-sequence', 4)
  assert.deepEqual(object((await current()).tokens), { rovloom_note: 'synthetic-new-sequence' })
  const missing = await patch('synthetic-missing', 5, 60_000, 'wZZZZZZZZZZZZ')
  assert.equal(object(missing.response.error).code, 'workspace_not_found')
  assert.equal(chain.claimCount(), beforeClaims + 8)
  checks.push({ name: 'metadata_eventual_expiry_retained_sequence_and_native_error', passed: true })

  diagnostics.stage = 'unchanged_state_and_zero_input'
  const afterWorkspace = await current()
  const { tokens: _beforeTokens, ...beforeState } = beforeWorkspace
  const { tokens: _afterTokens, ...afterState } = afterWorkspace
  assert.deepEqual(afterState, beforeState)
  assert.equal(Number(readFileSync(join(root, 'terminal.input.bytes'), 'utf8')), 0)
  checks.push({ name: 'metadata_owned_workspace_state_and_zero_synthetic_input', passed: true })

  diagnostics.stage = 'invalid_parameter_denials'
  const scope = HERDR_WORKSPACE_METADATA_SCOPE
  const valid = {
    workspace_id: workspaceId,
    source: scope.source,
    tokens: { [scope.token]: 'synthetic' },
    seq: 6,
    ttl_ms: 1000
  }
  const bad = [
    { ...valid, ttl_ms: null },
    { ...valid, source: 'other' },
    { ...valid, tokens: { other: 'synthetic' } },
    { ...valid, workspace_id: 'w_1' },
    { ...valid, tokens: { [scope.token]: ' padded ' } }
  ]
  const claimsBeforeRejected = chain.claimCount()
  for (const params of bad) {
    assert.throws(
      /** 错参数只检查生产准入拒绝，不实际调用未评审参数。 */ () =>
        chain.f.router.create(
          chain.f.principal,
          chain.target,
          { method: scope.method, params },
          {
            binding_revision: chain.binding_revision,
            contract_ref: contractRef(installation.record().wire.source),
            validation: 'strict',
            timeoutMs: 10_000
          }
        ),
      /provider_support_candidate/
    )
  }
  assert.equal(chain.claimCount(), claimsBeforeRejected)
  checks.push({ name: 'metadata_unreviewed_parameter_forms_rejected_without_claim', passed: true })
  diagnostics.stage = 'complete'
  return { captures, workspace_id: workspaceId, calls: 8, scope: 'synthetic_owned_workspace_only' }
}
