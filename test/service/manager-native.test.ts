// 通过原生后端的受控 runner 验证 Windows 自启与运行实例独立，绝不执行 PowerShell 或注册系统任务。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ServiceManager } from '../../src/service/manager.js'
import { createNativeServiceBackend } from '../../src/service/native.js'
import { manifest } from '../../src/service/spec.js'
import type { RegistrationFiles } from '../../src/service/files.js'
import type { CommandRunner } from '../../src/service/runner.js'
import { sampleSpec } from './helpers.js'

test(
  'Windows uninstall updates boot only, reinstall preserves instance, explicit stop cleans up later',
  /* 用真实 manager 与 native 后端组合核对操作序列，不把模型作为 Windows 实测。 */ async () => {
    const spec = sampleSpec('win32')
    let present = true
    let boot = true
    let instances = 1
    const operations: string[] = []
    const files: RegistrationFiles = {
      verify: /* 内存控制目录无系统副作用。 */ async () => {},
      read: /* Windows 任务由受控 COM runner 模拟。 */ async () => undefined,
      create: /* 任务注册不写 POSIX 文件。 */ async () => assert.fail(),
      remove: /* 任务删除不走文件删除端口。 */ async () => assert.fail(),
      lock: /* 此处只测组合命令计划，独占文件锁另有真实临时目录测试。 */ async (_name, f) => f()
    }
    const runner: CommandRunner = /* 明确模拟所有 COM 返回，记录请求；从不启动实际原生工具。 */ async (p) => {
      const data = JSON.parse(p.input!)
      operations.push(data.op)
      let response: object
      if (data.op === 'authorize') {
        response = { ok: true }
      } else if (data.op === 'read') {
        response = present ? { marker: manifest(spec) } : { absent: true }
      } else {
        if (data.op === 'enable') {
          boot = data.enabled
        }
        if (data.op === 'stop') {
          instances = 0
        }
        if (data.op === 'remove') {
          assert.equal(instances, 0)
          assert.equal(boot, false)
          present = false
        }
        response = present ? { state: instances ? 4 : 3, instances, enabled: boot, exitCode: 0 } : { absent: true }
      }
      return { code: 0, stdout: JSON.stringify(response), stderr: '' }
    }
    const backend = createNativeServiceBackend({
      platform: 'win32',
      files,
      runner,
      verifyRuntime: /* 模拟已核验后台宿主。 */ async () => {},
      verifyWindowsInstallation: /* 模拟 ACL 证明端口，不修改真实 ACL。 */ async () => {}
    })
    const manager = new ServiceManager(backend)
    const removed = await manager.execute({ action: 'uninstall', role: 'connector' })
    assert.equal(removed.state, 'running')
    assert.equal(removed.bootEnabled, false)
    assert.equal(removed.controlRetained, true)
    assert.equal(removed.stopMode, 'not_requested')
    assert.equal(instances, 1)
    assert(!operations.includes('stop') && !operations.includes('remove'))
    assert.equal((await manager.execute({ action: 'uninstall', role: 'connector' })).changed, false)
    await manager.execute({ action: 'install', role: 'connector', spec })
    assert.equal(boot, true)
    assert.equal(instances, 1)
    assert(!operations.includes('start') && !operations.includes('stop'))
    await manager.execute({ action: 'uninstall', role: 'connector' })
    assert.equal((await manager.execute({ action: 'stop', role: 'connector' })).state, 'absent')
    assert.equal(operations.filter(/* 全程只有用户明确发出的一次 stop。 */ (op) => op === 'stop').length, 1)
    assert.equal((await manager.execute({ action: 'uninstall', role: 'connector' })).changed, false)
  }
)
