/** 使用合成请求盘点直接终端入口，验证默认关闭、配置类型与目录/执行判定一致。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assertTerminalExecutionAllowed,
  pinTerminalExecution,
  requiresTerminalExecution,
  terminalExecutionAllowed
} from '../../src/connector/terminal-execution.js'

const direct = {
  luvus: [
    'pane.run',
    'pane.send_input',
    'terminal.backend.create',
    'terminal.backend.control',
    'terminal.backend.type_literal',
    'terminal.backend.paste_text',
    'terminal.backend.submit_text',
    'terminal.backend.send_key',
    'module.action.invoke',
    'agent.report',
    'pane.report_session',
    'pane.report_event'
  ],
  herdr: ['pane.send_text', 'pane.send_keys', 'pane.send_input', 'pane.link.activate']
} as const

test(
  'terminal execution requires a literal local boolean',
  /** 配置不能由字符串或其它真值意外开启。 */ () => {
    assert.equal(pinTerminalExecution(undefined), false)
    assert.equal(pinTerminalExecution(false), false)
    assert.equal(pinTerminalExecution(true), true)
    for (const value of ['true', 1, null, {}, [], Promise.resolve(true)]) {
      assert.throws(
        /** 无效本地配置保持拒绝。 */ () => pinTerminalExecution(value),
        /terminal_execution_config_invalid/
      )
    }
  }
)

for (const kind of ['luvus', 'herdr'] as const) {
  test(
    `${kind} alternate terminal inputs share directory and final execution denial`,
    /** 同一合成方法逐项经过目录判定和实际写入守卫。 */ () => {
      for (const method of direct[kind]) {
        const request = { method, params: {} }
        assert.equal(requiresTerminalExecution(kind, method), true)
        assert.equal(terminalExecutionAllowed(kind, method, {}), false)
        assert.equal(terminalExecutionAllowed(kind, method, {}, false), false)
        assert.throws(
          /** 隐藏目录之外，实际派发边界仍拒绝。 */ () => assertTerminalExecutionAllowed(kind, request),
          /terminal_execution_disabled/
        )
        assert.doesNotThrow(
          /** 显式开启仅通过本地开关，原 Wire 与原生权限仍由适配器检查。 */ () =>
            assertTerminalExecutionAllowed(kind, request, true)
        )
      }
    }
  )

  test(
    `${kind} ordinary Agent conversation and reads retain independent authorization`,
    /** 开关不声称限制 Agent 自身工具；不会把普通对话归类为裸 shell。 */ () => {
      for (const method of [
        'agent.prompt',
        'agent.send',
        'agent.keys',
        'agent.send_keys',
        'agent.read',
        'pane.read',
        'terminal.backend.capture',
        'ping'
      ]) {
        assert.equal(terminalExecutionAllowed(kind, method, { target: 'owned-agent', text: 'synthetic' }), true)
      }
      assert.equal(terminalExecutionAllowed(kind, 'agent.start', { name: 'owned', kind: 'opencode', args: [] }), true)
    }
  )
}

for (const [kind, method] of [
  ['luvus', 'agent.start'],
  ['luvus', 'workspace.new'],
  ['luvus', 'node.new'],
  ['luvus', 'tab.new'],
  ['luvus', 'pane.split'],
  ['herdr', 'agent.start'],
  ['herdr', 'workspace.create'],
  ['herdr', 'tab.create'],
  ['herdr', 'pane.split'],
  ['herdr', 'pane.report_agent'],
  ['herdr', 'pane.report_agent_session']
] as const) {
  test(
    `${kind}/${method} cannot introduce commands through launch or restore parameters`,
    /** 任意 argv、环境及恢复命令都能等价启动程序，不能用方法名绕过关闭状态。 */ () => {
      for (const params of [
        { command: ['/bin/sh'] },
        { args: ['--eval', 'synthetic'] },
        { env: { BASH_ENV: '/synthetic/startup' } },
        { resume_argv: ['sh', '-c', 'printf synthetic'] },
        { resume_command: 'printf synthetic' }
      ]) {
        assert.equal(terminalExecutionAllowed(kind, method, params), false)
        assert.throws(
          /** 参数预检与实际派发拒绝相同候选。 */ () => assertTerminalExecutionAllowed(kind, { method, params }),
          /terminal_execution_disabled/
        )
      }
    }
  )
}
