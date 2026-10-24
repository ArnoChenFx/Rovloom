// 显式局域网配置字段：只与通配绑定同用，回环配置不接受，文档序列化保持往返一致。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { configDocument, configTemplate, parseConfig } from '../../src/cli/config.js'
import type { GatewayConfig } from '../../src/cli/config.js'

const base = configDocument(configTemplate('gateway')) as {
  mcp: Record<string, unknown>
  management: Record<string, unknown>
}

test('gateway config accepts lan only with wildcard bindings and round-trips both groups', () => {
  const wildcard = {
    ...base,
    mcp: { ...base.mcp, hostname: '0.0.0.0', lan: true },
    management: { ...base.management, hostname: '0.0.0.0', lan: true }
  }
  const parsed = parseConfig(wildcard) as GatewayConfig
  assert.equal(parsed.mcp_lan, true)
  assert.equal(parsed.management_lan, true)
  assert.deepEqual(configDocument(parsed), wildcard)
  // 回环监听不存在局域网路径：lan 与回环绑定组合一律拒绝。
  assert.throws(() => parseConfig({ ...base, mcp: { ...base.mcp, lan: true } }))
  assert.throws(() => parseConfig({ ...base, management: { ...base.management, lan: true } }))
  // 通配但没有显式 lan：保持既有容器语义（Host 校验仍按回环），序列化不添字段。
  const containerOnly = parseConfig({
    ...base,
    management: { ...base.management, hostname: '0.0.0.0' }
  }) as GatewayConfig
  assert.equal(containerOnly.management_lan, undefined)
  // lan 只接受字面 true。
  assert.throws(() => parseConfig({ ...base, mcp: { ...base.mcp, hostname: '0.0.0.0', lan: false } }))
  assert.throws(() => parseConfig({ ...base, management: { ...base.management, hostname: '0.0.0.0', lan: 'yes' } }))
})
