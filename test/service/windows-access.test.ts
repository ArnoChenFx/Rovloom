// SID访问模型只在Windows用真实Authz运行；安全描述符仅存在内存，不修改任何真实文件ACL或账户。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { windowsAccountHasAccess, WINDOWS_SERVICE_ACCESS } from '../../src/service/windows-access.js'

test(
  'service访问请求拒绝非文件访问掩码和不合法SID，未进入系统库',
  /* 非法输入在任何FFI前失败。 */ () => {
    for (const [sid, mask] of [
      ['not-a-sid', 1],
      ['S-1-5-19', 0],
      ['S-1-5-19', 0x10000000]
    ] as const) {
      assert.throws(/* 固定输入拒绝不能调用平台回退。 */ () => windowsAccountHasAccess('O:SYD:P', sid, mask), {
        code: 'invalid_arguments'
      })
    }
  }
)

if (process.platform === 'win32') {
  test(
    '真实Authz对LocalService评估显式读授权、写拒绝及不完整DACL',
    /* 不创建登录token或计划任务。 */ () => {
      const read = 'O:SYG:SYD:P(A;;0x120089;;;LS)'
      assert.equal(windowsAccountHasAccess(read, 'S-1-5-19', WINDOWS_SERVICE_ACCESS.read), true)
      assert.equal(windowsAccountHasAccess(read, 'S-1-5-19', WINDOWS_SERVICE_ACCESS.dataDirectory), false)
      assert.equal(windowsAccountHasAccess('O:SYG:SYD:P(A;;FA;;;SY)', 'S-1-5-19', WINDOWS_SERVICE_ACCESS.read), false)
      for (const descriptor of ['O:SYG:SY', 'O:SYG:SYD:P(D;;FR;;;WD)(A;;FA;;;LS)']) {
        assert.throws(
          /* 缺DACL或deny可能涉及服务登录组，保守拒绝而非套管理员身份。 */ () =>
            windowsAccountHasAccess(descriptor, 'S-1-5-19', WINDOWS_SERVICE_ACCESS.read)
        )
      }
    }
  )
}
