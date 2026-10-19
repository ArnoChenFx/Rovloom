/** 使用同一共享管理 DTO 验证消费层；fixture 通过不等于真实管理后端或授权完成。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createManagementPageRead, type ManagementReadTransport } from '../../src/webui/read.js'
import { ReadError } from '../../src/webui/reader.js'
import { fixtureReply, fixtureSnapshot, fixtureDevice } from './fixtures.js'
import { checkPage } from '../../src/webui/validate.js'

const listRoute = { machineId: null, cursor: null, providerCursor: null }
const detailRoute = { machineId: 'fixture-a', cursor: null, providerCursor: null }

// 消费操作必须只使用既有共享名和参数，不能从页面注入管理身份。
test('只读取共享操作，列表页有界且不续 scope', async () => {
  const calls: { name: string; args: unknown }[] = []
  const transport: ManagementReadTransport = async (name, args) => {
    calls.push({ name, args })
    return fixtureReply(name, args)
  }
  const result = await createManagementPageRead(transport)(
    { ...listRoute, cursor: 'fixture-cursor' },
    new AbortController().signal
  )
  assert.deepEqual(calls, [
    { name: 'status', args: {} },
    { name: 'devices_list', args: { limit: 50, cursor: 'fixture-cursor' } },
    { name: 'status', args: {} }
  ])
  assert.equal(result.value.devices.items.length, 2)
  assert.equal(result.sessionExpiresAt, null)
  checkPage(result, listRoute)
})

// 详情包含 provider 和短期权限提示，读取前后设备 fence 必须一致。
test('设备详情复用共享 DTO，provider 与权限隔离', async () => {
  const calls: string[] = []
  const read = createManagementPageRead(
    /** 记录固定共享操作，不提供 AdminContext 或身份参数。 */
    async (name, args) => {
      calls.push(name)
      return fixtureReply(name, args)
    }
  )
  const result = await read(detailRoute, new AbortController().signal)
  assert.deepEqual(calls, ['status', 'devices_get', 'providers_list', 'permissions_get', 'devices_get', 'status'])
  assert.equal(result.value.device?.machine_id, 'fixture-a')
  assert.equal(result.value.providers.items[1]?.runtime.verification, 'verified')
  checkPage(result, detailRoute)
})

// Provider 403/503 可部分失败，401 等会话错误必须整页向上传递。
for (const problem of ['forbidden', 'unavailable', 'unauthenticated'] as const) {
  test(`provider ${problem} 不伪装设备离线或授权成功`, async () => {
    const read = createManagementPageRead(
      /** 仅 provider 读取失败。 */
      async (name, args) => {
        if (name === 'providers_list') {
          throw new ReadError(problem)
        }
        return fixtureReply(name, args)
      }
    )
    if (problem === 'unauthenticated') {
      await assert.rejects(read(detailRoute, new AbortController().signal), { problem })
    } else {
      const result = await read(detailRoute, new AbortController().signal)
      assert.equal(result.value.device?.persisted_state, 'online')
      assert.equal(result.value.providersProblem, problem)
      assert.deepEqual(result.value.providers.items, [])
    }
  })
}

// 恢复隔离只读取最小 status，不能触发设备、provider 或权限历史读取。
test('恢复隔离仅执行状态读取', async () => {
  const calls: string[] = []
  const read = createManagementPageRead(
    /** 合成隔离状态，拒绝任何非状态操作。 */
    async (name, args) => {
      calls.push(name)
      if (name !== 'status') {
        throw new Error('unexpected management read')
      }
      const result = fixtureReply(name, args)
      return { ...result, mode: 'recovery_quarantined' } as typeof result
    }
  )
  const result = await read(detailRoute, new AbortController().signal)
  assert.deepEqual(calls, ['status', 'status'])
  assert.equal(result.value.device, null)
  checkPage(result, detailRoute)
})

// 全局恢复代次、策略、history/mode 中任一 fence 变化都会拒绝混合快照。
for (const field of ['recovery_generation', 'policy_revision', 'history', 'mode'] as const) {
  test(`${field} 变化拒绝页面拼接`, async () => {
    let statuses = 0
    const read = createManagementPageRead(
      /** 第二个 status 故意改变一项全局 fence。 */
      async (name, args) => {
        const result = fixtureReply(name, args)
        if (name === 'status' && ++statuses === 2) {
          Object.assign(result, {
            [field]:
              field === 'history'
                ? { history_epoch: 'changed', accept_new_until: 1 }
                : field === 'mode'
                  ? 'storage_degraded'
                  : 'changed'
          })
        }
        return result
      }
    )
    await assert.rejects(read(detailRoute, new AbortController().signal), { problem: 'conflict' })
  })
}

