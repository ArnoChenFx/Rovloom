// 验证产品服务宿主的当前产物绑定、目标账户默认配置和只读预检；所有监管工具均为受控端口。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  assertServiceProduct,
  productServiceEnvironment,
  serviceAccountConfig,
  verifyProductServiceRuntime
} from '../../src/cli/service-host.js'
import { configDocument, configTemplate } from '../../src/cli/config.js'
import { parseServiceCommand } from '../../src/service/command.js'
import { ServiceError } from '../../src/service/types.js'
import { sampleSpec } from '../service/helpers.js'

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
  '安装默认绑定当前二进制，角色和目标账户分别进入共享配置路径规则',
  /* 受控 passwd 记录忽略环境 home。 */ () => {
    for (const role of ['gateway', 'connector'] as const) {
      let lookup = 0
      const parsed = parseServiceCommand(
        ['service', 'install', '--role', role, '--user', 'rovloom', '--workdir', '/home/服务'],
        'linux',
        /* resolver 获得所选账户，不能误用安装管理员的 home。 */ (selected, account) =>
          serviceAccountConfig(
            selected,
            account,
            /* 只返回本例合成系统记录。 */ (requested) => {
              assert.equal(requested, 'rovloom')
              lookup++
              return 'rovloom:x:1001:1001::/home/服务:/usr/sbin/nologin\n'
            },
            'linux'
          ),
        '/opt/rovloom/rovloom'
      )!
      assert.equal(parsed.spec?.executable, '/opt/rovloom/rovloom')
      assert.equal(parsed.spec?.config, `/home/服务/.config/rovloom/${role}.json`)
      assert.equal(lookup, 1)
      assert.equal(
        parseServiceCommand(
          [
            'service',
            'install',
            '--role',
            role,
            '--user',
            'rovloom',
            '--workdir',
            '/home/服务',
            '--config',
            '/explicit/config.json'
          ],
          'linux',
          /* 显式路径完全绕过缺省身份查询。 */ () => assert.fail(),
          '/opt/rovloom/rovloom'
        )!.spec?.config,
        '/explicit/config.json'
      )
    }
  }
)

test(
  '目标账户、缺失或歧义 home 不能回退管理员或环境默认值',
  /* 每条失败均只返回固定错误码。 */ () => {
    for (const record of [
      '',
      'other:x:1001:1001::/home/other:/bin/sh',
      'rovloom:x:0:0::/root:/bin/sh',
      'rovloom:x:1001:1001::relative:/bin/sh',
      'rovloom:x:1001:1001::/home/服务:/bin/sh\nother:x:1002:1002::/home/other:/bin/sh'
    ]) {
      assert.throws(
        /* 单个目标账户必须有唯一有效系统记录。 */ () =>
          serviceAccountConfig('gateway', 'rovloom', /* 固定畸形记录。 */ () => record, 'linux'),
        { code: 'config_path_required' }
      )
    }
    for (const account of ['root', '../operator', '--root', 'A B']) {
      assert.throws(
        /* 非法账户在任何系统查询之前拒绝。 */ () =>
          serviceAccountConfig('gateway', account, /* 不应查询非法账户。 */ () => assert.fail()),
        { code: 'invalid_arguments' }
      )
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

test(
  '无法提供平台账户数据库时保留 backend_unavailable',
  /* 未实现的账户查询不得伪装成另一身份。 */ () => {
    assert.throws(
      /* 模拟宿主平台明确不可用。 */ () =>
        serviceAccountConfig(
          'gateway',
          'rovloom',
          /* 固定受控错误。 */ () => {
            throw new ServiceError('backend_unavailable')
          }
        ),
      { code: 'backend_unavailable' }
    )
  }
)
