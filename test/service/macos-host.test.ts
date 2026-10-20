// macOS服务身份、只读自检计划及禁自启重启保护；真实系统服务不注册、不加载、不改权限。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { assertServiceProduct, verifyProductServiceRuntime } from '../../src/cli/service-host.js'
import { configDocument, configTemplate } from '../../src/cli/config.js'
import { sampleSpec, model } from './helpers.js'
import { ServiceManager } from '../../src/service/manager.js'

test(
  'Darwin只接通Gateway服务，不扩大本机Connector能力',
  /* 纯能力检查不解析另一账户的home。 */ () => {
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
  'Darwin撤自启后仍可重启，且不暗中恢复开机策略',
  /* loaded job的正常restart保留禁用自启状态，不先bootout。 */ async () => {
    const m = model('darwin')
    m.set({ spec: sampleSpec('darwin'), enabled: false, loaded: true, state: 'running' })
    const result = await new ServiceManager(m.backend, m.clock).execute({ action: 'restart', role: 'connector' })
    assert.equal(result.state, 'running')
    assert.equal(result.bootEnabled, false)
    assert(m.calls.includes('stop'))
    assert(m.calls.includes('start'))
    assert(!m.calls.includes('enable'))
  }
)

test(
  'Darwin服务普通检查保留配置并允许缺失状态目录，不运行sudo或ACL验证',
  /* 仅验证普通JSON/角色读取，不创建业务宿主或提前初始化数据。 */ async () => {
    const root = mkdtempSync(join(process.cwd(), '.service-macos-'))
    const state = join(root, 'state-not-created')
    const config = join(root, 'gateway.json')
    const spec = { ...sampleSpec('darwin'), role: 'gateway' as const, config, directory: root }
    const bytes = JSON.stringify(configDocument({ ...configTemplate('gateway'), state_dir: state }))
    writeFileSync(config, bytes, { mode: 0o644 })
    try {
      await verifyProductServiceRuntime(spec, {
        platform: 'darwin',
        arch: 'arm64',
        executable: spec.executable,
        standalone: true
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)
