/** 用真实 Store、原 NativeValidator 与 Wire 验证共同结果门禁和逐 provider 上限，不构造 Herdr 许可替身。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../../src/store.js'
import { createProviderResultAccess } from '../../src/runtime/results.js'
import type { ProviderOriginalRead, ProviderResultAccessOptions, ResultProvider } from '../../src/runtime/results.js'
import { commitLuvusResponse } from '../../src/integration/persistence.js'
import type { Principal } from '../../src/router.js'
import { DEFAULT_LIMITS } from '../../src/native-contract/index.js'
import { boundedJson, LIMITS } from '../../src/wire/index.js'
import { management, responseFrame } from '../storage/helpers.js'
import { nativeBackend } from '../storage/native-backend.js'

/** 同一 Store 内建立两个各持原 Wire 的真实测试 provider；全局句柄子额只有一份。 */
function fixture(handleBytes = 4096, contentBytes?: number) {
  const directory = mkdtempSync(join(tmpdir(), 'rovloom-provider-results-'))
  const path = join(directory, 'state.sqlite')
  const state = { now: 100, available: true }
  const store = new Store(path, /** 共同结果与原 Wire 使用同一受控可信时钟。 */ () => state.now, {
    management,
    retention: {
      handle_payload_bytes: handleBytes,
      handle_ttl: 10,
      content_ttl: 30,
      ...(contentBytes === undefined ? {} : { content_bytes: contentBytes })
    }
  })
  const inspect = new DatabaseSync(path, { readOnly: true })
  const first = nativeBackend(store)
  store.defineProvider({
    ...store.provider(first.target.machine_id, first.target.provider_id)!,
    provider_id: 'second_provider',
    config_ref: 'second_config'
  })
  const second = nativeBackend(store, { device: first.device, provider_id: 'second_provider' })
  const originals = new Map<string, ProviderOriginalRead>()
  const providers = new Map<string, ResultProvider>()
  const calls = [first, second].map(
    /** 经真实原许可派发并提交完整响应，不模拟结果授权成功。 */ (native) => {
      const call = native.create()
      const binding = native.dispatch(call.call_id)
      const frame = responseFrame(binding, {
        error: { code: 'isolated', message: 'preserved', data: { text: 'x'.repeat(256) } }
      })
      commitLuvusResponse(store, native.adapter, frame)
      originals.set(call.call_id, { binding, wire: native.adapter })
      providers.set(native.target.provider_id, {
        binding: store.provider(native.target.machine_id, native.target.provider_id)!,
        max_response_bytes: DEFAULT_LIMITS.object_bytes
      })
      return store.call('synthetic', call.call_id)
    }
  )
  const principal: Principal = {
    id: 'synthetic',
    policy: {
      revision: 'caller1',
      grants: [
        ...first.backend.policies('synthetic').caller.grants,
        ...second.backend.policies('synthetic').caller.grants
      ]
    },
    permissions: { discard_response: true }
  }
  const local = { revision: 'local1', grants: structuredClone(principal.policy.grants) }
  const ports: ProviderResultAccessOptions = {
    store,
    principal: /** 读取当前 fixture 主体，不从结果 ID 或 provider 配置推导身份。 */ () => principal,
    localPolicies: /** 当前双端 ACL 与原生许可独立，随测试显式撤销。 */ () => local,
    resolveOriginalRead: /** 仅返回本 fixture 持有原 permit 的真实 Wire。 */ (callId) =>
      state.available ? originals.get(callId) : undefined,
    provider: /** 由受保护完整 tuple 选择配置，不按 kind 或最近活动实例选结果。 */ (target) => {
      const native = [first, second].find(
        /** 只匹配各 provider 自己完整的固定目标。 */ (entry) => boundedJson(entry.target) === boundedJson(target)
      )
      return native ? providers.get(native.target.provider_id) : undefined
    }
  }
  return {
    store,
    state,
    first,
    second,
    originals,
    providers,
    calls,
    principal,
    local,
    ports,
    access: createProviderResultAccess(ports),
    /** 只读连接核对实际句柄个数，不能借此创建或恢复原许可。 */
    handles() {
      return Number(inspect.prepare('SELECT count(*) AS n FROM results').get()!.n)
    },
    /** 修改测试配置仅用于撤权与错误预算回归，不将该方法作为产品配置来源。 */
    configure(providerId: string, value: ResultProvider) {
      providers.set(providerId, value)
    },
    /** 释放本 fixture 独立 Wire、Store 与临时文件，保留真实共享预算检验。 */
    close() {
      first.adapter.close()
      second.adapter.close()
      inspect.close()
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

test(
  'common provider results preserve original response bytes and fixed Store handle expiry',
  /** 中性结果层只转接真实原 Wire，分页、重复 open 和读取均不新建执行或刷新期限。 */ (t) => {
    const f = fixture()
    t.after(/** 关闭两个真实测试 provider 的原上下文。 */ () => f.close())
    for (const call of f.calls) {
      const metadata = f.access.open(call.call_id)
      assert.equal(metadata.expires, f.state.now + 10)
      const page = f.access.read(metadata.result_id)
      assert.equal(Buffer.from(page.data, 'base64').toString('utf8'), call.response)
      assert.equal(page.bytes, Buffer.byteLength(call.response!))
      assert.equal(page.hash, metadata.hash)
      f.state.now = 105
      assert.equal(f.access.open(call.call_id).expires, metadata.expires)
      assert.equal(f.access.read(metadata.result_id).expires, metadata.expires)
    }
    assert.equal(f.handles(), 2)
    assert.equal(f.first.state.sends, 1)
    assert.equal(f.second.state.sends, 1)
  }
)

for (const axis of ['machine_id', 'provider_id', 'kind', 'binding_revision', 'config_ref', 'enabled'] as const) {
  test(
    'protected result provider must match canonical ' + axis,
    /** 任一完整 provider 轴变化都不能借正确 kind 或原 Wire 获得保留句柄。 */ (t) => {
      const f = fixture()
      t.after(/** 回收本例实际资源。 */ () => f.close())
      const binding = { ...f.providers.get(f.first.target.provider_id)!.binding }
      if (axis === 'machine_id') {
        binding.machine_id = 'other_machine'
      } else if (axis === 'provider_id') {
        binding.provider_id = f.second.target.provider_id
      } else if (axis === 'kind') {
        binding.kind = 'herdr'
      } else if (axis === 'binding_revision') {
        binding.binding_revision++
      } else if (axis === 'config_ref') {
        binding.config_ref = 'other_config'
      } else {
        binding.enabled = false
      }
      f.configure(f.first.target.provider_id, { binding, max_response_bytes: DEFAULT_LIMITS.object_bytes })
      assert.throws(
        /** 配置不匹配必须在 Store 创建句柄前失败。 */ () => f.access.open(f.calls[0]!.call_id),
        /provider_binding_mismatch/
      )
      assert.equal(f.handles(), 0)
      assert.equal(f.first.state.sends, 1)
    }
  )
}

test(
  'original result attempt kind cannot be substituted for the canonical provider kind',
  /** 原 binding 也须匹配受保护 kind；同形 JSON 不能把 Luvus 原许可解释为 Herdr。 */ (t) => {
    const f = fixture()
    t.after(/** 回收本例实际资源。 */ () => f.close())
    const call = f.calls[0]!
    const original = f.originals.get(call.call_id)!
    f.originals.set(call.call_id, { ...original, binding: { ...original.binding, provider_kind: 'herdr' } })
    assert.throws(
      /** 错种类不得进入原 Wire 或创建另一句柄。 */ () => f.access.open(call.call_id),
      /attempt_binding_mismatch/
    )
    assert.equal(f.handles(), 0)
  }
)

for (const budget of [0, -1, 0.5, Infinity, NaN, LIMITS.object_bytes + 1]) {
  test(
    'invalid protected provider response budget rejects result retention: ' + String(budget),
    /** 每 provider 上限必须为共享 Wire 硬限以内的正安全整数。 */ (t) => {
      const f = fixture()
      t.after(/** 回收本例实际资源。 */ () => f.close())
      const configured = f.providers.get(f.first.target.provider_id)!
      f.configure(f.first.target.provider_id, { ...configured, max_response_bytes: budget })
      assert.throws(/** 坏预算不能放大解析或结果分配。 */ () => f.access.open(f.calls[0]!.call_id))
      assert.equal(f.handles(), 0)
    }
  )
}

test(
  'one provider byte limit cannot borrow another provider allowance or bypass existing-handle reads',
  /** 逐实例预算同样约束原有句柄，另一 provider 的较大上限不构成共享扩容。 */ (t) => {
    const f = fixture()
    t.after(/** 回收本例实际资源。 */ () => f.close())
    const call = f.calls[0]!
    const meta = f.access.open(call.call_id)
    const configured = f.providers.get(f.first.target.provider_id)!
    f.configure(f.first.target.provider_id, { ...configured, max_response_bytes: meta.bytes - 1 })
    assert.throws(
      /** 当前 provider 已不能解析原完整响应。 */ () => f.access.read(meta.result_id),
      /native_response_invalid/
    )
    assert.throws(
      /** 显式 open 也不能借旧句柄绕过更小上限。 */ () => f.access.open(call.call_id),
      /native_response_invalid/
    )
    assert(f.access.open(f.calls[1]!.call_id).bytes > 0)
    assert.equal(f.handles(), 2)
  }
)

test(
  'two protected providers share the sole Store result quota',
  /** 两份各自合法的 provider 上限不会把全局 handle_payload_bytes 乘二。 */ (t) => {
    const f = fixture(512)
    t.after(/** 回收本例实际资源。 */ () => f.close())
    const first = f.access.open(f.calls[0]!.call_id)
    assert(first.bytes < 512)
    assert.throws(
      /** 第二个 provider 仍服从 Store 已有句柄用量。 */ () => f.access.open(f.calls[1]!.call_id),
      /result_quota/
    )
    assert.equal(f.handles(), 1)
    assert.equal(f.access.read(first.result_id).expires, first.expires)
    assert.equal(f.first.state.sends + f.second.state.sends, 2)
  }
)

test(
  'two protected providers cannot multiply the sole Store content budget',
  /** 内容池已满只持久保存证据，较大的逐 provider 上限不能重建第二份正文或结果句柄。 */ (t) => {
    const f = fixture(512, 700)
    t.after(/** 回收共享内容池中的两个真实原 Wire。 */ () => f.close())
    assert.notEqual(f.calls[0]!.response, null)
    assert.equal(f.calls[1]!.state, 'responded')
    assert.equal(f.calls[1]!.content_status, 'unavailable')
    assert.equal(f.calls[1]!.response, null)
    const first = f.access.open(f.calls[0]!.call_id)
    assert.throws(
      /** 原证据不构成可恢复正文，结果层不能从 permit 补建内容。 */ () => f.access.open(f.calls[1]!.call_id),
      /result_not_ready/
    )
    assert.equal(f.handles(), 1)
    assert.equal(f.access.read(first.result_id).bytes, first.bytes)
    assert.equal(f.first.state.sends + f.second.state.sends, 2)
  }
)

for (const change of ['identity', 'local', 'wire', 'source', 'budget'] as const) {
  test(
    'protected provider callback cannot invalidate final result ' + change + ' facts silently',
    /** 最后一次配置回调同步撤权或关闭后，必须重验原 Wire 与当前身份及策略。 */ (t) => {
      const f = fixture()
      t.after(/** 回收本例实际资源。 */ () => f.close())
      const meta = f.access.open(f.calls[0]!.call_id)
      let reads = 0
      const access = createProviderResultAccess({
        ...f.ports,
        /** 第三次配置查询位于读取的最后一道本地 ACL 之后。 */ provider(target) {
          if (++reads === 3) {
            if (change === 'identity') {
              f.principal.id = 'other'
            } else if (change === 'local') {
              f.local.grants = []
            } else if (change === 'wire') {
              f.first.adapter.close()
            } else if (change === 'source') {
              f.first.state.sourceVerified = false
            } else {
              const configured = f.providers.get(target.provider_id)!
              f.configure(target.provider_id, { ...configured, max_response_bytes: 1 })
            }
          }
          return f.ports.provider(target)
        }
      })
      assert.throws(/** 最后一道配置变化不能用先前已准备的结果页兜底。 */ () => access.read(meta.result_id))
      assert.equal(reads, 3)
      assert.equal(f.handles(), 1)
    }
  )
}

test(
  'late original Wire gate cannot mutate the protected provider budget and still deliver bytes',
  /** 原 Wire 保持真实校验，只在末次返回前改变活配置来验证最后的预算 fence。 */ (t) => {
    const f = fixture()
    t.after(/** 回收本例实际资源。 */ () => f.close())
    const call = f.calls[0]!
    const meta = f.access.open(call.call_id)
    const original = f.originals.get(call.call_id)!
    let checks = 0
    f.originals.set(call.call_id, {
      ...original,
      wire: {
        ...f.first.adapter,
        /** 先通过实际原 Wire，然后只在末次同步门禁后收紧同一活配置。 */ checkResult(binding, frame) {
          f.first.adapter.checkResult(binding, frame)
          if (++checks === 2) {
            const configured = f.providers.get(f.first.target.provider_id)! as { max_response_bytes: number }
            configured.max_response_bytes = 1
          }
        }
      }
    })
    assert.throws(/** 已变化的活配置不能继续授权正文。 */ () => f.access.read(meta.result_id), /forbidden/)
    assert.equal(checks, 2)
  }
)

test(
  'asynchronous protected provider ports reject safely before creating a handle',
  /** Promise 不是已完成的同步来源，晚到拒绝必须被消费且不能输出底层异常。 */ async (t) => {
    const f = fixture()
    t.after(/** 回收本例实际资源。 */ () => f.close())
    const access = createProviderResultAccess({
      ...f.ports,
      /** 错接的异步配置不得被当作允许。 */ async provider() {
        throw new Error('isolated_private_provider')
      }
    } as unknown as ProviderResultAccessOptions)
    assert.throws(/** 无同步可信配置时不得创建句柄。 */ () => access.open(f.calls[0]!.call_id), {
      message: 'result_port_invalid'
    })
    await Promise.resolve()
    assert.equal(f.handles(), 0)
  }
)
