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
        readiness: 'not_checked',
        stopMode: platform === 'win32' ? 'task_termination' : 'signal_then_kill'
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
      assert.equal((await manager.execute({ action: 'uninstall', role: spec.role })).state, 'absent')
      assert(m.calls.lastIndexOf('disable') < m.calls.lastIndexOf('stop'))
      assert(m.calls.lastIndexOf('stop') < m.calls.lastIndexOf('remove'))
      assert.equal((await manager.execute({ action: 'uninstall', role: spec.role })).changed, false)
      assert.equal((await manager.execute({ action: 'stop', role: spec.role })).state, 'absent')
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
  'failed stop disables boot and keeps registration; restart never starts a second instance',
  /* 模拟停止超时，保留可检查的注册且不继续删除或重启。 */ async () => {
    const m = model()
    const spec = sampleSpec()
    m.set({ spec, enabled: true, state: 'running' })
    m.stuck.add('stop')
    const manager = new ServiceManager(m.backend, m.clock)
    await assert.rejects(
      /* 无法停止时不能删除注册。 */ () => manager.execute({ action: 'uninstall', role: 'connector' }),
      { code: 'service_timeout' }
    )
    assert.equal(m.get()?.enabled, false)
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
