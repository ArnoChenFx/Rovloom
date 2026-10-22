/** 显式初始化沿用真实独占文件发布，不启动角色、不读取stdin或生成配对身份。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { runCli } from '../../src/cli/run.js'
import { configDocument, readConfig } from '../../src/cli/config.js'

/** 每次只使用当前测试 home；未提供任何角色宿主，误启动会返回失败。 */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'rovloom-config-init-'))
  return {
    home,
    path: (role: string) => join(home, '.config', 'rovloom', role + '.json'),
    async run(...args: string[]) {
      const out = new PassThrough()
      const err = new PassThrough()
      let stdout = ''
      let stderr = ''
      out.on(
        'data',
        /** 收集本例输出。 */ (value) => {
          stdout += value.toString()
        }
      )
      err.on(
        'data',
        /** 诊断只保留稳定代码。 */ (value) => {
          stderr += value.toString()
        }
      )
      const code = await runCli(
        args,
        { stdin: new PassThrough(), stdout: out, stderr: err, signal: new AbortController().signal },
        {},
        { home, platform: process.platform }
      )
      return { code, stdout, stderr }
    },
    close: /** 删除本用例生成的配置。 */ () => rmSync(home, { recursive: true, force: true })
  }
}

for (const provider of ['luvus', 'herdr', 'mixed']) {
  test('explicit provider initializes without Ctrl-C, running a role or editing JSON: ' + provider, async () => {
    const f = fixture()
    try {
      assert.deepEqual(await f.run('config', 'init', 'connector', '--provider', provider), {
        code: 0,
        stdout: '',
        stderr: 'config_ready\n'
      })
      const config = readConfig(f.path('connector'))
      assert.equal(config.role, 'connector')
      assert.equal(config.role === 'connector' && config.native?.provider, provider)
      assert.equal(existsSync(config.state_dir), false)
      const before = readFileSync(f.path('connector'))
      assert.equal((await f.run('config', 'init', 'connector', '--provider', provider)).code, 0)
      assert.deepEqual(readFileSync(f.path('connector')), before)
      const other = provider === 'herdr' ? 'luvus' : 'herdr'
      assert.equal((await f.run('config', 'init', 'connector', '--provider', other)).stderr, 'config_exists\n')
      assert.deepEqual(readFileSync(f.path('connector')), before)
    } finally {
      f.close()
    }
  })
}

test('container initialization selects container listeners explicitly while normal startup defaults remain local', async () => {
  const f = fixture()
  try {
    assert.equal((await f.run('config', 'init', 'gateway')).code, 0)
    const local = readConfig(f.path('gateway'))
    assert.equal(local.role === 'gateway' && local.mcp_hostname, '127.0.0.1')
    const before = readFileSync(f.path('gateway'))
    assert.equal((await f.run('config', 'init', 'gateway', '--container')).stderr, 'config_exists\n')
    assert.deepEqual(readFileSync(f.path('gateway')), before)
    const explicit = join(f.home, 'container.json')
    assert.equal((await f.run('config', 'init', 'gateway', '--container', '--config', explicit)).code, 0)
    const container = readConfig(explicit)
    assert.equal(container.role, 'gateway')
    if (container.role !== 'gateway') {
      assert.fail('wrong_role')
    }
    assert.deepEqual(
      [container.mcp_hostname, container.device_hostname, container.management_hostname],
      ['0.0.0.0', '0.0.0.0', '0.0.0.0']
    )
    assert.equal(container.state_dir, local.state_dir)
    assert.equal(existsSync(container.state_dir), false)
    assert.equal((await f.run('config', 'init', 'gateway', '--container', '--config', explicit)).code, 0)
  } finally {
    f.close()
  }
})

test('invalid initialization flags and corrupt existing files never overwrite configuration', async () => {
  const f = fixture()
  try {
    for (const args of [
      ['connector', '--container'],
      ['gateway', '--provider', 'herdr'],
      ['connector', '--provider', 'unknown'],
      ['connector', '--provider'],
      ['gateway', '--container', '--container'],
      ['gateway', '--unknown', 'secret']
    ]) {
      assert.equal((await f.run('config', 'init', ...args)).stderr, 'invalid_arguments\n')
      assert.equal(existsSync(join(f.home, '.config')), false)
    }
    await f.run('config', 'init', 'connector', '--provider', 'herdr')
    const config = readConfig(f.path('connector'))
    writeFileSync(f.path('connector'), JSON.stringify({ ...configDocument(config), private_unknown: true }))
    const before = readFileSync(f.path('connector'))
    assert.equal((await f.run('config', 'init', 'connector', '--provider', 'herdr')).stderr, 'invalid_config\n')
    assert.deepEqual(readFileSync(f.path('connector')), before)
  } finally {
    f.close()
  }
})
