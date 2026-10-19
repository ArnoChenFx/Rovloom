/** 验证完整帧与原始响应预算、claim 期间安装变化以及传输结束后的晚到认证边界。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Socket } from 'node:net'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { LuvusAdapterError } from '../../../src/connector/luvus/index.js'
import { requestFrame } from '../../../src/connector/luvus/adapter.js'
import { fixture } from './helpers.js'

const methods = ['task.add', 'terminal.backend.validate'] as const
const transports = ['ipc', 'cli'] as const
/** 构造安全错误码断言，确保传输边界失败不夹带底层内容。 */
function rejected(code: string) {
  return /* 核对拒绝值的 adapter 类型、错误码和公开消息。 */ (error: unknown) => {
    assert(error instanceof LuvusAdapterError)
    assert.equal(error.code, code)
    assert.equal(error.message, code)
    return true
  }
}
/** 同时核对自建 IPC 收件和 CLI stdin 文件，确认没有原生请求写入。 */
function noNativeInput(f: Awaited<ReturnType<typeof fixture>>) {
  assert.equal(f.received(), '')
  const input = join(f.cwd, 'request.jsonl')
  if (existsSync(input)) {
    assert.equal(readFileSync(input).length, 0)
  }
}

// 注入 auth/id/LF 后的实际帧必须符合在线上限，不能只计量原候选。
for (const method of methods) {
  for (const transport of transports) {
    test(
      `full injected frame intersects online request budget: ${transport}/${method}`,
      /* 在 IPC 和 CLI 上将在线请求预算设为完整帧少一字节，验证 claim 前拒绝。 */ async (t) => {
        const f = await fixture(transport, method)
        t.after(/* 清理本用例拥有的 adapter、连接和私有目录。 */ () => f.close())
        f.state.auth = 'x'.repeat(256)
        const actual = requestFrame(f.row.native_request, f.binding.native_request_id, f.state.auth, 1_048_576).length
        if (method.startsWith('terminal.backend.')) {
          f.capabilities.result.terminal.limits.request_bytes = actual - 1
        } else {
          f.capabilities.result.limits.frame_bytes = actual - 1
        }
        await assert.rejects(f.adapter.dispatch(f.input()), rejected('native_request_limit'))
        assert.equal(f.state.claims, 0)
        noNativeInput(f)
      }
    )
  }
  test(
    `online request budget accepts exact UTF-8/auth/id/LF boundary: ${method}`,
    /* 以含多字节及转义字符的请求验证在线预算接受恰好完整帧的边界。 */ async (t) => {
      const f = await fixture('ipc', method)
      t.after(/* 清理本用例拥有的 adapter、连接和私有目录。 */ () => f.close())
      f.state.auth = 'x'.repeat(256)
      if (method === 'task.add') {
        f.row.native_request.params = { title: '汉字 " \\ \n' }
      }
      const bytes = requestFrame(f.row.native_request, f.binding.native_request_id, f.state.auth, 1_048_576)
      if (method.startsWith('terminal.backend.')) {
        f.capabilities.result.terminal.limits.request_bytes = bytes.length
      } else {
        f.capabilities.result.limits.frame_bytes = bytes.length
      }
      const result = await f.adapter.dispatch(f.input())
      assert.deepEqual(result.native_response, f.response)
      assert.deepEqual(Buffer.from(f.received()), bytes)
      assert.equal(f.state.claims, 1)
    }
  )
}

// 不能只对解析后重序列化的 JSON 计量；原始空白和 LF 同样消耗在线预算。
for (const method of methods) {
  for (const transport of transports) {
    test(
      `raw response whitespace intersects online response budget: ${transport}/${method}`,
      /* 让原始响应空白超过在线预算，验证 IPC 和 CLI 都在解析重序列化前拒绝。 */ async (t) => {
        const f = await fixture(transport, method)
        t.after(/* 清理本用例拥有的 adapter、连接和私有目录。 */ () => f.close())
        if (method.startsWith('terminal.backend.')) {
          f.capabilities.result.terminal.limits.response_bytes = 512
        } else {
          f.capabilities.result.limits.frame_bytes = 512
        }
        const raw = JSON.stringify(f.response) + ' '.repeat(513) + '\n'
        assert(Buffer.byteLength(JSON.stringify(f.response) + '\n') < 512)
        assert(Buffer.byteLength(raw) > 512)
        if (transport === 'ipc') {
          f.respond(/* 返回包含超限空白的受控原始响应，并结束自建 socket。 */ (socket) => socket.end(raw))
        } else {
          f.configure({ mode: 'raw', raw, exit_code: method.startsWith('terminal.backend.') ? 0 : 1 })
        }
        await assert.rejects(f.adapter.dispatch(f.input()), rejected('native_stdout_limit'))
        assert.equal(f.state.claims, 1)
      }
    )
  }
  test(
    `raw response accepts exact whitespace/LF boundary: ${method}`,
    /* 把响应空白和 LF 填充到恰好在线预算，验证边界内响应正常返回。 */ async (t) => {
      const f = await fixture('ipc', method)
      t.after(/* 清理本用例拥有的 adapter、连接和私有目录。 */ () => f.close())
      if (method.startsWith('terminal.backend.')) {
        f.capabilities.result.terminal.limits.response_bytes = 512
      } else {
        f.capabilities.result.limits.frame_bytes = 512
      }
      const json = JSON.stringify(f.response)
      const raw = json + ' '.repeat(511 - Buffer.byteLength(json)) + '\n'
      assert.equal(Buffer.byteLength(raw), 512)
      f.respond(/* 发送恰好预算大小的受控响应，检验原始字节边界。 */ (socket) => socket.end(raw))
      assert.deepEqual((await f.adapter.dispatch(f.input())).native_response, f.response)
      assert.equal(f.state.claims, 1)
    }
  )
}

