// 验证产品服务宿主的当前产物绑定、单份角色配置和只读预检；所有监管工具均为受控端口。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  assertServiceProduct,
  productServiceEnvironment,
  productServiceBackend,
  createProductServiceHost,
  verifyProductServiceRuntime
} from '../../src/cli/service-host.js'
import { configDocument, configTemplate } from '../../src/cli/config.js'
import { parseServiceCommand } from '../../src/service/command.js'
import { parseCommand } from '../../src/cli/run.js'
import { sampleSpec } from '../service/helpers.js'
import { createNativeServiceBackend } from '../../src/service/native.js'
import { ServiceManager } from '../../src/service/manager.js'
import { manifest } from '../../src/service/spec.js'
import type { RegistrationFiles } from '../../src/service/files.js'
import { ServiceError } from '../../src/service/types.js'

test(
  'Windows排队取消前已变成running时明确失败，不能绕过正常Abort强停',
  /* 真实产品组合器、原生后端及状态机参与，只有系统命令/文件端口为隔离内存模型。 */ async () => {
    for (const finalState of [4, 2, 3]) {
      const spec = { ...sampleSpec('win32'), role: 'gateway' as const }
      const operations: string[] = []
      let inspections = 0
      let forcedWhileRunning = 0
      const files: RegistrationFiles = {
        verify: /* 模型不触碰系统控制目录。 */ async () => {},
        lock: /* 本回归只需包围单次状态转换，不创建真实锁。 */ async (_role, operation) => operation(),
        read: /* Windows登记来自受控COM端口。 */ async () => assert.fail('unexpected file read'),
        create: /* 停止不能创建登记文件。 */ async () => assert.fail('unexpected file create'),
        remove: /* 自启仍启用，停止不得清理登记。 */ async () => assert.fail('unexpected file remove')
      }
      const native = createNativeServiceBackend({
        platform: 'win32',
        files,
        verifyRuntime: /* 本例不启动角色，也不读业务配置。 */ async () => assert.fail('unexpected preflight'),
        runner: /* 前两次观察排队，最后分别运行/排队/退出；均不能强停或虚报终止。 */ async (plan) => {
          const request = JSON.parse(plan.input!)
          operations.push(request.op)
          if (request.op === 'authorize') {
            return { code: 0, stdout: '{"ok":true}', stderr: '' }
          }
          if (request.op === 'read') {
            return { code: 0, stdout: JSON.stringify({ marker: manifest(spec) }), stderr: '' }
          }
          if (request.op === 'inspect') {
            inspections++
            const state = inspections <= 2 ? 2 : forcedWhileRunning ? 3 : finalState
            return {
              code: 0,
              stdout: JSON.stringify({ state, instances: state === 4 ? 1 : 0, enabled: true, exitCode: 0 }),
              stderr: ''
            }
          }
          assert.equal(request.op, 'stop')
          forcedWhileRunning++
          return { code: 0, stdout: '{"state":3,"instances":0,"enabled":true,"exitCode":0}', stderr: '' }
        }
      })
      const backend = productServiceBackend(native, {
        platform: 'win32',
        arch: 'arm64',
        executable: spec.executable,
        standalone: true
      })
      const outcome = await new ServiceManager(backend)
        .execute({ action: 'stop', role: 'gateway' })
        .catch(/* 保留真实返回或错误，先断言没有强停，再核对明确失败。 */ (error: unknown) => error)
      assert.equal(inspections, 3)
      assert.equal(forcedWhileRunning, 0)
      assert(outcome instanceof ServiceError)
      assert.equal(outcome.code, 'service_busy')
      assert(!operations.includes('stop'))
    }
  }
)

test(
  '源码解释器不被识别为可安装的单文件产物',
  /* 只读进程元信息，不请求系统授权。 */ () => {
    const environment = productServiceEnvironment()
    assert.equal(environment.standalone, false)
    assert.equal(environment.platform, process.platform)
    assert.throws(/* Bun 路径不能代替产品。 */ () => assertServiceProduct(sampleSpec(), environment), {
      code: 'backend_unavailable'
    })
  }
)

test(
  '服务安装与前台使用同一默认角色文件，运行账户不会切换配置目录',
  /* 调用真实产品宿主的路径接缝；构造不授权、不查询系统账户、不创建文件。 */ () => {
    const host = createProductServiceHost()
    for (const role of ['gateway', 'connector'] as const) {
      const foreground = parseCommand([role])
      assert('path' in foreground)
      assert.deepEqual(parseCommand([role, '--non-interactive']), { ...foreground, nonInteractive: true })
      assert.equal(host.resolveDefaultConfig!(role, 'rovloom'), foreground.path)
      assert.equal(host.resolveDefaultConfig!(role, 'another-runtime-account'), foreground.path)
    }
  }
)

