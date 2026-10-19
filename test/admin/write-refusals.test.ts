// 验证writer内已知管理拒绝不误降级，未知宿主和真实SQLite异常仍走原存储故障路径。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../../src/store.js'
import { StoreManagementWriteService } from '../../src/admin/write-service.js'
import { management } from '../storage/helpers.js'
import { confirmed, context, setup } from './write-helpers.js'
import type { ManagementWrite } from '../../src/mcp/management.js'

/** 真实只读快照核对拒绝后的确认、回执和秘密记录，绝不读取用户数据库。 */
function unchanged(path: string, write: ManagementWrite) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    assert.equal(
      db.prepare('SELECT state FROM admin_confirmations WHERE confirmation_id=?').get(write.confirmation_id)!.state,
      'confirmed'
    )
    assert.equal(db.prepare('SELECT COUNT(*) n FROM admin_operations WHERE request_id=?').get(write.request_id)!.n, 0)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM enrollments').get()!.n, 0)
  } finally {
    db.close()
  }
}

for (const action of ['pairing_create', 'provider_enable'] as const) {
  test(
    `确认后${action}证明失效只回滚管理操作，健康writer可继续提交原意图`,
    /** 复现预检不取证明、writer内beforeMutation才拒绝的自然路径。 */ async () => {
      const root = mkdtempSync(join(tmpdir(), 'rovloom-owned-proof-refusal-'))
      const path = join(root, 'gateway.sqlite')
      const store = new Store(path, Date.now, { management })
      const f = setup(store)
      let proof = true
      try {
        const machine = store.register('owned_proof_refusal').machine_id
        store.defineProvider({
          machine_id: machine,
          provider_id: 'one',
          kind: 'luvus',
          config_ref: 'fixture_only',
          enabled: false,
          binding_revision: 1
        })
        f.grant({ action: 'providers_manage', machine_id: machine, provider_id: 'one' })
        const service = new StoreManagementWriteService({
          store,
          identities: f.identities,
          transport: { /** 此测试无活socket。 */ refresh() {} },
          /** 显式合成证明可在确认后撤回。 */ pairingPolicy: () => proof,
          /** 显式合成证明可在确认后撤回。 */ providerEnable: () => proof
        })
        const operation =
          action === 'pairing_create'
            ? { action, target: { name: 'must_remain_unregistered', labels: [], policy_ref: 'fixture_policy' } }
            : {
                action,
                target: { machine_id: machine, provider_id: 'one', kind: 'luvus' as const },
                expected_binding_revision: 1
              }
        const c = await confirmed(service, operation, action === 'pairing_create' ? 0 : 1)
        const args =
          action === 'pairing_create'
            ? { ...c.write, ...operation.target }
            : { ...c.write, ...operation.target, expected_binding_revision: 1 }
        proof = false
        await assert.rejects(
          service.execute(
            action === 'pairing_create' ? 'pairings_create' : 'providers_enable',
            args as never,
            context()
          ),
          /backend_unavailable/
        )
        assert.equal(store.health().mode, 'active')
        unchanged(path, c.write)
        assert.equal(store.provider(machine, 'one')!.binding_revision, 1)
        assert.equal(store.provider(machine, 'one')!.enabled, false)
        const db = new DatabaseSync(path, { readOnly: true })
        try {
          assert.equal(db.prepare('SELECT COUNT(*) n FROM machines').get()!.n, 1)
          assert.equal(db.prepare('SELECT COUNT(*) n FROM admin_pairings').get()!.n, 0)
        } finally {
          db.close()
        }
        proof = true
        const result = await service.execute(
          action === 'pairing_create' ? 'pairings_create' : 'providers_enable',
          args as never,
          context()
        )
        assert.equal(result.operation_state, 'committed')
        assert.equal(store.health().mode, 'active')
      } finally {
        store.close()
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
}

for (const refusal of ['session', 'permission'] as const) {
  for (const read of [2, 3]) {
    test(
      `writer内${read === 2 ? 'authority' : 'beforeMutation'}发生${refusal}撤回不会降级或消费确认`,
      /** 分别在事务授权回调与最后证明门禁重读时撤回，外部预检仍然成功。 */ async () => {
        const root = mkdtempSync(join(tmpdir(), 'rovloom-owned-session-refusal-'))
        const path = join(root, 'gateway.sqlite')
        const store = new Store(path)
        const f = setup(store)
        let armed = false
        let reads = 0
        try {
          const machine = store.register('owned_session_refusal').machine_id
          f.grant({ action: 'devices_rename', machine_id: machine })
          const service = new StoreManagementWriteService({
            store,
            identities: {
              principal: f.identities.principal,
              /** 受控后端只在写事务内返回已撤回的当前会话/权限。 */
              administrator(caller, session) {
                const current = f.identities.administrator(caller, session)
                if (armed && ++reads >= read) {
                  return refusal === 'session' ? null : { ...current!, grants: [] }
                }
                return current
              }
            }
          })
          const state = await service.execute('write_state_get', { machine_id: machine }, context())
          const c = await confirmed(
            service,
            { action: 'device_rename', target: { machine_id: machine }, name: 'healthy_after_refusal' },
            state.resource_revision
          )
          armed = true
          await assert.rejects(
            service.execute(
              'devices_rename',
              { ...c.write, machine_id: machine, name: 'healthy_after_refusal' },
              context()
            ),
            refusal === 'session' ? /unauthenticated/ : /forbidden/
          )
          assert.equal(store.health().mode, 'active')
          assert.equal(store.machine(machine).name, 'owned_session_refusal')
          unchanged(path, c.write)
          armed = false
          assert.equal(
            (
              await service.execute(
                'devices_rename',
                { ...c.write, machine_id: machine, name: 'healthy_after_refusal' },
                context()
              )
            ).operation_state,
            'committed'
          )
          assert.equal(store.health().mode, 'active')
          assert.equal(store.machine(machine).name, 'healthy_after_refusal')
        } finally {
          store.close()
          rmSync(root, { recursive: true, force: true })
        }
      }
    )
  }
}

for (const failure of ['unknown_host', 'sqlite'] as const) {
  test(
    `writer内${failure}异常仍锁存降级，不能被业务拒绝桥吞掉`,
    /** 使用未知宿主异常或真实SQLite执行错误，确认不会把故障统一降格为业务拒绝。 */ async () => {
      const root = mkdtempSync(join(tmpdir(), 'rovloom-owned-real-failure-'))
      const path = join(root, 'gateway.sqlite')
      const store = new Store(path, Date.now, { management })
      const f = setup(store)
      const sqlite = new DatabaseSync(':memory:')
      let armed = false
      try {
        const service = new StoreManagementWriteService({
          store,
          identities: f.identities,
          /** 确认阶段正常，提交阶段由受信证明后端注入实际SQLite异常或未知宿主错误。 */ pairingPolicy() {
            if (armed) {
              if (failure === 'sqlite') {
                sqlite.exec('SELECT missing_column FROM missing_table')
              } else {
                throw new Error('SYNTHETIC_PRIVATE_HOST_FAILURE')
              }
            }
            return true
          }
        })
        const target = { name: 'must_not_commit_fault', labels: [], policy_ref: 'fixture_policy' }
        const c = await confirmed(service, { action: 'pairing_create', target }, 0)
        armed = true
        await assert.rejects(
          service.execute('pairings_create', { ...c.write, ...target }, context()),
          /storage_degraded/
        )
        assert.equal(store.health().mode, 'storage_degraded')
        unchanged(path, c.write)
        const db = new DatabaseSync(path, { readOnly: true })
        try {
          assert.equal(db.prepare('SELECT COUNT(*) n FROM machines').get()!.n, 0)
        } finally {
          db.close()
        }
      } finally {
        sqlite.close()
        store.close()
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
}
