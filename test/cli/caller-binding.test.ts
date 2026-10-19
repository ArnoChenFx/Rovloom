// 验证受保护本机caller文件只解析当前OS身份，撤销即时生效且不能附带权限或秘密。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { createLocalCallerProvider } from '../../src/cli/index.js'

// 为每个测试分配私有目录与完整OS绑定，测试结束清理且不访问宿主现有配置。
async function isolated(check: (path: string, row: ReturnType<typeof binding>) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'rovloom-caller-binding-'))
  const path = join(directory, 'callers.json')
  try {
    await check(path, binding())
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

// 使用当前真实POSIX身份与固定合成principal，既不签发凭据也不创建权限。
function binding() {
  const os = userInfo()
  return { ref: 'local-stdio', uid: os.uid, gid: os.gid, principal_id: 'alice' }
}

// 写入当前测试拥有的私有文件；内容全部为非秘密绑定或明确拒绝的合成负例。
function write(path: string, rows: unknown[], extra: Record<string, unknown> = {}) {
  writeFileSync(path, JSON.stringify({ schema_version: 1, bindings: rows, ...extra }), { mode: 0o600 })
}

test(
  '本机caller按同一ref/uid/gid解析已有principal，每次重读且不接受伪造OS身份',
  /* 更新和移除真实私有文件，验证身份不从环境或旧缓存恢复。 */ async () => {
    await isolated(
      /* 只在本例目录中模拟本机绑定的合法更新与撤销。 */ async (path, row) => {
        write(path, [row])
        const caller = createLocalCallerProvider(path, row.ref)
        const identity = { uid: row.uid, gid: row.gid }
        const selected = await caller.resolve(identity)
        assert.deepEqual(selected, { principal_id: 'alice' })
        assert(Object.isFrozen(selected))
        assert.equal(await caller.resolve({ uid: row.uid + 1, gid: row.gid }), null)
        assert.equal(await caller.resolve({ uid: row.uid, gid: row.gid + 1 }), null)
        assert.equal(await createLocalCallerProvider(path, 'unknown').resolve(identity), null)
        write(path, [{ ...row, principal_id: 'bob' }])
        assert.deepEqual(await caller.resolve(identity), { principal_id: 'bob' })
        write(path, [])
        assert.equal(await caller.resolve(identity), null)
        unlinkSync(path)
        assert.equal(await caller.resolve(identity), null)
      }
    )
  }
)

test(
  '歧义绑定、额外权限或秘密、重复JSON键及非法编码统一拒绝且不反射内容',
  /* 将不可信结构写入测试文件，验证绑定解析失败关闭而不是选择最后一条记录。 */ async () => {
    await isolated(
      /* 使用固定合成标记验证拒绝，不读取或输出任何真实秘密。 */ async (path, row) => {
        const caller = createLocalCallerProvider(path, row.ref)
        const identity = { uid: row.uid, gid: row.gid }
        for (const rows of [
          [row, { ...row, principal_id: 'admin' }],
          [{ ...row, principal_id: '../admin' }],
          [{ ...row, uid: String(row.uid) }],
          [{ ...row, gid: -1 }],
          [{ ...row, permissions: { admin: true } }],
          [{ ...row, token: 'SYNTHETIC_NOT_A_CREDENTIAL' }]
        ]) {
          write(path, rows)
          assert.equal(await caller.resolve(identity), null)
        }
        write(path, [row], { principal_id: 'admin' })
        assert.equal(await caller.resolve(identity), null)
        writeFileSync(path, '{"schema_version":0,"schema_version":1,"bindings":' + JSON.stringify([row]) + '}')
        assert.equal(await caller.resolve(identity), null)
        writeFileSync(path, Buffer.from([0xff]))
        assert.equal(await caller.resolve(identity), null)
        writeFileSync(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')]))
        assert.equal(await caller.resolve(identity), null)
        assert.throws(
          /* 宿主引用也必须是稳定非秘密标识，不能用路径或URL选择来源。 */ () =>
            createLocalCallerProvider(path, 'file:///private/callers'),
          /Rovloom command failed/
        )
      }
    )
  }
)

test(
  'caller绑定沿用私有regular文件门禁，权限放宽、symlink或超限均撤销本次解析',
  /* 逐项改变测试文件保护，验证真实身份即使匹配也不能绕过文件可信性检查。 */ async () => {
    await isolated(
      /* 文件和父目录均属本例，改变保护后立即检查当前请求的拒绝。 */ async (path, row) => {
        write(path, [row])
        const identity = { uid: row.uid, gid: row.gid }
        const caller = createLocalCallerProvider(path, row.ref)
        chmodSync(path, 0o644)
        assert.equal(await caller.resolve(identity), null)
        chmodSync(path, 0o600)
        const link = path + '.link'
        symlinkSync(path, link)
        assert.equal(await createLocalCallerProvider(link, row.ref).resolve(identity), null)
        writeFileSync(path, 'x'.repeat(16_385))
        assert.equal(await caller.resolve(identity), null)
        write(path, [row])
        const directory = dirname(path)
        chmodSync(directory, 0o755)
        assert.equal(await caller.resolve(identity), null)
        chmodSync(directory, 0o700)
        assert.deepEqual(await caller.resolve(identity), { principal_id: 'alice' })
      }
    )
  }
)
