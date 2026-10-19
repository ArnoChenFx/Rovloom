// 只在自有临时目录验收 Linux 暂存锁、短写及失败清理；不替换安装、停止服务或改用户数据。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { updatePlatform } from '../../src/update/contract.js'
import { checkForUpdate } from '../../src/update/plan.js'
import { withStagedUpdate, type UpdateStagingFiles } from '../../src/update/staging.js'
import { fixture } from './fixtures.js'

// 每次构造自有 0700 根，只在测试结束删除该根；其它 OS 只验证保守拒绝。
async function isolated(run: (root: string) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'rovloom-update-test-')))
  await fs.chmod(root, 0o700)
  try {
    await run(root)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

// 从固定合成元数据创建待测试的可用计划，不请求外部 Release。
async function planned() {
  const f = fixture()
  const plan = await checkForUpdate(f.network, '1.0.0', updatePlatform('linux', 'x64'))
  return { f, plan }
}

test(
  'private staging is nonexecutable, verified, cross-instance locked and fully cleaned',
  /* 真实落盘仅限自有临时根。 */ async () => {
    const { f, plan } = await planned()
    await isolated(
      /* 暂存期间保留配置和数据库样例原字节。 */ async (root) => {
        if (process.platform !== 'linux') {
          await assert.rejects(
            /* 未有 ACL 适配器前不能按 mode 猜测 macOS/Windows 安全性。 */ () =>
              withStagedUpdate(root, f.network, plan, /* 不应到达候选检查。 */ async () => assert.fail()),
            { code: 'replacement_unavailable' }
          )
          return
        }
        await fs.writeFile(join(root, 'gateway.json'), 'config fixture')
        await fs.writeFile(join(root, 'state.db'), 'database fixture')
        const value = await withStagedUpdate(
          root,
          f.network,
          plan,
          /* 只读候选，绝不执行。 */ async (staged) => {
            assert.deepEqual(await fs.readFile(staged.path), f.payload)
            assert.equal((await fs.stat(staged.path)).mode & 0o777, 0o600)
            assert.equal(staged.receipt.sha256, plan.asset.sha256)
            await assert.rejects(
              /* 同一根的第二实例立即失败，不等待或清除旧锁。 */ () =>
                withStagedUpdate(root, f.network, plan, /* 锁冲突时不进入候选阶段。 */ async () => assert.fail()),
              { code: 'update_busy' }
            )
            return 17
          }
        )
        assert.equal(value, 17)
        assert.deepEqual((await fs.readdir(root)).sort(), ['gateway.json', 'state.db'])
        assert.equal(await fs.readFile(join(root, 'gateway.json'), 'utf8'), 'config fixture')
        assert.equal(await fs.readFile(join(root, 'state.db'), 'utf8'), 'database fixture')
        await withStagedUpdate(root, f.network, plan, /* 释放锁后下一次操作可进入。 */ async () => {})
      }
    )
  }
)

test(
  'checksum, callback and file write failures clean only owned temporary files',
  /* 故障不会保留候选或误报成功。 */ async () => {
    if (process.platform !== 'linux') {
      return
    }
    const { f, plan } = await planned()
    await isolated(
      /* 故障路径共同复用自有根。 */ async (root) => {
        await assert.rejects(
          /* 摘要不匹配不得交给候选观察者。 */ () =>
            withStagedUpdate(
              root,
              {
                fetch: /* 返回同大小坏字节。 */ async () => new Response(Buffer.alloc(f.payload.byteLength))
              },
              plan,
              /* 校验失败时不能进入。 */ async () => assert.fail()
            ),
          { code: 'checksum_mismatch' }
        )
        assert.deepEqual(await fs.readdir(root), [])
        await assert.rejects(
          /* 后续验证错误必须清理并传播非零类别。 */ () =>
            withStagedUpdate(
              root,
              f.network,
              plan,
              /* 模拟业务可用性验证失败。 */ async () => {
                throw new Error('private failure')
              }
            ),
          { code: 'staging_failed' }
        )
        assert.deepEqual(await fs.readdir(root), [])
        const denied = Object.assign(new Error('private path'), { code: 'EACCES' })
        const files: UpdateStagingFiles = {
          ...fs,
          // 注入打开失败，清理不得 unlink 未被本次成功创建的文件。
          open: async () => {
            throw denied
          },
          // 未创建文件就调用删除属于越权清理。
          unlink: async () => assert.fail('unowned unlink')
        }
        await assert.rejects(
          /* 没有静默提权重试。 */ () =>
            withStagedUpdate(root, f.network, plan, /* 文件错误不能进入候选阶段。 */ async () => assert.fail(), files),
          { code: 'permission_denied' }
        )
        assert.deepEqual(await fs.readdir(root), [])
      }
    )
  }
)

test(
  'filesystem short writes are completed and zero writes fail without success',
  /* 使用真实临时句柄但注入短写结果。 */ async () => {
    if (process.platform !== 'linux') {
      return
    }
    const { f, plan } = await planned()
    await isolated(
      /* 模型文件系统只代理自有临时文件。 */ async (root) => {
        let zero = false
        const files: UpdateStagingFiles = {
          ...fs,
          // 为测试保留原句柄的方法，只把每次写入限制为三个字节。
          open: async (...args: Parameters<typeof fs.open>) => {
            const file = await fs.open(...args)
            const write = file.write.bind(file)
            file.write = /* 固定下载器使用的 buffer/offset/length 形状。 */ (async (
              buffer: Uint8Array,
              offset: number,
              length: number
            ) => {
              if (zero) {
                return { bytesWritten: 0, buffer }
              }
              return await write(buffer, offset, Math.min(length, 3))
            }) as typeof file.write
            return file
          }
        }
        await withStagedUpdate(
          root,
          f.network,
          plan,
          /* 短写后文件必须仍逐字节完整。 */ async (staged) => {
            assert.deepEqual(await fs.readFile(staged.path), f.payload)
          },
          files
        )
        zero = true
        await assert.rejects(
          /* 零进展不能死循环。 */ () =>
            withStagedUpdate(root, f.network, plan, /* 写失败时没有已验证候选。 */ async () => assert.fail(), files),
          { code: 'staging_failed' }
        )
        assert.deepEqual(await fs.readdir(root), [])
      }
    )
  }
)

test(
  'symlink roots, shared writable roots and preexisting locks are never adopted or removed',
  /* 拒绝不安全命名空间和未知锁。 */ async () => {
    if (process.platform !== 'linux') {
      return
    }
    const { f, plan } = await planned()
    await isolated(
      /* 恶意链接样例仍全部位于自有临时根。 */ async (root) => {
        const child = join(root, 'private')
        await fs.mkdir(child, { mode: 0o700 })
        const alias = join(root, 'alias')
        await fs.symlink(child, alias)
        await assert.rejects(
          /* 符号链接不能作为暂存根。 */ () =>
            withStagedUpdate(alias, f.network, plan, /* 不安全根不可进入候选。 */ async () => assert.fail()),
          { code: 'unsafe_staging' }
        )
        await fs.chmod(child, 0o777)
        await assert.rejects(
          /* 共享可写根不可接管。 */ () =>
            withStagedUpdate(child, f.network, plan, /* 不安全根不可进入候选。 */ async () => assert.fail()),
          { code: 'unsafe_staging' }
        )
        await fs.chmod(child, 0o700)
        const lock = join(child, '.rovloom-update.lock')
        await fs.mkdir(lock)
        await fs.writeFile(join(lock, 'keep'), 'unknown lock')
        await assert.rejects(
          /* 不按 PID 或年龄清除旧锁。 */ () =>
            withStagedUpdate(child, f.network, plan, /* 旧锁不可进入候选。 */ async () => assert.fail()),
          { code: 'update_busy' }
        )
        assert.equal(await fs.readFile(join(lock, 'keep'), 'utf8'), 'unknown lock')
      }
    )
  }
)

test(
  'cleanup failures are nonzero even after a successful verified download',
  /* 不允许下载成功但清理失败退出零。 */ async () => {
    if (process.platform !== 'linux') {
      return
    }
    const { f, plan } = await planned()
    await isolated(
      /* 注入一个失败的 unlink，最后仍由测试自有根兜底清理。 */ async (root) => {
        const files: UpdateStagingFiles = {
          ...fs,
          // 模拟候选清理权限不足，不能被成功回调掩盖。
          unlink: async () => {
            throw Object.assign(new Error('private path'), { code: 'EPERM' })
          }
        }
        await assert.rejects(
          /* 即便观察者成功，暂存清理失败也必须传播。 */ () =>
            withStagedUpdate(root, f.network, plan, /* 受控观察者返回成功。 */ async () => true, files),
          { code: 'permission_denied' }
        )
        assert(!(await fs.readdir(root)).includes('.rovloom-update.lock'))
      }
    )
  }
)
