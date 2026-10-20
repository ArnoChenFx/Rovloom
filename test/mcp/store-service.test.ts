// 验证真实Store/Router接线的当前授权、分页、内容隔离和清理事务；历史/native内容只来自明确人工fixture。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { Router } from '../../src/router.js'
import { Store } from '../../src/store.js'
import {
  FacadeServiceError,
  StoreGatewayService,
  type AdminContext,
  type ManagementArguments,
  type ManagementOperation,
  type ServiceContext
} from '../../src/mcp/index.js'
import { policy, secondTarget, storeFixture, syntheticCredential, syntheticSecret, target } from './store-fixture.js'
import { clockWrites } from '../storage/clock-write-helpers.js'

// 生成受信宿主context，既不来自MCP参数，也不携带设备凭据或管理员会话。
function context(principal = 'alice', signal = new AbortController().signal): ServiceContext {
  return { caller: { principal_id: principal }, wait_signal: signal }
}
// 为独立管理接口注入合成已认证会话，仍须由同一身份服务每次复验。
function adminContext(): AdminContext {
  return { ...context(), management_session_ref: 'admin_session' }
}
// 检查固定公共拒绝代码，拒绝把任意异常文本当作符合预期的失败。
function code(expected: string) {
  return /* 严格匹配受控服务异常和代码，不接纳SQLite路径或其它异常。 */ (error: unknown) =>
    error instanceof FacadeServiceError && error.code === expected
}

test(
  'call_get 每轮只由 Store.call 写一次最新持久时钟，后续回退仍被拒绝',
  /** 在真实文件库上计数实际 UPDATE，并从第二连接确认高水位没有取消或延迟持久化。 */ async () => {
    const f = storeFixture()
    const inspect = new DatabaseSync(f.path, { readOnly: true })
    try {
      f.advance(1)
      const measured = clockWrites(
        f.store,
        /** 无等待读取的首轮同步完成 Store 门禁，返回的 Promise 仍由测试等待。 */ () =>
          f.service.execute('runtime_call_get', { call_id: 'call_fixture' }, context())
      )
      assert.equal((await measured.result).data.state, 'responded')
      assert.equal(measured.updates, 1)
      assert.equal(inspect.prepare('SELECT clock FROM metadata').get()!.clock, 1_000_001)
      f.advance(-1)
      await assert.rejects(
        f.service.execute('runtime_call_get', { call_id: 'call_fixture' }, context()),
        code('storage_degraded')
      )
    } finally {
      inspect.close()
      f.close()
    }
  }
)

for (const change of ['clock', 'recovery', 'owner'] as const) {
  test(
    'call_get 短等下一轮重新核验 ' + change,
    /** 第二轮身份读取时交错改变真实存储事实，不能跨轮沿用入口的时钟或归属快照。 */ async () => {
      const f = storeFixture()
      f.store.connect('machine_a', syntheticCredential)
      const call = new Router(f.store, f.localPolicies).create(
        f.current(),
        target,
        { method: 'pane.read' },
        { binding_revision: 1, contract_ref: 'a'.repeat(64) }
      )
      let snapshots = 0
      const service = new StoreGatewayService({
        store: f.store,
        localPolicies: f.localPolicies,
        identities: {
          ...f.identities,
          /** 第三次身份快照是等待后的第二轮，之后仍由原 Store/Router 完成实际拒绝。 */ principal(caller) {
            const value = f.identities.principal(caller)
            if (++snapshots === 3) {
              if (change === 'clock') {
                f.advance(-1)
              } else {
                const update = new DatabaseSync(f.path)
                try {
                  if (change === 'recovery') {
                    update.exec("UPDATE metadata SET mode='recovery_quarantined'")
                  } else {
                    update.prepare("UPDATE calls SET principal='bob' WHERE call_id=?").run(call.call_id)
                  }
                } finally {
                  update.close()
                }
              }
            }
            return value
          }
        }
      })
      try {
        await assert.rejects(
          service.execute('runtime_call_get', { call_id: call.call_id, wait_ms: 5000 }, context()),
          code(change === 'clock' ? 'storage_degraded' : change === 'recovery' ? 'recovery_quarantined' : 'not_found')
        )
        assert.equal(snapshots, 3)
      } finally {
        f.close()
      }
    }
  )
}

