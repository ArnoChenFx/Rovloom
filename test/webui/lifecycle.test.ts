// provider页面状态机通过真实临时Store验证；不使用生产身份或设备。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDeviceManagementFlow } from '../../src/webui/write-flow.js'
import {
  managementWriteBody,
  ManagementClientError,
  type ManagementWriteTransport
} from '../../src/webui/write-contract.js'
import { management } from '../storage/helpers.js'
import { setup, context } from '../admin/write-helpers.js'

/** 合成管理员每次仍走原服务鉴权，记录请求并可模拟提交后的回执丢失。 */
function fixture() {
  const f = setup(undefined, { management })
  const calls: string[] = []
  let lose = false
  const transport: ManagementWriteTransport = {
    /** 原服务保留确认、revision、去重和审计语义，不以stub返回成功。 */
    async execute(operation, args) {
      calls.push(operation)
      const result = await f.service.execute(operation, args, context())
      if (lose && operation === 'providers_disable') {
        throw new ManagementClientError('unavailable', true)
      }
      return result
    }
  }
  return {
    f,
    calls,
    transport,
    /** 只模拟网络丢回执，不改变真实事务。 */
    set lose(value: boolean) {
      lose = value
    }
  }
}

test(
  'provider精确binding确认、重复提交保护、单实例禁用及原回执对账',
  /** 两实例互不影响，旧页面不得静默接受新binding。 */ async () => {
    const h = fixture()
    const device = h.f.store.register('owned_provider_ui')
    for (const provider_id of ['one', 'two']) {
      h.f.store.defineProvider({
        machine_id: device.machine_id,
        provider_id,
        kind: 'luvus',
        config_ref: 'fixture',
        binding_revision: 1,
        enabled: true
      })
    }
    h.f.grant({ action: 'providers_manage', machine_id: device.machine_id, provider_id: 'one' })
    const flow = createDeviceManagementFlow({ transport: h.transport })
    try {
      const review = await flow.prepare({
        action: 'provider_disable',
        machine_id: device.machine_id,
        provider_id: 'one',
        kind: 'luvus',
        expected_binding_revision: 1
      })
      assert.equal(review.phase, 'awaiting_confirmation')
      h.lose = true
      const first = flow.confirm()
      await assert.rejects(flow.confirm())
      assert.equal((await first).phase, 'unconfirmed')
      h.lose = false
      const receipt = await flow.checkReceipt()
      assert.equal(receipt.phase, 'committed')
      if (receipt.phase === 'committed') {
        assert.equal(receipt.receipt.new_binding_revision, 2)
        assert.equal(receipt.receipt.effects.provider, 'disabled')
        assert.equal(receipt.receipt.effects.persistent_authorization, 'unchanged')
      }
      assert.equal(h.calls.filter(/** 只计实际提交次数。 */ (x) => x === 'providers_disable').length, 1)
      const stale = createDeviceManagementFlow({ transport: h.transport })
      assert.equal(
        (
          await stale.prepare({
            action: 'provider_disable',
            machine_id: device.machine_id,
            provider_id: 'one',
            kind: 'luvus',
            expected_binding_revision: 1
          })
        ).phase,
        'failed'
      )
      stale.dispose()
      const other = createDeviceManagementFlow({ transport: h.transport })
      assert.equal(
        (
          await other.prepare({
            action: 'provider_disable',
            machine_id: device.machine_id,
            provider_id: 'two',
            kind: 'luvus',
            expected_binding_revision: 1
          })
        ).phase,
        'failed'
      )
      other.dispose()
      assert.equal(h.f.store.machine(device.machine_id).status, 'pending')
      assert.equal(h.f.store.provider(device.machine_id, 'two')!.enabled, true)
      assert.equal(h.f.store.provider(device.machine_id, 'two')!.binding_revision, 1)
      assert.throws(
        /** 损坏或超范围输入必须拒绝。 */ () => managementWriteBody('providers_enable' as never, {} as never)
      )
    } finally {
      flow.dispose()
      h.f.close()
    }
  }
)
