/** 使用自建 listener 和真实 LuvusRpcAdapter 验证本地开关；所有原生回包均为明确合成数据。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture } from './helpers.js'
import { G } from '../../native-contract/helpers.js'
import { LuvusRpcAdapter } from '../../../src/connector/luvus/adapter.js'

const method = 'terminal.backend.submit_text'
const params = { server_generation: G, terminal_id: '1'.repeat(32), pane_id: '3', text: 'printf synthetic' }

test(
  'Luvus pinned local config accepts a boolean enable and rejects truthy JSON',
  /** 不需要额外配置框架；原本机配置的单一布尔字段即可开启合成终端。 */ async () => {
    const f = await fixture('ipc', method, params)
    const adapter = new LuvusRpcAdapter({ ...f.config, allow_terminal_execution: true }, f.host)
    f.respond(
      /** 合成原生 queued 仅表示输入入队，不能表示 shell 命令完成。 */ (socket) =>
        socket.end(
          JSON.stringify({
            id: f.binding.native_request_id,
            result: { type: 'terminal_backend_action', state: 'succeeded', dispatch: 'queued' }
          }) + '\n'
        )
    )
    try {
      assert.throws(
        /** JSON 字符串不能通过静态本机配置的验证。 */ () =>
          new LuvusRpcAdapter({ ...f.config, allow_terminal_execution: 'true' as unknown as boolean }, f.host),
        /terminal_execution_config_invalid/
      )
      const result = await adapter.dispatch(f.input())
      assert.equal(
        result.native_response.result && (result.native_response.result as Record<string, unknown>).dispatch,
        'queued'
      )
      assert.equal(result.exit_code, null)
    } finally {
      adapter.close()
      await f.close()
    }
  }
)

for (const enabled of [undefined, false] as const) {
  test(
    `Luvus rejects terminal input before discovery and claim when local switch is ${enabled}`,
    /** 默认及显式关闭均不能触达自建原生 listener。 */ async () => {
      const f = await fixture('ipc', method, params)
      if (enabled !== undefined) {
        f.host.terminalExecution = /** 从受保护宿主接缝返回当前关闭状态。 */ () => enabled
      }
      try {
        await assert.rejects(f.adapter.dispatch(f.input()), {
          code: 'terminal_execution_disabled',
          outcome: 'not_dispatched'
        })
        assert.equal(f.state.claims, 0)
        assert.equal(f.received(), '')
      } finally {
        await f.close()
      }
    }
  )
}

test(
  'Luvus explicit enable preserves the native reply and never invents command completion',
  /** 发送成功只获得合成 native error，不能被包装成 shell 成功或退出码零。 */ async () => {
    const f = await fixture('ipc', method, params)
    f.host.terminalExecution = /** 只为本测试自建 listener 显式开启。 */ () => true
    const response = {
      id: f.binding.native_request_id,
      error: { code: 'send_failed', message: 'synthetic', dispatch: 'started', metadata: { retained: true } }
    }
    f.respond(
      /** 使用官方终端错误根允许的合成错误，保留其派发状态和元数据。 */ (socket) =>
        socket.end(JSON.stringify(response) + '\n')
    )
    try {
      const result = await f.adapter.dispatch(f.input())
      assert.equal(JSON.parse(f.received()).params.text, params.text)
      assert.deepEqual(result.native_response, response)
      assert.equal(result.exit_code, null)
      assert.equal(f.state.claims, 1)
    } finally {
      await f.close()
    }
  }
)

test(
  'Luvus revocation during durable claim blocks the final write and retains no-replay state',
  /** claim 异步边界后重新读取当前配置，发送墓碑不能因拒绝而丢失。 */ async () => {
    const f = await fixture('ipc', method, params)
    let enabled = true
    f.host.terminalExecution = /** 每次真实适配器检查都读取当前状态，不缓存首次 true。 */ () => enabled
    const claim = f.host.claimDispatch
    f.host.claimDispatch = /** 保留原唯一 claim，然后在写入前撤销。 */ async (...args) => {
      await claim(...args)
      enabled = false
    }
    try {
      await assert.rejects(f.adapter.dispatch(f.input()), {
        code: 'terminal_execution_disabled',
        outcome: 'not_dispatched'
      })
      assert.equal(f.received(), '')
      assert.equal(f.state.claims, 1)
      enabled = true
      await assert.rejects(f.adapter.dispatch(f.input()), { code: 'attempt_already_observed' })
      assert.equal(f.state.claims, 1)
    } finally {
      await f.close()
    }
  }
)

test(
  'Luvus native Agent-not-ready remains an error with direct execution disabled',
  /** 对话沿用原生 Agent 门禁，测试 listener 的拒绝不能退化为 pane.run 或其它 shell 重试。 */ async () => {
    const f = await fixture('ipc', 'agent.send', { target: '3', text: 'synthetic' })
    const response = {
      id: f.binding.native_request_id,
      error: { code: 'agent_not_ready', message: 'synthetic shell pane' }
    }
    f.respond(
      /** 合成原生端明确拒绝普通 shell pane，没有发送文本到任何真实终端。 */ (socket) =>
        socket.end(JSON.stringify(response) + '\n')
    )
    try {
      const result = await f.adapter.dispatch(f.input())
      assert.deepEqual(result.native_response, response)
      assert.equal(f.state.responses, 1)
      assert.equal(JSON.parse(f.received()).method, 'agent.send')
      assert.equal(f.state.claims, 1)
    } finally {
      await f.close()
    }
  }
)
