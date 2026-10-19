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
        '-c',
        `import json,sys,plistlib,xml.etree.ElementTree as E
p=json.load(sys.stdin)
a=plistlib.loads(p['plist'].encode())
assert a['ProgramArguments']==p['argv']
assert a['RunAtLoad'] is True and a['KeepAlive'] is False
assert a['UserName']=='rovloom'
b=E.fromstring(p['task']); n={'t':'http://schemas.microsoft.com/windows/2004/02/mit/task'}
assert len(b.findall('t:Triggers/*',n))==1
assert b.find('t:Triggers/t:BootTrigger',n) is not None
assert b.find('t:Principals/t:Principal/t:UserId',n).text=='S-1-5-19'
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