test(
  '真实Store设备/provider查询按双方同一tuple过滤，未知及跨实例目标不泄露',
  /* 分别撤销本地read和尝试相似目标，确认元数据不会继承其它授权。 */ async () => {
    const f = storeFixture()
    try {
      const devices = await f.service.execute('machines_list', {}, context())
      assert.deepEqual(
        devices.data.items.map(/* 只比较公开设备ID及授权集合。 */ (item) => item.machine_id),
        ['machine_a', 'machine_b']
      )
      assert.equal((await f.service.execute('machines_get', { name: 'alpha' }, context())).data.link, 'unverified')
      assert.equal(
        (await f.service.execute('providers_get', { machine_id: 'machine_a', provider_id: 'luvus_a' }, context())).data
          .readiness,
        'unverified'
      )
      await assert.rejects(
        f.service.execute('providers_get', { machine_id: 'machine_a', provider_id: 'herdr_a' }, context()),
        code('not_found')
      )
      f.setLocal(policy([secondTarget], 'local_2'))
      assert.deepEqual(
        (await f.service.execute('machines_list', {}, context())).data.items.map(
          /* 当前政策只保留第二个完整目标。 */ (item) => item.machine_id
        ),
        ['machine_b']
      )
      await assert.rejects(f.service.execute('machines_get', { name: 'alpha' }, context()), code('not_found'))
      f.setLocal(policy([{ ...target, profile: 'session', session: 'other' }], 'local_3'))
      assert.deepEqual((await f.service.execute('machines_list', {}, context())).data.items, [])
    } finally {
      f.close()
    }
  }
)

test(
  '真实授权分页游标绑定身份、查询、limit、当前政策和期限，不接受offset自报',
  /* 使用同一数据库跨页，再改变查询和政策验证旧游标失效。 */ async () => {
    const f = storeFixture()
    try {
      const first = await f.service.execute('machines_list', { limit: 1 }, context())
      assert.equal(first.data.items.length, 1)
      assert(first.data.next_cursor)
      const second = await f.service.execute('machines_list', { limit: 1, cursor: first.data.next_cursor }, context())
      assert.equal(second.data.items[0]?.machine_id, 'machine_b')
      await assert.rejects(
        f.service.execute('machines_list', { limit: 2, cursor: first.data.next_cursor }, context()),
        code('invalid_cursor')
      )
      await assert.rejects(f.service.execute('machines_list', { cursor: '1' }, context()), code('invalid_cursor'))
      f.setLocal(policy([target], 'local_changed'))
      await assert.rejects(
        f.service.execute('machines_list', { limit: 1, cursor: first.data.next_cursor }, context()),
        code('invalid_cursor')
      )
      f.setLocal(policy([target, secondTarget], 'local_1'))
      f.advance(30_001)
      await assert.rejects(
        f.service.execute('machines_list', { limit: 1, cursor: first.data.next_cursor }, context()),
        code('invalid_cursor')
      )
    } finally {
      f.close()
    }
  }
)

