/** Gateway schema 的跨 POSIX 私有来源回归；只编译公开 fixture，不建立 native 安装或真实凭据。 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHerdrGatewayResources } from '../../../src/connector/herdr/provider.js'
import { raw, source } from './helpers.js'

/** Gateway 测试使用真实系统临时根；macOS 的系统别名只在创建 fixture 前规范化。 */
function schemaFixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'rovloom-gateway-schema-'))
  const schema = join(root, 'schema.json')
  writeFileSync(schema, raw, { mode: 0o600 })
  return {
    root,
    schema,
    config: {
      version: 1,
      target: { machine_id: 'owned-machine', provider_id: 'herdr', profile: 'session', session: 'owned' },
      binding_revision: 1,
      config_ref: 'owned-herdr',
      expected_source: source,
      schema_path: schema,
      peer_policy_revision: 'local1'
    }
  }
}

test(
  'Gateway schema uses POSIX private storage and keeps replacement, permission and symlink changes fenced',
  { skip: process.platform === 'win32' },
  /** 在真实 fd 与文件系统上改变来源，不伪造平台或替换存储校验器。 */ async () => {
    for (const mutation of ['replacement', 'permissions', 'symlink']) {
      const fixture = schemaFixture()
      let resources: Awaited<ReturnType<typeof createHerdrGatewayResources>> | undefined
      try {
        resources = await createHerdrGatewayResources({ config: fixture.config })
        assert.equal(resources.describe().source_basis, 'configured_connector_contract')
        const ready = resources.providers[0]!.ready!
        assert.equal(ready(), true)
        if (mutation === 'replacement') {
          const replacement = join(fixture.root, 'replacement.json')
          writeFileSync(replacement, raw, { mode: 0o600 })
          renameSync(replacement, fixture.schema)
          assert.throws(ready, /herdr_provider_file_changed/)
        } else if (mutation === 'permissions') {
          chmodSync(fixture.schema, 0o644)
          assert.throws(ready, /unsafe_storage_file/)
          chmodSync(fixture.schema, 0o600)
          assert.throws(ready, /herdr_provider_file_changed/)
        } else {
          const original = join(fixture.root, 'original.json')
          renameSync(fixture.schema, original)
          symlinkSync(original, fixture.schema)
          assert.throws(ready, /unsafe_storage_file/)
        }
        assert.throws(/** 公共描述也必须重新验证固定来源，不能只在 readiness 处撤销。 */ () => resources!.describe())
      } finally {
        await resources?.release()
        rmSync(fixture.root, { recursive: true, force: true })
      }
    }
  }
)

test(
  'Gateway schema rejects links, public permissions and invalid size before compilation',
  { skip: process.platform === 'win32' },
  /** 反例都使用原始官方 pin，不能依靠 hash 不匹配掩盖文件边界缺失。 */ async () => {
    const fixture = schemaFixture()
    try {
      const linked = join(fixture.root, 'linked.json')
      symlinkSync(fixture.schema, linked)
      await assert.rejects(
        createHerdrGatewayResources({ config: { ...fixture.config, schema_path: linked } }),
        /unsafe_storage_file/
      )
      const alias = join(fixture.root, 'alias')
      symlinkSync(fixture.root, alias)
      await assert.rejects(
        createHerdrGatewayResources({ config: { ...fixture.config, schema_path: join(alias, 'schema.json') } }),
        /unsafe_storage_path/
      )
      chmodSync(fixture.schema, 0o644)
      await assert.rejects(createHerdrGatewayResources({ config: fixture.config }), /unsafe_storage_file/)
      chmodSync(fixture.schema, 0o600)
      chmodSync(fixture.root, 0o755)
      await assert.rejects(
        createHerdrGatewayResources({ config: fixture.config }),
        /private_storage_directory_required/
      )
      chmodSync(fixture.root, 0o700)
      truncateSync(fixture.schema, 0)
      await assert.rejects(createHerdrGatewayResources({ config: fixture.config }), /herdr_provider_file_invalid/)
      truncateSync(fixture.schema, 16_777_217)
      await assert.rejects(createHerdrGatewayResources({ config: fixture.config }), /herdr_provider_file_invalid/)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  }
)

test(
  'Gateway compilation rejects a same-byte schema replacement while awaiting the real compiler',
  { skip: process.platform === 'win32' },
  /** 在工厂首次同步读取后立即替换 inode，真实 Worker 完成仍不能发布旧来源。 */ async () => {
    const fixture = schemaFixture()
    try {
      const pending = createHerdrGatewayResources({ config: fixture.config })
      const replacement = join(fixture.root, 'replacement.json')
      writeFileSync(replacement, raw, { mode: 0o600 })
      renameSync(replacement, fixture.schema)
      await assert.rejects(pending, /herdr_provider_file_changed/)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  }
)

if (process.platform === 'darwin') {
  test(
    'macOS Gateway schema rejects an actual ACL grant even when mode remains 0600',
    /** 只给自有 fixture 添加读取 ACL；初读与后续来源复核都必须走实际 fd ACL。 */ async () => {
      const fixture = schemaFixture()
      let resources: Awaited<ReturnType<typeof createHerdrGatewayResources>> | undefined
      try {
        resources = await createHerdrGatewayResources({ config: fixture.config })
        const grant = spawnSync('/bin/chmod', ['+a', 'everyone allow read', fixture.schema], { encoding: 'utf8' })
        assert.equal(grant.status, 0, grant.stderr)
        assert.equal(statSync(fixture.schema).mode & 0o777, 0o600)
        assert.throws(resources.providers[0]!.ready!, /unsafe_storage_acl/)
        await assert.rejects(createHerdrGatewayResources({ config: fixture.config }), /unsafe_storage_acl/)
      } finally {
        await resources?.release()
        rmSync(fixture.root, { recursive: true, force: true })
      }
    }
  )
}
