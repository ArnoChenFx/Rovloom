/** 固定官方 schema 与脱敏原生值回放；合成授权不能开放共享 Herdr 门禁。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createHerdrCodec,
  createHerdrReadonlyAdapter,
  HERDR_READONLY_REVIEW as review
} from '../../../src/connector/herdr/readonly.js'
import { boundedJson, hash, providerFor } from '../../../src/wire/index.js'
import { backendFixture, exchanges, fixture, raw, schemas, source } from './helpers.js'

test(
  'official installed schema hash and all redacted native replies validate without rewriting values',
  /** 逐条回放脱敏原生请求和响应，核对安装 schema 摘要及值保真。 */ () => {
    assert.equal(hash(raw), review.schema_sha256)
    const codec = createHerdrCodec(source, schemas)
    for (const { request, response } of exchanges) {
      assert.deepEqual(JSON.parse(Buffer.from(codec.encode(request)).toString()), request)
      assert.deepEqual(codec.decode(Buffer.from(JSON.stringify(response) + '\n'), request), response)
    }
  }
)

test(
  'full response root rejects malformed pane data beyond the method envelope',
  /** 破坏 pane 的深层状态字段，验证完整响应根会拒绝合法 envelope 下的坏数据。 */ () => {
    const { request, response } = fixture(2)
    ;(response.result as any).snapshot.panes[0].agent_status = 'invented_status'
    assert.throws(
      /** 解析带非法 pane 状态的完整原生响应。 */ () =>
        createHerdrCodec(source, schemas).decode(Buffer.from(JSON.stringify(response) + '\n'), request),
      /herdr_native_response_invalid/
    )
  }
)

for (const method of [
  'pane.read',
  'agent.read',
  'events.subscribe',
  'events.wait',
  'workspace.rename',
  'agent.prompt',
  'server.stop',
  'unknown'
]) {
  test(
    `unreviewed native method ${method} is rejected before dispatch`,
    /** 对每个未评审方法检查编码前拒绝，不能从方法名称推断执行许可。 */ () => {
      assert.throws(
        /** 尝试编码当前未评审方法，检查分类拒绝。 */ () =>
          createHerdrCodec(source, schemas).encode({ id: 'n', method, params: {} }),
        /herdr_method_unreviewed/
      )
    }
  )
}

for (const params of [undefined, null, [], { recent: true }, { viewport: true }, { extra: 1 }]) {
  test(
    `passive RPC rejects nonempty or missing params ${JSON.stringify(params)}`,
    /** 逐项验证缺失或非空参数，保持被动 RPC 的精确空对象范围。 */ () => {
      assert.throws(
        /** 将当前参数反例传给 snapshot 编码器。 */ () =>
          createHerdrCodec(source, schemas).encode({ id: 'n', method: 'session.snapshot', params })
      )
    }
  )
}

test(
  'native error remains native and cannot be transformed into pong or a gateway error',
  /** 回放原生错误并核对原字段，避免将错误伪造成 pong 或网关错误。 */ () => {
    const { request } = fixture()
    const response = { id: request.id, error: { code: 'server_unavailable', message: 'synthetic native error' } }
    assert.deepEqual(
      createHerdrCodec(source, schemas).decode(Buffer.from(JSON.stringify(response) + '\n'), request),
      response
    )
  }
)

test(
  'native response requires exact id, method result and runtime version',
  /** 逐项破坏响应 ID、结果类型和版本，检查响应关联与来源约束。 */ () => {
    for (const patch of [
      { id: 'other' },
      { result: { type: 'ok' } },
      { result: { type: 'pong', version: 'future', protocol: 22 } }
    ]) {
      const { request, response } = fixture()
      assert.throws(
        /** 解析本轮破坏后的响应，检查明确拒绝。 */ () =>
          createHerdrCodec(source, schemas).decode(
            Buffer.from(JSON.stringify({ ...response, ...patch }) + '\n'),
            request
          )
      )
    }
  }
)

