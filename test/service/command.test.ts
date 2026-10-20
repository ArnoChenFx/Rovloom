// 验证最小 CLI 接缝、路径与清单验证及三种原生参数编码，不执行原生服务管理器。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { handleServiceCommand, parseServiceCommand } from '../../src/service/command.js'
import { ServiceManager } from '../../src/service/manager.js'
import { manifest, parseManifest, validateSpec } from '../../src/service/spec.js'
import { renderDefinition, renderTask, unitQuote, windowsQuote } from '../../src/service/render.js'
import { model, sampleSpec } from './helpers.js'

test(
  'service parser composes with the existing CLI without claiming unrelated commands',
  /* 确认不增加入口且 service 外参数保留给原 parser。 */ () => {
    assert.equal(parseServiceCommand(['connector', '--config', '/x'], 'linux'), undefined)
    const spec = sampleSpec()
    assert.deepEqual(
      parseServiceCommand(
        [
          'service',
          'install',
          '--user',
          spec.account,
          '--role',
          spec.role,
          '--config',
          spec.config,
          '--workdir',
          spec.directory,
          '--executable',
          spec.executable
        ],
        'linux'
      ),
      { action: 'install', role: 'connector', spec }
    )
    for (const args of [
      ['service'],
      ['service', 'status'],
      ['service', 'start'],
      ['service', 'stop', '--role', 'other'],
      ['service', 'start', '--role', 'connector', '--role', 'gateway'],
      ['service', 'uninstall', '--role', 'connector', '--purge', 'true'],
      ['service', 'install', '--role', 'connector']
    ]) {
      assert.throws(/* 未知、重复、缺失及清理数据参数全部拒绝。 */ () => parseServiceCommand(args, 'linux'), {
        code: 'invalid_arguments'
      })
    }
  }
)

test(
  'manifest is exact, versioned, scoped to project role and rejects unsafe paths/accounts',
  /* 注册内清单不可宽松解码或自动迁移。 */ () => {
    const spec = sampleSpec()
    assert.deepEqual(parseManifest(manifest(spec), 'connector', 'linux'), spec)
    for (const change of [
      { account: 'root' },
      { config: '../config' },
      { executable: '/opt/a/../rovloom' },
      { directory: '/data\nUser=root' },
      { arbitrary: true },
      { version: 2 }
    ]) {
      assert.throws(/* 非法清单不能生成系统声明。 */ () => validateSpec({ ...spec, ...change }))
    }
    assert.throws(/* 本角色不能接管另一角色清单。 */ () => parseManifest(manifest(spec), 'gateway', 'linux'), {
      code: 'service_conflict'
    })
    assert.throws(/* 同角色也不能跨平台接管。 */ () => parseManifest(manifest(spec), 'connector', 'darwin'), {
      code: 'service_conflict'
    })
    assert.throws(
      /* Windows 不允许 SYSTEM 账户。 */ () => validateSpec({ ...sampleSpec('win32'), account: 'S-1-5-18' })
    )
    assert.throws(
      /* Windows 不接受 UNC 网络可执行路径。 */ () =>
        validateSpec({ ...sampleSpec('win32'), executable: '\\\\server\\share\\app.exe' })
    )
  }
)

test(
  'Windows用户账户保留同一配置引用，不回退系统账户或转换路径',
  /* 常规用户名称和用户SID交由Windows正常解析；本地只核对参数形状。 */ () => {
    const spec = sampleSpec('win32')
    for (const account of ['operator', 'RovloomHost\\operator', 'S-1-5-21-100-200-300-1001']) {
      const selected = validateSpec({ ...spec, account })
      assert.equal(selected.account, account)
      assert.equal(selected.config, spec.config)
    }
    for (const account of [null, 42, {}, '', 'bad\naccount', 'a'.repeat(257), 'S-1-5-18', 'S-1-5-19', 'S-1-5-20']) {
      assert.throws(/* 无效账户不进入OS注册，不添加另一个配置目录。 */ () => validateSpec({ ...spec, account }), {
        code: 'invalid_arguments'
      })
    }
  }
)

test(
  'systemd escapes variables/specifiers and Windows follows CRT quoting for slashes and quotes',
  /* 特殊字符作为字面 argv，不能注入 unit 选项或环境扩展。 */ () => {
    assert.equal(unitQuote('/opt/$HOME/%n/"a"\\b'), '"/opt/$HOME/%%n/\\"a\\"\\\\b"')
    assert.equal(windowsQuote('a b'), '"a b"')
    assert.equal(windowsQuote('C:\\space\\'), '"C:\\space\\\\"')
    assert.equal(windowsQuote('a\\"b'), '"a\\\\\\"b"')
    const unit = renderDefinition(sampleSpec())
    assert(unit.includes('WantedBy=multi-user.target'))
    assert(unit.includes('StandardInput=null'))
    assert(unit.includes('ExecStart=:'))
    assert(!unit.includes('default.target'))
    assert(!unit.includes('ExecStop='))
  }
)

