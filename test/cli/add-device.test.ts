// 加入第二台及以后设备：共享策略修订、授权并集与多 Herdr 设备路由；只验证纯接线，真实配对由 e2e/quickstart.py --second-device 覆盖。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { configTemplate } from '../../src/cli/config.js'
import { routeProductionSources } from '../../src/cli/product-sources.js'
import type { ProductionCliSources } from '../../src/cli/production.js'
import { selectedSetupPolicies } from '../../src/cli/setup-policy.js'
import { unionGrants } from '../../src/cli/setup-gateway.js'
import { createManagementSessionAuthority } from '../../src/runtime/index.js'

test('策略修订标签沿用 lineage，授权内容仍只含各自设备', () => {
  const first = selectedSetupPolicies({ attempt_id: 'a1', actor: 'actor' } as never, 'm1', ['herdr'])
  const second = selectedSetupPolicies({ attempt_id: 'a2', actor: 'actor', lineage: 'a1' } as never, 'm2', ['herdr'])
  assert.equal(first.policies.local.revision, 'setup_local_a1')
  assert.equal(second.policies.local.revision, first.policies.local.revision)
  assert.equal(second.policies.caller.revision, first.policies.caller.revision)
  assert.equal(second.policies.caller.grants[0]!.target.machine_id, 'm2')
  assert.notDeepEqual(second.policies.caller.grants, first.policies.caller.grants)
})

test('授权并集：新设备追加、同目标重入允许、同目标不同授权拒绝', () => {
  const a = selectedSetupPolicies({ attempt_id: 'a1', actor: 'x' } as never, 'm1', ['herdr']).policies.caller.grants
  const b = selectedSetupPolicies({ attempt_id: 'a2', actor: 'x', lineage: 'a1' } as never, 'm2', ['herdr']).policies
    .caller.grants
  const merged = unionGrants(a, b)
  assert.equal(merged.length, a.length + b.length)
  assert.deepEqual(unionGrants(merged, b), merged)
  const changed = structuredClone(b)
  ;(changed[0] as { methods?: unknown[] }).methods = []
  assert.throws(() => unionGrants(merged, changed), {
    code: 'configuration_required'
  })
})

test('Gateway 上多份 Herdr 引用各成一个设备会话组；Connector 仍整体交给 Herdr', async () => {
  const gateway = configTemplate('gateway')
  const connector = configTemplate('connector')
  if (gateway.role !== 'gateway' || connector.role !== 'connector') {
    assert.fail('role template mismatch')
  }
  const seen: string[][] = []
  const herdr: ProductionCliSources = {
    async gateway(_config, refs) {
      seen.push(refs.map((entry) => entry.reference))
      throw new Error('probe')
    },
    async connector(_config, refs) {
      seen.push(refs.map((entry) => entry.reference))
      throw new Error('probe')
    }
  }
  const refs = ['one', 'two', 'three'].map((reference) => ({
    reference,
    value: { kind: 'herdr' }
  }))
  const routed = routeProductionSources({ herdr })
  const authority = createManagementSessionAuthority({
    principal: () => null,
    administrator: () => null
  })
  try {
    await assert.rejects(() => routed.gateway!(gateway, refs, authority), {
      message: 'probe'
    })
    await assert.rejects(() => routed.connector!(connector, refs.slice(0, 1)), {
      message: 'probe'
    })
  } finally {
    authority.close()
  }
  // Gateway：首个设备组只含自己的引用（未分组时会是全部三份）；Connector：整体交给 Herdr。
  assert.deepEqual(seen[0], ['one'])
  assert.deepEqual(seen.at(-1), ['one'])
})