test(
  'framing rejects EOF, partial, extra frames, duplicate id, invalid UTF8 and oversize replies',
  /** 覆盖完整单帧边界，拒绝 EOF、坏编码、重复键和超长原文。 */ () => {
    const { request, response } = fixture()
    const json = JSON.stringify(response)
    for (const bytes of [
      Buffer.alloc(0),
      Buffer.from(json),
      Buffer.from(json + '\n' + json + '\n'),
      Buffer.from('{"id":"a","id":"a","result":{}}\n'),
      Buffer.from([255, 10]),
      Buffer.from(' '.repeat(review.frame_bytes) + '\n')
    ]) {
      assert.throws(
        /** 解析当前 framing 反例，确认不能产生原生结果。 */ () =>
          createHerdrCodec(source, schemas).decode(bytes, request)
      )
    }
  }
)

test(
  'source pin, classification, schema provenance and claimed generation cannot drift',
  /** 逐项改变固定来源和分类，验证研究值不能替代安装来源。 */ () => {
    for (const patch of [
      { binary_sha256: 'a'.repeat(64) },
      { schema_sha256: 'b'.repeat(64) },
      { binary_version: '0.9.6' },
      { native_protocol_version: '23' },
      { classification_revision: 'unreviewed' },
      { runtime_generation: 'fabricated' },
      { support_basis: 'live_catalog' as const }
    ]) {
      assert.throws(
        /** 以当前漂移的来源建立 codec，检查版本与摘要门禁。 */ () =>
          createHerdrCodec({ ...source, ...patch }, schemas),
        /herdr_contract_unreviewed/
      )
    }
    assert.throws(
      /** 提供与来源记录不符的编译 schema 摘要。 */ () =>
        createHerdrCodec(source, { ...schemas, schema_sha256: 'c'.repeat(64) }),
      /herdr_contract_unreviewed/
    )
  }
)

test(
  'complete schema rejection is not bypassed by the exact readonly allowlist',
  /** 让完整根校验器明确拒绝，检查精确方法列表不会绕过 schema 失败。 */ () => {
    const { request, response } = fixture()
    assert.throws(
      /** 编码原请求并保留完整 request 根拒绝结果。 */ () =>
        createHerdrCodec(source, { ...schemas, request: /** 模拟完整 request 根验证失败。 */ () => false }).encode(
          request
        ),
      /herdr_native_request_invalid/
    )
    assert.throws(
      /** 解析原响应并保留完整 response 根拒绝结果。 */ () =>
        createHerdrCodec(source, { ...schemas, response: /** 模拟完整 response 根验证失败。 */ () => false }).decode(
          Buffer.from(JSON.stringify(response) + '\n'),
          request
        ),
      /herdr_native_response_invalid/
    )
  }
)

test(
  'caller getters and extra native envelope fields cannot trigger a readonly request',
  /** 用 getter 和额外 auth 字段构造输入，检查边界验证不触发调用方代码。 */ () => {
    let invoked = false
    const params = Object.defineProperty({}, 'viewport', {
      enumerable: true,
      /** 记录 getter 是否被执行；安全入口应在读取它之前拒绝。 */
      get() {
        invoked = true
        return true
      }
    })
    assert.throws(
      /** 尝试编码含访问器的参数，检查读取前拒绝。 */ () =>
        createHerdrCodec(source, schemas).encode({ id: 'n', method: 'ping', params })
    )
    assert.equal(invoked, false)
    assert.throws(
      /** 尝试编码额外 auth 字段，检查原生 envelope 不接受扩权输入。 */ () =>
        createHerdrCodec(source, schemas).encode({ id: 'n', method: 'ping', params: {}, auth: 'forbidden' })
    )
  }
)

test(
  'shared Herdr candidate gate blocks even synthetic validated registry and complete codec',
  /** 用完整合成 registry 验证真实共享 Herdr gate 仍拒绝派发和来源凭据。 */ () => {
    const fixture = backendFixture()
    assert.throws(
      /** 直接调用真实 provider gate，防止测试替身掩盖生产关闭状态。 */ () =>
        providerFor(fixture.binding, fixture.context),
      /provider_support_candidate/
    )
    const adapter = createHerdrReadonlyAdapter(fixture.backend)
    const resolved = adapter.resolve(fixture.identity)
    assert.throws(
      /** 尝试通过 adapter 编码 ping，检查共享 candidate 硬拒绝。 */ () =>
        adapter.encodeRequest({ ...fixture.record.native_request, id: fixture.binding.native_request_id }, resolved),
      /provider_support_candidate/
    )
    assert.throws(
      /** 尝试获取私有证据来源，检查关闭门禁不能被只解析句柄绕过。 */ () => adapter.trustedSource(resolved),
      /provider_support_candidate/
    )
    adapter.release(resolved)
    assert.throws(
      /** 释放句柄后再次编码，检查旧 handle 不能复活。 */ () =>
        adapter.encodeRequest({ ...fixture.record.native_request, id: fixture.binding.native_request_id }, resolved),
      /native_handle_unavailable/
    )
  }
)

