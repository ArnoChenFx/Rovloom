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
  const plan = await checkForUpdate(f.network, '1.0.0', updatePlatform('linux', 'x64', 'glibc'))
  return { f, plan }
}

// 等待已经静止后的后台精确清理；只轮询测试自有目录，并为测试本身保留独立上界。
async function cleaned(root: string): Promise<void> {
  const until = performance.now() + 2000
  while ((await fs.readdir(root)).some(/* 仅观察本更新器命名空间。 */ (name) => name.startsWith('.rovloom-update'))) {
    if (performance.now() > until) {
      assert.fail('quarantine cleanup did not settle')
    }
    await new Promise(/* 让已结算的 I/O 和后台清理继续推进。 */ (resolve) => setTimeout(resolve, 1))
  }
}

test(
  'pending writes return nonzero and quarantine the lock until late I/O is really quiescent',
  /* 迟到写入只能落到旧私有候选。 */ async () => {
    if (process.platform !== 'linux') {
      return
    }
    const { f, plan } = await planned()
    await isolated(
      /* 隔离期间第二实例必须拒绝，静止清理后才可开始新事务。 */ async (root) => {
        await fs.writeFile(join(root, 'keep.db'), 'unchanged data')
        let release!: () => void
        const gate = new Promise<void>(
          /* 保存受控晚到写入的放行器。 */ (resolve) => {
            release = resolve
          }
        )
        let writes = 0
        let removals = 0
        const files: UpdateStagingFiles = {
          ...fs,
          // 持有真实自有句柄；Promise 静止之前仍可能发出本次写入。
          open: async (...args: Parameters<typeof fs.open>) => {
            const file = await fs.open(...args)
            const write = file.write.bind(file)
            file.write = /* 模拟不能被 AbortSignal 强退的单次系统写入。 */ (async (
              buffer: Uint8Array,
              offset: number,
              length: number
            ) => {
              await gate
              writes++
              return await write(buffer, offset, length)
            }) as typeof file.write
            return file
          },
          // 未静止前不得删除旧候选。
          unlink: async (path) => {
            removals++
            await fs.unlink(path)
          },
          // 未静止前不得释放本次锁。
          rmdir: async (...args: Parameters<typeof fs.rmdir>) => {
            removals++
            await fs.rmdir(...args)
          }
        }
        try {
          await assert.rejects(
            /* 超时必须返回，而不是无限等待底层 write。 */ () =>
              withStagedUpdate(
                root,
                { ...f.network, timeoutMs: 25 },
                plan,
                /* 未完整落盘时没有可用候选。 */ async () => assert.fail(),
                files
              ),
            { code: 'staging_io_pending' }
          )
          assert.equal(writes, 0)
          assert.equal(removals, 0)
          assert((await fs.readdir(root)).includes('.rovloom-update.lock'))
          await assert.rejects(
            /* 旧 syscall pending 时根不能重用。 */ () =>
              withStagedUpdate(root, f.network, plan, /* 锁冲突时不可调用观察者。 */ async () => assert.fail()),
            { code: 'update_busy' }
          )
        } finally {
          release()
        }
        await cleaned(root)
        assert.equal(writes, 1)
        assert.equal(await fs.readFile(join(root, 'keep.db'), 'utf8'), 'unchanged data')
        await withStagedUpdate(
          root,
          f.network,
          plan,
          /* 新事务只接收新候选原字节。 */ async (staged) => {
            assert.deepEqual(await fs.readFile(staged.path), f.payload)
          }
        )
        assert.deepEqual(await fs.readdir(root), ['keep.db'])
      }
    )
  }
)

test(
  'pending sync or cleanup keeps ownership until settlement before releasing the lock',
  /* 先命中目标阶段再触发期限，不把较早 I/O 的超时误认成 unlink 隔离。 */ async (context) => {
    if (process.platform !== 'linux') {
      return
    }
    for (const phase of ['sync', 'unlink']) {
      const { f, plan } = await planned()
      await isolated(
        /* 每个故障使用不同的根，不能相互复用旧句柄。 */ async (root) => {
          let release!: () => void
          const gate = new Promise<void>(
            /* 独立控制真实 I/O 的结算时间。 */ (resolve) => {
              release = resolve
            }
          )
          let arrive!: () => void
          const entered = new Promise<void>(
            /* 明确证明已进入本轮 sync 或 unlink，而非在较早的真实 I/O 上超时。 */ (resolve) => {
              arrive = resolve
            }
          )
          const operations: string[] = []
          let targetSettled = false
          let closes = 0
          let removals = 0
          const files: UpdateStagingFiles = {
            ...fs,
            // 只对本次自有候选注入延迟同步。
            open: async (...args: Parameters<typeof fs.open>) => {
              const file = await fs.open(...args)
              const sync = file.sync.bind(file)
              const close = file.close.bind(file)
              file.sync = /* 延迟系统同步，不谎报已取消。 */ async () => {
                operations.push('sync')
                if (phase === 'sync') {
                  arrive()
                  await gate
                }
                await sync()
                if (phase === 'sync') {
                  targetSettled = true
                }
              }
              file.close = /* 只把真实 close 完成计入证据，不能以发起关闭代替。 */ async () => {
                await close()
                closes++
                operations.push('close')
              }
              return file
            },
            // cleanup 自身也可能长期 pending，不能接着删除父目录或锁。
            unlink: async (path) => {
              operations.push('unlink')
              if (phase === 'unlink') {
                arrive()
                await gate
              }
              await fs.unlink(path)
              if (phase === 'unlink') {
                targetSettled = true
              }
            },
            // 目录和锁必须在本次 unlink 静止后才可删除。
            rmdir: async (...args: Parameters<typeof fs.rmdir>) => {
              removals++
              await fs.rmdir(...args)
            }
          }
          context.mock.timers.enable({ apis: ['setTimeout'] })
          try {
            const pending = withStagedUpdate(
              root,
              { ...f.network, timeoutMs: 25 },
              plan,
              /* 校验观察者只读返回。 */ async () => true,
              files
            )
            await Promise.race([
              entered,
              pending.then(
                /* 未到目标阶段就完成必须使回归失败。 */ () => assert.fail('staging completed before target phase'),
                /* 其它阶段的错误不能冒充目标阶段超时。 */ (error) => {
                  throw new Error('staging failed before target phase', { cause: error })
                }
              )
            ])
            assert.deepEqual([...operations], phase === 'sync' ? ['sync'] : ['sync', 'close', 'unlink'])
            assert.equal(targetSettled, false)
            context.mock.timers.tick(25)
            await assert.rejects(/* 只有已观测到的目标阶段仍 pending 时才验证隔离错误。 */ pending, {
              code: 'staging_io_pending'
            })
            assert.equal(targetSettled, false)
            assert.equal(removals, 0)
            assert.equal(closes, phase === 'sync' ? 0 : 1)
            assert((await fs.readdir(root)).includes('.rovloom-update.lock'))
          } finally {
            release()
            context.mock.timers.reset()
            await cleaned(root)
          }
          assert.equal(targetSettled, true)
          assert.equal(closes, 1)
          assert.equal(removals, 2)
          assert.deepEqual(await fs.readdir(root), [])
        }
      )
    }
  }
)

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
