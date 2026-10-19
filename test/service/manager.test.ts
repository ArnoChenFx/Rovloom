// 验证三平台统一生命周期、幂等与失败保守语义；本文件不安装真实服务。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ServiceManager } from '../../src/service/manager.js'
import { ServiceError, type ServicePlatform } from '../../src/service/types.js'
import { model, sampleSpec } from './helpers.js'

for (const platform of ['linux', 'darwin', 'win32'] as ServicePlatform[]) {
  test(
    `${platform}: install registers boot only, repeated operations converge without duplicating instances`,
    /* 检查开机注册与运行分离以及所有幂等分支。 */ async () => {
      const m = model(platform)
      const manager = new ServiceManager(m.backend, m.clock)
      const spec = sampleSpec(platform)
      const install = { action: 'install' as const, role: spec.role, spec }
      assert.deepEqual(await manager.execute(install), {
        action: 'install',
        role: 'connector',
        changed: true,
        state: 'stopped',
        bootEnabled: true,
        controlRetained: true,
        readiness: 'not_checked',
        stopMode: 'not_requested'
      })
      assert(!m.calls.includes('start'))
      assert.equal((await manager.execute(install)).changed, false)
      assert.equal((await manager.execute({ action: 'stop', role: spec.role })).changed, false)
      assert.equal((await manager.execute({ action: 'start', role: spec.role })).state, 'running')
      assert.equal((await manager.execute({ action: 'start', role: spec.role })).changed, false)
      assert.equal((await manager.execute(install)).state, 'running')
      const starts = m.calls.filter(/* 计数启动次数，重复 start/install 不得产生新实例。 */ (x) => x === 'start').length
      assert.equal(starts, 1)
      await manager.execute({ action: 'restart', role: spec.role })
      assert(m.calls.lastIndexOf('stop') < m.calls.lastIndexOf('start'))
      const beforeUninstall = m.calls.length
      const removed = await manager.execute({ action: 'uninstall', role: spec.role })
      assert.equal(removed.state, 'running')
      assert.equal(removed.bootEnabled, false)
      assert.equal(removed.controlRetained, true)
      assert.equal(removed.stopMode, 'not_requested')
      assert(!m.calls.slice(beforeUninstall).includes('stop'))
      assert(!m.calls.slice(beforeUninstall).includes('remove'))
      assert.equal((await manager.execute({ action: 'uninstall', role: spec.role })).changed, false)
      assert.equal((await manager.execute({ action: 'stop', role: spec.role })).state, 'absent')
      assert.equal((await manager.execute({ action: 'uninstall', role: spec.role })).changed, false)
      await assert.rejects(/* 未安装角色不能隐式安装。 */ () => manager.execute({ action: 'start', role: spec.role }), {
        code: 'service_not_installed'
      })
      await assert.rejects(/* 重启也不能隐式安装。 */ () => manager.execute({ action: 'restart', role: spec.role }), {
        code: 'service_not_installed'
      })
    }
  )
}

test(
  'different reinstall, unsupported runtime and permission failures do not mutate registration',
  /* 检查危险安装在任何注册修改前失败。 */ async () => {
    const m = model()
    const manager = new ServiceManager(m.backend, m.clock)
    const spec = sampleSpec()
    await manager.execute({ action: 'install', role: 'connector', spec })
    m.calls.length = 0
    await assert.rejects(
      /* 不允许借同名安装重绑配置。 */ () =>
        manager.execute({ action: 'install', role: 'connector', spec: { ...spec, config: '/other/config' } }),
      { code: 'service_conflict' }
    )
    assert(!m.calls.includes('create') && !m.calls.includes('enable'))
    m.failures.add('preflight')
    await assert.rejects(
      /* 运行能力不足不修改已经注册的服务。 */ () => manager.execute({ action: 'install', role: 'connector', spec }),
      { nativeExitCode: 73 }
    )
    m.failures.clear()
    m.failures.add('authorize')
    m.calls.length = 0
    await assert.rejects(
      /* 权限失败不得触发后续读取或状态修改。 */ () => manager.execute({ action: 'uninstall', role: 'connector' })
    )
    assert.deepEqual(m.calls, ['authorize'])
  }
)