test(
  'snapshot protocol evidence cannot become an execution permission even with a synthetic registry',
  /** 将原 attempt 改为 snapshot，验证协议可回放不等于允许执行。 */ () => {
    const fixture = backendFixture()
    fixture.record.method = fixture.record.native_request.method = 'session.snapshot'
    const adapter = createHerdrReadonlyAdapter(fixture.backend)
    assert.throws(
      /** 解析 snapshot attempt，检查在创建执行句柄前拒绝。 */ () => adapter.resolve(fixture.identity),
      /herdr_method_unreviewed/
    )
    assert.deepEqual(review.methods, ['ping'])
    assert.deepEqual(review.protocol_methods, ['ping', 'session.snapshot'])
  }
)

test(
  'binding, profile, params and invented source fail before a handle can be used',
  /** 分别破坏目标、profile、参数和来源，验证完整 attempt 锚点。 */ () => {
    const fixture = backendFixture()
    const adapter = createHerdrReadonlyAdapter(fixture.backend)
    assert.throws(
      /** 使用另一 provider 的目标解析原调用。 */ () =>
        adapter.resolve({ ...fixture.identity, target: { ...fixture.binding.target, provider_id: 'other' } })
    )
    assert.throws(
      /** 把 session 原调用伪装成 Host 目标。 */ () =>
        adapter.resolve({
          ...fixture.identity,
          target: { machine_id: 'machine1', provider_id: 'herdr1', profile: 'host' }
        })
    )
    fixture.record.native_request.params = { viewport: true }
    assert.throws(/** 使用带 viewport 参数的原调用解析句柄。 */ () => adapter.resolve(fixture.identity))
    fixture.record.native_request.params = {}
    fixture.backend.nativeSource = /** 模拟宿主无法独立建立原生来源。 */ () => undefined
    assert.throws(
      /** 在原生来源缺失时重新解析原调用。 */ () => adapter.resolve(fixture.identity),
      /native_source_untrusted/
    )
  }
)

test(
  'unreleased handles have a hard count limit and share no persistent identity',
  /** 填满私有句柄额度，验证上限拒绝不会创建持久设备身份。 */ () => {
    const fixture = backendFixture()
    const adapter = createHerdrReadonlyAdapter(fixture.backend)
    for (let index = 0; index < 128; index++) {
      fixture.binding.call_id = fixture.identity.call_id = `call-${index}`
      adapter.resolve(fixture.identity)
    }
    fixture.binding.call_id = fixture.identity.call_id = 'call-over-limit'
    assert.throws(
      /** 超过未释放句柄上限后尝试登记另一调用。 */ () => adapter.resolve(fixture.identity),
      /adapter_limit/
    )
    assert.equal(boundedJson(fixture.binding), boundedJson(fixture.record.binding))
  }
)

test(
  'resolving the same complete binding preserves its private native handle',
  /** 重复解析同一完整 binding，并验证返回对象修改不能污染私有状态。 */ () => {
    const fixture = backendFixture()
    const adapter = createHerdrReadonlyAdapter(fixture.backend)
    const first = adapter.resolve(fixture.identity)
    const second = adapter.resolve(fixture.identity)
    assert.equal(second.native_handle, first.native_handle)
    const third = adapter.resolve(fixture.identity)
    second.binding.connection_epoch = 'mutated-result'
    assert.equal(third.binding.connection_epoch, fixture.binding.connection_epoch)
    assert.equal(adapter.resolve(fixture.identity).native_handle, first.native_handle)
  }
)
