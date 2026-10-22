/** 用已发布 v0.1.1 schema 建旧库，经实际生产 CLI 打开，拒绝迁移且提供可操作的安全诊断。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { SCHEMA, SCHEMA_VERSION } from '../fixtures/storage/v0.1.1/schema.js'
import { configDocument, configTemplate, type GatewayConfig } from '../../src/cli/config.js'
import { createProductionCliRuntime } from '../../src/cli/production.js'
import { runCli } from '../../src/cli/run.js'
import { Store } from '../../src/store.js'
import { DatabaseVersionError, DATABASE_UPGRADE_URL } from '../../src/storage/version.js'

for (const version of [5, 'sensitive-invalid-version'] as const) {
  test('old schema refusal is actionable and never prints arbitrary database values: ' + typeof version, async () => {
    const root = mkdtempSync(join(tmpdir(), 'rovloom-upgrade-'))
    const database = join(root, 'gateway.db')
    try {
      assert.equal(SCHEMA_VERSION, 5)
      assert.equal(
        createHash('sha256')
          .update(readFileSync(new URL('../fixtures/storage/v0.1.1/schema.ts', import.meta.url)))
          .digest('hex'),
        '7e8430019cc67a57e86782efe28c77e1ade341aca3a23c98fc0b50e45a17b120'
      )
      const old = new DatabaseSync(database)
      old.exec(SCHEMA)
      old.prepare('INSERT INTO metadata VALUES(1,?,?,?,?)').run(version, 'old_generation', 'active', 1000)
      old.close()
      chmodSync(database, 0o600)
      const before = readFileSync(database)
      assert.throws(
        /** 打开失败保留结构化本地类型。 */ () => new Store(database),
        (error: unknown) => {
          assert(error instanceof DatabaseVersionError)
          assert.equal(error.found, typeof version === 'number' ? version : null)
          assert.equal(error.expected, 6)
          return true
        }
      )
      const config = { ...configTemplate('gateway'), state_dir: root, management_enabled: false } as GatewayConfig
      const configPath = join(root, 'gateway.json')
      writeFileSync(configPath, JSON.stringify(configDocument(config)), { mode: 0o600 })
      const out = new PassThrough()
      const err = new PassThrough()
      let stdout = ''
      let stderr = ''
      out.on(
        'data',
        /** 仅收集本用例 CLI 输出。 */ (data) => {
          stdout += data.toString()
        }
      )
      err.on(
        'data',
        /** 只断言固定数字和文档链接。 */ (data) => {
          stderr += data.toString()
        }
      )
      const code = await runCli(
        ['gateway', '--config', configPath, '--non-interactive'],
        {
          stdin: new PassThrough(),
          stdout: out,
          stderr: err,
          signal: new AbortController().signal
        },
        createProductionCliRuntime()
      )
      assert.equal(code, 3)
      assert.equal(stdout, '')
      assert.equal(
        stderr,
        `unsupported_database_version found_schema=${typeof version === 'number' ? version : 'unknown'} expected_schema=6 upgrade=${DATABASE_UPGRADE_URL}\n`
      )
      assert.equal(stderr.includes('sensitive'), false)
      assert.equal(stderr.includes(root), false)
      assert.deepEqual(readFileSync(database), before)
      assert.equal(existsSync(database + '.lock'), false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}
