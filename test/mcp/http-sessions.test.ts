// 两个真实HTTP SDK客户端共享同一业务服务，验证协议实例、认证主体和取消等待都隔离。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startHttpFacade } from '../../src/mcp/http.js'
import { FacadeServiceError, type ServiceContext, type ToolName } from '../../src/mcp/types.js'
import { sdkTestLifecycle } from './sdk-lifecycle.js'

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
  /* 服务明确为阻塞探针，不执行native或创建真实凭据。 */ async (testContext) => {
    const lifecycle = sdkTestLifecycle(testContext, 'http-sessions', 5000)
    return lifecycle.run(
      /** after须等待取消后的主体结束，不能只观察已登记的资源。 */ async () => {
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
          service: lifecycle.service({
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
          })
        })
        await lifecycle.own('listener', /** 客户端等待排空后关闭同一个真实listener。 */ () => running.close())
        const clientA = new Client({ name: 'alice-test', version: '1' })
        const clientB = new Client({ name: 'bob-test', version: '1' })
        const transportA = new StreamableHTTPClientTransport(new URL(running.url), {
          requestInit: { headers: { authorization: 'Bearer ALICE_TEST_ONLY' } }
        })
        const transportB = new StreamableHTTPClientTransport(new URL(running.url), {
          requestInit: { headers: { authorization: 'Bearer BOB_TEST_ONLY' } }
        })
        await lifecycle.own(
          'clients',
          /** 超时也释放业务探针和两条SDK连接，不让旧回调进入下一用例。 */ async () => {
            release.alice.resolve()
            release.bob.resolve()
            await Promise.all([clientA.close(), clientB.close()])
          }
        )
        try {
          await Promise.all([
            lifecycle.call(
              'initialize',
              /** A初始化服从本例原五秒期限。 */ () => clientA.connect(transportA, lifecycle.options())
            ),
            lifecycle.call(
              'initialize',
              /** B初始化共享原期限，不重新取得五秒预算。 */ () => clientB.connect(transportB, lifecycle.options())
            )
          ])
          assert(transportA.sessionId && transportB.sessionId)
          assert.notEqual(transportA.sessionId, transportB.sessionId)
          lifecycle.phase('start')
          const stop = new AbortController()
          const first = lifecycle
            .call(
              'machines_list',
              /** A显式取消与测试清理分别可中止本次等待。 */ () =>
                clientA.callTool({ name: 'machines_list', arguments: {} }, undefined, {
                  ...lifecycle.options(),
                  signal: AbortSignal.any([stop.signal, lifecycle.signal])
                })
            )
            .then(
              /* 意外成功也被立即观察，最后必须断言它真实拒绝。 */ () => false,
              /* 标准客户端取消拒绝不是native取消成功。 */ () => true
            )
          const second = lifecycle.call(
            'machines_list',
            /** B只绑定测试作用域，不绑定A的取消信号。 */ () =>
              clientB.callTool({ name: 'machines_list', arguments: {} }, undefined, lifecycle.options())
          )
          const secondObserved = second.then(
            /* 提前观察B成功路径，防止测试清理窗口留下未处理拒绝。 */ (reply) => ({ reply }),
            /* B的意外失败保留为失败结果，不能被清理隐藏。 */ (error: unknown) => ({ error })
          )
          lifecycle.phase('both_running')
          await lifecycle.wait(ready.promise)
          lifecycle.phase('client_cancel')
          stop.abort()
          assert.equal(await first, true)
          lifecycle.phase('server_cancel')
          await lifecycle.wait(stopped.promise)
          assert.equal(contexts.get('alice')!.wait_signal.aborted, true)
          assert.equal(contexts.get('bob')!.wait_signal.aborted, false)
          lifecycle.phase('client_close')
          await clientA.close()
          release.alice.resolve()
          release.bob.resolve()
          lifecycle.phase('bob_reply')
          const result = await secondObserved
          assert('reply' in result)
          assert.equal(result.reply.isError, true)
          lifecycle.phase('ping')
          assert.deepEqual(
            await lifecycle.call('ping', /** 保留B的真实协议存活检查。 */ () => clientB.ping(lifecycle.options())),
            {}
          )
          assert.deepEqual(operations, ['machines_list', 'machines_list'])
          lifecycle.phase('listener_auth')
          const denied = await fetch(running.url, { signal: lifecycle.signal })
          assert.equal(denied.status, 401)
          await denied.body?.cancel()
          lifecycle.phase('complete')
          lifecycle.complete()
        } finally {
          await lifecycle.close()
        }
      }
    )
  }
)
