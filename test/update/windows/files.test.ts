// Windows 文件原语使用自有临时 PE 样例；ACL 纯模型与 Windows 实机文件验收明确分列。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { checkWindowsAcl } from '../../../src/update/windows/security.js'
import {
  WindowsPathLease,
  readWindowsExecutable,
  readWindowsExecutableSecurity,
  replaceWindowsExecutable,
  writeWindowsReceipt
} from '../../../src/update/windows/files.js'
import { parseWindowsReceipt, windowsReceiptExit } from '../../../src/update/windows/protocol.js'
import { runSystemCommand } from '../../../src/service/runner.js'

declare const Bun: { build(options: unknown): Promise<{ success: boolean }> }

test(
  'Windows ACL policy refuses untrusted write/owner rights without treating deny as a repair',
  /* 纯模型：继承仅传播 ACE 不授权当前目录；祖先创建其它子目录不等于可替换已保护组件。 */ () => {
    const user = 'S-1-5-21-1-2-3-1001'
    const installer = 'S-1-5-80-123'
    const outsider = 'S-1-5-32-545'
    for (const mask of [0x10000, 0x40000, 0x80000, 0x40000000, 0x10000000, 2, 16, 256]) {
      assert.throws(
        /* 不可信账户的删除、写元数据或写安全边界均拒绝。 */ () =>
          checkWindowsAcl(user, [{ kind: 'allow', sid: outsider, mask, inheritOnly: false }], user, installer, true),
        { code: 'unsafe_installation' }
      )
    }
    assert.throws(
      /* owner 本身可改 DACL，不因只读 allow 列表被信任。 */ () =>
        checkWindowsAcl(outsider, [], user, installer, false),
      { code: 'unsafe_installation' }
    )
    assert.throws(
      /* deny 不能让模块忽略仍存在的不可信 allow。 */ () =>
        checkWindowsAcl(
          user,
          [
            { kind: 'deny', sid: outsider, mask: 0xffffffff, inheritOnly: false },
            { kind: 'allow', sid: outsider, mask: 2, inheritOnly: false }
          ],
          user,
          installer,
          false
        ),
      { code: 'unsafe_installation' }
    )
    checkWindowsAcl(user, [{ kind: 'allow', sid: outsider, mask: 4, inheritOnly: false }], user, installer, true)
    assert.throws(
      /* 同一位在叶文件意味着可追加数据，不能安全替换。 */ () =>
        checkWindowsAcl(user, [{ kind: 'allow', sid: outsider, mask: 4, inheritOnly: false }], user, installer, false),
      { code: 'unsafe_installation' }
    )
    checkWindowsAcl(
      user,
      [{ kind: 'allow', sid: outsider, mask: 0xffffffff, inheritOnly: true }],
      user,
      installer,
      true
    )
  }
)

test(
  'native Windows fixture preserves owner/DACL, keeps the old PE, writes receipts and rolls back',
  { skip: process.platform !== 'win32', timeout: 45_000 },
  /* 真实 Win32/NTFS 文件与版本进程验收；尚不表示完整父退出/服务交接状态机已交付。 */ async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'rovloom-windows-files-')))
    let lease: WindowsPathLease | undefined
    const executable = join(root, 'rovloom.exe')
    try {
      for (const [version, name] of [
        ['0.1.0-dev', 'old.exe'],
        ['0.1.1', 'next.exe']
      ]) {
        const result = await Bun.build({
          entrypoints: [fileURLToPath(new URL('../posix/probe.ts', import.meta.url))],
          target: 'bun',
          env: 'disable',
          define: { UPDATE_PROBE_VERSION: JSON.stringify(version) },
          compile: {
            outfile: join(root, name!),
            autoloadDotenv: false,
            autoloadBunfig: false,
            autoloadTsconfig: false,
            autoloadPackageJson: false
          }
        })
        assert.equal(result.success, true)
      }
      await fs.copyFile(join(root, 'old.exe'), executable)
      const arch = process.arch as 'x64' | 'arm64'
      const original = readWindowsExecutable(executable, arch)
      const originalSecurity = readWindowsExecutableSecurity(executable)
      const alias = join(root, 'alias.exe')
      await fs.link(executable, alias)
      assert.throws(/* 额外硬链接不能被默默替换。 */ () => readWindowsExecutable(executable, arch), {
        code: 'unsafe_installation'
      })
      await fs.unlink(alias)
      await fs.writeFile(executable + ':fixture-ads', 'isolated fixture data')
      assert.throws(/* 未支持的 ADS 不被复制或清空。 */ () => readWindowsExecutable(executable, arch), {
        code: 'unsafe_installation'
      })
      await fs.unlink(executable + ':fixture-ads')
      lease = WindowsPathLease.acquire(executable)
      const transactionId = randomBytes(16).toString('hex')
      const directory = lease.createDirectory(transactionId)
      await fs.writeFile(join(directory, 'candidate.exe'), await fs.readFile(join(root, 'next.exe')), { flag: 'wx' })
      const next = readWindowsExecutable(join(directory, 'candidate.exe'), arch)
      const receipt = {
        schemaVersion: 1,
        transactionId,
        jobSha256: 'a'.repeat(64),
        sequence: 1,
        state: 'prepared',
        code: null
      }
      writeWindowsReceipt(lease, transactionId, 1, Buffer.from(JSON.stringify(receipt)))
      replaceWindowsExecutable(lease, transactionId)
      const installed = readWindowsExecutable(executable, arch)
      assert.equal(installed.fileId, next.fileId)
      assert.equal(installed.sha256, next.sha256)
      assert.deepEqual(readWindowsExecutableSecurity(executable), originalSecurity)
      assert.equal(installed.security, original.security)
      assert.equal(readWindowsExecutable(join(directory, 'previous.exe'), arch).fileId, original.fileId)
      assert.deepEqual(await runSystemCommand({ executable, args: ['--version'], timeout: 10000 }), {
        code: 0,
        stdout: '',
        stderr: 'Rovloom 0.1.1\n'
      })
      writeWindowsReceipt(
        lease,
        transactionId,
        2,
        Buffer.from(JSON.stringify({ ...receipt, sequence: 2, state: 'updated' }))
      )
      assert.equal(windowsReceiptExit(parseWindowsReceipt(await fs.readFile(join(directory, 'receipt.json')))), 0)
      replaceWindowsExecutable(lease, transactionId, true)
      const restored = readWindowsExecutable(executable, arch)
      assert.equal(restored.fileId, original.fileId)
      assert.equal(restored.sha256, original.sha256)
      assert.equal(restored.security, original.security)
      assert.equal(readWindowsExecutable(join(directory, 'rejected.exe'), arch).fileId, next.fileId)
      assert.deepEqual(await runSystemCommand({ executable, args: ['--version'], timeout: 10000 }), {
        code: 0,
        stdout: '',
        stderr: 'Rovloom 0.1.0-dev\n'
      })
      writeWindowsReceipt(
        lease,
        transactionId,
        3,
        Buffer.from(JSON.stringify({ ...receipt, sequence: 3, state: 'rolled_back', code: 'verification_failed' }))
      )
      assert.equal(windowsReceiptExit(parseWindowsReceipt(await fs.readFile(join(directory, 'receipt.json')))), 6)
    } finally {
      lease?.close()
      await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    }
  }
)
