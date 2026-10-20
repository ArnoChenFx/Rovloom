// 用纯平台参数验证Windows模板根因，不伪装在Linux执行Windows文件权限或产品产物。
import { configDocument } from '../../src/cli/config.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { configTemplate, parseConfig, selectedNativeProviders } from '../../src/cli/config.js'

test(
  '双角色模板在各平台生成本机规范绝对占位路径并经过同一严格解析',
  /* 独立于当前OS覆盖两种路径语义；Windows实际产物仍由原生CI smoke执行。 */ () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      for (const role of ['gateway', 'connector'] as const) {
        const template = configTemplate(role, platform)
        assert.equal(
          template.state_dir,
          platform === 'win32' ? `C:\\absolute\\protected\\rovloom\\${role}` : `/absolute/protected/rovloom/${role}`
        )
        assert.deepEqual(parseConfig(JSON.parse(JSON.stringify(configDocument(template))), platform), template)
        assert(Object.isFrozen(template))
        assert(
          !Object.keys(template).some(
            /* 模板不得因平台差异引入秘密或身份字段。 */ (key) => /secret|token|principal/.test(key)
          )
        )
      }
    }
  }
)

test(
  '原生业务安装目录只接受单个规范路径，拒绝argv/env、终端开关和PATH列表',
  /* 这些字段进入实际首次发现和固定Agent PATH，不能把JSON扩成任意进程配置。 */ () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const directory = platform === 'win32' ? 'C:\\rovloom\\bin' : '/opt/rovloom/bin'
      const value = {
        ...configDocument(configTemplate('connector', platform)),
        native: { runtime_bin_dir: directory, agent_bin_dir: directory }
      }
      const config = parseConfig(value, platform)
      assert.equal(config.role, 'connector')
      assert.deepEqual(configDocument(config).native, value.native)
      for (const native of [
        { binary: directory },
        { argv: [] },
        { env: {} },
        { allow_terminal_execution: true },
        { agent_bin_dir: directory + (platform === 'win32' ? ';' : ':') + directory },
        { runtime_bin_dir: true },
        { agent_bin_dir: '~/.local/bin' }
      ]) {
        assert.throws(
          /* 未声明的能力或多目录PATH输入均在角色parser前置拒绝。 */ () => parseConfig({ ...value, native }, platform)
        )
      }
    }
  }
)

test(
  '首次native选择只接受Luvus、Herdr或固定混合，省略时保留原Luvus路径',
  /* 业务选择不能变成动态模块、路径、空列表或任意provider注册接口。 */ () => {
    const value = configDocument(configTemplate('connector'))
    assert.deepEqual(selectedNativeProviders(parseConfig(value) as import('../../src/cli/config.js').ConnectorConfig), [
      'luvus'
    ])
    for (const provider of ['luvus', 'herdr', 'mixed'] as const) {
      const selected = parseConfig({
        ...value,
        native: { provider }
      }) as import('../../src/cli/config.js').ConnectorConfig
      assert.deepEqual(selectedNativeProviders(selected), provider === 'mixed' ? ['luvus', 'herdr'] : [provider])
      assert.deepEqual(configDocument(selected).native, { provider })
    }
    for (const provider of ['', 'custom', '/bin/herdr', ['luvus', 'herdr'], {}, null, 1]) {
      assert.throws(/* 无效选择在任何配对或原生进程之前拒绝。 */ () => parseConfig({ ...value, native: { provider } }))
    }
  }
)

test(
  'Windows模板修复不放宽真实路径规范性，拒绝drive相对路径、根目录及混合分隔符',
  /* 负例直接使用生产parseConfig的Windows路径分支，不绕过规范化相等检查。 */ () => {
    const windows = configTemplate('gateway', 'win32')
    for (const state_dir of [
      'C:relative',
      'C:\\',
      '/',
      '/absolute/protected/rovloom/gateway',
      'C:/absolute/protected/rovloom/gateway',
      'C:\\absolute\\..\\gateway',
      'C:\\absolute\\\\gateway',
      'C:\\absolute\\gateway\n'
    ]) {
      assert.throws(
        /* 路径仍须在目标平台绝对、非根且已规范化；模板不能成为放宽校验的例外。 */ () =>
          parseConfig({ ...configDocument(windows), data: { directory: state_dir } }, 'win32')
      )
    }
    assert.throws(
      /* 跨平台模板必须明确重新生成，不能把Windows路径用于POSIX。 */ () => parseConfig(configDocument(windows), 'linux')
    )
    assert.throws(
      /* POSIX模板不能靠忽略分隔符规范性在Windows上通过。 */ () =>
        parseConfig(configDocument(configTemplate('gateway', 'linux')), 'win32')
    )
  }
)