test(
  '安装固化显式配置绝对路径，后台命令不再解析用户home',
  /* parser保存同一现有角色文件；显式路径不调用默认解析器。 */ () => {
    const platform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
    const spec = sampleSpec(platform)
    for (const role of ['gateway', 'connector'] as const) {
      const foreground = parseCommand([role])
      assert('path' in foreground)
      const request = parseServiceCommand(
        [
          'service',
          'install',
          '--role',
          role,
          '--user',
          spec.account,
          '--workdir',
          spec.directory,
          '--config',
          foreground.path
        ],
        platform,
        /* 显式用户文件优先，不能另查服务账户目录。 */ () => assert.fail(),
        spec.executable
      )!
      assert.equal(request.spec?.config, foreground.path)
      assert.equal(request.spec?.executable, spec.executable)
    }
  }
)

test(
  '产物绑定拒绝其它可执行文件并如实保留现有平台/角色限制',
  /* 纯函数覆盖全部平台，无模拟安装成功。 */ () => {
    const spec = sampleSpec()
    const environment = { platform: 'linux', arch: 'x64', executable: spec.executable, standalone: true }
    assertServiceProduct(spec, environment)
    assertServiceProduct({ ...spec, role: 'gateway' }, { ...environment, arch: 'arm64' })
    assert.throws(
      /* 本机 Connector owner 尚限 x64。 */ () => assertServiceProduct(spec, { ...environment, arch: 'arm64' }),
      {
        code: 'backend_unavailable'
      }
    )
    assert.throws(
      /* 不允许登记其它安装或任意程序。 */ () =>
        assertServiceProduct({ ...spec, executable: '/opt/other' }, environment),
      {
        code: 'unsafe_installation'
      }
    )
    for (const platform of ['darwin', 'win32'] as const) {
      const target = sampleSpec(platform)
      assert.throws(
        /* 原生声明可生成，不代表角色运行时已跨平台。 */ () =>
          assertServiceProduct(target, { ...environment, platform, executable: target.executable }),
        { code: 'backend_unavailable' }
      )
    }
  }
)

test(
  'Windows当前单文件Gateway可接服务，仍拒绝尚无本机owner的Connector',
  /* 纯产品能力检查不注册任务、不读取另一用户目录。 */ () => {
    const spec = { ...sampleSpec('win32'), role: 'gateway' as const }
    for (const arch of ['x64', 'arm64']) {
      const environment = { platform: 'win32', arch, executable: spec.executable, standalone: true }
      assertServiceProduct(spec, environment)
      assert.throws(
        /* 服务后端不能赋予Windows尚未实现的native Connector能力。 */ () =>
          assertServiceProduct({ ...spec, role: 'connector' }, environment),
        { code: 'backend_unavailable' }
      )
    }
  }
)

test(
  '无运行时支持时预检不能执行工具或读取所选路径',
  /* 缺省必须在所有文件与命令操作之前拒绝。 */ async () => {
    const spec = sampleSpec()
    await assert.rejects(
      /* 明确模拟源码解释器上下文。 */ () =>
        verifyProductServiceRuntime(spec, {
          platform: 'linux',
          arch: 'x64',
          executable: spec.executable,
          standalone: false
        }),
      { code: 'backend_unavailable' }
    )
  }
)

test(
  '已有普通配置保留原字节，检查角色与JSON；缺失配置留给正常首次启动',
  /* 只用普通文件API，不要求私有mode、UID、状态目录或运行目标账户命令。 */ async () => {
    const root = mkdtempSync(join(process.cwd(), '.service-fixture-'))
    const work = join(root, 'work')
    mkdirSync(work)
    const state = join(root, 'state-not-created')
    const config = join(root, 'gateway.json')
    const spec = { ...sampleSpec(), role: 'gateway' as const, config, directory: work }
    const environment = { platform: 'linux', arch: 'x64', executable: spec.executable, standalone: true }
    const bytes = JSON.stringify(configDocument({ ...configTemplate('gateway'), state_dir: state }))
    try {
      writeFileSync(config, bytes, { mode: 0o644 })
      await verifyProductServiceRuntime(spec, environment)
      assert.equal(readFileSync(config, 'utf8'), bytes)
      assert.equal(existsSync(state), false)
      await assert.rejects(
        /* 角色不匹配仍属于真实配置错误。 */ () =>
          verifyProductServiceRuntime({ ...spec, role: 'connector' }, environment),
        { code: 'invalid_arguments' }
      )
      writeFileSync(config, '{broken-json')
      await assert.rejects(/* 格式错误不能登记后伪报成功。 */ () => verifyProductServiceRuntime(spec, environment), {
        code: 'invalid_arguments'
      })
      const missing = join(root, 'missing.json')
      await verifyProductServiceRuntime({ ...spec, config: missing }, environment)
      assert.equal(existsSync(missing), false)
      await assert.rejects(
        /* 工作目录必须是目录，不能把普通配置文件当成chdir目标。 */ () =>
          verifyProductServiceRuntime({ ...spec, directory: config }, environment),
        { code: 'invalid_arguments' }
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)
