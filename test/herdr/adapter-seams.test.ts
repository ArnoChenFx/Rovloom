/** 只在临时派生模块放行合成 reviewed provider，检查硬门禁之后的组件接缝。 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { after, test } from 'node:test'
import { providerFor } from '../../src/wire/index.js'
import { backendFixture, fixture } from './helpers.js'

const root = mkdtempSync(join(tmpdir(), 'rovloom-herdr-seams-'))
const originalUrl = new URL('../../src/herdr/readonly.ts', import.meta.url)
const original = readFileSync(originalUrl, 'utf8')
let derived = original
for (const [relative, absolute] of [
  ['../integration/luvus-wire.js', new URL('../../src/integration/luvus-wire.ts', import.meta.url).href],
  ['../wire/index.js', new URL('../../src/wire/index.ts', import.meta.url).href],
  ['../wire/types.js', new URL('../../src/wire/types.ts', import.meta.url).href]
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
const isolated = (await import(pathToFileURL(modulePath).href)) as typeof import('../../src/herdr/readonly.js')
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