test(
  'uninstall never calls a failing stop; explicit stop/restart still preserve the instance on timeout',
  /* 撤销自启独立于停止能力；显式停止失败时仍保留受保护控制记录。 */ async () => {
    const m = model()
    const spec = sampleSpec()
    m.set({ spec, enabled: true, state: 'running' })
    m.stuck.add('stop')
    const manager = new ServiceManager(m.backend, m.clock)
    assert.equal((await manager.execute({ action: 'uninstall', role: 'connector' })).state, 'running')
    assert.equal(m.get()?.enabled, false)
    assert(!m.calls.includes('stop') && !m.calls.includes('remove'))
    await assert.rejects(
      /* 只有显式停止命令会等待停止并报告超时。 */ () => manager.execute({ action: 'stop', role: 'connector' }),
      { code: 'service_timeout' }
    )
    assert.equal(m.get()?.state, 'running')
    assert(!m.calls.includes('remove'))
    await assert.rejects(
      /* 重启必须先等旧实例退出。 */ () => manager.execute({ action: 'restart', role: 'connector' }),
      { code: 'service_timeout' }
    )
    assert(!m.calls.includes('start'))
  }
)

test(
  'start observes failure, early exit, timeout and concurrent mutation instead of accepting tool success',
  /* 检查请求成功不等于进程稳定运行。 */ async () => {
    const m = model()
    const spec = sampleSpec()
    m.set({ spec, enabled: true, state: 'stopped' })
    m.stuck.add('start')
    const manager = new ServiceManager(m.backend, m.clock)
    await assert.rejects(
      /* 立即退出的进程不能报告运行成功。 */ () => manager.execute({ action: 'start', role: 'connector' }),
      { code: 'service_start_failed' }
    )
    m.backend.start = /* 模拟进程明确非零退出。 */ async () => {
      m.set({ spec, state: 'failed', enabled: true, exitCode: 42 })
    }
    await assert.rejects(
      /* 保留受信内部退出码但不输出底层原文。 */ () => manager.execute({ action: 'start', role: 'connector' }),
      { code: 'service_start_failed', nativeExitCode: 42 }
    )
    m.backend.start = /* 模拟外部管理员在启动期间替换注册。 */ async () => {
      m.set({ spec: { ...spec, config: '/other/config' }, state: 'running', enabled: true })
    }
    await assert.rejects(
      /* 等待期间变更身份必须停止控制。 */ () => manager.execute({ action: 'start', role: 'connector' }),
      { code: 'service_conflict' }
    )
  }
)

test(
  'partial install can converge and role lock spans asynchronous state observation',
  /* 验证启用失败后的重试与同角色并发拒绝。 */ async () => {
    const m = model()
    const spec = sampleSpec()
    const manager = new ServiceManager(m.backend, m.clock)
    m.failures.add('enable')
    await assert.rejects(
      /* 首次只创建成功但未完成启用。 */ () => manager.execute({ action: 'install', role: 'connector', spec })
    )
    assert(m.get())
    m.failures.clear()
    await manager.execute({ action: 'install', role: 'connector', spec })
    assert.equal(m.calls.filter(/* 确认重复安装未再次创建。 */ (x) => x === 'create').length, 1)
    let release!: () => void
    const blocked = new Promise<void>(
      /* 保持第一次启动占有角色锁。 */ (resolve) => {
        release = resolve
      }
    )
    m.backend.start = /* 在模型启动中制造受控并发窗口。 */ async () => {
      await blocked
      m.get()!.state = 'running'
    }
    const first = manager.execute({ action: 'start', role: 'connector' })
    await Promise.resolve()
    await assert.rejects(
      /* 第二次状态转换必须由角色锁拒绝。 */ () => manager.execute({ action: 'uninstall', role: 'connector' }),
      { code: 'service_busy' }
    )
    release()
    await first
  }
)