test(
  '调用元数据来自实际Store且不交付正文；独立discard受归属、当前双端策略和专门权限保护',
  /* 用实际清理事务验证授权失败不删、成功后正文和句柄均消失且审计记录实际principal。 */ async () => {
    const f = storeFixture()
    try {
      assert(f.store.call('alice', 'call_fixture').response?.includes(syntheticSecret))
      const view = await f.service.execute('runtime_call_get', { call_id: 'call_fixture' }, context())
      assert.equal(view.data.state, 'responded')
      assert.equal(view.data.contract_ref, null)
      assert.equal(view.data.content_delivery, 'unavailable')
      assert(!JSON.stringify(view).includes(syntheticSecret))
      f.setCaller({ ...f.current(), permissions: { discard_response: false } })
      await assert.rejects(
        f.service.execute('runtime_response_discard', { call_id: 'call_fixture' }, context()),
        code('forbidden')
      )
      f.setCaller({ id: 'bob', policy: policy(), permissions: { discard_response: true } })
      await assert.rejects(
        f.service.execute('runtime_response_discard', { call_id: 'call_fixture' }, context('bob')),
        code('not_found')
      )
      f.setCaller({ id: 'alice', policy: policy(), permissions: { discard_response: true } })
      f.setLocal(policy([], 'local_revoked'))
      await assert.rejects(
        f.service.execute('runtime_response_discard', { call_id: 'call_fixture' }, context()),
        code('forbidden')
      )
      assert(f.store.call('alice', 'call_fixture').response)
      f.setLocal(policy([target, secondTarget], 'local_1'))
      assert.equal(
        (await f.service.execute('runtime_response_discard', { call_id: 'call_fixture' }, context())).data
          .content_status,
        'discarded'
      )
      assert.equal(f.store.call('alice', 'call_fixture').response, null)
      f.store.close()
      const inspect = new DatabaseSync(f.path, { readOnly: true })
      try {
        assert.equal(
          inspect.prepare('SELECT request_json FROM calls WHERE call_id=?').get('call_fixture')!.request_json,
          null
        )
        assert.equal(inspect.prepare('SELECT COUNT(*) n FROM results').get()!.n, 0)
        assert.equal(inspect.prepare("SELECT actor FROM audit WHERE action='discard_response'").get()!.actor, 'alice')
      } finally {
        inspect.close()
      }
    } finally {
      f.close()
    }
  }
)

test(
  '真实Router登记的短等及时响应撤权和AbortSignal，等待不改变账本或派发',
  /* 合成固定hash只用于隔离Store身份，不进行凭据签发、配对或真实连接。 */ async () => {
    const f = storeFixture()
    try {
      f.store.connect('machine_a', syntheticCredential)
      const router = new Router(f.store, f.localPolicies)
      const call = router.create(
        f.current(),
        target,
        { method: 'pane.read' },
        { binding_revision: 1, contract_ref: 'a'.repeat(64) }
      )
      const stop = new AbortController()
      const waiting = f.service.execute(
        'runtime_call_get',
        { call_id: call.call_id, wait_ms: 5000 },
        context('alice', stop.signal)
      )
      stop.abort()
      await assert.rejects(waiting, code('unavailable'))
      assert.equal(f.store.call('alice', call.call_id).state, 'created')
      const revoked = f.service.execute('runtime_call_get', { call_id: call.call_id, wait_ms: 5000 }, context())
      f.setLocal(policy([], 'local_revoked'))
      await assert.rejects(revoked, code('forbidden'))
      assert.equal(f.store.call('alice', call.call_id).state, 'created')
      const device = await f.service.management.execute('devices_get', { machine_id: 'machine_a' }, adminContext())
      assert.equal(device.persisted_state, 'online')
      assert.equal(device.connection.verification, 'unverified')
    } finally {
      f.close()
    }
  }
)

