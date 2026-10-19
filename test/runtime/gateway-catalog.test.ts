/** 复用真实认证 fixture 验证 Gateway 目录的当前 epoch、断连与策略回调撤销，不启动另一套原生环境。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLuvusCatalog } from '../../src/connector/luvus/index.js'
import { GatewayError } from '../../src/contracts.js'
import { runtimeFixture } from './helpers.js'
import { until } from '../transport/helpers.js'

test(
  'Gateway catalog binds its original capability view to the actual authenticated epoch',
  /** 目录读取使用同一实际连接和当前主体；查询方法不会登记调用、发送原生请求或制造 token。 */ async () => {
    const fixture = await runtimeFixture()
    try {
      await fixture.ready()
      await fixture.gateway.runAuthenticated(
        fixture.caller,
        /** 当前作用域内验证真实连接来源，并让原目录实现复核每次读取。 */ () => {
          const principal = fixture.gateway.principal()
          const connection = fixture.gateway.transport.currentConnection(fixture.target.machine_id)
          assert(connection)
          const resolved = fixture.gateway.catalog.resolve(fixture.target, principal)
          assert(resolved)
          assert.deepEqual(
            resolved.local_provider,
            fixture.state.store.provider(fixture.target.machine_id, fixture.target.provider_id)
          )
          assert.equal(resolved.source.authenticated, true)
          assert.equal(resolved.source.source_verified, true)
          assert.equal(resolved.source.binding.connection_epoch, connection.connection_epoch)
          assert.equal(resolved.source.binding.recovery_generation, connection.recovery_generation)
          assert.equal(resolved.source.binding.target.machine_id, fixture.target.machine_id)
          assert.equal(resolved.source.binding.provider_id, fixture.target.provider_id)
          assert.equal(resolved.source.binding.caller_policy_revision, principal.policy.revision)
          const catalog = createLuvusCatalog(resolved.record.compiled, resolved.record.capabilities, resolved.source, {
            now: Date.now,
            expires_at: resolved.expires_at,
            /** 每次原目录读取都再次解析当前身份、固定配置和实际 epoch。 */
            current() {
              const current = fixture.gateway.catalog.resolve(fixture.target, fixture.gateway.principal())
              assert(current)
              return current.source
            }
          })
          assert.equal(catalog.describe('task.add').method, 'task.add')
        }
      )
      assert.equal(fixture.claims(), 0)
      assert.equal(fixture.native.state.responses, 0)
    } finally {
      await fixture.close()
    }
  }
)

test(
  'Gateway catalog returns unavailable after its actual Connector epoch disconnects',
  /** 旧目录来源不能凭 MAX_SAFE_INTEGER 格式期限越过实际连接寿命。 */ async () => {
    const fixture = await runtimeFixture()
    try {
      await fixture.ready()
      await fixture.connector.close()
      await until(
        /** 等待真实断连被 Gateway 处理，不修改身份记录或自报一个离线 epoch。 */ () =>
          fixture.gateway.transport.currentConnection(fixture.target.machine_id) === undefined
      )
      await fixture.gateway.runAuthenticated(
        fixture.caller,
        /** 当前主体仍有效，实际连接缺失必须保持目录未知。 */ () => {
          assert.equal(fixture.gateway.catalog.resolve(fixture.target, fixture.gateway.principal()), undefined)
        }
      )
      assert.equal(fixture.native.state.responses, 0)
    } finally {
      await fixture.close()
    }
  }
)

test(
  'Gateway catalog rejects a provider disabled by its final local policy callback',
  /** 策略内容保持原样仍不能返回回调前已启用的旧 binding，最终完整 canonical 复核必须拒绝。 */ async () => {
    const fixture = await runtimeFixture()
    let reads = 0
    try {
      await fixture.ready()
      fixture.onLocalPolicyRead(
        /** 第二次查询正好发生在 provider source 返回后，重现原实现最后返回窗口中的禁用。 */ () => {
          if (++reads === 2) {
            fixture.state.store.setProviderEnabled(fixture.target.machine_id, fixture.target.provider_id, 1, false)
          }
        }
      )
      await fixture.gateway.runAuthenticated(
        fixture.caller,
        /** 只公开固定不可用错误，不返回旧来源、binding 或目录条目。 */ () => {
          assert.throws(
            /** 使用同一当前主体，排除身份错误掩盖 canonical binding 漏检。 */ () =>
              fixture.gateway.catalog.resolve(fixture.target, fixture.gateway.principal()),
            /** 错误来源必须是最终目录 fence，而不是原生环境或身份建立失败。 */ (error: unknown) =>
              error instanceof GatewayError && error.message === 'runtime_catalog_unavailable'
          )
        }
      )
      assert.equal(reads, 2)
      assert.equal(fixture.state.store.provider(fixture.target.machine_id, fixture.target.provider_id)!.enabled, false)
      assert.equal(fixture.gateway.transport.currentConnection(fixture.target.machine_id)?.active, true)
      assert.equal(fixture.claims(), 0)
      assert.equal(fixture.native.state.responses, 0)
    } finally {
      fixture.onLocalPolicyRead()
      await fixture.close()
    }
  }
)
