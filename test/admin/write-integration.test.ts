// 用真实双 SQLite、真实双 loopback Connector 验证管理服务；管理员与原生来源均为隔离合成材料。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StoreManagementWriteService } from '../../src/admin/write-service.js'
import { realFixture } from '../transport/real-helpers.js'
import { until } from '../transport/helpers.js'
import { confirmed, context, setup } from './write-helpers.js'

test(
  '共享管理服务断开精确epoch可重连，重复请求不关新epoch，撤销旧身份拒绝接入',
  { timeout: 20_000 },
  /** 所有设备与凭据由本测试创建，不接触用户设备或长期配置。 */ async () => {
    const r = realFixture()
    const f = setup(r.f.store)
    const a = r.pair('owned_management_a')
    const b = r.pair('owned_management_b')
    f.grant(
      ...[a, b].flatMap(
        /** 每台设备显式授予独立权限，不扩大到未知设备。 */ (device) => [
          { action: 'devices_read' as const, machine_id: device.machine_id },
          { action: 'devices_disconnect' as const, machine_id: device.machine_id },
          { action: 'devices_revoke' as const, machine_id: device.machine_id }
        ]
      )
    )
    const service = new StoreManagementWriteService({
      store: r.f.store,
      identities: f.identities,
      transport: r.f.gateway
    })
    const ca = r.connector(a)
    const cb = r.connector(b)
    try {
      await r.ready(ca, cb)
      const stateA = await service.execute('write_state_get', { machine_id: a.machine_id }, context())
      const stateB = await service.execute('write_state_get', { machine_id: b.machine_id }, context())
      assert(stateA.connection_epoch)
      assert(stateB.connection_epoch)
      const disconnect = await confirmed(
        service,
        {
          action: 'device_disconnect',
          target: { machine_id: a.machine_id },
          expected_connection_epoch: stateA.connection_epoch
        },
        stateA.resource_revision
      )
      const first = await service.execute(
        'devices_disconnect',
        { ...disconnect.write, machine_id: a.machine_id, expected_connection_epoch: stateA.connection_epoch },
        context()
      )
      assert.equal(first.effects.persistent_authorization, 'unchanged')
      assert.equal(first.effects.channel, 'unconfirmed')
      await until(
        /** 等待实际重新认证和Store分配新epoch，绝不手工标online。 */ () =>
          r.records.some(
            /** 只匹配本机新认证。 */ (record) =>
              record.connection.machine_id === a.machine_id &&
              record.connection.connection_epoch !== stateA.connection_epoch
          ),
        8000
      )
      await r.ready(ca)
      const reconnected = await service.execute('write_state_get', { machine_id: a.machine_id }, context())
      assert.notEqual(reconnected.connection_epoch, stateA.connection_epoch)
      assert.deepEqual(
        await service.execute(
          'devices_disconnect',
          { ...disconnect.write, machine_id: a.machine_id, expected_connection_epoch: stateA.connection_epoch },
          context()
        ),
        first
      )
      assert.equal(
        (await service.execute('write_state_get', { machine_id: a.machine_id }, context())).connection_epoch,
        reconnected.connection_epoch
      )
      assert.equal(
        (await service.execute('write_state_get', { machine_id: b.machine_id }, context())).connection_epoch,
        stateB.connection_epoch
      )
      const revoke = await confirmed(
        service,
        { action: 'device_revoke', target: { machine_id: a.machine_id } },
        reconnected.resource_revision
      )
      const receipt = await service.execute('devices_revoke', { ...revoke.write, machine_id: a.machine_id }, context())
      assert.equal(receipt.effects.persistent_authorization, 'revoked')
      assert.equal(receipt.effects.native_work, 'may_continue')
      assert.equal(r.f.store.machine(a.machine_id).status, 'revoked')
      await until(
        /** 旧Connector实际退出ready，持久身份证明也不能绕过主Store撤销。 */ () => ca.status().phase !== 'ready'
      )
      await assert.rejects(
        confirmed(
          service,
          {
            action: 'device_disconnect',
            target: { machine_id: a.machine_id },
            expected_connection_epoch: reconnected.connection_epoch!
          },
          reconnected.resource_revision
        ),
        /connection_epoch_conflict/
      )
      assert.throws(
        /** 直接使用旧设备长期材料请求认证仍被同一Store门禁拒绝。 */ () =>
          r.f.store.connect(a.machine_id, 'x'.repeat(43)),
        /invalid_device_credential/
      )
      await until(
        /** 允许旧Connector实际重试并保持拒绝，而非只检查本地数据库状态。 */ () => ca.status().reconnects >= 2,
        8000
      )
      assert.notEqual(ca.status().phase, 'ready')
      const after = await service.execute('write_state_get', { machine_id: b.machine_id }, context())
      assert.equal(after.connection_epoch, stateB.connection_epoch)
      assert.equal(cb.status().phase, 'ready')
      assert.equal(r.f.executions, 0)
      const output = JSON.stringify([first, receipt, after])
      for (const device of [a, b]) {
        assert(!output.includes(device.credential.credential))
      }
    } finally {
      r.close()
    }
  }
)
