// 真实配置解析与现有策略清单覆盖确认文本；不创建身份、终端或原生资源。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { configDocument, configTemplate, parseConfig } from '../../src/cli/config.js'
import { connectorNativePrompt, gatewayNativePrompt } from '../../src/cli/setup-prompts.js'
import { setupPolicies, setupTarget } from '../../src/cli/setup-policy.js'

for (const enabled of [undefined, false, true]) {
  test(
    `setup prompt reflects local terminal ${enabled} without Gateway claiming it is disabled`,
    // 两端批准集合含 pane.run；Gateway 仍不能从方法集合或本机批准推断远端开关。
    () => {
      const document = configDocument(configTemplate('connector'))
      delete document.allow_terminal_execution
      const connector = parseConfig({
        ...document,
        ...(enabled === undefined ? {} : { allow_terminal_execution: enabled })
      })
      assert(connector.role === 'connector')
      const local = connectorNativePrompt(connector.allow_terminal_execution)
      assert.match(
        local,
        enabled === true ? /terminal execution ENABLED.*已开启终端执行/ : /terminal execution disabled.*关闭终端执行/
      )
      const target = setupTarget('synthetic_machine')
      const policies = setupPolicies({ attempt_id: 'synthetic_attempt', actor: 'synthetic_actor' }, target).policies
      assert(policies.caller.grants[0]!.methods.includes('pane.run'))
      assert(policies.local.grants[0]!.methods.includes('pane.run'))
      const gateway = gatewayNativePrompt('synthetic-version', 'a'.repeat(64))
      assert.match(gateway, /Terminal execution is controlled by the Connector machine owner's local configuration/)
      assert.match(gateway, /终端执行由 Connector 本机所有者配置决定/)
      assert.doesNotMatch(gateway, /stays disabled|终端执行关闭|关闭终端执行/)
    }
  )
}
