// macOS服务身份、只读自检计划及禁自启重启保护；真实系统服务不注册、不加载、不改权限。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { userInfo } from 'node:os'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { serviceAccountConfig, assertServiceProduct, verifyProductServiceRuntime } from '../../src/cli/service-host.js'
import { configDocument, configTemplate } from '../../src/cli/config.js'
import { sampleSpec, model } from './helpers.js'
import { ServiceManager } from '../../src/service/manager.js'

const account =
  'name: rovloom\npassword: *\nuid: 501\ngid: 20\ndir: /Users/服务\nshell: /usr/bin/false\ngecos: Service User\n'
test(
  'Darwin系统账户记录决定共享角色路径，歧义或root不回退HOME',
  /* 纯记录模型不查询系统身份。 */ () => {
    assert.equal(
      serviceAccountConfig('gateway', 'rovloom', /* 合成单条系统记录。 */ () => account, 'darwin'),
      '/Users/服务/.config/rovloom/gateway.json'
    )
    for (const text of [
      account.replace('uid: 501', 'uid: 0'),
      account + 'dir: /other',
      account.replace('name: rovloom', 'name: other'),
      account.replace('dir: /Users/服务', 'dir: relative')
    ]) {
      assert.throws(
        /* 错误来源不选择管理员默认配置。 */ () =>
          serviceAccountConfig('gateway', 'rovloom', /* 当前反例记录。 */ () => text, 'darwin'),
        { code: 'config_path_required' }
      )
    }
    const spec = { ...sampleSpec('darwin'), role: 'gateway' as const }
    assertServiceProduct(spec, { platform: 'darwin', arch: 'arm64', executable: spec.executable, standalone: true })
    assert.throws(
      /* macOS纯Gateway不扩大本机native Connector能力。 */ () =>
        assertServiceProduct(
          { ...spec, role: 'connector' },
          { platform: 'darwin', arch: 'x64', executable: spec.executable, standalone: true }
        ),
      { code: 'backend_unavailable' }
    )
  }
)

test(
  'Darwin已撤自启的restart在停止前拒绝，原实例保持运行',
  /* launchctl disable覆盖不能在bootout后bootstrap。 */ async () => {
    const m = model('darwin')
    m.set({ spec: sampleSpec('darwin'), enabled: false, loaded: true, state: 'running' })
    await assert.rejects(
      /* 不能先破坏当前实例才发现重载不可行。 */ () =>
        new ServiceManager(m.backend, m.clock).execute({ action: 'restart', role: 'connector' }),
      { code: 'service_busy' }
    )
    assert.equal(m.get()?.state, 'running')
    assert(!m.calls.includes('stop'))
    assert(!m.calls.includes('start'))
  }
)

if (process.platform !== 'win32' && process.getuid?.() !== 0) {
  test(
    'Darwin自检以固定非交互sudo降为目标账户，只读同一产物且不开业务宿主',
    /* 仅观察受控命令计划；当前平台的fd ACL检查仍实际执行。 */ async () => {
      const root = mkdtempSync(join(process.cwd(), '.service-macos-'))
      const state = join(root, 'state')
      mkdirSync(state, { mode: 0o700 })
      const config = join(root, 'gateway.json')
      const spec = { ...sampleSpec('darwin'), role: 'gateway' as const, config, directory: root }
      const bytes = JSON.stringify(configDocument({ ...configTemplate('gateway'), state_dir: state }))
      writeFileSync(config, bytes, { mode: 0o600 })
      let called = 0
      try {
        await verifyProductServiceRuntime(
          spec,
          { platform: 'darwin', arch: 'arm64', executable: spec.executable, standalone: true },
          /* 不运行sudo或任何服务工具。 */ async (plan) => {
            called++
            assert.equal(plan.executable, '/usr/bin/sudo')
            assert.deepEqual(plan.args, [
              '-n',
              '-H',
              '-u',
              'rovloom',
              '--',
              spec.executable,
              'config',
              'check-runtime',
              '--role',
              'gateway',
              '--config',
              config
            ])
            assert.equal(plan.input, undefined)
            return { code: 0, stdout: '', stderr: 'runtime_config_valid\n' }
          },
          /* 模型仅跳过root拥有路径的生产前提，不改真实文件权限。 */ async () => {}
        )
        assert.equal(called, 1)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
}

if (process.platform === 'darwin') {
  test(
    'Darwin实际只读账户查询解析当前非root账户home',
    /* 只使用已有CI账户，不创建用户或改变权限。 */ () => {
      const user = userInfo()
      assert(user.uid > 0)
      assert.equal(
        serviceAccountConfig('gateway', user.username),
        join(user.homedir, '.config', 'rovloom', 'gateway.json')
      )
      assert.equal(execFileSync('/usr/bin/id', ['-u', user.username], { encoding: 'utf8' }).trim(), String(user.uid))
    }
  )
}