test(
  '未接线的原生/资源关闭/管理写入明确失败，不创建调用、不清理内容、不签发凭据',
  /* 对真实Store调用所有缺后端动作，验证拒绝没有数据库副作用。 */ async () => {
    const f = storeFixture()
    try {
      const raw = {
        target,
        expected_binding_revision: 1,
        contract_ref: 'a'.repeat(64),
        deadline: 1_020_000,
        native_request: { method: 'pane.read' }
      }
      await assert.rejects(f.service.execute('runtime_call', raw, context()), code('backend_unavailable'))
      await assert.rejects(
        f.service.execute('runtime_discover', { target, expected_binding_revision: 1 }, context()),
        code('backend_unavailable')
      )
      await assert.rejects(
        f.service.execute('runtime_call_cancel', { call_id: 'call_fixture' }, context()),
        code('backend_unavailable')
      )
      await assert.rejects(
        f.service.execute('runtime_result_read', { result_id: 'result_fixture' }, context()),
        code('backend_unavailable')
      )
      await assert.rejects(
        f.service.execute('machines_register', { name: 'new' }, context()),
        code('backend_unavailable')
      )
      await assert.rejects(
        f.service.execute('machines_rename', { machine_id: 'machine_a', name: 'renamed' }, context()),
        code('backend_unavailable')
      )
      await assert.rejects(
        f.service.execute(
          'machines_revoke',
          { machine_id: 'machine_a', confirmation_id: 'not_a_confirmation' },
          context()
        ),
        code('backend_unavailable')
      )
      const write = {
        confirmation_id: 'not_a_confirmation',
        request_id: 'req_1',
        history_epoch: 'admin_history',
        recovery_generation: f.store.generation(),
        expected_revision: 1,
        reason: 'isolated test'
      }
      const provider = {
        ...write,
        machine_id: 'machine_a',
        provider_id: 'luvus_a',
        kind: 'luvus' as const,
        expected_binding_revision: 1
      }
      type ManagementRequest = {
        [K in ManagementOperation]: { name: K; args: ManagementArguments[K] }
      }[ManagementOperation]
      const unavailable: ManagementRequest[] = [
        {
          name: 'operations_get',
          args: {
            request_id: write.request_id,
            history_epoch: write.history_epoch,
            recovery_generation: write.recovery_generation
          }
        },
        {
          name: 'confirmations_create',
          args: {
            request_id: write.request_id,
            history_epoch: write.history_epoch,
            recovery_generation: write.recovery_generation,
            expected_revision: write.expected_revision,
            reason: write.reason,
            action: 'device_revoke',
            target: { machine_id: 'machine_a' }
          }
        },
        { name: 'confirmations_confirm', args: { ...write, operation_digest: 'a'.repeat(64) } },
        { name: 'pairings_create', args: { ...write, name: 'new', policy_ref: 'policy_1', labels: [] } },
        { name: 'pairings_cancel', args: { ...write, machine_id: 'machine_a', pairing_id: 'pairing_1' } },
        {
          name: 'devices_disconnect',
          args: { ...write, machine_id: 'machine_a', expected_connection_epoch: 'synthetic_epoch' }
        },
        { name: 'devices_revoke', args: { ...write, machine_id: 'machine_a' } },
        { name: 'providers_disable', args: provider },
        { name: 'providers_enable', args: provider }
      ]
      for (const request of unavailable) {
        await assert.rejects(
          f.service.management.execute(request.name, request.args, adminContext()),
          code('backend_unavailable')
        )
      }
      assert.equal(f.store.machine('machine_a').name, 'alpha')
      assert.equal(f.store.machine('machine_a').status, 'offline')
      assert.equal(f.store.provider('machine_a', 'luvus_a')?.binding_revision, 1)
      assert(f.store.call('alice', 'call_fixture').response?.includes(syntheticSecret))
      f.store.close()
      const inspect = new DatabaseSync(f.path, { readOnly: true })
      try {
        assert.equal(inspect.prepare('SELECT COUNT(*) n FROM calls').get()!.n, 1)
        assert.equal(inspect.prepare('SELECT COUNT(*) n FROM enrollments').get()!.n, 0)
        assert.equal(inspect.prepare('SELECT COUNT(*) n FROM management').get()!.n, 0)
      } finally {
        inspect.close()
      }
    } finally {
      f.close()
    }
  }
)

test(
  'MCP清理沿用Store提交后回收：回滚不通知，成功提交后外部连接只见已删除内容',
  /* 对真实SQLite提交注入故障，验证facade不绕开Store回收次序，也不向公共结果泄露内部通知。 */ async () => {
    const f = storeFixture()
    f.store.close()
    let fail = false
    const store = new Store(f.path, /* 固定为人工历史的当前时刻，不接入用户时钟或会话。 */ () => 1_000_000, {
      fault: /* 只阻断明确指定的提交阶段，保留真实SQLite事务与回滚。 */ (point) => {
        if (fail && point === 'before_commit') {
          throw new Error('synthetic commit failure')
        }
      }
    })
    const service = new StoreGatewayService({ store, identities: f.identities, localPolicies: f.localPolicies })
    const inspect = new DatabaseSync(f.path, { readOnly: true })
    const observed: { machine_id: string; call_id: string; request_json: unknown; response: unknown }[] = []
    const unsubscribe = store.subscribeInvalidation(
      /* 从独立只读连接记录通知时已提交的内容状态，回调中不重入Store或改变事务。 */ (event) => {
        if (event.kind === 'content') {
          const row = inspect.prepare('SELECT request_json,response FROM calls WHERE call_id=?').get(event.call_id)!
          observed.push({
            machine_id: event.machine_id,
            call_id: event.call_id,
            request_json: row.request_json,
            response: row.response
          })
        }
      }
    )
    try {
      fail = true
      await assert.rejects(
        service.execute('runtime_response_discard', { call_id: 'call_fixture' }, context()),
        code('storage_degraded')
      )
      assert.deepEqual(observed, [])
      assert(inspect.prepare('SELECT response FROM calls WHERE call_id=?').get('call_fixture')!.response)
      fail = false
      const discarded = await service.execute('runtime_response_discard', { call_id: 'call_fixture' }, context())
      assert.deepEqual(discarded.data, { call_id: 'call_fixture', content_status: 'discarded' })
      assert.deepEqual(observed, [
        { machine_id: 'machine_a', call_id: 'call_fixture', request_json: null, response: null }
      ])
      assert.equal(inspect.prepare('SELECT COUNT(*) n FROM results').get()!.n, 0)
      assert(!JSON.stringify(discarded).includes(syntheticSecret))
      assert.equal(
        (await service.execute('runtime_call_get', { call_id: 'call_fixture' }, context())).data.content_delivery,
        'unavailable'
      )
    } finally {
      unsubscribe()
      inspect.close()
      store.close()
      f.close()
    }
  }
)

