// 使用纯合成 SID/ACE 验证私有数据权限判定，不创建 Windows 身份、ACL 或系统对象。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkWindowsPrivateAcl, type WindowsPrivateAce } from '../../src/storage/windows-private-acl.js'
import { checkWindowsAcl } from '../../src/update/windows/security.js'

const sid = 'S-1-5-21-1-2-3-1001'
const mine: WindowsPrivateAce = {
  kind: 'allow',
  sid,
  mask: 0x1f01ff,
  inheritOnly: false,
  fileInherit: true,
  directoryInherit: true
}

test(
  'Windows 私有数据拒绝更新器可接受的外部只读权限',
  /* 同一 ACE 证明两个策略的安全目标不同。 */ () => {
    const everyone: WindowsPrivateAce = { ...mine, sid: 'S-1-1-0', mask: 0x120089 }
    checkWindowsAcl(sid, [mine, everyone], sid, 'S-1-5-80-1', false)
    checkWindowsPrivateAcl(sid, [mine], sid, true, true)
    assert.throws(
      /* 外部读取会暴露数据，不能沿用安装器的仅防写策略。 */ () =>
        checkWindowsPrivateAcl(sid, [mine, everyone], sid, true, false)
    )
    assert.throws(
      /* deny 不被用于抵消未知授权。 */ () =>
        checkWindowsPrivateAcl(sid, [mine, everyone, { ...everyone, kind: 'deny' }], sid, true, false)
    )
  }
)

test(
  'Windows 私有目录要求当前 SID、受保护 DACL 及可供 journal 继承的权限',
  /* 仍保留未接线平台拒绝。 */ () => {
    for (const entries of [
      [],
      [{ ...mine, fileInherit: false }],
      [{ ...mine, directoryInherit: false }],
      [{ ...mine, inheritOnly: true }],
      [{ ...mine, mask: 0x120089 }]
    ]) {
      assert.throws(
        /* 不完整继承不能保证 SQLite 辅助文件私有。 */ () => checkWindowsPrivateAcl(sid, entries, sid, true, true)
      )
    }
    assert.throws(
      /* 管理员所有权不是当前用户私有所有权证明。 */ () =>
        checkWindowsPrivateAcl('S-1-5-32-544', [mine], sid, true, true)
    )
    assert.throws(
      /* 未保护 DACL 不能依赖祖先未来保持安全。 */ () => checkWindowsPrivateAcl(sid, [mine], sid, false, true)
    )
    assert.throws(
      /* 未知访问掩码必须拒绝。 */ () => checkWindowsPrivateAcl(sid, [{ ...mine, mask: -1 }], sid, true, false)
    )
    assert.throws(
      /* 缺少已验证私有父目录时，不接受未保护文件DACL。 */ () => checkWindowsPrivateAcl(sid, [mine], sid, false, false)
    )
    checkWindowsPrivateAcl(sid, [mine], sid, false, false, true)
    assert.throws(
      /* journal继承只适用于文件，不能以父级证明放宽目录保护。 */ () =>
        checkWindowsPrivateAcl(sid, [mine], sid, false, true, true)
    )
  }
)
