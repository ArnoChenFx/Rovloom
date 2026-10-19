// 不挂DOM或改布局，使用真实Store/HTTP管理服务验证有限确认状态、回执和取消边界。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDeviceManagementFlow } from '../../src/webui/write-flow.js'
import { sessionFlowFixture, gate } from '../admin/session-flow-helpers.js'
import type { DeviceManagementIntent } from '../../src/webui/write-contract.js'

for (const action of ['device_rename', 'device_disconnect', 'device_revoke'] as const) {
  test(
    `浏览器${action}仅在明确confirm之后提交一次，回执保留真实持久效果`,
    /** 三动作不混用目标，准备/确认/提交都走真实服务。 */ async () => {
      const f = sessionFlowFixture()
      const flow = createDeviceManagementFlow({ transport: f.client })
      try {
        const intent: DeviceManagementIntent =
          action === 'device_rename'
            ? { action, machine_id: f.device.machine_id, name: 'owned_browser_renamed' }
            : { action, machine_id: f.device.machine_id }
        const prepared = await flow.prepare(intent)
        assert.equal(prepared.phase, 'awaiting_confirmation')
        assert.deepEqual(f.calls, ['history_open', 'write_state_get', 'confirmations_create'])
        assert.equal(f.f.store.machine(f.device.machine_id).status, 'online')
        const submission = flow.confirm()
        await assert.rejects(flow.confirm(), /invalid_request/)
        const committed = await submission
        assert.equal(committed.phase, 'committed')
        assert.equal(
          f.calls.filter(/** 只统计真实设备动作，不把后台确认当业务提交。 */ (name) => name.startsWith('devices_'))
            .length,
          1
        )
        assert(committed.phase === 'committed')
        assert.equal(committed.receipt.effects.native_work, 'may_continue')
        if (action === 'device_rename') {
          assert.equal(f.f.store.machine(f.device.machine_id).name, 'owned_browser_renamed')
        }
        if (action === 'device_disconnect') {
          assert.equal(f.f.store.machine(f.device.machine_id).status, 'offline')
          assert.equal(committed.receipt.effects.persistent_authorization, 'unchanged')
        }
        if (action === 'device_revoke') {
          assert.equal(f.f.store.machine(f.device.machine_id).status, 'revoked')
          assert.equal(committed.receipt.effects.persistent_authorization, 'revoked')
        }
        const state = JSON.stringify(flow.state())
        for (const secret of [f.cookie, f.csrf, f.device.credential]) {
          assert(!state.includes(secret))
        }
        await assert.rejects(flow.prepare(intent), /invalid_request/)
      } finally {
        flow.dispose()
        f.close()
      }
    }
  )
}

test(
  '确认回复改变原截止或撤销影响集合时拒绝提交，不能替代用户已看到的摘要',
  /** 只篡改真实服务回复，后台确认有效也不能跳过本次人机确认边界。 */ async () => {
    for (const change of ['expiry', 'providers']) {
      const f = sessionFlowFixture()
      const flow = createDeviceManagementFlow({ transport: f.client })
      try {
        await flow.prepare({ action: 'device_revoke', machine_id: f.device.machine_id })
        f.hook = /** 模拟合法字段内部变化，严格形状校验之外还须比较原视图。 */ async (path, response) => {
          if (!path.endsWith('/confirmations_confirm')) {
            return response
          }
          const body = (await response.json()) as Record<string, unknown>
          if (change === 'expiry') {
            body.expires_at = Number(body.expires_at) + 1
          } else {
            body.affected_providers = []
          }
          return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
        }
        const result = await flow.confirm()
        assert(result.phase === 'failed')
        assert.equal(result.problem, 'invalid_response')
        assert.equal(f.calls.includes('devices_revoke'), false)
        assert.equal(f.f.store.machine(f.device.machine_id).status, 'online')
      } finally {
        flow.dispose()
        f.close()
      }
    }
  }
)

test(
  '已提交但丢响应保持原关联，只查原回执；不更换ID或再次发送设备动作',
  /** 服务真实提交后才丢弃网络回复，避免以stub假造幂等成功。 */ async () => {
    const f = sessionFlowFixture()
    const flow = createDeviceManagementFlow({ transport: f.client })
    try {
      await flow.prepare({ action: 'device_rename', machine_id: f.device.machine_id, name: 'owned_lost_reply' })
      f.hook = /** 只丢失已提交设备动作的响应，原确认和回执账本仍真实存在。 */ async (path, response) => {
        if (path.endsWith('/devices_rename')) {
          throw new Error('SYNTHETIC_PRIVATE_NETWORK_FAILURE')
        }
        return response
      }
      const unknown = await flow.confirm()
      assert.equal(unknown.phase, 'unconfirmed')
      assert.equal(f.f.store.machine(f.device.machine_id).name, 'owned_lost_reply')
      assert(unknown.phase === 'unconfirmed')
      const original = unknown.operation
      f.hook = undefined
      const result = await flow.checkReceipt()
      assert(result.phase === 'committed')
      assert.equal(result.receipt.request_id, original.request_id)
      assert.equal(result.receipt.history_epoch, original.history_epoch)
      assert.equal(f.calls.filter(/** 回执查询不得重送原改名动作。 */ (name) => name === 'devices_rename').length, 1)
      assert(!JSON.stringify(flow.state()).includes('PRIVATE_NETWORK'))
    } finally {
      flow.dispose()
      f.close()
    }
  }
)

