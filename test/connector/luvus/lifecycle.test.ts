/** 使用隔离 IPC 验证 adapter 关闭时释放 Wire 订阅，并保留派发前后不同的取消语义。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { LuvusAdapterError, LuvusRpcAdapter } from '../../../src/connector/luvus/index.js'
import { fixture } from './helpers.js'

/** 提供测试可控的异步完成点，兼容仓库现行 TypeScript 标准库目标。 */
function deferred<T>() {
  let resolve!: /* 声明由测试调用的完成回调，参数只来自本用例。 */ (value: T) => void
  const promise = new Promise<T>(
    /* 保存 Promise 原生完成器，让测试在观察到真实边界后继续执行。 */ (complete) => {
      resolve = complete
    }
  )
  return { promise, resolve }
}

/** 记录私有 Wire 订阅的创建和释放次数，不替代任何身份或授权门禁。 */
function trackedAdapter(f: Awaited<ReturnType<typeof fixture>>) {
  const subscriptions = { active: 0, released: 0 }
  f.backend.subscribeInvalidation = /* 为本用例记录 Wire 的账本订阅，并返回可观测的释放器。 */ () => {
    subscriptions.active++
    return /* 记录单次解除订阅；重复调用会使断言失败。 */ () => {
      subscriptions.active--
      subscriptions.released++
    }
  }
  return { adapter: new LuvusRpcAdapter(f.config, f.host), subscriptions }
}

/** 核对取消的公开错误及其结果是否仍按实际写入状态区分。 */
function cancelled(outcome: 'not_dispatched' | 'outcome_unknown') {
  return /* 保留安全错误码并核对结果未知边界，不将关闭解释成原生回滚。 */ (error: unknown) => {
    assert(error instanceof LuvusAdapterError)
    assert.equal(error.code, 'native_cancelled')
    assert.equal(error.outcome, outcome)
    return true
  }
}

test(
  'close releases the private Wire subscription exactly once after a completed RPC',
  /* 完成一次真实隔离 IPC 后重复关闭，验证 Wire 释放一次且新派发被拒绝。 */ async (t) => {
    const f = await fixture()
    t.after(/* 释放本用例拥有的 listener、socket 和私有目录。 */ () => f.close())
    const { adapter, subscriptions } = trackedAdapter(f)
    t.after(/* 即使用例中途失败也释放额外 adapter 的 Wire 资源。 */ () => adapter.close())
    assert.equal(subscriptions.active, 1)
    await adapter.dispatch(f.input())
    adapter.close()
    adapter.close()
    assert.deepEqual(subscriptions, { active: 0, released: 1 })
    await assert.rejects(
      adapter.dispatch(f.input()),
      /* 已关闭 adapter 必须在任何新原生派发前拒绝调用。 */ (error: unknown) => {
        assert(error instanceof LuvusAdapterError)
        assert.equal(error.code, 'adapter_closed')
        assert.equal(error.outcome, 'not_dispatched')
        return true
      }
    )
    assert.equal(f.state.claims, 1)
  }
)

test(
  'close during pending auth releases Wire and prevents late auth from claiming or writing',
  /* 在认证尚未返回时关闭，随后结算旧认证，验证没有延迟 claim 或原生写入。 */ async (t) => {
    const f = await fixture()
    t.after(/* 释放本用例拥有的 listener、socket 和私有目录。 */ () => f.close())
    const { adapter, subscriptions } = trackedAdapter(f)
    t.after(/* 确保额外 adapter 在断言失败时也完成关闭。 */ () => adapter.close())
    const entered = deferred<void>()
    const auth = deferred<string>()
    f.host.nativeAuth = /* 告知测试认证已开始，并等待测试显式返回合成 token。 */ () => {
      entered.resolve()
      return auth.promise
    }
    const pending = adapter.dispatch(f.input())
    const rejected = assert.rejects(pending, cancelled('not_dispatched'))
    await entered.promise
    adapter.close()
    await rejected
    auth.resolve('test-only-late-token')
    await setImmediate()
    assert.deepEqual(subscriptions, { active: 0, released: 1 })
    assert.equal(f.state.claims, 0)
    assert.equal(f.received(), '')
  }
)

test(
  'close after a written request releases Wire and preserves outcome_unknown without replay',
  /* 等待自建 listener 收到完整请求后关闭，验证取消保守为结果未知且不会重发。 */ async (t) => {
    const f = await fixture()
    t.after(/* 释放本用例拥有的 listener、socket 和私有目录。 */ () => f.close())
    const { adapter, subscriptions } = trackedAdapter(f)
    t.after(/* 断言异常时仍关闭额外 adapter。 */ () => adapter.close())
    const written = deferred<void>()
    f.respond(/* 记录请求实际到达并保持连接无响应，以便检验写入后的关闭。 */ () => written.resolve())
    const pending = adapter.dispatch(f.input())
    const rejected = assert.rejects(pending, cancelled('outcome_unknown'))
    await written.promise
    adapter.close()
    await rejected
    assert.deepEqual(subscriptions, { active: 0, released: 1 })
    assert.equal(f.state.claims, 1)
    assert.equal(f.state.responses, 1)
  }
)
