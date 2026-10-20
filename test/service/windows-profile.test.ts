// 固定LocalService账户home解析与真实只读注册表探针；不创建profile、账户、token或文件ACL。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { windowsServiceHome } from '../../src/service/windows-profile.js'
import { serviceAccountConfig } from '../../src/cli/service-host.js'

test(
  'LocalService缺省路径仅来自固定系统账户记录，不展开任意环境或借用管理员home',
  /* 纯记录端口不加载原生库。 */ () => {
    const valid = { path: '%SystemRoot%\\ServiceProfiles\\LocalService', expanded: true, windows: 'C:\\Windows' }
    assert.equal(
      windowsServiceHome(/* 合成系统API记录。 */ () => valid),
      'C:\\Windows\\ServiceProfiles\\LocalService'
    )
    assert.equal(
      serviceAccountConfig('gateway', 'S-1-5-19', /* 显式固定目标身份的合成home。 */ () => 'C:\\服务', 'win32'),
      'C:\\服务\\.config\\rovloom\\gateway.json'
    )
    for (const path of ['%USERPROFILE%\\home', 'relative', 'C:\\a\\..\\b', 'C:\\a:stream', 'C:\\a\u0000b']) {
      assert.throws(
        /* 未受信路径不能回退到当前管理员HOME。 */ () =>
          windowsServiceHome(/* 本次反例记录。 */ () => ({ ...valid, path })),
        { code: 'config_path_required' }
      )
    }
    assert.throws(
      /* Windows不接受任意用户名或SYSTEM。 */ () => serviceAccountConfig('gateway', 'SYSTEM', undefined, 'win32'),
      { code: 'invalid_arguments' }
    )
  }
)

if (process.platform === 'win32') {
  test(
    'Windows系统64位profile记录只读解析LocalService并复用角色路径规则',
    /* 读取已有HKLM键，不创建真实身份或启动服务。 */ () => {
      const home = windowsServiceHome()
      assert(/^[A-Za-z]:\\/u.test(home))
      assert.equal(serviceAccountConfig('gateway', 'S-1-5-19'), home + '\\.config\\rovloom\\gateway.json')
      assert.equal(serviceAccountConfig('connector', 'S-1-5-19'), home + '\\.config\\rovloom\\connector.json')
    }
  )
}
