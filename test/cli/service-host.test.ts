// 验证产品服务宿主的当前产物绑定、目标账户默认配置和只读预检；所有监管工具均为受控端口。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
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
import type { CommandPlan } from '../../src/service/runner.js'

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
        verifyProductServiceRuntime(
          spec,
          { platform: 'linux', arch: 'x64', executable: spec.executable, standalone: false },
          /* 不得调用任何系统工具。 */ async () => assert.fail()
        ),
      { code: 'backend_unavailable' }
    )
  }
)

if (process.platform === 'linux' && process.getuid?.() !== 0) {
  test(
    '服务配置预检保留原字节，以目标账户只读校验同一角色且不创建缺失配置',
    /* 仅使用自有工作区 fixture，无实际切换身份。 */ async () => {
      const root = mkdtempSync(join(process.cwd(), '.service-fixture-'))
      const state = join(root, 'state')
      mkdirSync(state, { mode: 0o700 })
      const config = join(root, 'gateway.json')
      const spec = { ...sampleSpec(), role: 'gateway' as const, config }
      const environment = { platform: 'linux', arch: 'x64', executable: spec.executable, standalone: true }
      const bytes = JSON.stringify(configDocument({ ...configTemplate('gateway'), state_dir: state }))
      const plans: CommandPlan[] = []
      // 云环境根目录并非 root 所有；隔离路径端口只核对参数，不把它称为真实安装权限证明。
      const verifyStatePath = async (path: string, owner: number, privateLeaf: boolean) => {
        assert.equal(path, state)
        assert.equal(owner, process.getuid!())
        assert.equal(privateLeaf, true)
      }
      try {
        writeFileSync(config, bytes, { mode: 0o600 })
        await verifyProductServiceRuntime(
          spec,
          environment,
          /* 仅记录 runuser 计划，不在测试中切换系统身份。 */ async (plan) => {
            plans.push(plan)
            return { code: 0, stdout: '', stderr: 'runtime_config_valid\n' }
          },
          verifyStatePath
        )
        assert.equal(readFileSync(config, 'utf8'), bytes)
        assert.deepEqual(plans[0], {
          executable: '/usr/sbin/runuser',
          args: [
            '--user',
            'rovloom',
            '--',
            spec.executable,
            'config',
            'check-runtime',
            '--role',
            'gateway',
            '--config',
            config
          ],
          timeout: 10000
        })
        await assert.rejects(
          /* 错配角色不能进入系统自检计划。 */ () =>
            verifyProductServiceRuntime(
              { ...spec, role: 'connector' },
              environment,
              /* 不应执行。 */ async () => assert.fail()
            ),
          { code: 'unsafe_installation' }
        )
        await assert.rejects(
          /* 子进程的未知输出不能冒充只读检查成功。 */ () =>
            verifyProductServiceRuntime(
              spec,
              environment,
              /* 合成未脱敏失败正文只能被拒绝。 */ async () => ({
                code: 0,
                stdout: 'SYNTHETIC_SECRET',
                stderr: ''
              }),
              verifyStatePath
            ),
          { code: 'unsafe_installation' }
        )
        await assert.rejects(
          /* 缺少文件不创建、不启动、也不继续工具计划。 */ () =>
            verifyProductServiceRuntime(
              { ...spec, config: join(root, 'missing.json') },
              environment,
              /* 不应执行。 */ async () => assert.fail()
            ),
          { code: 'ENOENT' }
        )
        assert.equal(plans.length, 1)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
}

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
          },
          'linux'
        ),
      { code: 'backend_unavailable' }
    )
  }
)
