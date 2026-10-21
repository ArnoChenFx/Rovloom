/** Luvus 的会话名随运行方式确定并经配对传给 Gateway；只接受程序定义的两个值。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { configDocument, configTemplate, parseConfig } from '../../src/cli/config.js'
import type { ConnectorConfig } from '../../src/cli/config.js'
import { selectedSetupPolicies, setupSessions, setupSessionsFor, setupTarget } from '../../src/cli/setup-policy.js'

const plan = { attempt_id: 'attempt_1', actor: 'actor_1' } as never

test('Luvus 目标会话：附着为 default，managed 为 rovloom，Herdr 固定 default', () => {
  assert.equal(setupTarget('m1', 'luvus').session, 'rovloom')
  assert.equal(setupTarget('m1', 'luvus', { luvus: 'default' }).session, 'default')
  assert.equal(setupTarget('m1', 'herdr', { luvus: 'rovloom' }).session, 'default')
})

test('Connector 按运行方式选择会话，默认附着 default', () => {
  const base = configDocument(configTemplate('connector', 'linux'))
  const attach = parseConfig(base, 'linux') as ConnectorConfig
  const managed = parseConfig({ ...base, native: { luvus: { mode: 'managed' } } }, 'linux') as ConnectorConfig
  assert.deepEqual(setupSessionsFor(attach), { luvus: 'default' })
  assert.deepEqual(setupSessionsFor(managed), { luvus: 'rovloom' })
})

test('配对授权的 Target 使用所选会话，其它会话名一律拒绝', () => {
  const authorization = selectedSetupPolicies(plan, 'm1', ['luvus'], { luvus: 'default' })
  assert.equal(authorization.policies.caller.grants[0]!.target.session, 'default')
  assert.equal(selectedSetupPolicies(plan, 'm1', ['luvus']).policies.caller.grants[0]!.target.session, 'rovloom')
  assert.deepEqual(setupSessions(undefined), {})
  for (const bad of [{ luvus: 'other' }, { luvus: 1 }, { herdr: 'default' }, [], 'default', null]) {
    assert.throws(() => setupSessions(bad), { code: 'configuration_required' })
  }
})