// 设备再次认证产生新 epoch，或资源 revision 更新，都不能复用旧详情。
test('设备 epoch/revision 变化及读取取消不会继续消费旧页', async () => {
  for (const fence of ['epoch', 'revision'] as const) {
    let devices = 0
    const read = createManagementPageRead(
      /** 第二次设备读取改变独立 epoch 或资源 revision。 */
      async (name, args) => {
        const result = fixtureReply(name, args)
        if (name === 'devices_get' && ++devices === 2) {
          const changed = fixtureDevice('fixture-a')
          if (fence === 'revision') {
            changed.resource_revision = 4
          } else if (changed.connection.verification === 'verified') {
            changed.connection.value.connection_epoch_ref = 'changed-epoch'
          }
          Object.assign(result, changed)
        }
        return result
      }
    )
    await assert.rejects(read(detailRoute, new AbortController().signal), { problem: 'conflict' })
  }
  const abort = new AbortController()
  let calls = 0
  const cancelled = createManagementPageRead(
    /** 第一次 status 后取消，后续操作必须停止。 */
    async (name, args) => {
      calls++
      abort.abort()
      return fixtureReply(name, args)
    }
  )
  await assert.rejects(cancelled(listRoute, abort.signal))
  assert.equal(calls, 1)
})

// 空页/详情/部分失败/隔离投影互斥，未来心跳及子观测不能制造新鲜状态。
test('拒绝详情夹带列表、部分失败夹带行或游标和未来子观测', () => {
  for (const scenario of [
    'detail_list',
    'detail_cursor',
    'partial_rows',
    'partial_cursor',
    'quarantine_cursor',
    'device_time',
    'heartbeat_time',
    'provider_time',
    'permission_time'
  ] as const) {
    const snapshot = fixtureSnapshot(detailRoute)
    if (scenario === 'detail_list') {
      snapshot.value.devices.items = [fixtureDevice('fixture-b')]
    }
    if (scenario === 'detail_cursor') {
      snapshot.value.devices.next_cursor = 'unrelated-page'
    }
    if (scenario === 'partial_rows') {
      snapshot.value.providersProblem = 'forbidden'
    }
    if (scenario === 'partial_cursor') {
      snapshot.value.providersProblem = 'unavailable'
      snapshot.value.providers = { items: [], next_cursor: 'unavailable-page' }
    }
    if (scenario === 'quarantine_cursor') {
      snapshot.value.status.mode = 'recovery_quarantined'
      snapshot.value.device = null
      snapshot.value.permissions = null
      snapshot.value.providers = { items: [] }
      snapshot.value.devices = { items: [], next_cursor: 'backup-page' }
    }
    if (scenario === 'device_time') {
      snapshot.value.device!.observed_at = snapshot.serverTime + 1
    }
    if (scenario === 'heartbeat_time' && snapshot.value.device!.connection.verification === 'verified') {
      snapshot.value.device!.connection.value.last_heartbeat_at = snapshot.serverTime + 1
    }
    if (scenario === 'provider_time' && snapshot.value.providers.items[0]!.runtime.verification === 'verified') {
      snapshot.value.providers.items[0]!.runtime.observed_at = snapshot.serverTime + 1
    }
    if (scenario === 'permission_time') {
      snapshot.value.permissions!.observed_at = snapshot.serverTime + 1
    }
    assert.throws(
      /** 每个不一致组合都只能返回固定失败分类。 */
      () => checkPage(snapshot, detailRoute),
      { problem: 'invalid_response' }
    )
  }
})

// 未核实状态必须原样保留，不能由 persisted online 推导认证或 ready。
test('unverified 保留未知，校验后脱离源对象可变引用', () => {
  const snapshot = fixtureSnapshot(detailRoute)
  snapshot.value.device!.connection = { verification: 'unverified', reason_code: 'not_recorded' }
  snapshot.value.device!.authentication = { verification: 'unverified', reason_code: 'backend_unavailable' }
  const result = checkPage(snapshot, detailRoute)
  snapshot.value.device!.name = 'changed after read'
  assert.notEqual(result.value.device!.name, 'changed after read')
  assert.equal(result.value.device!.connection.verification, 'unverified')
})

// 未知字段、超限、越机器和错误分支不能进入普通页面快照。
test('拒绝秘密附加字段、超限列表、跨机器和非法状态', () => {
  for (const scenario of ['secret', 'oversize', 'wrong_machine', 'invalid_auth', 'future_time', 'scope'] as const) {
    const snapshot = fixtureSnapshot(detailRoute)
    if (scenario === 'secret') {
      Object.assign(snapshot.value.device!, { enrollment_secret: 'fixture-secret-must-not-leak' })
    }
    if (scenario === 'oversize') {
      snapshot.value.devices.items = Array.from(
        { length: 201 },
        /** 重复合成行用于验证列表硬上限。 */
        () => snapshot.value.device!
      )
    }
    if (scenario === 'wrong_machine') {
      snapshot.value.providers.items[0]!.machine_id = 'fixture-b'
    }
    if (scenario === 'invalid_auth') {
      Object.assign(snapshot.value.device!.authentication, { value: { state: 'ready' } })
    }
    if (scenario === 'future_time') {
      snapshot.serverTime = Infinity
    }
    if (scenario === 'scope') {
      snapshot.value.permissions!.target.machine_id = 'fixture-b'
    }
    assert.throws(
      /** 非法 DTO 必须只返回固定错误分类。 */
      () => checkPage(snapshot, detailRoute),
      { problem: 'invalid_response', message: 'invalid_response' }
    )
  }
})