test(
  '独立管理会话复用同一身份后端，状态和权限快照不伪造现场能力或暴露配置路径',
  /* 同时验证MCP身份隔离、provider独立查看权和管理写后端阻断。 */ async () => {
    const f = storeFixture()
    try {
      const status = await f.service.management.execute('status', {}, adminContext())
      assert.equal(status.mode, 'active')
      assert.equal(status.history, null)
      assert.equal(status.components.transport, 'unavailable')
      const provider = await f.service.management.execute(
        'providers_get',
        { machine_id: 'machine_a', provider_id: 'herdr_a' },
        adminContext()
      )
      assert.equal(provider.config_ref, null)
      assert.equal(provider.runtime.verification, 'unverified')
      const snap = await f.service.management.execute(
        'permissions_get',
        { machine_id: 'machine_a', provider_id: 'luvus_a' },
        adminContext()
      )
      assert(
        snap.decisions.some(
          /* 有providers_manage授权仍因缺后端而不能执行写入。 */ (decision) =>
            decision.action === 'providers_manage' &&
            !decision.allowed &&
            decision.reason_code === 'backend_unavailable'
        )
      )
      assert(!JSON.stringify({ status, provider, snap }).includes(syntheticSecret))
      const page = await f.service.management.execute('devices_list', { limit: 1 }, adminContext())
      assert(page.next_cursor)
      assert.equal(
        (await f.service.management.execute('devices_list', { limit: 1, cursor: page.next_cursor }, adminContext()))
          .items[0]?.machine_id,
        'machine_b'
      )
      f.setAdmin(null)
      await assert.rejects(f.service.management.execute('status', {}, adminContext()), code('unauthenticated'))
      assert.equal(
        (await f.service.execute('machines_get', { machine_id: 'machine_a' }, context())).data.machine_id,
        'machine_a'
      )
    } finally {
      f.close()
    }
  }
)

test(
  '当前身份失效、伪造管理会话和非法参数只返回固定拒绝',
  /* 验证直接服务入口也不接受额外身份字段，不依赖HTTP facade预先验证。 */ async () => {
    const f = storeFixture()
    try {
      await assert.rejects(
        f.service.management.execute(
          'devices_get',
          { machine_id: 'machine_a', principal_id: 'alice' } as never,
          adminContext()
        ),
        code('invalid_arguments')
      )
      await assert.rejects(
        f.service.management.execute('status', {}, { ...adminContext(), management_session_ref: 'forged' }),
        code('unauthenticated')
      )
      f.setCaller(null)
      await assert.rejects(f.service.execute('machines_list', {}, context()), code('unauthenticated'))
    } finally {
      f.close()
    }
  }
)

