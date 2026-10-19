/** 用合成 custody 输入检查 secret 的完整绑定和不可续期语义，不代表真实凭据发行。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LuvusBoundDelegation } from '../../../src/connector/luvus/delegation.js'
import type { LuvusDelegationInput } from '../../../src/connector/luvus/delegation.js'
import { LuvusAdapterError } from '../../../src/connector/luvus/types.js'
import { clone, source } from '../../native-contract/helpers.js'

/** 构造仅属于测试的 metadata 和 token，caller 永远不能向生产 custody 填入这些值。 */
function input(): LuvusDelegationInput {
  return {
    config_ref: 'config1',
    binding: clone(source().binding),
    scopes: ['read', 'orchestration'],
    methods: ['task.add', 'task.update', 'automation.list'],
    issued_at: 100,
    expires_at: 200,
    token: 'test-only-token'
  }
}

/** 只校验安全错误码，不允许异常包含合成 token 或内部 metadata。 */
function failure(code: string) {
  return /* 固定公开异常类型及消息内容。 */ (error: unknown) => {
    assert(error instanceof LuvusAdapterError)
    assert.equal(error.code, code)
    assert.equal(error.message, code)
    return true
  }
}

test(
  'delegation pins full source, config and exact methods independently of mutable input',
  /** 修改入参不会改变闭包内的原绑定；每种 revision/identity 变化都拒绝交付 token。 */ () => {
    const metadata = input()
    const original = clone(metadata)
    const grant = new LuvusBoundDelegation(metadata)
    Object.assign(metadata.binding.contract, { revision: 'changed-after-construction' })
    assert.equal(grant.read(original, source(), 'automation.list', 110), 'test-only-token')
    const changes = [
      { config_ref: 'other' },
      ...[
        'provider_id',
        'binding_revision',
        'contract_source_ref',
        'server_generation',
        'connection_epoch',
        'recovery_generation',
        'capability_revision',
        'caller_policy_revision',
        'local_policy_revision',
        'classification_revision'
      ].map(
        /* 逐项改变完整 NativeBinding 字段，不用一个摘要冒充当前来源。 */ (field) => ({
          binding: { ...original.binding, [field]: 'other' }
        })
      ),
      { binding: { ...original.binding, target: { machine_id: 'm1', profile: 'session' as const, session: 'other' } } },
      { binding: { ...original.binding, contract: { ...original.binding.contract, schema_sha256: 'f'.repeat(64) } } }
    ]
    for (const change of changes) {
      assert.throws(
        /* 每次都要求同一受限绑定，不能跨目标借用 secret。 */ () =>
          grant.read({ ...original, ...change }, source(), 'task.add', 110),
        failure('native_delegation_mismatch')
      )
    }
    assert.throws(
      /* scope 不会把 task.* 通配为全部方法。 */ () => grant.read(original, source(), 'task.next', 110),
      failure('native_delegation_mismatch')
    )
    assert.throws(
      /* 当前来源失去认证后即使 metadata 一致也拒绝。 */ () =>
        grant.read(original, { ...source(), authenticated: false }, 'task.add', 110),
      failure('native_delegation_mismatch')
    )
    assert.equal(JSON.stringify(grant), '{}')
    grant.close()
    assert.throws(
      /* close 后不能再用同一对象恢复 secret。 */ () => grant.read(original, source(), 'task.add', 110),
      failure('native_delegation_unavailable')
    )
  }
)

test(
  'delegation expiry and clock rollback are irreversible and reads never renew TTL',
  /** 固定到期时间不随读取延长，回拨也不能把已失效 secret 重新变成有效。 */ () => {
    for (const invalid of [109, 200]) {
      const metadata = input()
      const grant = new LuvusBoundDelegation(metadata)
      assert.equal(grant.read(metadata, source(), 'task.add', 110), 'test-only-token')
      assert.throws(
        /* 比上一读更早或到达原始截止均失效。 */ () => grant.read(metadata, source(), 'task.add', invalid),
        failure('native_delegation_unavailable')
      )
      assert.throws(
        /* 恢复表面有效时间不会恢复对象。 */ () => grant.read(metadata, source(), 'task.add', 120),
        failure('native_delegation_unavailable')
      )
    }
  }
)

test(
  'synchronous custody close during source access cannot return an empty or stale secret',
  /** 真实宿主撤销可与属性读取重入；结束时的关闭事实不能被先前检查覆盖。 */ () => {
    const metadata = input()
    const grant = new LuvusBoundDelegation(metadata)
    const current = {
      ...source(),
      /** 属性读取时模拟受保护 custody 同步撤销本对象。 */
      get authenticated() {
        grant.close()
        return true
      }
    }
    assert.throws(
      /* 不返回 undefined，也不交付 close 前保存的 token 副本。 */ () => grant.read(metadata, current, 'task.add', 110),
      failure('native_delegation_unavailable')
    )
  }
)

test(
  'custody binding rejects owner/admin/all scopes, duplicates, broad methods and empty secrets',
  /** 不生成 token、不调用 native，错误输入在本地绑定前收敛拒绝。 */ () => {
    for (const change of [
      { scopes: ['admin'] },
      { scopes: ['all'] },
      { scopes: ['owner'] },
      { scopes: ['read', 'read'] },
      { methods: ['task.*'] },
      { methods: ['task.add', 'task.add'] },
      { token: '' },
      { expires_at: 100 }
    ]) {
      assert.throws(
        /* 非法 custody 交付不会因调用方输入而取得更宽权限。 */ () =>
          new LuvusBoundDelegation({ ...input(), ...change } as LuvusDelegationInput),
        failure('native_delegation_invalid')
      )
    }
  }
)
