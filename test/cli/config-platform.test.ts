// 用纯平台参数验证Windows模板根因，不伪装在Linux执行Windows文件权限或产品产物。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { configTemplate, parseConfig } from '../../src/cli/config.js'

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
        assert.deepEqual(parseConfig(JSON.parse(JSON.stringify(template)), platform), template)
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
          parseConfig({ ...windows, state_dir }, 'win32')
      )
    }
    assert.throws(/* 跨平台模板必须明确重新生成，不能把Windows路径用于POSIX。 */ () => parseConfig(windows, 'linux'))
    assert.throws(
      /* POSIX模板不能靠忽略分隔符规范性在Windows上通过。 */ () =>
        parseConfig(configTemplate('gateway', 'linux'), 'win32')
    )
  }
)
