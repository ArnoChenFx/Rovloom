/** 使用真实 provider gate、品牌 schema 与 Store 检查精确 ping 的正反向接缝。 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { boundedJson, providerFor } from '../../../src/wire/index.js'
import { createHerdrReadonlyAdapter } from '../../../src/connector/herdr/readonly.js'
import { persistentHerdrBackend, commitHerdrResponse } from '../../../src/connector/herdr/persistence.js'
import { Store } from '../../../src/store.js'
import { createHerdrWireAdapter } from '../../../src/connector/herdr/wire.js'
import type { Adapter } from '../../../src/transport/common.js'
import { connected, management, responseFrame } from '../../storage/helpers.js'
import { backendFixture, fixture } from './helpers.js'

/** 为每个反例准备合成完整来源与私有 permit；没有原生 socket 或 Store 写入。 */
function prepared() {
  const state = backendFixture()
  const adapter = createHerdrReadonlyAdapter(state.backend)
  const context = adapter.resolve(state.identity)
  const request = { ...state.record.native_request, id: state.binding.native_request_id }
  adapter.encodeRequest(request, context)
  const token = adapter.trustedSource(context)
  return { ...state, adapter, context, request, token }
}

test(
  'reviewed ordinary gate passes the shared provider and result-boundary contract',
  /** 核对普通结果边界和真实固定来源 provider gate，不导入派生源码。 */ () => {
    const state = prepared()
    const gate = state.adapter.validator.requestGate(state.request, state.context)
    assert.equal(gate.authorized, true)
    assert.equal(gate.secret_result_authorized, true)
    assert.equal(gate.raw_contract_authorized, false)
    assert.equal(providerFor(state.binding, state.backend.context('principal1', 'gateway_to_connector')).kind, 'herdr')
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
    `provider ${change} still blocks evidence under the reviewed-provider gate`,
    /** 模拟 provider 禁用或 revision 改变，验证真实固定来源测试仍保留共享身份门禁。 */ () => {
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
    const adapter = createHerdrReadonlyAdapter(state.backend)
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

/** 用自有临时 SQLite、真实品牌编译器和固定来源构造准入/派发链；原生响应来自脱敏 fixture。 */
function stored(prepare = true) {
  const directory = mkdtempSync(join(tmpdir(), 'rovloom-herdr-store-'))
  let now = 100
  const store = new Store(join(directory, 'db'), /** 只由测试推进可信时钟。 */ () => now, {
    management,
    retention: { content_ttl: 50 }
  })
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
  const target = {
    machine_id: device.machine_id,
    provider_id: provider.provider_id,
    profile: 'session' as const,
    session: 'synthetic'
  }
  const options = {
    binding_revision: 1,
    contract_ref: state.binding.contract_ref,
    caller_policy_revision: 'caller1',
    local_policy_revision: 'local1',
    timeoutMs: 20
  }
  const call = store.createCall('principal1', target, state.record.native_request, options)
  const binding = store.dispatch('principal1', call.call_id, device.epoch)
  const { machine_id: _machine, connection_epoch: _epoch, recovery_generation: _generation, ...identity } = binding
  state.context.connection = {
    ...state.context.connection,
    machine_id: device.machine_id,
    connection_epoch: device.epoch,
    recovery_generation: store.generation(),
    negotiated: { major: 2, minor: 0, capabilities: ['rpc', 'late_evidence'] }
  }
  for (const side of [state.context.policies!.caller, state.context.policies!.local]) {
    side.grants[0]!.target = target
  }
  const local = { ...provider }
  const token = Object.freeze({ owned_synthetic_socket: true })
  const backend = persistentHerdrBackend(store, {
    ...state.backend,
    localProvider: /** 本机配置独立于 Store 持有，可测试相同 kind 的错误实例。 */ () => local,
    nativeSource: /** 来源只绑定本轮 Store 派发事实，不从响应建立。 */ (value) =>
      boundedJson(value) === boundedJson(binding) ? { binding, token } : undefined
  })
  const adapter = createHerdrReadonlyAdapter(backend)
  const context = adapter.resolve(identity)
  const request = { method: 'ping', params: {}, id: binding.native_request_id }
  if (prepare) {
    adapter.encodeRequest(request, context)
  }
  const frame = responseFrame(binding, { result: fixture().response.result })
  return {
    ...state,
    store,
    target,
    options,
    local,
    provider,
    backend,
    binding,
    identity,
    adapter,
    context,
    request,
    frame,
    advance: /** 时间推进不触发其它设备、会话或模型调用。 */ (value: number) => {
      now = value
    },
    close: /** 关闭真实 Store/adapter 并删除本轮自有数据库。 */ () => {
      adapter.close()
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

test(
  'real Store admits exact reviewed ping and persistent backend checks local configuration and shutdown',
  /** 真实 Store 正向建档并提交真实 codec 验过的 fixture；本测试不声称运行原生 binary。 */ () => {
    const state = stored()
    try {
      assert.deepEqual(
        state.backend.context('principal1', 'gateway_to_connector').resolveProvider!(state.target),
        state.provider
      )
      state.local.config_ref = 'different-protected-instance'
      assert.throws(
        /** 同 kind 不同本机配置不得混用。 */ () => state.adapter.encodeRequest(state.request, state.context),
        /provider_binding_mismatch/
      )
      state.local.config_ref = state.provider.config_ref
      const bytes = Buffer.from(JSON.stringify(state.frame.payload.native_response) + '\n')
      assert.deepEqual(state.adapter.decodeResponse(bytes, state.context), state.frame.payload.native_response)
      const result = commitHerdrResponse(state.store, state.adapter, state.frame)
      assert.equal(result.state, 'responded')
      assert.deepEqual(JSON.parse(result.response!), state.frame.payload.native_response)
      state.store.close()
      assert.throws(
        /** Store 关闭同步撤销 adapter 及监听。 */ () => state.adapter.resolve(state.identity),
        /native_adapter_closed/
      )
    } finally {
      state.close()
    }
  }
)

for (const cleanup of ['ttl', 'discard', 'late'] as const) {
  test(
    `real Store ${cleanup} accepts original ping evidence without reviving forbidden content`,
    /** 原生 permit 经真实 Store 回收/迟到事务仍只提交合法证据，不恢复原请求或内容期限。 */ () => {
      const state = stored()
      try {
        const anchor = state.store.responseAnchor(state.binding)
        if (cleanup === 'discard') {
          state.store.discardResponse('principal1', state.binding.call_id)
        } else {
          state.advance(cleanup === 'ttl' ? 150 : 120)
          state.store.expire()
        }
        const result = commitHerdrResponse(state.store, state.adapter, state.frame)
        assert.equal(state.store.responseAnchor(state.binding).content_expires_at, anchor.content_expires_at)
        assert.equal(state.store.responseAnchor(state.binding).dedup_expires_at, anchor.dedup_expires_at)
        if (cleanup === 'late') {
          assert.equal(result.state, 'responded')
          assert.equal(
            state.store
              .auditRecords()
              .some(/** 固定审计记录迟到证据，不代表重复派发。 */ (entry) => entry.action === 'late_evidence'),
            true
          )
          assert.deepEqual(JSON.parse(result.response!), state.frame.payload.native_response)
        } else {
          assert.equal(result.response, null)
          assert.equal(state.backend.attempt(state.binding.call_id, state.binding.attempt_id), undefined)
          assert.equal(state.adapter.stats().executions, 0)
          assert.equal(state.adapter.stats().responses, 1)
          assert.throws(
            /** 回收后的原 permit 不能恢复当前内容交付。 */ () => state.adapter.checkResult(state.context),
            /content_unavailable/
          )
        }
      } finally {
        state.close()
      }
    }
  )
}

for (const invalid of [
  { request: { method: 'session.snapshot', params: {} } },
  { request: { method: 'ping', params: { recent: true } } },
  { request: { method: 'ping' } },
  { request: { method: 'ping', params: {}, extra: true } },
  { validation: 'raw-contract' as const },
  { contract_ref: 'b'.repeat(64) },
  { host: true }
]) {
  test(
    `real Herdr Store admission refuses unreviewed intent ${JSON.stringify(invalid)}`,
    /** 建档严格匹配 session、契约、模式和完整 ping 空参对象，未知值不能成为派发锚点。 */ () => {
      const state = stored()
      try {
        assert.throws(
          /** 每个反例都走真实 Store writer，不修改数据库或生产源码。 */ () =>
            state.store.createCall(
              'principal1',
              'host' in invalid
                ? { machine_id: state.target.machine_id, provider_id: state.target.provider_id, profile: 'host' }
                : state.target,
              'request' in invalid ? invalid.request! : { method: 'ping', params: {} },
              {
                ...state.options,
                ...('validation' in invalid ? { validation: invalid.validation } : {}),
                ...('contract_ref' in invalid ? { contract_ref: invalid.contract_ref } : {})
              }
            ),
          /provider_support_candidate/
        )
      } finally {
        state.close()
      }
    }
  )
}

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

test(
  'Herdr Wire shares its native permit with the real Store and transport Adapter interface',
  /** 普通 Wire 请求、原生 fixture 响应和真实 Store 提交共用一个 core，不依赖源码派生或第二账本。 */ () => {
    const state = stored(false)
    const wire: Adapter = createHerdrWireAdapter(state.backend, state.adapter)
    try {
      const request = {
        ...state.frame,
        type: 'request' as const,
        message_id: 'wire-request',
        payload: {
          attempt: state.identity,
          expected_binding_revision: 1,
          native_request: { method: 'ping', params: {} },
          validation: 'strict' as const
        }
      }
      const raw = wire.encode(request, 'gateway_to_connector')
      assert.deepEqual(wire.decode(raw, 'gateway_to_connector'), request)
      assert.equal(wire.observeMessage(request, 'gateway_to_connector'), 'new')
      assert.equal(wire.observeMessage(request, 'gateway_to_connector'), 'duplicate')
      assert.throws(
        /** 相同 message ID 对应不同摘要不能变成第二个调用。 */ () =>
          wire.observeMessage(
            { ...request, payload: { ...request.payload, expected_binding_revision: 2 } },
            'gateway_to_connector'
          )
      )
      const encoded = wire.encode(state.frame, 'connector_to_gateway')
      assert.deepEqual(wire.decode(encoded, 'connector_to_gateway'), state.frame)
      wire.checkResult(state.binding, state.frame.payload.native_response)
      wire.checkResultRetention(state.binding, state.frame.payload.native_response)
      const result = state.store.commitEvidence(
        state.binding,
        /** 现有事务内重新规划响应证据。 */ () => wire.planEvidence(state.frame)
      )
      assert.equal(result.state, 'responded')
      wire.release(state.binding)
      assert.equal(state.adapter.stats().executions, 0)
      assert.throws(
        /** 释放后合法旧响应也不能复用旧 permit。 */ () => wire.decode(encoded, 'connector_to_gateway'),
        /dispatch_permit_unavailable/
      )
    } finally {
      wire.close()
      assert.equal(wire.stats().closed, true)
      state.close()
    }
  }
)

test(
  'Herdr bridge cancellation authorizes only the Wire wait and rejects native stream or object paths',
  /** cancel 只是现有 Wire 的等待治理；本切片无原生 cancel、流或对象实现。 */ () => {
    const state = stored()
    const wire = createHerdrWireAdapter(state.backend, state.adapter)
    try {
      const cancel = {
        ...state.frame,
        type: 'cancel' as const,
        payload: { attempt: state.identity, reason: 'caller_cancelled' as const }
      }
      assert.throws(
        /** 缺 cancel grant 不能停止其它调用者的桥接等待。 */ () => wire.encode(cancel, 'gateway_to_connector'),
        /provider_scope_forbidden/
      )
      for (const side of [
        state.backend.context('principal1', 'gateway_to_connector').policies!.caller,
        state.backend.context('principal1', 'gateway_to_connector').policies!.local
      ]) {
        side.grants[0]!.actions.push('cancel')
      }
      assert.equal(JSON.parse(wire.encode(cancel, 'gateway_to_connector')).type, 'cancel')
      assert.equal(state.adapter.stats().executions, 1)
      assert.throws(
        /** 不建立原生 stream 或 terminal fence。 */ () => wire.advanceStream(),
        /herdr_transport_unsupported/
      )
      assert.throws(/** 大响应不能暗中走 objects。 */ () => wire.encodeResponseObject(), /herdr_transport_unsupported/)
      assert.throws(/** 分片不能分配隐藏的组装器。 */ () => wire.acceptChunk(), /herdr_transport_unsupported/)
      wire.release(state.binding)
      assert.equal(state.adapter.stats().executions, 0)
      assert.equal(state.store.call('principal1', state.binding.call_id).state, 'dispatching')
    } finally {
      wire.close()
      state.close()
    }
  }
)
