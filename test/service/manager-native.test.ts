// 通过受控 runner 验证 Windows 排队与 Linux 启动 Job、自启和运行控制的分离，不实际注册系统服务。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ServiceManager } from '../../src/service/manager.js'
import { createNativeServiceBackend } from '../../src/service/native.js'
import { manifest } from '../../src/service/spec.js'
import type { RegistrationFiles } from '../../src/service/files.js'
import type { CommandRunner } from '../../src/service/runner.js'
import { model, sampleSpec } from './helpers.js'
import { inspectTask } from '../../src/service/windows.js'
import { renderDefinition } from '../../src/service/render.js'

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

for (const action of ['start', 'restart'] as const) {
  test(
    `Windows ${action} cannot succeed while state is QUEUED with one enumerated instance`,
    /* 精确组合真实 Windows 状态映射与管理器等待逻辑，虚拟时间持续排队直到原超时。 */ async () => {
      const spec = sampleSpec('win32')
      const m = model('win32')
      let state = action === 'restart' ? 4 : 3
      let instances = action === 'restart' ? 1 : 0
      const runner: CommandRunner = /* 模拟官方允许的 QUEUED+Count=1，不调用真实 COM。 */ async (p) => ({
        code: 0,
        stdout: JSON.stringify(
          JSON.parse(p.input!).op === 'read'
            ? { marker: manifest(spec) }
            : { state, instances, enabled: true, exitCode: 0 }
        ),
        stderr: ''
      })
      m.backend.inspect = /* 使用真实映射，使错误的 Count 优先逻辑会提前返回 running 并使本测试失败。 */ async (role) =>
        inspectTask(runner, role)
      m.backend.stop = /* 模拟显式重启先停止已有实例。 */ async () => {
        state = 3
        instances = 0
      }
      m.backend.start = /* 启动请求已受理，但实例持续排队，不能冒充运行成功。 */ async () => {
        state = 2
        instances = 1
      }
      await assert.rejects(
        /* 原有稳定运行观测与 30 秒预算保持不变。 */ () =>
          new ServiceManager(m.backend, m.clock).execute({ action, role: 'connector' }),
        { code: 'service_start_failed' }
      )
      assert.equal(m.clock.now(), 30000)
      assert.equal(state, 2)
      assert.equal(instances, 1)
    }
  )
}

for (const scenario of ['waiting_dependency', 'unlink_window_start', 'idle', 'stop_job_not_canceled'] as const) {
  test(
    `Linux uninstall retains its declaration through ${scenario}; explicit stop cancels before cleanup`,
    /* 通过真实 manager/native 组合模拟待启动 Job 与 unlink 窗口，不实际注册 systemd 单元。 */ async () => {
      const spec = sampleSpec('linux')
      const definition = renderDefinition(spec)
      let present = true
      let enabled = true
      let job = ['waiting_dependency', 'stop_job_not_canceled'].includes(scenario) ? '42' : ''
      let active = 'inactive'
      let pid = 0
      let stops = 0
      let removals = 0
      const operations: string[] = []
      // 模拟依赖满足后由系统调度启动，独立于 CLI 文件锁及 enable 状态。
      function activate() {
        active = 'active'
        pid = 123
        job = ''
      }
      const files: RegistrationFiles = {
        verify: /* 内存声明不检查或写入真实系统目录。 */ async () => {},
        read: /* 保留所有权清单，确保后续显式 stop 能找到它。 */ async () => (present ? definition : undefined),
        create: /* 本用例从已注册服务开始，不允许创建另一个。 */ async () => assert.fail(),
        remove: /* 若卸载触及已读静止后的 unlink 窗口，依赖可立即满足并启动，不能丢掉声明。 */ async (
          _name,
          content
        ) => {
          if (stops === 0 && scenario === 'unlink_window_start') {
            activate()
          }
          assert(stops > 0, 'only explicit stop may reach declaration cleanup')
          assert.equal(job, '')
          assert.equal(pid, 0)
          assert.equal(content, definition)
          operations.push('unlink')
          removals++
          present = false
        },
        lock: /* 角色锁不能冻结内核调度，运行状态由上面的独立模型控制。 */ async (_name, f) => f()
      }
      const runner: CommandRunner = /* 仿真 Unit.Job 的官方 systemctl 展示格式及 stop 的取消效果。 */ async (p) => {
        assert.equal(p.executable, '/usr/bin/systemctl')
        if (p.args.includes('show')) {
          assert(p.args.includes('--all'))
          assert(
            p.args.some(
              /* 确保查询未遗漏 Unit.Job。 */ (a) => a.startsWith('--property=') && a.split(',').includes('Job')
            )
          )
          return {
            code: present ? 0 : 4,
            stdout: `LoadState=${present ? 'loaded' : 'not-found'}\nActiveState=${active}\nSubState=${active === 'active' ? 'running' : 'dead'}\nMainPID=${pid}\nJob=${job}\nFragmentPath=${present ? '/etc/systemd/system/rovloom-connector.service' : ''}\nDropInPaths=\nExecMainStatus=0\nUnitFileState=${enabled ? 'enabled' : 'disabled'}\n`,
            stderr: ''
          }
        }
        if (p.args.includes('disable')) {
          enabled = false
          operations.push('disable')
        }
        if (p.args.includes('stop')) {
          stops++
          operations.push('stop')
          if (scenario !== 'stop_job_not_canceled') {
            job = ''
          }
          active = 'inactive'
          pid = 0
        }
        return { code: 0, stdout: '', stderr: '' }
      }
      const backend = createNativeServiceBackend({
        platform: 'linux',
        files,
        runner,
        verifyRuntime: /* 受控用例不启动真实程序。 */ async () => {}
      })
      const m = model('linux')
      const manager = new ServiceManager(backend, m.clock)
      const removed = await manager.execute({ action: 'uninstall', role: 'connector' })
      assert.equal(removed.bootEnabled, false)
      assert.equal(removed.controlRetained, true)
      assert.equal(removed.stopMode, 'not_requested')
      assert.equal(
        removed.state,
        ['waiting_dependency', 'stop_job_not_canceled'].includes(scenario) ? 'starting' : 'stopped'
      )
      assert.equal(stops, 0)
      assert.equal(removals, 0)
      assert.equal(present, true)
      assert.equal((await manager.execute({ action: 'uninstall', role: 'connector' })).changed, false)
      if (scenario === 'unlink_window_start') {
        activate()
        assert.equal((await backend.inspect('connector'))?.state, 'running')
      }
      if (scenario === 'stop_job_not_canceled') {
        await assert.rejects(
          /* stop 受理后 Job 仍在也不能误报已停止并清理声明。 */ () =>
            manager.execute({ action: 'stop', role: 'connector' }),
          { code: 'service_timeout' }
        )
        assert.equal(m.clock.now(), 30000)
        assert.equal(stops, 1)
        assert.equal(removals, 0)
        assert.equal(present, true)
        return
      }
      assert.equal((await manager.execute({ action: 'stop', role: 'connector' })).state, 'absent')
      assert.equal(stops, 1)
      assert.equal(removals, 1)
      assert(operations.indexOf('stop') < operations.indexOf('unlink'))
    }
  )
}