test(
  'plist and task XML parse independently and preserve Unicode, spaces, ampersands and argument boundaries',
  /* 用标准库 XML/plist 解析器核对原生声明的结构，避免只比字符串快照。 */ () => {
    const mac = { ...sampleSpec('darwin'), config: '/var/lib/汉字 & <x>/config.json' }
    const win = { ...sampleSpec('win32'), config: 'C:\\汉字 & 数据\\config.json' }
    const xml = spawnSync(
      'python3',
      [
        '-X',
        'utf8',
        '-c',
        `import json,sys,plistlib,xml.etree.ElementTree as E
p=json.load(sys.stdin)
a=plistlib.loads(p['plist'].encode())
assert a['ProgramArguments']==p['argv']
assert a['RunAtLoad'] is True and a['KeepAlive'] is False
assert a['UserName']=='rovloom'
assert a['StandardInPath']=='/dev/null'
b=E.fromstring(p['task']); n={'t':'http://schemas.microsoft.com/windows/2004/02/mit/task'}
assert len(b.findall('t:Triggers/*',n))==1
assert b.find('t:Triggers/t:BootTrigger',n) is not None
assert b.find('t:Principals/t:Principal/t:UserId',n).text==p['account']
assert b.find('t:Principals/t:Principal/t:LogonType',n).text=='S4U'
for k,v in {'ExecutionTimeLimit':'PT0S','MultipleInstancesPolicy':'IgnoreNew','DisallowStartIfOnBatteries':'false','StopIfGoingOnBatteries':'false','AllowStartOnDemand':'true','AllowHardTerminate':'true'}.items(): assert b.find('t:Settings/t:'+k,n).text==v
assert b.find('t:Actions/t:Exec/t:Command',n).text==p['exe']
assert b.find('t:Actions/t:Exec/t:WorkingDirectory',n).text==p['cwd']
assert b.find('t:Actions/t:Exec/t:Arguments',n).text==p['args']
`
      ],
      {
        input: JSON.stringify({
          plist: renderDefinition(mac),
          argv: [mac.executable, 'connector', '--config', mac.config],
          task: renderTask(win),
          account: win.account,
          exe: win.executable,
          cwd: win.directory,
          args: ['connector', '--config', win.config].map(windowsQuote).join(' ')
        }),
        encoding: 'utf8'
      }
    )
    assert.equal(xml.status, 0, xml.stderr)
  }
)

test(
  'CLI seam reports fixed stderr diagnostics and exit status without argv or native output',
  /* 错误消息不回显配置路径、原生输出或异常内容。 */ async () => {
    const m = model()
    const output: string[] = []
    const host = {
      platform: 'linux',
      manager: new ServiceManager(m.backend, m.clock),
      diagnostic: /* 收集模拟 stderr。 */ (s: string) => {
        output.push(s)
      }
    }
    assert.equal(await handleServiceCommand(['--help'], host), undefined)
    assert.equal(await handleServiceCommand(['service', '--help'], host), 0)
    assert.equal(await handleServiceCommand(['service', 'start', '--role', 'connector'], host), 1)
    assert.equal(output.at(-1), 'service_not_installed\n')
    assert.equal(await handleServiceCommand(['service', 'start', '--password', 'secret'], host), 2)
    assert(!output.join('').includes('secret'))
    assert.equal(
      await handleServiceCommand(['service', 'stop', '--role', 'connector'], { ...host, platform: 'aix' }),
      3
    )
    m.backend.authorize = /* 模拟具有秘密原文的系统异常。 */ async () => {
      throw new Error('private-system-diagnostic')
    }
    assert.equal(await handleServiceCommand(['service', 'stop', '--role', 'connector'], host), 1)
    assert.equal(output.at(-1), 'system_command_failed\n')
  }
)

