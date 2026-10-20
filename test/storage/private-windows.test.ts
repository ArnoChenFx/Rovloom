// 在 Windows 自有临时目录验收真实句柄、ACL、junction、ADS 与 SQLite lease；不创建账户、服务或生产身份。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import {
  existsSync,
  linkSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import {
  createWindowsPrivate,
  ensureWindowsPrivateDirectory,
  readWindowsPrivate,
  retainWindowsDatabase,
  syncWindowsPrivate,
  windowsManagedBytes,
  windowsPrivateFile,
  windowsPrivatePath,
  windowsPrivateStamp,
  writeWindowsPrivateAtomic
} from '../../src/storage/private-windows.js'
import { windowsLibrary, windowsPointer, windowsWide } from '../../src/update/windows/native.js'
import { windowsCurrentSid } from '../../src/update/windows/security.js'

// 根目录由待测原生 API 直接新建私有 DACL，不能将默认继承的 mkdtemp 目录修复成成功fixture。
function temporary(check: (root: string) => void): void {
  const root = join(tmpdir(), 'rovloom-win-private-' + randomUUID())
  ensureWindowsPrivateDirectory(root)
  try {
    check(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// 仅给本例刚创建的fixture添加外部读取负例；不接受根目录以外的路径或修改系统ACL。
function exposeFixture(path: string, root: string): void {
  assert(path.startsWith(root + sep))
  const security = windowsLibrary<{
    ConvertStringSecurityDescriptorToSecurityDescriptorW(
      text: Buffer,
      revision: number,
      output: Buffer,
      size: number
    ): number
    SetFileSecurityW(path: Buffer, information: number, descriptor: number): number
  }>('advapi32', {
    ConvertStringSecurityDescriptorToSecurityDescriptorW: { args: ['buffer', 'u32', 'buffer', 'ptr'], returns: 'i32' },
    SetFileSecurityW: { args: ['buffer', 'u32', 'ptr'], returns: 'i32' }
  })
  const kernel = windowsLibrary<{ LocalFree(pointer: bigint): bigint }>('kernel32', {
    LocalFree: { args: ['u64'], returns: 'u64' }
  })
  const output = Buffer.alloc(8)
  const sid = windowsCurrentSid()
  const sddl = 'O:' + sid + 'D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;' + sid + ')(A;OICI;FR;;;WD)'
  assert.notEqual(security.ConvertStringSecurityDescriptorToSecurityDescriptorW(windowsWide(sddl), 1, output, 0), 0)
  const allocation = output.readBigUInt64LE()
  try {
    assert.notEqual(security.SetFileSecurityW(windowsWide(path), 0x80000004, windowsPointer(allocation)), 0)
  } finally {
    assert.equal(kernel.LocalFree(allocation), 0n)
  }
}

test(
  'Windows 原生私有创建、同句柄读取、排他原子发布与带代次替换',
  /* 验收真实落盘及错误路径，不mock Win32。 */ () => {
    if (process.platform !== 'win32') {
      assert.throws(
        /* 非本机不能假装已验证原生文件层。 */ () => windowsPrivatePath('C:\\fixture\\db'),
        /unsupported_storage_platform/
      )
      return
    }
    temporary(
      /* 所有字节和路径都在本例新建私有根。 */ (root) => {
        const path = join(root, 'config.json')
        createWindowsPrivate(path, '{"synthetic":1}')
        assert.equal(readWindowsPrivate(path, 1024).toString(), '{"synthetic":1}')
        assert.throws(/* CREATE_NEW 不能覆盖既有文件。 */ () => createWindowsPrivate(path), /EEXIST/)
        assert.throws(/* 实际文件超过预算仍拒绝。 */ () => readWindowsPrivate(path, 4))
        const before = windowsPrivateStamp(path)
        assert.throws(
          /* 新配置发布不携带覆盖标志。 */ () => writeWindowsPrivateAtomic(path, '{"synthetic":2}'),
          /EEXIST/
        )
        assert.equal(windowsPrivateStamp(path), before)
        writeWindowsPrivateAtomic(path, '{"synthetic":2}', true, before)
        assert.equal(readWindowsPrivate(path, 1024).toString(), '{"synthetic":2}')
        assert.throws(
          /* 旧文件ID/时间/ACL摘要不能覆盖新一代。 */ () => writeWindowsPrivateAtomic(path, '{}', true, before),
          /config_changed/
        )
        const newPath = join(root, 'new.json')
        writeWindowsPrivateAtomic(newPath, '{"synthetic":3}')
        syncWindowsPrivate(newPath)
        assert.equal(readWindowsPrivate(newPath, 1024).toString(), '{"synthetic":3}')
        assert.deepEqual(readdirSync(root).sort(), ['config.json', 'new.json'])
      }
    )
  }
)

test(
  'Windows 实际句柄拒绝硬链接、ADS 与 junction 祖先',
  /* 不需要提升符号链接特权；junction仅指向自有目录。 */ () => {
    if (process.platform !== 'win32') {
      return
    }
    temporary(
      /* 默认数据流、硬链接及挂载点全部只引用fixture。 */ (root) => {
        const directory = join(root, 'state')
        ensureWindowsPrivateDirectory(directory)
        const path = join(directory, 'private.json')
        createWindowsPrivate(path, '{"synthetic":true}')
        const hard = join(directory, 'hard.json')
        linkSync(path, hard)
        assert.throws(/* 同一文件对象的额外名字不能绕过单链接边界。 */ () => windowsPrivateFile(path))
        unlinkSync(hard)
        const stream = path + ':fixture'
        writeFileSync(stream, 'synthetic-stream')
        assert.throws(/* 附加数据流不能被默认流读取静默忽略。 */ () => readWindowsPrivate(path, 1024))
        unlinkSync(stream)
        assert.equal(readWindowsPrivate(path, 1024).toString(), '{"synthetic":true}')
        const alias = join(root, 'alias')
        symlinkSync(directory, alias, 'junction')
        assert.throws(
          /* OPEN_REPARSE_POINT实际打开祖先，不能经junction别名访问。 */ () =>
            readWindowsPrivate(join(alias, 'private.json'), 1024)
        )
        assert.throws(/* 配额遍历同样拒绝junction，而非递归到别处。 */ () => windowsManagedBytes(root))
      }
    )
  }
)

test(
  'Windows 实际外部只读ACL在私有数据中拒绝，已有目录权限不修复',
  /* 只变更自有fixture的DACL用于负例。 */ () => {
    if (process.platform !== 'win32') {
      return
    }
    temporary(
      /* 根目录保持私有，额外读取授权仍必须被检查出来。 */ (root) => {
        const path = join(root, 'exposed.json')
        createWindowsPrivate(path, '{"synthetic":"fixture"}')
        exposeFixture(path, root)
        assert.throws(
          /* Windows默认遍历特权使父目录私有不足以证明文件保密。 */ () => readWindowsPrivate(path, 1024),
          /unsafe_storage_acl/
        )
        assert.equal(readFileSync(path, 'utf8'), '{"synthetic":"fixture"}')
        assert.throws(/* 第一次拒绝不会自动修复该DACL。 */ () => windowsPrivateFile(path), /unsafe_storage_acl/)
        const directory = join(root, 'exposed-directory')
        ensureWindowsPrivateDirectory(directory)
        exposeFixture(directory, root)
        assert.throws(
          /* 已有宽松目录不能被本机配置创建器修复。 */ () => ensureWindowsPrivateDirectory(directory),
          /unsafe_storage_acl/
        )
        assert.throws(
          /* 父目录不私有时连临时正文也不写入。 */ () =>
            writeWindowsPrivateAtomic(join(directory, 'must-not-exist.json'), 'synthetic')
        )
        assert.deepEqual(readdirSync(directory), [])
      }
    )
  }
)

test(
  'Windows SQLite实际journal继承保密，lease阻止文件/祖先改名且辅助文件预检拒绝泄漏',
  /* 只写本例空业务表，无设备或凭据。 */ () => {
    if (process.platform !== 'win32') {
      return
    }
    temporary(
      /* 实际SQLite生命周期与原生句柄兼容性由Windows内核验证。 */ (root) => {
        const directory = join(root, 'state')
        ensureWindowsPrivateDirectory(directory)
        const path = join(directory, 'gateway.db')
        createWindowsPrivate(path)
        const release = retainWindowsDatabase(path)
        let db: DatabaseSync | undefined
        try {
          db = new DatabaseSync(path)
          db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE fixture(value TEXT);')
          db.exec("BEGIN IMMEDIATE; INSERT INTO fixture VALUES('synthetic');")
          assert.equal(existsSync(path + '-journal'), true)
          windowsPrivateFile(path + '-journal')
          assert(windowsManagedBytes(directory) > 0)
          assert.throws(/* 数据库同一对象在lease生存期不能换名。 */ () => renameSync(path, path + '.moved'))
          assert.throws(/* 直接父目录同样不能被换名并替换。 */ () => renameSync(directory, directory + '.moved'))
          db.exec('COMMIT')
          db.close()
          db = undefined
          assert.throws(/* SQLite关闭本身不代表调用方已释放原生lease。 */ () => renameSync(path, path + '.moved'))
        } finally {
          try {
            db?.close()
          } finally {
            release()
          }
        }
        renameSync(path, path + '.moved')
        renameSync(path + '.moved', path)
        const reopenedLease = retainWindowsDatabase(path)
        const reopened = new DatabaseSync(path)
        try {
          assert.equal(reopened.prepare('SELECT value FROM fixture').get()!.value, 'synthetic')
        } finally {
          try {
            reopened.close()
          } finally {
            reopenedLease()
          }
        }
        createWindowsPrivate(path + '-journal', 'synthetic-invalid-journal')
        exposeFixture(path + '-journal', root)
        assert.throws(
          /* SQLite打开前拒绝既有可泄漏journal；不能依赖未来继承修复。 */ () => retainWindowsDatabase(path),
          /unsafe_storage_acl/
        )
      }
    )
  }
)