test(
  '确认期间取消忽略迟到confirmed，不能继续提交设备动作',
  /** 后台确认已经成功也不使已取消的本地流程恢复执行。 */ async () => {
    const f = sessionFlowFixture()
    const flow = createDeviceManagementFlow({ transport: f.client })
    const received = gate()
    const release = gate()
    try {
      await flow.prepare({ action: 'device_revoke', machine_id: f.device.machine_id })
      f.hook = /** 后台确认结果滞留于网络，设备撤销尚未发送。 */ async (path, response) => {
        if (path.endsWith('/confirmations_confirm')) {
          received.resolve()
          await release.promise
        }
        return response
      }
      const pending = flow.confirm()
      await received.promise
      flow.cancel()
      assert.equal((await pending).phase, 'cancelled')
      release.resolve()
      await Promise.resolve()
      await Promise.resolve()
      assert.equal(flow.state().phase, 'cancelled')
      assert.equal(f.f.store.machine(f.device.machine_id).status, 'online')
      assert.equal(f.calls.includes('devices_revoke'), false)
    } finally {
      release.resolve()
      flow.dispose()
      f.close()
    }
  }
)

test(
  '设备提交期间取消保留unknown，迟到回复不改状态，原回执仍可对账',
  /** 取消前服务已提交，不能宣称回滚或删除原关联。 */ async () => {
    const f = sessionFlowFixture()
    const flow = createDeviceManagementFlow({ transport: f.client })
    const received = gate()
    const release = gate()
    try {
      await flow.prepare({ action: 'device_revoke', machine_id: f.device.machine_id })
      f.hook = /** 服务回执先提交，再延迟网络交付。 */ async (path, response) => {
        if (path.endsWith('/devices_revoke')) {
          received.resolve()
          await release.promise
        }
        return response
      }
      const pending = flow.confirm()
      await received.promise
      flow.cancel()
      assert.equal((await pending).phase, 'unconfirmed')
      assert.equal(f.f.store.machine(f.device.machine_id).status, 'revoked')
      release.resolve()
      await Promise.resolve()
      await Promise.resolve()
      assert.equal(flow.state().phase, 'unconfirmed')
      f.hook = undefined
      assert.equal((await flow.checkReceipt()).phase, 'committed')
      assert.equal(f.calls.filter(/** 原撤销请求始终只发送一次。 */ (name) => name === 'devices_revoke').length, 1)
    } finally {
      release.resolve()
      flow.dispose()
      f.close()
    }
  }
)

test(
  '确认过期或session撤销不提交；篡改回执目标不会显示成功',
  /** 使用真实拒绝与严格DTO验证，UI按钮状态不作为授权依据。 */ async () => {
    const f = sessionFlowFixture()
    const flow = createDeviceManagementFlow({ transport: f.client })
    try {
      const prepared = await flow.prepare({
        action: 'device_rename',
        machine_id: f.device.machine_id,
        name: 'owned_expired'
      })
      assert(prepared.phase === 'awaiting_confirmation')
      const target = prepared.review.summary.target
      assert('machine_id' in target)
      assert.throws(
        /** 页面拿到的是独立冻结快照，不能改写后续动作目标。 */ () => {
          target.machine_id = 'forged_target'
        }
      )
      f.f.advance(120_000)
      const failed = await flow.confirm()
      assert.equal(failed.phase, 'failed')
      assert.equal(f.calls.includes('devices_rename'), false)
      assert.equal(f.f.store.machine(f.device.machine_id).name, 'owned_browser_flow')
    } finally {
      flow.dispose()
      f.close()
    }
    const g = sessionFlowFixture()
    const next = createDeviceManagementFlow({ transport: g.client })
    try {
      await next.prepare({ action: 'device_rename', machine_id: g.device.machine_id, name: 'owned_bad_reply' })
      g.hook = /** 当前真实回执的目标被网络错误篡改，必须拒绝成功展示。 */ async (path, response) => {
        if (!path.endsWith('/devices_rename')) {
          return response
        }
        const body = (await response.json()) as Record<string, unknown>
        body.target = { machine_id: 'forged_target' }
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
      }
      assert.equal((await next.confirm()).phase, 'unconfirmed')
      g.hook = undefined
      assert.equal((await next.checkReceipt()).phase, 'committed')
    } finally {
      next.dispose()
      g.close()
    }
  }
)
