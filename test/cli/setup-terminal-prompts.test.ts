// 真实配置解析与现有策略清单覆盖确认文本；不创建身份、终端或原生资源。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { configDocument, configTemplate, parseConfig } from '../../src/cli/config.js'
import { connectorNativePrompt, gatewayNativePrompt } from '../../src/cli/setup-prompts.js'
import { selectedSetupPolicies } from '../../src/cli/setup-policy.js'

// 默认输出单语英文；zh-CN 输出单语中文，两种语言都不再拼接另一语言的文案。
const cjk = /[\u{4e00}-\u{9fff}]/u

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
      for (const kind of ['Luvus', 'Herdr'] as const) {
        const local = connectorNativePrompt(connector.allow_terminal_execution, kind)
        assert.match(local, enabled === true ? /terminal execution ENABLED/ : /terminal execution disabled/)
        assert.doesNotMatch(local, cjk)
        assert(local.includes(kind))
        const translated = connectorNativePrompt(connector.allow_terminal_execution, kind, false, 'zh-CN')
        assert.match(translated, enabled === true ? /已开启终端执行/ : /关闭终端执行/)
        assert.doesNotMatch(translated, /terminal execution (ENABLED|disabled)/u)
        assert(translated.includes(kind))
      }
      const policies = selectedSetupPolicies(
        { attempt_id: 'synthetic_attempt', actor: 'synthetic_actor' },
        'synthetic_machine',
        ['luvus', 'herdr']
      ).policies
      assert(policies.caller.grants[0]!.methods.includes('pane.run'))
      assert(policies.local.grants[0]!.methods.includes('pane.run'))
      const gateway = gatewayNativePrompt('synthetic-version', 'a'.repeat(64))
      assert.match(gateway, /Terminal execution is controlled by the Connector machine owner's local configuration/)
      assert.doesNotMatch(gateway, cjk)
      assert.doesNotMatch(gateway, /stays disabled/)
      const gatewayZh = gatewayNativePrompt('synthetic-version', 'a'.repeat(64), 'zh-CN')
      assert.match(gatewayZh, /终端执行由 Connector 本机所有者配置决定/)
      assert.doesNotMatch(gatewayZh, /Terminal execution is controlled/u)
      assert.doesNotMatch(gatewayZh, /终端执行关闭|关闭终端执行/)
    }
  )
}