test(
  '原生实装脚本在普通机器或自托管环境先拒绝，不读取安装目标',
  /* 只启动带拒绝条件的子进程；没有有效二进制路径，也绝不伪造可实装的托管VM环境。 */ () => {
    for (const env of [
      {},
      { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted', ROVLOOM_NATIVE_SERVICE_CI: '1' },
      { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' }
    ]) {
      const result = spawnSync(process.execPath, ['--no-env-file', 'scripts/service/native-smoke.mjs'], {
        env: { ...env, ROVLOOM_SERVICE_EXECUTABLE: 'missing-candidate' },
        encoding: 'utf8',
        timeout: 5000
      })
      assert.equal(result.status, 1)
      assert.equal(result.signal, null)
      assert.match(result.stderr, /native_service_requires_disposable_github_vm/u)
      assert(!result.stderr.includes('ENOENT'))
    }
  }
)

test(
  'Windows task principal satisfies official XSD LogonType enum/cardinality semantics',
  /* 独立检查 schema 枚举与基数，证明语法正确但非法的 ServiceAccount 会被拒绝；不声称全 XSD 验证。 */ () => {
    const result = spawnSync(
      'python3',
      [
        '-X',
        'utf8',
        '-c',
        `import json,sys,xml.etree.ElementTree as E
p=json.load(sys.stdin)
s=E.parse('test/fixtures/service/logon-type.xsd'); xs={'x':'http://www.w3.org/2001/XMLSchema'}
values={v.attrib['value'] for v in s.findall('.//x:simpleType[@name="logonType"]/x:restriction/x:enumeration',xs)}
r=s.find('.//x:complexType/x:all/x:element',xs)
assert r.attrib['type']=='logonType'
# 只实现此官方片段的枚举和出现次数规则，不冒充完整 XMLSchema 引擎。
def valid(xml):
 root=E.fromstring(xml); ns={'t':'http://schemas.microsoft.com/windows/2004/02/mit/task'}
 nodes=root.findall('t:Principals/t:Principal/t:LogonType',ns)
 return int(r.attrib['minOccurs'])<=len(nodes)<=int(r.attrib['maxOccurs']) and all(n.text in values for n in nodes)
assert valid(p['xml'])
xml=p['xml'].replace('<LogonType>S4U</LogonType>','')
assert not valid(xml.replace('<RunLevel>','<LogonType>ServiceAccount</LogonType><RunLevel>'))
assert not valid(xml.replace('<RunLevel>','<LogonType>Unknown</LogonType><RunLevel>'))
for value in values:
 assert valid(xml.replace('<RunLevel>','<LogonType>'+value+'</LogonType><RunLevel>'))
assert not valid(xml.replace('<RunLevel>','<LogonType>S4U</LogonType><LogonType>Password</LogonType><RunLevel>'))
`
      ],
      { input: JSON.stringify({ xml: renderTask(sampleSpec('win32')) }), encoding: 'utf8' }
    )
    assert.equal(result.status, 0, result.stderr)
  }
)

for (const platform of ['linux', 'darwin', 'win32'] as const) {
  test(
    `${platform}: install resolves one trusted default config and freezes it across service-account changes`,
    /* 默认路径复用唯一 CLI 的受信 resolver，注册后所有管理动作都使用固化路径。 */ async () => {
      const m = model(platform)
      const spec = sampleSpec(platform)
      const config =
        platform === 'win32'
          ? 'C:\\Users\\操作员\\.config\\rovloom\\connector.json'
          : '/home/操作员/.config/rovloom/connector.json'
      let resolves = 0
      const args = [
        'service',
        'install',
        '--role',
        'connector',
        '--executable',
        spec.executable,
        '--workdir',
        spec.directory,
        '--user',
        spec.account
      ]
      const resolveDefaultConfig = /* 测试中模拟唯一 CLI 已验证的原用户 home 路径。 */ (
        role: 'gateway' | 'connector'
      ) => {
        resolves++
        assert.equal(role, 'connector')
        return config
      }
      const parsed = parseServiceCommand(args, platform, resolveDefaultConfig)!
      assert.equal(parsed.spec?.config, config)
      assert.equal(resolves, 1)
      const manager = new ServiceManager(m.backend, m.clock)
      await manager.execute(parsed)
      await manager.execute({ action: 'start', role: 'connector' })
      await manager.execute({ action: 'restart', role: 'connector' })
      assert.equal(m.get()?.spec.config, config)
      assert.equal(resolves, 1)
      const explicit = platform === 'win32' ? 'C:\\Explicit\\config.json' : '/explicit/config.json'
      assert.equal(
        parseServiceCommand(
          [...args, '--config', explicit],
          platform,
          /* 显式路径不应调用默认 resolver。 */ () => assert.fail()
        )?.spec?.config,
        explicit
      )
      await assert.rejects(
        /* 未知原用户身份必须要求明确路径，不猜测 HOME/SUDO_USER。 */ async () => parseServiceCommand(args, platform),
        { code: 'config_path_required' }
      )
      assert.equal(
        await handleServiceCommand(args, {
          platform,
          manager,
          diagnostic: /* 固定错误文本无需写入真实标准流。 */ () => {}
        }),
        2
      )
    }
  )
}

test(
  'default config resolver receives the selected role and refuses an unverified home',
  /* Gateway/Connector 默认路径分开解析，不从服务账户 home 重算，也不接受环境自报身份。 */ () => {
    const spec = sampleSpec()
    for (const role of ['gateway', 'connector'] as const) {
      const args = [
        'service',
        'install',
        '--role',
        role,
        '--executable',
        spec.executable,
        '--workdir',
        spec.directory,
        '--user',
        spec.account
      ]
      assert.equal(
        parseServiceCommand(
          args,
          'linux',
          /* 这里的受信 helper 对两种角色生成不同文件。 */ (selected) =>
            `/home/operator/.config/rovloom/${selected}.json`
        )?.spec?.config,
        `/home/operator/.config/rovloom/${role}.json`
      )
      assert.throws(
        /* 无法验证原用户的 helper 必须直接要求显式路径。 */ () =>
          parseServiceCommand(
            args,
            'linux',
            /* 模拟提升后无法确定原身份。 */ () => {
              throw new Error('unverified original identity')
            }
          )
      )
    }
  }
)
