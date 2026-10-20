// 注册、配对及provider页面状态机通过真实临时Store验证；不使用生产身份或设备。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDeviceManagementFlow } from '../../src/webui/write-flow.js'
import {
  checkManagementWriteReply,
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
      if (lose && ['pairings_create', 'providers_disable', 'pairings_cancel'].includes(operation)) {
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

test(
  '注册仅pending、没有签发秘密或自动devices_read，丢失回执仍保留原pairing引用',
  /** 新设备权限由既有策略独立管理，页面不能补权。 */ async () => {
    const h = fixture()
    const flow = createDeviceManagementFlow({ transport: h.transport })
    try {
      assert.equal(
        (
          await flow.prepare({
            action: 'pairing_create',
            name: 'owned_new_ui',
            policy_ref: 'fixture_policy',
            labels: []
          })
        ).phase,
        'awaiting_confirmation'
      )
      h.lose = true
      assert.equal((await flow.confirm()).phase, 'unconfirmed')
      h.lose = false
      const result = await flow.checkReceipt()
      assert.equal(result.phase, 'committed')
      if (result.phase !== 'committed') {
        throw new Error('missing_receipt')
      }
      assert.equal(result.receipt.status, 'pending')
      assert.equal(result.receipt.requires_local_issuance, true)
      assert.ok(result.receipt.machine_id && result.receipt.pairing_id)
      const args = { machine_id: result.receipt.machine_id, pairing_id: result.receipt.pairing_id }
      await assert.rejects(h.f.service.execute('pairings_get', args, context()), /forbidden/)
      assert.equal(
        h.f.admin!.grants.some(
          /** 验证新设备没有任何隐式目标grant。 */ (g) => 'machine_id' in g && g.machine_id === args.machine_id
        ),
        false
      )
      assert.equal(h.calls.filter(/** 只计实际提交次数。 */ (x) => x === 'pairings_create').length, 1)
      assert.equal(h.f.store.machine(args.machine_id).status, 'pending')
      assert.equal(/credential|enrollment|secret|token/i.test(JSON.stringify(result)), false)
    } finally {
      flow.dispose()
      h.f.close()
    }
  }
)

test(
  '已授权pending申请真实查询、取消与过期，签发始终未核实',
  /** 所有目标授权在fixture创建时明确给出；不会在注册回调内增权。 */ async () => {
    const h = fixture()
    const device = h.f.store.register('owned_pending_ui')
    h.f.grant(
      { action: 'devices_read', machine_id: device.machine_id },
      { action: 'devices_revoke', machine_id: device.machine_id }
    )
    const create = createDeviceManagementFlow({ transport: h.transport })
    const cancel = createDeviceManagementFlow({ transport: h.transport })
    try {
      await create.prepare({ action: 'pairing_create', machine_id: device.machine_id, policy_ref: 'fixture_policy' })
      const result = await create.confirm()
      assert.equal(result.phase, 'committed')
      if (result.phase !== 'committed' || !result.receipt.pairing_id) {
        throw new Error('missing_pairing')
      }
      const args = { machine_id: device.machine_id, pairing_id: result.receipt.pairing_id }
      const pending = await h.f.service.execute('pairings_get', args, context())
      assert.equal(checkManagementWriteReply('pairings_get', pending, args).status, 'pending')
      assert.equal(pending.issuance, 'unverified')
      assert.throws(
        /** 损坏或超范围输入必须拒绝。 */ () =>
          checkManagementWriteReply('pairings_get', { ...pending, status: 'issued' }, args)
      )
      assert.throws(
        /** 损坏或超范围输入必须拒绝。 */ () =>
          checkManagementWriteReply('pairings_get', { ...pending, enrollment: 'SYNTHETIC_PRIVATE' }, args)
      )
      await cancel.prepare({ action: 'pairing_cancel', ...args })
      assert.equal((await cancel.confirm()).phase, 'committed')
      assert.equal((await h.f.service.execute('pairings_get', args, context())).status, 'cancelled')
      const next = createDeviceManagementFlow({ transport: h.transport })
      await next.prepare({ action: 'pairing_create', machine_id: device.machine_id, policy_ref: 'fixture_policy' })
      const renewed = await next.confirm()
      assert.equal(renewed.phase, 'committed')
      if (renewed.phase === 'committed') {
        h.f.advance(600_001)
        assert.equal(
          (await h.f.service.execute('pairings_get', { ...args, pairing_id: renewed.receipt.pairing_id! }, context()))
            .status,
          'expired'
        )
      }
      next.dispose()
    } finally {
      create.dispose()
      cancel.dispose()
      h.f.close()
    }
  }
)
