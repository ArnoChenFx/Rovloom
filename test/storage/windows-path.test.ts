// 用跨平台纯字符串负例验证 Windows 路径边界，不创建 Windows 账户或访问真实文件。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { windowsStorageAncestors, windowsStoragePath } from '../../src/storage/windows-path.js'

test(
  'Windows 私有路径只接受规范本地 DOS 组件及卷根',
  /* 正常用户路径与空格不需要 shell 转义。 */ () => {
    assert.equal(windowsStoragePath('C:\\'), 'C:\\')
    assert.equal(
      windowsStoragePath('C:\\Users\\fixture\\private data\\gateway.db'),
      'C:\\Users\\fixture\\private data\\gateway.db'
    )
    assert.deepEqual(windowsStorageAncestors('D:\\private\\state'), ['D:\\', 'D:\\private', 'D:\\private\\state'])
  }
)

test(
  'Windows 私有路径拒绝 ADS、折叠、命名空间和保留设备别名',
  /* 同一策略用于路径预检与实际句柄打开。 */ () => {
    for (const path of [
      '',
      'relative',
      'C:relative',
      '\\\\server\\share\\db',
      '\\\\?\\C:\\db',
      'C:/db',
      'C:\\a\\..\\db',
      'C:\\a\\\\db',
      'C:\\a\\',
      'C:\\db:stream',
      'C:\\a.\\db',
      'C:\\a \\db',
      'C:\\CON',
      'C:\\con.txt',
      'C:\\COM¹.txt',
      'C:\\LPT²',
      'C:\\CONIN$',
      'C:\\NUL.db',
      'C:\\bad\0name',
      'C:\\bad\nname',
      'C:\\bad?name',
      'C:\\' + 'x'.repeat(256)
    ]) {
      assert.throws(/* 任意别名都在访问磁盘或 DLL 前拒绝。 */ () => windowsStoragePath(path), /invalid_storage_path/)
    }
  }
)
