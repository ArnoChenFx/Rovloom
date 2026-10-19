/** 只在临时派生模块放行合成 reviewed provider，检查硬门禁之后的组件接缝。 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, test } from 'node:test'
import { providerFor } from '../../../src/wire/index.js'
import { createHerdrReadonlyAdapter } from '../../../src/connector/herdr/readonly.js'
import { persistentHerdrBackend, commitHerdrResponse } from '../../../src/connector/herdr/persistence.js'
import { Store } from '../../../src/store.js'
import { connected, management, responseFrame } from '../../storage/helpers.js'
import { backendFixture, fixture } from './helpers.js'

const root = mkdtempSync(join(tmpdir(), 'rovloom-herdr-seams-'))
const originalUrl = new URL('../../../src/connector/herdr/readonly.ts', import.meta.url)
const original = readFileSync(originalUrl, 'utf8')
let derived = original
for (const [relative, absolute] of [
  ['../../integration/luvus-wire.js', new URL('../../../src/integration/luvus-wire.ts', import.meta.url).href],
  ['../../wire/index.js', new URL('../../../src/wire/index.ts', import.meta.url).href],
  ['../../wire/types.js', new URL('../../../src/wire/types.ts', import.meta.url).href],
  ['./persistence.js', new URL('../../../src/connector/herdr/persistence.ts', import.meta.url).href]
]) {
  assert(derived.includes(relative!))
  derived = derived.replaceAll(relative!, absolute!)
}
assert(derived.includes('  assertProviderAccess,\n') && derived.includes('  providerFor,\n'))
derived = derived
  .replace('  assertProviderAccess,\n', '')
  .replace('  providerFor,\n', '  providerFor as originalProviderFor,\n  providerScopeAllowed,\n')

// 保留共享 provider 校验；仅将合成 validated Herdr 的 candidate 拒绝作为测试前提放行。
// 不改仓库文件、共享模块缓存或生产允许集，也不把此测试当实际 Wire 接通证明。
derived += `
/** 独立测试假定 reviewed provider 已接线，其余共享错误必须保持原样。 */
function providerFor(binding: AttemptBinding, ctx: AuthenticatedContext) {
  try { return originalProviderFor(binding, ctx) }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'provider_support_candidate') throw error
    const record = ctx.resolveContract?.(binding.contract_ref)
    if (binding.provider_kind !== 'herdr' || record?.support_status !== 'validated' ||
        record.source.classification_revision !== HERDR_READONLY_REVIEW.classification_revision) throw error
    return ctx.resolveProvider!(binding.target)!
  }
}
/** 原样采用完整 Target 的双端 grant 求交；不默认授予派发或读取。 */
function assertProviderAccess(binding: AttemptBinding, method: string, action: 'dispatch' | 'read', ctx: AuthenticatedContext) {
  providerFor(binding, ctx)
  if (!providerScopeAllowed(binding, method, action, ctx.policies)) fail('provider_scope_forbidden')
}
`
const modulePath = join(root, 'readonly.ts')
writeFileSync(modulePath, derived, { mode: 0o600 })
const isolated = (await import(
  pathToFileURL(modulePath).href
)) as typeof import('../../../src/connector/herdr/readonly.js')
after(
  /** 测试结束核对原文件未变，并删除本轮派生模块目录。 */ () => {
    try {
      assert.equal(readFileSync(fileURLToPath(originalUrl), 'utf8'), original)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)

/** 为每个反例准备合成完整来源与私有 permit；没有原生 socket 或 Store 写入。 */
function prepared() {
  const state = backendFixture()
  const adapter = isolated.createHerdrReadonlyAdapter(state.backend)
  const context = adapter.resolve(state.identity)
  const request = { ...state.record.native_request, id: state.binding.native_request_id }
  adapter.encodeRequest(request, context)
  const token = adapter.trustedSource(context)
  return { ...state, adapter, context, request, token }
}

test(
  'isolated ordinary gate passes the shared result-boundary contract while real Herdr stays closed',
  /** 核对隔离普通结果边界，同时直接检查真实 provider gate 继续关闭。 */ () => {
    const state = prepared()
    const gate = state.adapter.validator.requestGate(state.request, state.context)
    assert.equal(gate.authorized, true)
    assert.equal(gate.secret_result_authorized, true)
    assert.equal(gate.raw_contract_authorized, false)
    assert.throws(
      /** 对相同合成 binding 调用真实 gate，确认没有共享模块污染。 */ () =>
        providerFor(state.binding, state.backend.context('principal1', 'gateway_to_connector')),
      /provider_support_candidate/
    )
  }
)

test(
  'repeated resolution preserves permit and native source receipt',
  /** 重复解析原 binding 后回放响应，检查 permit 和私有来源凭据保持一致。 */ () => {
    const state = prepared()
    const next = state.adapter.resolve(state.identity)
    assert.equal(next.native_handle, state.context.native_handle)
    assert.equal(state.adapter.trustedSource(next), state.token)
    assert.doesNotThrow(
      /** 用重复解析返回的句柄验证原 permit 对应响应。 */ () =>
        state.adapter.validator.validateResponse(fixture().response, { ...next, trusted_source: state.token })
    )
  }
)

test(
  'valid native evidence survives read revocation while content delivery remains forbidden',
  /** 撤回 read grant 后保留原生证据校验，同时拒绝内容交付。 */ () => {
    const state = prepared()
    state.context = { ...state.context, trusted_source: state.token }
    state.backend.context('principal1', 'connector_to_gateway').policies!.local.grants[0]!.actions = ['dispatch']
    assert.doesNotThrow(
      /** 验证已派发调用的合法回包不因读取撤权被丢弃。 */ () =>
        state.adapter.validator.validateResponse(fixture().response, state.context)
    )
    assert.throws(
      /** 在读取撤权后检查内容边界的独立拒绝。 */ () => state.adapter.checkResult(state.context),
      /provider_scope_forbidden/
    )
  }
)

test(
  'policy revision change preserves evidence and current read but rejects new dispatch',
  /** 改变当前策略 revision，分别验证证据、当前读取及禁止重新派发。 */ () => {
    const state = prepared()
    state.backend.context('principal1', 'connector_to_gateway').policies!.local.revision = 'local2'
    assert.doesNotThrow(
      /** 使用原 permit 验证策略变化后的合法回包。 */ () =>
        state.adapter.validator.validateResponse(fixture().response, { ...state.context, trusted_source: state.token })
    )
    assert.doesNotThrow(/** 检查仍有当前 read grant 的内容交付边界。 */ () => state.adapter.checkResult(state.context))
    assert.throws(
      /** 用过期策略 revision 重新编码请求，检查派发拒绝。 */ () =>
        state.adapter.encodeRequest(state.request, state.context),
      /policy_revision_stale/
    )
  }
)

test(
  'background evidence needs no current reader while actual delivery does',
  /** 移除当前读者，核对后台证据仍有效而内容交付失败。 */ () => {
    const state = prepared()
    state.backend.currentPrincipal = /** 模拟后台处理回包时没有当前 caller。 */ () => undefined
    const next = state.adapter.resolve(state.identity)
    assert.equal(state.adapter.trustedSource(next), state.token)
    assert.doesNotThrow(
      /** 在没有当前读者时校验原私有来源的响应。 */ () =>
        state.adapter.validator.validateResponse(fixture().response, { ...next, trusted_source: state.token })
    )
    assert.throws(
      /** 尝试向不存在的当前读者交付内容。 */ () => state.adapter.checkResult(next),
      /attempt_binding_mismatch/
    )
  }
)

for (const key of ['connection_epoch', 'recovery_generation'] as const) {
  test(
    `old ${key} evidence cannot attach to the current connection or reuse its handle`,
    /** 切换连接或恢复代次，检查旧证据拒绝及新句柄不继承 permit。 */ () => {
      const state = prepared()
      const wire = state.backend.context('principal1', 'connector_to_gateway')
      wire.connection[key] = 'new-value'
      assert.throws(
        /** 将旧句柄回包交给已变化的当前连接上下文。 */ () =>
          state.adapter.validator.validateResponse(fixture().response, {
            ...state.context,
            trusted_source: state.token
          }),
        /attempt_binding_mismatch/
      )
      assert.throws(
        /** 在可信连接变化后重新解析旧身份。 */ () => state.adapter.resolve(state.identity),
        /attempt_binding_mismatch/
      )
      state.binding[key] = 'new-value'
      const next = state.adapter.resolve(state.identity)
      assert.notEqual(next.native_handle, state.context.native_handle)
      assert.throws(
        /** 向新句柄提交旧响应，检查没有原 permit 时拒绝。 */ () =>
          state.adapter.decodeResponse(Buffer.from(JSON.stringify(fixture().response) + '\n'), next),
        /dispatch_permit_unavailable/
      )
      assert.throws(
        /** 建立新句柄后再次提交旧句柄证据，防止旧状态被重绑。 */ () =>
          state.adapter.validator.validateResponse(fixture().response, {
            ...state.context,
            trusted_source: state.token
          }),
        /attempt_binding_mismatch/
      )
    }
  )
}

for (const change of ['disabled', 'revision'] as const) {
  test(
    `provider ${change} still blocks evidence under the isolated reviewed-provider premise`,
    /** 模拟 provider 禁用或 revision 改变，验证隔离测试仍保留共享身份门禁。 */ () => {
      const state = prepared()
      const wire = state.backend.context('principal1', 'connector_to_gateway')
      const resolver = wire.resolveProvider!
      wire.resolveProvider = /** 只替换本轮 provider 的 enabled 或 revision，保留其余完整 binding。 */ (target) => ({
        ...resolver(target)!,
        ...(change === 'disabled' ? { enabled: false } : { binding_revision: 2 })
      })
      assert.throws(
        /** 使用失效 provider 上下文验证原响应。 */ () =>
          state.adapter.validator.validateResponse(fixture().response, {
            ...state.context,
            trusted_source: state.token
          }),
        change === 'disabled' ? /provider_disabled/ : /provider_binding_mismatch/
      )
    }
  )
}

test(
  'source replacement and caller-invented receipt remain invalid for evidence',
  /** 分别伪造私有来源凭据和替换 endpoint token，验证证据来源隔离。 */ () => {
    const state = prepared()
    assert.throws(
      /** 提交调用方自行构造的来源对象。 */ () =>
        state.adapter.validator.validateResponse(fixture().response, { ...state.context, trusted_source: {} }),
      /native_source_untrusted/
    )
    state.backend.nativeSource = /** 每次返回不同的私有 endpoint token，模拟本机实例替换。 */ () => ({
      binding: state.binding,
      token: {}
    })
    assert.throws(
      /** 来源替换后重复解析，检查旧状态拒绝复用。 */ () => state.adapter.resolve(state.identity),
      /native_source_untrusted/
    )
    assert.throws(
      /** 来源替换后提交原句柄的回包证据。 */ () =>
        state.adapter.validator.validateResponse(fixture().response, { ...state.context, trusted_source: state.token }),
      /native_source_untrusted/
    )
  }
)

test(
  'unprepared or released state cannot accept even a schema-valid native response',
  /** 覆盖未准备、已释放及重新解析状态，确保合法 schema 不会补造 permit。 */ () => {
    const state = backendFixture()
    const adapter = isolated.createHerdrReadonlyAdapter(state.backend)
    const first = adapter.resolve(state.identity)
    const token = adapter.trustedSource(first)
    assert.throws(
      /** 编码前提交合法回包，检查缺少 dispatch permit。 */ () =>
        adapter.validator.validateResponse(fixture().response, { ...first, trusted_source: token }),
      /dispatch_permit_unavailable/
    )
    adapter.release(first)
    const next = adapter.resolve(state.identity)
    assert.notEqual(first.native_handle, next.native_handle)
    assert.throws(
      /** 释放后使用原句柄和来源凭据提交回包。 */ () =>
        adapter.validator.validateResponse(fixture().response, { ...first, trusted_source: token }),
      /native_handle_unavailable/
    )
    assert.throws(
      /** 向重新解析的句柄提交回包，确认不继承已释放状态的 permit。 */ () =>
        adapter.decodeResponse(Buffer.from(JSON.stringify(fixture().response) + '\n'), next),
      /dispatch_permit_unavailable/
    )
  }
)

for (const status of ['expired', 'discarded', 'unavailable'] as const) {
  test(
    `retention ${status} permits only native validation and never content delivery`,
    /** 分别模拟过期、discard 和不可用，区分证据校验与内容读取。 */ () => {
      const state = prepared()
      state.backend.contentStatus = /** 返回当前子场景固定保留状态，不更新原期限。 */ () => status
      assert.doesNotThrow(
        /** 在测试 backend 仍保留原 attempt 时校验响应证据。 */ () =>
          state.adapter.validator.validateResponse(fixture().response, {
            ...state.context,
            trusted_source: state.token
          })
      )
      assert.throws(
        /** 按当前保留状态检查内容交付必须拒绝。 */ () => state.adapter.checkResult(state.context),
        /content_unavailable/
      )
    }
  )
}

test(
  'real Store admission stays closed and persistent backend checks local configuration and shutdown',
  /** 真实 Store 拒绝 Herdr 建档；仅检验已授权配置核对与关闭通知，不伪造成功派发链路。 */ () => {
    const directory = mkdtempSync(join(tmpdir(), 'rovloom-herdr-store-'))
    const store = new Store(join(directory, 'db'), /** 固定真实账本的测试时钟。 */ () => 100, { management })
    const device = connected(store)
    const state = backendFixture()
    const provider = {
      machine_id: device.machine_id,
      provider_id: 'herdr',
      kind: 'herdr' as const,
      config_ref: 'owned-synthetic-herdr',
      binding_revision: 1,
      enabled: true
    }
    store.defineProvider(provider)
    const target = { ...device.target, provider_id: provider.provider_id }
    state.context.connection = {
      ...state.context.connection,
      machine_id: device.machine_id,
      connection_epoch: device.epoch,
      recovery_generation: store.generation()
    }
    const local = { ...provider }
    const backend = persistentHerdrBackend(store, {
      ...state.backend,
      localProvider: /** 受保护本机配置由独立对象表达，不从响应或设备广告生成。 */ () => local
    })
    const adapter = createHerdrReadonlyAdapter(backend)
    try {
      assert.deepEqual(backend.context('principal1', 'gateway_to_connector').resolveProvider!(target), provider)
      local.config_ref = 'different-protected-instance'
      assert.throws(
        /** 同 kind 不同实例也必须拒绝。 */ () =>
          backend.context('principal1', 'gateway_to_connector').resolveProvider!(target),
        /provider_binding_mismatch/
      )
      local.config_ref = provider.config_ref
      assert.throws(
        /** 真实 Store 不因 adapter 存在而自动开放建档。 */ () =>
          store.createCall('principal1', target, state.record.native_request, {
            binding_revision: 1,
            contract_ref: state.binding.contract_ref,
            caller_policy_revision: 'caller1',
            local_policy_revision: 'local1'
          }),
        /provider_support_candidate/
      )
      assert.throws(
        /** 缺行仍保留 Store 的固定错误，不补造空调用。 */ () =>
          backend.attempt(state.binding.call_id, state.binding.attempt_id),
        /call_not_found/
      )
      assert.throws(
        /** 没有真实 attempt 不能从响应补造许可。 */ () => adapter.resolve(state.identity),
        /call_not_found/
      )
      const frame = responseFrame(state.binding, { result: (fixture().response as any).result })
      assert.throws(/** 真实提交同样缺锚点，不会写成功结果。 */ () => commitHerdrResponse(store, adapter, frame))
      store.close()
      assert.throws(
        /** Store 关闭已经同步撤销 adapter 及监听。 */ () => adapter.resolve(state.identity),
        /native_adapter_closed/
      )
    } finally {
      adapter.close()
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

for (const cleanup of ['ttl', 'discard'] as const) {
  test(
    `synthetic ${cleanup} releases request anchor and keeps only the already permitted ping response`,
    /** 合成许可前提下覆盖请求已不可恢复的路径；不宣称真实 Store 的 Herdr 正向接通。 */ () => {
      const state = prepared()
      try {
        const before = state.adapter.stats().attempt_bytes
        if (cleanup === 'ttl') {
          state.backend.now = /** 原内容期限到达，但去重期限仍有效。 */ () => 1000
        } else {
          state.emit({ kind: 'content', machine_id: state.binding.machine_id, call_id: state.binding.call_id })
        }
        state.backend.attempt = /** 内容回收后不再保留请求锚点。 */ () => undefined
        assert.equal(state.adapter.stats().executions, 0)
        assert.equal(state.adapter.stats().responses, 1)
        assert(state.adapter.stats().attempt_bytes < before)
        const context = state.adapter.resolve(state.identity)
        assert.equal(context.native_handle, state.context.native_handle)
        assert.deepEqual(
          state.adapter.decodeResponse(Buffer.from(JSON.stringify(fixture().response) + '\n'), context),
          fixture().response
        )
        assert.throws(
          /** 最小响应上下文不能重新派发。 */ () => state.adapter.encodeRequest(state.request, context),
          /content_unavailable/
        )
        assert.throws(
          /** 最小响应上下文不能复活交付权。 */ () => state.adapter.checkResult(context),
          /content_unavailable/
        )
      } finally {
        state.adapter.close()
        assert.equal(state.listeners.size, 0)
      }
    }
  )
}

test(
  'minimal response context rejects changed anchor retention and expires without refreshing dedup',
  /** 回收后固定期限不可变，改锚点或达到原去重期限均不能延长证据能力。 */ () => {
    const state = prepared()
    try {
      state.emit({ kind: 'content', machine_id: state.binding.machine_id, call_id: state.binding.call_id })
      state.backend.attempt = /** 模拟请求原文已不可恢复。 */ () => undefined
      const anchor = state.backend.responseAnchor
      state.backend.responseAnchor = /** 模拟错误地延长固定内容期限。 */ (binding) => ({
        ...anchor(binding)!,
        content_expires_at: 1001
      })
      assert.throws(
        /** 原期限变更拒绝旧能力。 */ () => state.adapter.decodeResponse(Buffer.alloc(0), state.context),
        /attempt_binding_mismatch/
      )
      state.backend.responseAnchor = anchor
      state.backend.now = /** 达到原去重截止时间，不从新回复刷新。 */ () => 2000
      assert.equal(state.adapter.stats().responses, 0)
      assert.throws(
        /** 到期后没有旧句柄可取。 */ () => state.adapter.decodeResponse(Buffer.alloc(0), state.context),
        /native_handle_unavailable/
      )
    } finally {
      state.adapter.close()
      assert.equal(state.listeners.size, 0)
    }
  }
)

for (const kind of ['closed', 'content', 'fence'] as const) {
  test(
    `reentrant ${kind} notification during resolution cannot register a handle after invalidation`,
    /** 原生宿主回调同步触发回收时，真实组件也不能在关闭或 fence 后登记上下文。 */ () => {
      const state = backendFixture()
      const anchor = state.backend.responseAnchor
      state.backend.responseAnchor = /** 在真实组件读取锚点期间注入同步通知，不放行生产 provider gate。 */ (
        binding
      ) => {
        const result = anchor(binding)
        state.emit(kind === 'closed' ? { kind } : { kind, machine_id: binding.machine_id, call_id: binding.call_id })
        return result
      }
      const adapter = createHerdrReadonlyAdapter(state.backend)
      try {
        assert.throws(
          /** 在所有 callbacks 完成后仍须核对关闭与本轮失效代次。 */ () => adapter.resolve(state.identity),
          kind === 'closed' ? /native_adapter_closed/ : /attempt_context_invalidated/
        )
        if (kind !== 'closed') {
          assert.equal(adapter.stats().executions, 0)
          assert.equal(adapter.stats().responses, 0)
        }
      } finally {
        adapter.close()
        assert.equal(state.listeners.size, 0)
      }
    }
  )
}

test(
  'independent Store retention windows need not place dedup after content expiry',
  /** 保持 Store 各期限独立；相等或较短的去重窗口不能被 adapter 擅自改成无效配置。 */ () => {
    for (const expires of [500, 1000]) {
      const state = backendFixture()
      const anchor = state.backend.responseAnchor
      state.backend.responseAnchor = /** 使用仍在未来、但不大于内容期限的原锚点去重期限。 */ (binding) => ({
        ...anchor(binding)!,
        dedup_expires_at: expires
      })
      const adapter = createHerdrReadonlyAdapter(state.backend)
      try {
        adapter.resolve(state.identity)
        assert.equal(adapter.stats().executions, 1)
        state.backend.now = /** 达到各自原截止时间后精确释放，不延长任何窗口。 */ () => expires
        assert.equal(adapter.stats().executions, 0)
      } finally {
        adapter.close()
      }
    }
  }
)
