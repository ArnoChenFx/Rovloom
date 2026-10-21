// 覆盖管理历史、schema拒绝和provider重启门禁；全部材料属于独立测试目录。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/store.js'
import { StoreManagementWriteService } from '../../src/admin/write-service.js'
import { confirmed, context, setup } from './write-helpers.js'
import { management } from '../storage/helpers.js'

test(
  'history固定到期、跨会话和缺失历史拒绝，过期后只读原回执不再变更',
  /** 原request在新的history中不能伪装为一次旧请求重送。 */ async () => {
    const f = setup()
    try {
      const machine = f.store.register('owned_history').machine_id
      f.grant({ action: 'devices_rename', machine_id: machine })
      const state = await f.service.execute('write_state_get', { machine_id: machine }, context())
      const c = await confirmed(
        f.service,
        { action: 'device_rename', target: { machine_id: machine }, name: 'owned_history_changed' },
        state.resource_revision
      )
      const first = await f.service.execute(
        'devices_rename',
        { ...c.write, machine_id: machine, name: 'owned_history_changed' },
        context()
      )
      const scope = {
        request_id: c.write.request_id,
        history_epoch: c.write.history_epoch,
        recovery_generation: c.write.recovery_generation
      }
      const history = await f.service.execute('history_open', {}, context())
      f.advance(60_000)
      assert.deepEqual(await f.service.execute('history_open', {}, context()), history)
      f.admin = { ...f.admin!, session_ref: 'fixture_other_session' }
      await assert.rejects(
        f.service.execute('operations_get', scope, { ...context(), management_session_ref: 'fixture_other_session' }),
        /management_history_unavailable/
      )
      f.admin = { ...f.admin!, session_ref: 'fixture_session' }
      f.advance(240_000)
      assert.deepEqual(await f.service.execute('operations_get', scope, context()), first)
      assert.deepEqual(
        await f.service.execute(
          'devices_rename',
          { ...c.write, machine_id: machine, name: 'owned_history_changed' },
          context()
        ),
        first
      )
      await assert.rejects(
        f.service.execute('confirmations_create', { ...c.draft, request_id: 'new_intent' }, context()),
        /management_history_unavailable/
      )
      await assert.rejects(
        f.service.execute('operations_get', { ...scope, history_epoch: 'missing_history' }, context()),
        /management_history_unavailable/
      )
    } finally {
      f.close()
    }
  }
)

test(
  '备份快照不携带有效确认/回执范围，且使用新的恢复 generation',
  /** 由现有Store备份生成快照库，不手改库来冒充生产恢复流程。 */ async () => {
    const root = mkdtempSync(join(tmpdir(), 'rovloom-management-snapshot-'))
    const path = join(root, 'snapshot.sqlite')
    const f = setup(undefined, { backupDirectory: root, management })
    try {
      const history = await f.service.execute('history_open', {}, context())
      f.store.backup(path)
      const snapshot = new Store(path)
      try {
        assert.notEqual(snapshot.generation(), history.recovery_generation)
      } finally {
        snapshot.close()
      }
      const db = new DatabaseSync(path)
      try {
        assert.equal(db.prepare('SELECT COUNT(*) n FROM admin_history').get()!.n, 0)
        assert.equal(db.prepare('SELECT COUNT(*) n FROM admin_confirmations').get()!.n, 0)
      } finally {
        db.close()
      }
    } finally {
      f.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  '未发布v4数据库先于业务修改无损拒绝',
  /** schema升级不迁移或覆盖已有用户文件。 */ () => {
    const root = mkdtempSync(join(tmpdir(), 'rovloom-management-old-schema-'))
    const path = join(root, 'old.sqlite')
    try {
      const db = new DatabaseSync(path)
      db.exec('CREATE TABLE metadata(version INTEGER); INSERT INTO metadata VALUES(4)')
      db.close()
      chmodSync(path, 0o600)
      // Store要求文件仅属本用户可读写，测试文件不包含任何真实用户状态。
      const before = readFileSync(path)
      assert.throws(
        /** 应先识别旧版本，绝不执行新schema或业务更新。 */ () => new Store(path),
        /unsupported_database_version/
      )
      assert.deepEqual(readFileSync(path), before)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  'provider启用仅接受显式可信接线，新revision不复活旧确认或其它provider',
  /** 这里只验证宿主端口和原子fence，true回调是合成证明而非原生来源。 */ async () => {
    const f = setup(undefined, { management })
    try {
      const machine = f.store.register('owned_enable').machine_id
      f.store.defineProvider({
        machine_id: machine,
        provider_id: 'one',
        kind: 'luvus',
        config_ref: 'fixture',
        enabled: false,
        binding_revision: 1
      })
      f.store.defineProvider({
        machine_id: machine,
        provider_id: 'two',
        kind: 'herdr',
        config_ref: 'fixture',
        enabled: true,
        binding_revision: 1
      })
      f.grant({ action: 'providers_manage', machine_id: machine, provider_id: 'one' })
      const service = new StoreManagementWriteService({
        store: f.store,
        identities: f.identities,
        transport: { /** 本fixture没有活socket，资源作用域另有双Connector测试。 */ refresh() {} },
        /** 只为本fixture精确目标和旧revision给出短期合成证明。 */ providerEnable: (target, revision) =>
          target.machine_id === machine &&
          target.provider_id === 'one' &&
          revision === 1 &&
          f.store.provider(machine, 'one')?.enabled === false
      })
      const operation = {
        action: 'provider_enable' as const,
        target: { machine_id: machine, provider_id: 'one', kind: 'luvus' as const },
        expected_binding_revision: 1
      }
      const c = await confirmed(service, operation, 1)
      const args = { ...c.write, ...operation.target, expected_binding_revision: 1 }
      const receipt = await service.execute('providers_enable', args, context())
      assert.equal(receipt.new_binding_revision, 2)
      assert.equal(receipt.effects.provider, 'enabled')
      // 已消费证明即使不再满足启用前条件，重复请求仍只取同一持久回执。
      assert.deepEqual(await service.execute('providers_enable', args, context()), receipt)
      assert.equal(f.store.provider(machine, 'one')!.binding_revision, 2)
      assert.equal(f.store.provider(machine, 'two')!.binding_revision, 1)
      await assert.rejects(
        confirmed(service, { ...operation, target: { ...operation.target, provider_id: 'two', kind: 'herdr' } }, 1),
        /forbidden/
      )
    } finally {
      f.close()
    }
  }
)
