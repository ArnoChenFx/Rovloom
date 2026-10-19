// 两个真实HTTP SDK客户端共享同一业务服务，验证协议实例、认证主体和取消等待都隔离。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startHttpFacade } from '../../src/mcp/http.js'
import { FacadeServiceError, type ServiceContext, type ToolName } from '../../src/mcp/types.js'

// 只有真实业务入口及AbortSignal回调能推进这些测试握手。
function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(
    /* 保存本例显式通知，不用sleep猜测进度。 */ (done) => {
      resolve = done
    }
  )
  return { promise, resolve }
}

test(
  '同一Gateway的两会话并发复用SDK请求ID，A取消/退出不影响B等待或持久listener',
  /* 服务明确为阻塞探针，不执行native或创建真实凭据。 */ async () => {
    const ready = gate()
    const stopped = gate()
    const release = { alice: gate(), bob: gate() }
    const contexts = new Map<string, ServiceContext>()
    const operations: ToolName[] = []
    const running = startHttpFacade({
      port: 0,
      authentication: {
        authenticate: /* 仅本用例接受两条固定合成header，不使用用户账户。 */ (request) => {
          const token = request.headers.get('authorization')
          return token === 'Bearer ALICE_TEST_ONLY'
            ? { principal_id: 'alice' }
            : token === 'Bearer BOB_TEST_ONLY'
              ? { principal_id: 'bob' }
              : null
        }
      },
      service: {
        execute: /* 两主体共享同一服务实例，但等待分别持有各自的认证上下文。 */ async (name, _args, context) => {
          operations.push(name)
          const id = context.caller.principal_id as keyof typeof release
          contexts.set(id, context)
          if (id === 'alice') {
            context.wait_signal.addEventListener('abort', stopped.resolve, { once: true })
          }
          if (contexts.size === 2) {
            ready.resolve()
          }
          await release[id].promise
          throw new FacadeServiceError('unavailable')
        }
      }
    })
    const clientA = new Client({ name: 'alice-test', version: '1' })
    const clientB = new Client({ name: 'bob-test', version: '1' })
    const transportA = new StreamableHTTPClientTransport(new URL(running.url), {
      requestInit: { headers: { authorization: 'Bearer ALICE_TEST_ONLY' } }
    })
    const transportB = new StreamableHTTPClientTransport(new URL(running.url), {
      requestInit: { headers: { authorization: 'Bearer BOB_TEST_ONLY' } }
    })
    try {
      await Promise.all([
        clientA.connect(transportA, { timeout: 5000 }),
        clientB.connect(transportB, { timeout: 5000 })
      ])
      assert(transportA.sessionId && transportB.sessionId)
      assert.notEqual(transportA.sessionId, transportB.sessionId)
      const stop = new AbortController()
      const first = clientA
        .callTool({ name: 'machines_list', arguments: {} }, undefined, { signal: stop.signal, timeout: 5000 })
        .then(
          /* 意外成功也被立即观察，最后必须断言它真实拒绝。 */ () => false,
          /* 标准客户端取消拒绝不是native取消成功。 */ () => true
        )
      const second = clientB.callTool({ name: 'machines_list', arguments: {} }, undefined, { timeout: 5000 })
      const secondObserved = second.then(
        /* 提前观察B成功路径，防止测试清理窗口留下未处理拒绝。 */ (reply) => ({ reply }),
        /* B的意外失败保留为失败结果，不能被清理隐藏。 */ (error: unknown) => ({ error })
      )
      await ready.promise
      stop.abort()
      assert.equal(await first, true)
      await stopped.promise
      assert.equal(contexts.get('alice')!.wait_signal.aborted, true)
      assert.equal(contexts.get('bob')!.wait_signal.aborted, false)
      await clientA.close()
      release.alice.resolve()
      release.bob.resolve()
      const result = await secondObserved
      assert('reply' in result)
      assert.equal(result.reply.isError, true)
      assert.deepEqual(await clientB.ping({ timeout: 5000 }), {})
      assert.deepEqual(operations, ['machines_list', 'machines_list'])
      assert.equal((await fetch(running.url)).status, 401)
    } finally {
      release.alice.resolve()
      release.bob.resolve()
      await Promise.allSettled([clientA.close(), clientB.close()])
      await running.close()
    }
  }
)
