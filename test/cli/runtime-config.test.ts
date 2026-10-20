// 单文件配置与程序管理registry共用正式装配；旧runtime/ref输入不能改变运行参数。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configTemplate, readRuntimeConfig } from '../../src/cli/index.js'

test(
  'single user configuration supplies listeners without a runtime manifest',
  /* 只核对实际单文件解析和状态装配。 */ () => {
    const directory = mkdtempSync(join(tmpdir(), 'rovloom-managed-config-'))
    try {
      mkdirSync(join(directory, 'managed'), { mode: 0o700 })
      const config = { ...configTemplate('gateway'), state_dir: directory, device_port: 9333 }
      assert.equal(config.role, 'gateway')
      if (config.role !== 'gateway') {
        throw new Error('wrong fixture role')
      }
      writeFileSync(join(directory, 'runtime.json'), '{"secret":"SYNTHETIC_IGNORED_OLD_INPUT"}', { mode: 0o600 })
      const settings = readRuntimeConfig(config)
      assert.deepEqual(settings.device_listener, { hostname: '127.0.0.1', port: 9333 })
      assert.deepEqual(settings.providers, [])
      writeFileSync(
        join(directory, 'managed', 'providers.json'),
        JSON.stringify({
          schema_version: 1,
          role: 'gateway',
          providers: [{ reference: 'owned_provider', value: { kind: 'luvus' } }]
        }),
        { mode: 0o600 }
      )
      assert.deepEqual(readRuntimeConfig(config).providers, [{ reference: 'owned_provider', value: { kind: 'luvus' } }])
      writeFileSync(
        join(directory, 'managed', 'providers.json'),
        '{"schema_version":1,"role":"connector","providers":[]}',
        { mode: 0o600 }
      )
      assert.throws(/* 程序管理状态损坏必须拒绝。 */ () => readRuntimeConfig(config), { code: 'invalid_config' })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