test(
  '真实Store恢复隔离与降级约束覆盖服务，内容期限不会因查询或缺后端重建',
  /* 用关闭writer时设置的隔离fixture验证模式，不冒充受控恢复流程。 */ async () => {
    const quarantined = storeFixture('recovery_quarantined')
    try {
      await assert.rejects(quarantined.service.execute('machines_list', {}, context()), code('recovery_quarantined'))
      await assert.rejects(
        quarantined.service.management.execute('status', {}, adminContext()),
        code('recovery_quarantined')
      )
      quarantined.setAdmin({
        principal_id: 'alice',
        session_ref: 'admin_session',
        assurance: 'recovery_local',
        policy_revision: 'recovery_1',
        grants: [{ action: 'gateway_read' }, { action: 'devices_read', machine_id: 'machine_a' }]
      })
      assert.equal(
        (await quarantined.service.management.execute('status', {}, adminContext())).mode,
        'recovery_quarantined'
      )
      await assert.rejects(
        quarantined.service.management.execute('devices_get', { machine_id: 'machine_a' }, adminContext()),
        code('recovery_quarantined')
      )
    } finally {
      quarantined.close()
    }
    const degraded = storeFixture('storage_degraded')
    try {
      assert.equal((await degraded.service.management.execute('status', {}, adminContext())).mode, 'storage_degraded')
      assert.equal((await degraded.service.execute('machines_list', {}, context())).data.items.length, 2)
      await degraded.service.execute('runtime_response_discard', { call_id: 'call_fixture' }, context())
      assert.equal(degraded.store.call('alice', 'call_fixture').content_status, 'discarded')
    } finally {
      degraded.close()
    }
    const expired = storeFixture()
    try {
      expired.advance(60_001)
      assert.equal(
        (await expired.service.execute('runtime_call_get', { call_id: 'call_fixture' }, context())).data.content_status,
        'expired'
      )
      assert(
        !JSON.stringify(
          await expired.service.execute('runtime_call_get', { call_id: 'call_fixture' }, context())
        ).includes(syntheticSecret)
      )
    } finally {
      expired.close()
    }
  }
)

test(
  '未知持久设备状态拒绝而非激活，旧binding调用返回明确revision冲突',
  /* 在关闭writer的fixture阶段模拟未来状态和真实绑定变更，不替换服务或Router行为。 */ async () => {
    const unknown = storeFixture(
      'active',
      /* 持久状态未知时不允许MCP将它映射为active。 */ (db) => {
        db.prepare('UPDATE machines SET status=? WHERE machine_id=?').run('quarantined_unknown', 'machine_a')
      }
    )
    try {
      await assert.rejects(
        unknown.service.execute('machines_get', { machine_id: 'machine_a' }, context()),
        code('unavailable')
      )
      await assert.rejects(
        unknown.service.management.execute('devices_get', { machine_id: 'machine_a' }, adminContext()),
        code('unavailable')
      )
    } finally {
      unknown.close()
    }
    const changed = storeFixture(
      'active',
      /* 当前binding变更不能让旧调用以一般内部错误或新实例身份返回。 */ (db) => {
        db.prepare('UPDATE providers SET binding_revision=2 WHERE machine_id=? AND provider_id=?').run(
          'machine_a',
          'luvus_a'
        )
      }
    )
    try {
      await assert.rejects(
        changed.service.execute('runtime_call_get', { call_id: 'call_fixture' }, context()),
        code('binding_revision_conflict')
      )
    } finally {
      changed.close()
    }
  }
)

test(
  '独立管理设备状态筛选有界且绑定游标，不从持久offline猜测现场重连',
  /* 同一真实Store验证匹配、无匹配和非法枚举，筛选不能改写或绕过当前授权。 */ async () => {
    const f = storeFixture()
    try {
      assert.equal(
        (await f.service.management.execute('devices_list', { states: ['offline'] }, adminContext())).items.length,
        2
      )
      assert.deepEqual(
        (await f.service.management.execute('devices_list', { states: ['pending'] }, adminContext())).items,
        []
      )
      const page = await f.service.management.execute('devices_list', { states: ['offline'], limit: 1 }, adminContext())
      assert(page.next_cursor)
      await assert.rejects(
        f.service.management.execute(
          'devices_list',
          { states: ['pending'], limit: 1, cursor: page.next_cursor },
          adminContext()
        ),
        code('invalid_cursor')
      )
      for (const states of [[], ['offline', 'offline'], ['connecting']]) {
        await assert.rejects(
          f.service.management.execute('devices_list', { states } as never, adminContext()),
          code('invalid_arguments')
        )
      }
    } finally {
      f.close()
    }
  }
)
