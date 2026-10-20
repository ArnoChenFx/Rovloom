// 用真实ServiceManager和明确标注的内存监管stub验证唯一CLI接缝，不安装或启动系统服务。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli, resolveRoleConfigPath, type CliRuntime } from '../../src/cli/index.js'
import { CliError, configDocument, configTemplate } from '../../src/cli/config.js'
import { ServiceManager, ServiceError } from '../../src/service/index.js'
import { model, sampleSpec } from '../service/helpers.js'

const marker = 'SYNTHETIC_SECRET_DO_NOT_PRINT'

test(
  '非交互角色仍核验配置并调用后端，但不进入可能由系统控制台误触发的TTY准备',
  /* 显式prepare失败模拟被误识别的控制台；后端仍真实返回不可用，不能被标记为就绪。 */ async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rovloom-service-no-prompt-'))
    try {
      for (const role of ['gateway', 'connector'] as const) {
        const path = join(directory, role + '.json')
        const template =
          role === 'connector'
            ? { ...configTemplate('connector'), gateway_url: 'ws://localhost:9443' }
            : configTemplate('gateway')
        const bytes = JSON.stringify(configDocument({ ...template, state_dir: join(directory, role) }))
        writeFileSync(path, bytes, 'utf8')
        let prepared = 0
        let started = 0
        const runtime: CliRuntime = {
          prepare: /* 本地交互在非交互模式不得进入。 */ async () => {
            prepared++
            throw new CliError('configuration_required')
          },
          [role]: /* 配置正确也必须继续检查真实后端能力，不授予任何默认身份。 */ async () => {
            started++
            throw new CliError('backend_unavailable', 3)
          }
        }
        assert.deepEqual(await capture([role, '--config', path, '--non-interactive'], runtime), {
          code: 3,
          stdout: '',
          stderr: 'backend_unavailable\n'
        })
        assert.equal(prepared, 0)
        assert.equal(started, 1)
        assert.equal((await capture([role, '--config', path], runtime)).code, 2)
        assert.equal(prepared, 1)
        assert.equal(started, 1)
        writeFileSync(path, '{}', 'utf8')
        assert.equal((await capture([role, '--config', path, '--non-interactive'], runtime)).code, 2)
        assert.equal(prepared, 1)
        assert.equal(started, 1)
        writeFileSync(path, bytes, 'utf8')
        assert.equal(readFileSync(path, 'utf8'), bytes)
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

// 收集唯一CLI的真实退出码及两个输出通道，不接触角色配置文件或系统监管器。
async function capture(args: string[], runtime?: CliRuntime) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let out = ''
  let err = ''
  stdout.on('data', /* 保存标准输出以确认监管状态不会混入协议或模板通道。 */ (chunk) => (out += chunk))
  stderr.on('data', /* 保存诊断以验证固定代码和非秘密状态。 */ (chunk) => (err += chunk))
  stdin.end()
  const code = await runCli(args, { stdin, stdout, stderr, signal: new AbortController().signal }, runtime)
  return { code, stdout: out, stderr: err }
}

// 构造固定无秘密安装参数；路径只进入内存监管模型，不写入操作系统注册。
function install(role: 'gateway' | 'connector', config?: string): string[] {
  return [
    'service',
    'install',
    '--role',
    role,
    '--executable',
    '/opt/rovloom/rovloom',
    '--workdir',
    '/var/lib/rovloom',
    '--user',
    'rovloom',
    ...(config ? ['--config', config] : [])
  ]
}

test(
  'service帮助独立可用，缺少受信监管宿主的动作明确拒绝',
  /* 在没有任何后端的入口检查帮助与失败，不伪装安装成功。 */ async () => {
    const help = await capture(['service', '--help'])
    assert.equal(help.code, 0)
    assert.equal(help.stdout, '')
    assert.match(help.stderr, /uninstall never stops it/)
    for (const args of [install('gateway'), ['service', 'uninstall', '--role', 'connector']]) {
      assert.deepEqual(await capture(args), { code: 3, stdout: '', stderr: 'backend_unavailable\n' })
    }
  }
)

test(
  'service五项动作不进入角色prepare、TTY配对或业务宿主',
  /* 防止新首次引导在服务控制命令中被隐式触发。 */ async () => {
    const stub = model()
    let preparations = 0
    const runtime: CliRuntime = {
      service: { platform: 'linux', manager: new ServiceManager(stub.backend, stub.clock) },
      prepare: /* 如被调用会立刻失败，不从非交互控制器发起任何配对。 */ async () => {
        preparations++
        throw new Error(marker)
      },
      gateway: /* 服务控制不启动当前CLI进程内的Gateway。 */ async () => assert.fail(),
      connector: /* 服务控制不启动当前CLI进程内的Connector。 */ async () => assert.fail()
    }
    for (const args of [
      install('gateway', '/explicit/config.json'),
      ...['start', 'restart', 'stop', 'uninstall'].map(
        /* 所有后续动作都仍选择同一角色。 */ (action) => ['service', action, '--role', 'gateway']
      )
    ]) {
      const result = await capture(args, runtime)
      assert.equal(result.code, 0)
      assert.equal(result.stdout, '')
    }
    assert.equal(preparations, 0)
  }
)

test(
  'service安装复用唯一角色路径helper，显式配置优先且只注册不启动',
  /* 两角色各用独立内存stub和真实监管状态机，核对CLI未自行解析提权身份。 */ async () => {
    for (const role of ['gateway', 'connector'] as const) {
      const stub = model()
      let resolved = 0
      const runtime: CliRuntime = {
        service: {
          platform: 'linux',
          manager: new ServiceManager(stub.backend, stub.clock),
          resolveDefaultConfig: /* 仅测试宿主已验证home；CLI复用共享helper，不读取环境身份断言。 */ (selected) => {
            resolved++
            return resolveRoleConfigPath(selected, undefined, { home: '/verified/home', platform: 'linux' })
          }
        }
      }
      const result = await capture(install(role), runtime)
      assert.equal(result.code, 0)
      assert.equal(result.stdout, '')
      assert.equal(resolved, 1)
      assert.equal(stub.get()!.spec.config, `/verified/home/.config/rovloom/${role}.json`)
      assert.equal(stub.get()!.state, 'stopped')
      assert.equal(JSON.parse(result.stderr).readiness, 'not_checked')
      assert(!stub.calls.includes('start'))

      const explicit = model()
      runtime.service!.manager = new ServiceManager(explicit.backend, explicit.clock)
      assert.equal((await capture(install(role, '/explicit/protected/config.json'), runtime)).code, 0)
      assert.equal(resolved, 1)
      assert.equal(explicit.get()!.spec.config, '/explicit/protected/config.json')
    }
  }
)

test(
  'service卸载绕过角色配置读取，保留运行实例且不解析默认身份',
  /* 真实状态机消费已运行的内存记录，验证唯一CLI没有把uninstall变成stop。 */ async () => {
    const stub = model()
    stub.set({ spec: sampleSpec(), state: 'running', enabled: true })
    const result = await capture(['service', 'uninstall', '--role', 'connector'], {
      service: {
        platform: 'linux',
        manager: new ServiceManager(stub.backend, stub.clock),
        resolveDefaultConfig: /* 卸载不应读取home或配置；若调用即使本例失败。 */ () => {
          throw new Error(marker)
        }
      }
    })
    assert.equal(result.code, 0)
    assert.equal(result.stdout, '')
    assert.equal(stub.get()!.state, 'running')
    assert.equal(stub.get()!.enabled, false)
    assert(!stub.calls.includes('stop'))
    assert.deepEqual(JSON.parse(result.stderr), {
      action: 'uninstall',
      role: 'connector',
      changed: true,
      state: 'running',
      bootEnabled: false,
      controlRetained: true,
      readiness: 'not_checked',
      stopMode: 'not_requested'
    })
  }
)

test(
  'service参数、缺省身份和后端故障只返回固定诊断及真实失败码',
  /* 使用失败内存stub验证服务parser与CLI输出边界，不回显合成秘密。 */ async () => {
    const stub = model()
    const runtime: CliRuntime = {
      service: { platform: 'linux', manager: new ServiceManager(stub.backend, stub.clock) }
    }
    assert.deepEqual(await capture(install('gateway'), runtime), {
      code: 2,
      stdout: '',
      stderr: 'config_path_required\n'
    })
    runtime.service!.resolveDefaultConfig = /* 宿主不能证明home时复用共享helper的拒绝结果。 */ (role) =>
      resolveRoleConfigPath(role, undefined, { home: undefined, platform: 'linux' })
    assert.deepEqual(await capture(install('gateway'), runtime), {
      code: 2,
      stdout: '',
      stderr: 'config_path_required\n'
    })
    assert.deepEqual(await capture(['service', 'start', '--role', 'connector', '--secret', marker], runtime), {
      code: 2,
      stdout: '',
      stderr: 'invalid_arguments\n'
    })
    stub.failures.add('authorize')
    assert.deepEqual(await capture(['service', 'start', '--role', 'connector'], runtime), {
      code: 1,
      stdout: '',
      stderr: 'system_command_failed\n'
    })
  }
)

test(
  'service运行时边界拒绝畸形错误码和监管状态，不因静态类型泄露后端文本',
  /* 故意让内存stub违反类型契约，证明真实CLI在stderr前仍有运行时白名单。 */ async () => {
    const stub = model()
    const runtime: CliRuntime = {
      service: { platform: 'linux', manager: new ServiceManager(stub.backend, stub.clock) }
    }
    stub.backend.authorize = /* 后端扩展或损坏的code不能被当作已脱敏诊断。 */ async () => {
      throw new ServiceError(marker as never)
    }
    assert.deepEqual(await capture(['service', 'start', '--role', 'connector'], runtime), {
      code: 1,
      stdout: '',
      stderr: 'runtime_failed\n'
    })
    stub.backend.authorize = /* 恢复权限stub，只让监管状态违反受信类型。 */ async () => {}
    stub.set({ spec: sampleSpec(), state: marker as never, enabled: true })
    assert.deepEqual(await capture(['service', 'uninstall', '--role', 'connector'], runtime), {
      code: 1,
      stdout: '',
      stderr: 'system_command_failed\n'
    })
    assert(!stub.calls.includes('stop'))
  }
)