for (const transport of transports) {
  test(
    `binary mutation while durable claim waits prevents native write: ${transport}`,
    /* 在 durable claim 等待中修改受控安装，验证最终写入前再次核验二进制。 */ async (t) => {
      const f = await fixture(transport)
      t.after(/* 清理本用例拥有的 adapter、连接和私有目录。 */ () => f.close())
      f.host.claimDispatch = /* 登记合成 claim 后让出异步执行，再修改本 fixture 的固定入口。 */ async () => {
        f.state.claims++
        await Promise.resolve()
        appendFileSync(f.binary, '\n// 受控测试：claim 等待期间更改固定安装身份。\n')
      }
      await assert.rejects(f.adapter.dispatch(f.input()), rejected('binary_identity_changed'))
      assert.equal(f.state.claims, 1)
      noNativeInput(f)
    }
  )

  test(
    `transport ending during pending auth cannot claim after rejection: ${transport}`,
    /* 在认证尚未完成时结束传输，验证晚到认证不会新增 claim 或写入。 */ async (t) => {
      const f = await fixture(transport)
      t.after(/* 清理本用例拥有的 adapter、连接和私有目录。 */ () => f.close())
      let signalAuth!: /* 声明通知测试已进入认证等待的无参数回调。 */ () => void
      let releaseAuth!: /* 声明释放本次受控认证 promise 的测试回调。 */ (token: string) => void
      let socket: Socket | undefined
      let child: ChildProcessWithoutNullStreams | undefined
      const entered = new Promise<void>(
        /* 保存认证已进入的通知器，供测试精确终止当前传输。 */ (resolve) => {
          signalAuth = resolve
        }
      )
      const auth = new Promise<string>(
        /* 保存认证释放器，使测试能在派发已经拒绝后返回晚到认证。 */ (resolve) => {
          releaseAuth = resolve
        }
      )
      f.host.nativeAuth = /* 通知测试已经进入认证，再返回受控的未完成认证 promise。 */ () => {
        signalAuth()
        return auth
      }
      f.host.verifyPeer = /* 记录已连接的自有 socket 并返回匹配的合成 peer 身份。 */ async (connected) => {
        socket = connected
        return { pid: process.pid, uid: process.geteuid!(), gid: process.getegid!() }
      }
      f.host.verifyProxy = /* 记录本次受控代理子进程，供认证等待期间精确终止。 */ async (spawned) => {
        child = spawned
      }
      const pending = f.adapter.dispatch(f.input()).then(
        /** 派发意外成功时让测试失败，确保用例确实覆盖传输提前结束。 */
        () => {
          throw new Error('test expected a transport rejection')
        },
        /** 保留派发拒绝值供后续断言，同时消费 promise 拒绝。 */
        (error: unknown) => error
      )
      await entered
      if (transport === 'ipc') {
        socket!.destroy()
      } else {
        child!.kill('SIGKILL')
      }
      const error = await pending
      assert(error instanceof LuvusAdapterError)
      assert.equal(error.outcome, transport === 'ipc' ? 'not_dispatched' : 'outcome_unknown')
      assert.equal(f.state.claims, 0)
      releaseAuth('test-only-token')
      // 让已经返回的 auth promise 和可能残留的异步 prepare 有机会推进。
      await new Promise<void>(
        /* 给晚到认证和残余微任务短暂推进机会，再验证未产生任何新派发。 */ (resolve) => setTimeout(resolve, 30)
      )
      assert.equal(f.state.claims, 0)
      noNativeInput(f)
    }
  )
}
