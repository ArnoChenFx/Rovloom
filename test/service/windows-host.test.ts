// 隔离验证Windows服务的LocalService默认配置与无交互CLI接线；仅Windows本机项只读profile。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { homedir } from 'node:os'
import { serviceAccountConfig } from '../../src/cli/service-host.js'
import { runCli } from '../../src/cli/run.js'
import { windowsServiceHome } from '../../src/service/windows-home.js'
import { ServiceManager } from '../../src/service/manager.js'
import { parseServiceCommand } from '../../src/service/command.js'
import { model, sampleSpec } from './helpers.js'

test(
  'Windows默认配置属于所选LocalService，两角色共享唯一home路径规则且显式配置优先',
  /* 模拟普通系统profile查询，不调用登录API、任务调度器或管理员用户目录。 */ () => {
    for (const role of ['gateway', 'connector'] as const) {
      let queries = 0
      const spec = sampleSpec('win32')
      const args = ['service', 'install', '--role', role, '--user', spec.account, '--workdir', spec.directory]
      // parser只把固定目标账户交给正常系统记录查询。
      const resolve = (selected: 'gateway' | 'connector', account: string) =>
        serviceAccountConfig(
          selected,
          account,
          /* 合成系统路径保留空格与Unicode。 */ (requested) => {
            assert.equal(requested, 'S-1-5-19')
            queries++
            return 'D:\\Service Profiles\\本机服务'
          },
          'win32'
        )
      const request = parseServiceCommand(args, 'win32', resolve, spec.executable)!
      assert.equal(request.spec?.config, `D:\\Service Profiles\\本机服务\\.config\\rovloom\\${role}.json`)
      assert.equal(queries, 1)
      assert.equal(
        parseServiceCommand([...args, '--config', 'C:\\Explicit Data\\role.json'], 'win32', resolve, spec.executable)!
          .spec?.config,
        'C:\\Explicit Data\\role.json'
      )
      assert.equal(queries, 1)
    }
  }
)

test(
  'Windows缺失profile和坏路径要求显式配置，账户参数不能切换SYSTEM或调用者',
  /* 普通输入错误必须在任何系统查询前拒绝，不引入文件ACL或额外安装验证器。 */ () => {
    for (const account of ['S-1-5-18', 'Administrator', 'LocalService', 'S-1-5-20']) {
      assert.throws(
        /* 只允许当前后端声明的LocalService SID。 */ () =>
          serviceAccountConfig('gateway', account, /* 非法账户不查询。 */ () => assert.fail(), 'win32'),
        { code: 'invalid_arguments' }
      )
    }
    for (const home of ['', 'relative', 'C:\\', 'C:\\profiles\\..\\service', '%USERPROFILE%\\service', 'C:\\a\nb']) {
      assert.throws(
        /* 不回退管理员HOME，也不展开调用者环境。 */ () =>
          serviceAccountConfig('gateway', 'S-1-5-19', /* 返回单个坏记录。 */ () => home, 'win32'),
        { code: 'config_path_required' }
      )
    }
    assert.throws(
      /* 只读系统查询失败仍要求明确路径。 */ () =>
        windowsServiceHome(
          /* 模拟普通IO失败。 */ () => {
            throw new Error('synthetic_profile_error')
          }
        ),
      { code: 'config_path_required' }
    )
  }
)

test(
  'Windows五项service控制在已关闭stdin下只操作显式监管宿主，不进入角色TTY初始化',
  /* 后端为明确内存模型；验证同一CLI parser/状态机，不伪称真实任务安装通过。 */ async () => {
    const stub = model('win32')
    const spec = { ...sampleSpec('win32'), role: 'gateway' as const }
    const runtime = {
      service: {
        platform: 'win32',
        executable: spec.executable,
        manager: new ServiceManager(stub.backend, stub.clock),
        resolveDefaultConfig: /* 安装配置固定来自目标账户。 */ (role: 'gateway' | 'connector', account: string) =>
          serviceAccountConfig(role, account, /* 合成LocalService系统记录。 */ () => 'C:\\ServiceProfile', 'win32')
      },
      prepare: /* 服务控制不能请求TTY或生成配对身份。 */ async () => assert.fail(),
      gateway: /* 服务控制不能在当前进程启动业务角色。 */ async () => assert.fail(),
      connector: /* 服务控制不能创建native或会话。 */ async () => assert.fail()
    }
    for (const args of [
      ['service', 'install', '--role', 'gateway', '--user', spec.account, '--workdir', spec.directory],
      ...['start', 'uninstall', 'restart', 'stop'].map(
        /* 撤自启后重启必须继续使用原登记。 */ (action) => ['service', action, '--role', 'gateway']
      )
    ]) {
      const stdin = new PassThrough()
      stdin.end()
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      let output = ''
      let diagnostic = ''
      stdout.on('data', /* 监管结果不能混入stdout。 */ (chunk) => (output += chunk))
      stderr.on('data', /* 只接收本例固定监管结果。 */ (chunk) => (diagnostic += chunk))
      assert.equal(await runCli(args, { stdin, stdout, stderr, signal: new AbortController().signal }, runtime), 0)
      assert.equal(output, '')
      assert.equal(JSON.parse(diagnostic).readiness, 'not_checked')
    }
    assert.equal(stub.get(), undefined)
  }
)

if (process.platform === 'win32') {
  test(
    '本机只读查询LocalService系统profile并生成其角色配置路径，不注册任务或创建用户文件',
    /* 原生Windows CI查询既有系统记录，不冒充另一个账户或使用ACL检查端口。 */ () => {
      const home = windowsServiceHome()
      assert.notEqual(home.toLowerCase(), homedir().toLowerCase())
      assert.equal(serviceAccountConfig('gateway', 'S-1-5-19'), home + '\\.config\\rovloom\\gateway.json')
    }
  )
}
