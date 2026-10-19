// 用真实SDK和明确服务stub验证测试结束能取消等待、排空拒绝并清理子进程，正常断言失败仍传播。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { sdkTestSession } from './sdk-test-session.js'

const server = {
  command: process.execPath,
  args: ['--no-env-file', fileURLToPath(new URL('./stub-server.ts', import.meta.url))],
  env: { PATH: process.env.PATH ?? '' },
  stderr: 'pipe' as const
}

test(
  'SDK测试结束hook排空在途取消错误，真实子进程退出且没有晚到未处理拒绝',
  /* 手动触发测试拥有的结束hook，不靠延长runner超时掩盖挂起；服务明确为stub。 */ async (t) => {
    let cleanup!: () => Promise<void>
    const session = sdkTestSession(
      {
        after: /* 保存与真实超时完全相同的清理入口，后续仍由当前用例确保执行。 */ (hook) => {
          cleanup = hook
        }
      },
      server
    )
    t.after(/* 断言中途失败也必须清理已创建的SDK子进程。 */ () => cleanup())
    let sent!: () => void
    const writing = new Promise<void>(
      /* 用实际请求写入握手代替sleep。 */ (resolve) => {
        sent = resolve
      }
    )
    let pid: number | null = null
    const running = session.run(
      /* 等初始化后提交明确stub的长等待，结束hook必须取消它并排空SDK拒绝。 */ async (client, transport, signal) => {
        pid = transport.pid
        const send = transport.send.bind(transport)
        transport.send = /* 只在tools/call确实写入管道后通知父用例触发结束。 */ async (message) => {
          await send(message)
          if ('method' in message && message.method === 'tools/call') {
            sent()
          }
        }
        await client.callTool(
          {
            name: 'runtime_call',
            arguments: {
              target: { machine_id: 'machine', provider_id: 'provider', profile: 'session', session: 'isolated' },
              expected_binding_revision: 1,
              contract_ref: 'a'.repeat(64),
              deadline: 2_000_000_000_000,
              native_request: { method: 'stub.slow' },
              wait_ms: 5000
            }
          },
          CallToolResultSchema,
          { signal, timeout: 5000 }
        )
      }
    )
    // 在触发结束前挂好最终等待，取消过程中不能留下无接收方的拒绝。
    const finished = running.then(
      /* 正常结束与结束hook取消都须完整结算工作流。 */ () => ({ ok: true }),
      /* 初始化失败同样唤醒父用例并保留失败，不能留下无接收方拒绝或永不结算的写入握手。 */ (error: unknown) => {
        sent()
        return { ok: false, error }
      }
    )
    await writing
    assert(pid)
    await cleanup()
    assert.deepEqual(await finished, { ok: true })
    assert.equal(session.transport.pid, null)
    assert.throws(/* 核对自建子进程已退出，不只依赖SDK把pid字段清空。 */ () => process.kill(pid!, 0), { code: 'ESRCH' })
  }
)

test(
  'SDK初始化拒绝的自动close与finally共享真实退出过程，不提前返回或遗留进程',
  /* 受控替身忽略EOF/TERM；收到拒绝响应后才安排显式释放，核对SDK自动close竞态。 */ async (t) => {
    let pid: number | null = null
    let release: ReturnType<typeof setTimeout> | undefined
    let released = false
    t.after(
      /* 断言失败也只终止本用例创建的子进程，不遗留受控替身。 */ () => {
        clearTimeout(release)
        if (pid) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch (error) {
            assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH')
          }
        }
      }
    )
    const session = sdkTestSession(t, {
      ...server,
      args: ['--no-env-file', fileURLToPath(new URL('./reject-initialize-server.ts', import.meta.url))]
    })
    session.transport.onmessage = /* 真实收到initialize拒绝后再启动释放计时器，排除进程尚未启动的混淆。 */ (
      message
    ) => {
      if ('result' in message) {
        release = setTimeout(
          /* 延迟只用于故障注入；run必须等待此自有进程实际退出。 */ () => {
            released = true
            process.kill(pid!, 'SIGUSR1')
          },
          120
        )
      }
    }
    const running = session.run(
      /* 初始化失败后不能继续执行任何工具请求。 */ async () => {
        assert.fail('unexpected_initialized_session')
      }
    )
    pid = session.transport.pid
    await assert.rejects(running, /protocol version is not supported/)
    assert.equal(released, true)
    assert(pid)
    assert.throws(/* 不只检查SDK字段，要求父测试持有的真实子进程已退出。 */ () => process.kill(pid!, 0), {
      code: 'ESRCH'
    })
  }
)

test(
  'SDK生命周期清理不会吞掉正常工作流的断言失败',
  /* 真实握手后故意抛固定错误，正常失败必须传播给runner，不能被清理分支洗成成功。 */ async (t) => {
    const session = sdkTestSession(t, server)
    const failure = new Error('synthetic_assertion_failure')
    await assert.rejects(
      session.run(
        /* 固定失败只用于断言传播，不含底层或用户异常内容。 */ async () => {
          throw failure
        }
      ),
      failure
    )
    assert.equal(session.transport.pid, null)
  }
)