test(
  'invalid direct API actions and mismatched role cannot reach system mutations',
  /* 公共 API 也拒绝绕过 parser 的非法输入。 */ async () => {
    const m = model()
    const manager = new ServiceManager(m.backend, m.clock)
    await assert.rejects(
      /* 未知动作不应落入停止分支。 */ () => manager.execute({ action: 'delete' as never, role: 'connector' }),
      ServiceError
    )
    await assert.rejects(
      /* 安装的清单角色必须与锁角色一致。 */ () =>
        manager.execute({ action: 'install', role: 'gateway', spec: sampleSpec() }),
      { code: 'invalid_arguments' }
    )
    assert(!m.calls.includes('create'))
  }
)

for (const platform of ['linux', 'darwin', 'win32'] as ServicePlatform[]) {
  test(
    `${platform}: reinstall restores boot without stopping; cleanup after exit keeps foreign protection`,
    /* 检查撤销自启后的重新安装、自然退出清理与身份保护。 */ async () => {
      const m = model(platform)
      const spec = sampleSpec(platform)
      const manager = new ServiceManager(m.backend, m.clock)
      m.set({ spec, enabled: true, state: 'running' })
      await manager.execute({ action: 'uninstall', role: spec.role })
      m.calls.length = 0
      const again = await manager.execute({ action: 'install', role: spec.role, spec })
      assert.equal(again.state, 'running')
      assert.equal(again.bootEnabled, true)
      assert(!m.calls.includes('stop') && !m.calls.includes('start') && !m.calls.includes('create'))
      await manager.execute({ action: 'uninstall', role: spec.role })
      m.get()!.state = 'stopped'
      const cleaned = await manager.execute({ action: 'uninstall', role: spec.role })
      assert.equal(cleaned.state, platform === 'linux' ? 'stopped' : 'absent')
      assert.equal(cleaned.controlRetained, platform === 'linux')
      assert(!m.calls.includes('stop'))
      if (platform === 'linux') {
        assert(!m.calls.includes('remove'))
        assert.equal((await manager.execute({ action: 'stop', role: spec.role })).state, 'absent')
      }
      m.set({ spec, enabled: false, state: 'stopped' })
      m.backend.remove = /* 模拟清理前发现同名异物，不允许删除它。 */ async () => {
        throw new ServiceError('service_conflict')
      }
      await assert.rejects(
        /* 外部替换后的记录必须保留供人工检查。 */ () =>
          manager.execute({ action: platform === 'linux' ? 'stop' : 'uninstall', role: spec.role }),
        { code: 'service_conflict' }
      )
      assert(m.get())
    }
  )
  test(
    `${platform}: starting and stopping instances keep control records when boot is revoked`,
    /* 尚在状态转换中的实例也不能被卸载路径中断或遗弃。 */ async () => {
      for (const state of ['starting', 'stopping'] as const) {
        const m = model(platform)
        const spec = sampleSpec(platform)
        m.set({ spec, enabled: true, state })
        const result = await new ServiceManager(m.backend, m.clock).execute({ action: 'uninstall', role: spec.role })
        assert.equal(result.state, state)
        assert.equal(result.bootEnabled, false)
        assert.equal(result.controlRetained, true)
        assert(!m.calls.includes('stop') && !m.calls.includes('remove'))
      }
    }
  )
}

test(
  'cleanup races retain current ownership and reobserve state instead of reporting absent',
  /* 已静止实例在清理前重新运行时只保留控制记录，不停止它或误报删除。 */ async () => {
    const m = model('darwin')
    const spec = sampleSpec('darwin')
    m.set({ spec, enabled: false, state: 'stopped' })
    m.backend.remove = /* 模拟原生监管器在安全检查时发现实例已经运行。 */ async () => {
      m.set({ spec, enabled: false, state: 'running' })
      return false
    }
    const result = await new ServiceManager(m.backend, m.clock).execute({ action: 'uninstall', role: 'connector' })
    assert.equal(result.state, 'running')
    assert.equal(result.controlRetained, true)
    assert.equal(result.stopMode, 'not_requested')
    assert(!m.calls.includes('stop'))
  }
)
