// 在自有临时原生 binary/子进程上验证实际替换与回滚；系统服务状态只使用明确的受控模型。
// 原生编译、摘要与多次子进程/权限核验独立限时 45 秒，不沿用 Bun 普通单元测试的 5 秒默认值。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { join, basename } from 'node:path'
import { createPosixUpdater } from '../../../src/update/posix/transaction.js'
import { probeVersion } from '../../../src/update/posix/policy.js'
import { handleUpdateCommand } from '../../../src/update/command.js'
import { runSystemCommand } from '../../../src/service/runner.js'
import { cleanupBinaries, compiled, newVersion, oldVersion, setup } from './helpers.js'

test(
  'a failed exclusive candidate open never deletes an unowned file',
  { timeout: 45_000 },
  /* 失败的 O_EXCL 不能成为清理所有权证明。 */ async () => {
    if (process.platform === 'win32') {
      return
    }
    const f = await setup([])
    let unowned = ''
    try {
      const updater = createPosixUpdater({
        executable: f.executable,
        services: f.manager,
        files: {
          ...fs,
          // 只在私有 fixture 目录注入同名冲突，不触及任何真实用户文件。
          open: async (...args: Parameters<typeof fs.open>) => {
            if (basename(String(args[0])) === 'candidate') {
              unowned = String(args[0])
              await fs.writeFile(unowned, 'unowned fixture')
              throw Object.assign(new Error('fixture conflict'), { code: 'EEXIST' })
            }
            return fs.open(...args)
          }
        }
      })
      await assert.rejects(/* 未知文件导致清理非零，不能递归删除。 */ () => updater.update(f.network, f.plan), {
        code: 'update_cleanup_failed'
      })
      assert.equal(await fs.readFile(unowned, 'utf8'), 'unowned fixture')
      assert.equal(f.calls.length, 0)
      await probeVersion(f.executable, oldVersion)
    } finally {
      await f.cleanup()
    }
  }
)

test(
  'equal-size candidate corruption is rejected from the held file before execution or role shutdown',
  { timeout: 45_000 },
  /* 注入实际文件的等长错写，区分网络摘要与落盘摘要；这不是物理磁盘故障实测。 */ async () => {
    if (process.platform === 'win32') {
      return
    }
    const f = await setup()
    let corrupted = false
    let executed = false
    try {
      const updater = createPosixUpdater({
        executable: f.executable,
        services: f.manager,
        verifyRoleReady: f.health,
        files: {
          ...fs,
          // 网络下载仍是正确 fixture，独立在首次 fsync 后破坏磁盘文件的一字节。
          open: async (...args: Parameters<typeof fs.open>) => {
            const file = await fs.open(...args)
            if (basename(String(args[0])) === 'candidate') {
              const sync = file.sync.bind(file)
              file.sync = /* 模拟等长持久化错写，保留原生头与文件大小。 */ async () => {
                await sync()
                if (!corrupted) {
                  const byte = Buffer.alloc(1)
                  await file.read(byte, 0, 1, 64)
                  byte[0] = byte[0]! ^ 1
                  await file.write(byte, 0, 1, 64)
                  corrupted = true
                }
              }
            }
            return file
          }
        },
        runner: /* 候选在落盘摘要通过前绝不能执行。 */ async (plan) => {
          if (basename(plan.executable) === 'candidate') {
            executed = true
          }
          return runSystemCommand(plan)
        }
      })
      await assert.rejects(/* 实际长度和原生头仍合法，必须由文件摘要阻断。 */ () => updater.update(f.network, f.plan), {
        code: 'checksum_mismatch'
      })
      assert.equal(corrupted, true)
      assert.equal(executed, false)
      assert.equal(f.calls.length, 0)
      await probeVersion(f.executable, oldVersion)
      assert(
        !(await fs.readdir(f.root)).some(/* 没有接触角色或旧版备份。 */ (name) => name.startsWith('.rovloom-update-'))
      )
    } finally {
      await f.cleanup()
    }
  }
)

test(
  'a backup link applied before an error is identified and safely unwound',
  { timeout: 45_000 },
  /* 不遗留使下次安装误判的额外硬链接。 */ async () => {
    if (process.platform === 'win32') {
      return
    }
    const f = await setup([])
    try {
      const updater = createPosixUpdater({
        executable: f.executable,
        services: f.manager,
        files: {
          ...fs,
          // 模拟 native link 已完成而响应失败。
          link: async (from, to) => {
            await fs.link(from, to)
            throw Object.assign(new Error('fixture late failure'), { code: 'EIO' })
          }
        }
      })
      await assert.rejects(
        /* 没有停止或替换之前失败，仍须精确回收自己的备份。 */ () => updater.update(f.network, f.plan),
        { code: 'staging_failed' }
      )
      assert.equal((await fs.stat(f.executable)).nlink, 1)
      assert.equal(f.calls.length, 0)
      await probeVersion(f.executable, oldVersion)
    } finally {
      await f.cleanup()
    }
  }
)

test(
  'an externally replaced target is never overwritten and its original backup is retained',
  { timeout: 45_000 },
  /* 不把同名的新 inode 盲目回滚成旧版本。 */ async () => {
    if (process.platform === 'win32') {
      return
    }
    const f = await setup()
    const foreign = join(f.root, 'foreign')
    await fs.copyFile(f.executable, foreign)
    const identity = await fs.stat(foreign)
    try {
      const updater = createPosixUpdater({
        executable: f.executable,
        services: f.manager,
        verifyRoleReady: f.health,
        files: {
          ...fs,
          // 对自有 fixture 模拟不遵守角色锁的外部管理员变更。
          link: async (from, to) => {
            await fs.link(from, to)
            await fs.rename(foreign, f.executable)
          }
        }
      })
      await assert.rejects(
        /* 目标来源未知时保持旧备份和恢复保护，不覆盖外部变更。 */ () => updater.update(f.network, f.plan),
        { code: 'update_recovery_required' }
      )
      await updater.settled()
      assert.equal((await fs.stat(f.executable)).ino, identity.ino)
      assert.equal(f.calls.length, 0)
      const directory = (await fs.readdir(f.root)).find(
        /* 只读取当前 fixture 的私有恢复目录。 */ (name) =>
          name.startsWith('.rovloom-update-') && !name.endsWith('.lock')
      )!
      await probeVersion(join(f.root, directory, 'previous'), oldVersion)
    } finally {
      await f.cleanup()
    }
  }
)

// 后台事务只有真正清理安装锁和角色锁后，调用方才能复用此测试根。
async function settled(root: string): Promise<void> {
  const deadline = performance.now() + 20_000
  while ((await fs.readdir(root)).some(/* 只检查更新事务自己的命名空间。 */ (name) => name.startsWith('.rovloom-'))) {
    if (performance.now() > deadline) {
      assert.fail('fixture update did not quiesce')
    }
    await new Promise(/* 等待已放行的旧 I/O 完成补偿。 */ (resolve) => setTimeout(resolve, 5))
  }
}

test(
  'installation and both role locks remain held through a cancelled, late atomic rename and rollback',
  { timeout: 45_000 },
  /* 真实迟到 rename 不能污染下一实例。 */ async () => {
    if (process.platform === 'win32') {
      return
    }
    const f = await setup()
    let release!: () => void
    const gate = new Promise<void>(
      /* 控制已经发出的原生替换何时真正完成。 */ (resolve) => {
        release = resolve
      }
    )
    let reached!: () => void
    const entering = new Promise<void>(
      /* 只在全部预检和服务静止完成后才取消。 */ (resolve) => {
        reached = resolve
      }
    )
    const controller = new AbortController()
    try {
      const updater = createPosixUpdater({
        executable: f.executable,
        services: f.manager,
        verifyRoleReady: f.health,
        files: {
          ...fs,
          rename: /* 原子替换被延迟，日志 rename 不受影响。 */ async (from, to) => {
            if (basename(String(from)) === 'candidate' && to === f.executable) {
              reached()
              await gate
            }
            await fs.rename(from, to)
          }
        }
      })
      const updating = updater.update(f.network, f.plan, controller.signal)
      await Promise.race([
        entering,
        updating.then(
          /* 不允许绕过目标替换阶段。 */ () => assert.fail('fixture did not replace'),
          /* 提前失败须马上报告。 */ (error) => {
            throw error
          }
        )
      ])
      controller.abort()
      await assert.rejects(/* 调用方有界返回，不能据此释放后台租约。 */ () => updating, { code: 'update_io_pending' })
      for (const role of ['gateway', 'connector'] as const) {
        await assert.rejects(
          /* 所有原角色生命周期和注册操作都被现有角色锁互斥。 */ () => f.manager.execute({ action: 'start', role }),
          { code: 'service_busy' }
        )
      }
      await assert.rejects(
        /* 第二更新者不能重用同一安装。 */ () =>
          createPosixUpdater({ executable: f.executable, services: f.manager, verifyRoleReady: f.health }).update(
            f.network,
            f.plan
          ),
        { code: 'update_busy' }
      )
      release()
      await settled(f.root)
      await probeVersion(f.executable, oldVersion)
      assert.equal(f.versions.get('gateway'), oldVersion)
      assert.equal(f.snapshots.get('gateway')!.state, 'running')
    } finally {
      release()
      await f.cleanup()
    }
  }
)

test(
  'failed rollback preserves old binary, durable recovery record and both role locks',
  { timeout: 45_000 },
  /* 不接受恢复失败后退出零或盲目启动新版本。 */ async () => {
    if (process.platform === 'win32') {
      return
    }
    const f = await setup()
    try {
      f.failNewHealth()
      const updater = createPosixUpdater({
        executable: f.executable,
        services: f.manager,
        verifyRoleReady: f.health,
        files: {
          ...fs,
          rename: /* 明确模拟权限拒绝，不重试、不提权、不换路径。 */ async (from, to) => {
            if (basename(String(from)) === 'previous' && to === f.executable) {
              throw Object.assign(new Error('fixture denied'), { code: 'EACCES' })
            }
            await fs.rename(from, to)
          }
        }
      })
      await assert.rejects(/* 报告需要恢复，具体事务继续保持保护。 */ () => updater.update(f.network, f.plan), {
        code: 'update_recovery_required'
      })
      const transaction = (await fs.readdir(f.root)).find(
        /* 私有事务目录和固定安装锁分开保存。 */ (name) =>
          name.startsWith('.rovloom-update-') && !name.endsWith('.lock')
      )!
      await probeVersion(join(f.root, transaction, 'previous'), oldVersion)
      await updater.settled()
      const deadline = performance.now() + 1000
      let journal
      do {
        journal = JSON.parse(await fs.readFile(join(f.root, transaction, 'journal.json'), 'utf8'))
        if (journal.phase === 'recovery_required') {
          break
        }
        await new Promise(/* 给私有记录持久化让出事件循环。 */ (resolve) => setTimeout(resolve, 1))
      } while (performance.now() < deadline)
      assert.equal(journal.phase, 'recovery_required')
      assert.equal(f.snapshots.get('gateway')!.state, 'stopped')
      await assert.rejects(
        /* 未恢复前原服务不能被另一个 CLI 误启动。 */ () => f.manager.execute({ action: 'start', role: 'gateway' }),
        { code: 'service_busy' }
      )
      assert(
        (await fs.readdir(f.root)).some(
          /* 不自动删除未知安装锁。 */ (name) => name.startsWith('.rovloom-update-') && name.endsWith('.lock')
        )
      )
    } finally {
      await f.cleanup()
    }
  }
)

test(
  'unsafe symlink, hardlink, writable ancestor and special-mode installations fail before service mutation',
  { timeout: 45_000 },
  /* 路径安全策略在任何替换前失败关闭。 */ async () => {
    if (process.platform === 'win32') {
      return
    }
    for (const kind of ['symlink', 'hardlink', 'writable', 'setuid']) {
      const f = await setup([])
      try {
        let executable = f.executable
        if (kind === 'symlink') {
          executable = join(f.root, 'alias')
          await fs.symlink(f.executable, executable)
        }
        if (kind === 'hardlink') {
          await fs.link(f.executable, join(f.root, 'alias'))
        }
        if (kind === 'writable') {
          await fs.chmod(f.root, 0o777)
        }
        if (kind === 'setuid') {
          await fs.chmod(f.executable, 0o4750)
        }
        await assert.rejects(
          /* 不静默修正权限、跟随链接或替换另一个路径。 */ () =>
            createPosixUpdater({ executable, services: f.manager }).update(f.network, f.plan),
          { code: 'unsafe_installation' }
        )
        assert.equal(f.calls.length, 0)
      } finally {
        await fs.chmod(f.executable, 0o750)
        await fs.chmod(f.root, 0o700)
        await f.cleanup()
      }
    }
  }
)

test(
  'extended permission metadata or missing role health proof cannot be bypassed',
  { timeout: 45_000 },
  /* 未支持的 ACL 和业务就绪证据不能降格为 mode/running。 */ async () => {
    if (process.platform === 'win32') {
      return
    }
    const f = await setup()
    try {
      await assert.rejects(
        /* 活服务缺少业务就绪端口时不能先停后补。 */ () =>
          createPosixUpdater({ executable: f.executable, services: f.manager }).update(f.network, f.plan),
        { code: 'replacement_unavailable' }
      )
      assert.equal(f.calls.length, 0)
      const updater = createPosixUpdater({
        executable: f.executable,
        services: f.manager,
        verifyRoleReady: f.health,
        runner: /* 真实查询结果只为权限标记反例注入一个 ACL 位。 */ async (plan) => {
          const result = await runSystemCommand(plan)
          if (plan.executable === '/bin/ls' && plan.args[0] !== '--version') {
            return { ...result, stdout: result.stdout.replace(/^([d-][rwxStTs-]{9})/u, '$1+') }
          }
          return result
        }
      })
      await assert.rejects(/* 不改 ACL，也不忽略无法保持的访问语义。 */ () => updater.update(f.network, f.plan), {
        code: 'unsafe_installation'
      })
      assert.equal(f.calls.length, 0)
    } finally {
      await f.cleanup()
    }
  }
)

after(
  /* 测试结束后删除自己编译的样例。 */ async () => {
    await cleanupBinaries()
  }
)

test(
  'native POSIX update replaces atomically, preserves metadata/data and restores original role states',
  { timeout: 45_000 },
  /* 真实文件和自有进程闭环，非 OS service 实装。 */ async () => {
    if (process.platform === 'win32') {
      return
    }
    const f = await setup()
    try {
      const before = await fs.stat(f.executable)
      const updater = createPosixUpdater({ executable: f.executable, services: f.manager, verifyRoleReady: f.health })
      assert.deepEqual(await updater.update(f.network, f.plan), { status: 'updated', version: newVersion })
      await probeVersion(f.executable, newVersion)
      const stat = await fs.stat(f.executable)
      assert.equal(stat.mode, before.mode)
      assert.equal(stat.uid, before.uid)
      assert.equal(stat.gid, before.gid)
      assert.equal(stat.nlink, 1)
      assert.notEqual(stat.ino, before.ino)
      assert.equal(f.snapshots.get('gateway')!.state, 'running')
      assert.equal(f.versions.get('gateway'), newVersion)
      assert.equal(f.snapshots.get('connector')!.state, 'stopped')
      assert.equal(f.snapshots.get('connector')!.enabled, false)
      assert.equal(await fs.readFile(join(f.root, 'state.db'), 'utf8'), 'unchanged database')
      assert.equal(await fs.readFile(join(f.root, 'gateway.json'), 'utf8'), 'unchanged gateway configuration')
      assert(
        !(await fs.readdir(f.root)).some(
          /* 成功后自己的锁和候选被精确清理。 */ (name) => name.startsWith('.rovloom-update')
        )
      )
    } finally {
      await f.cleanup()
    }
  }
)

test(
  'a target replaced during new-version readiness cannot commit or delete its old backup',
  { timeout: 45_000 },
  /* 同版本异 inode 不能通过 --version 冒充本事务候选。 */ async () => {
    if (process.platform === 'win32') {
      return
    }
    const f = await setup()
    let foreignIdentity: Awaited<ReturnType<typeof fs.stat>> | undefined
    try {
      const updater = createPosixUpdater({
        executable: f.executable,
        services: f.manager,
        // 只在自有模型的健康检查中模拟外部管理员替换同版本文件。
        verifyRoleReady: async (spec, version) => {
          await f.health(spec, version)
          if (version === newVersion) {
            const foreign = join(f.root, 'foreign-ready')
            await fs.copyFile(f.executable, foreign)
            foreignIdentity = await fs.stat(foreign)
            await fs.rename(foreign, f.executable)
          }
        }
      })
      await assert.rejects(
        /* 提交前再次核对 inode，发现异物即保留备份及角色恢复保护。 */ () => updater.update(f.network, f.plan),
        { code: 'update_recovery_required' }
      )
      await updater.settled()
      assert.equal((await fs.stat(f.executable)).ino, foreignIdentity!.ino)
      await probeVersion(f.executable, newVersion)
      const directory = (await fs.readdir(f.root)).find(
        /* 只查找本 fixture 的事务目录。 */ (name) => name.startsWith('.rovloom-update-') && !name.endsWith('.lock')
      )!
      await probeVersion(join(f.root, directory, 'previous'), oldVersion)
      assert.equal(f.snapshots.get('gateway')!.state, 'stopped')
      assert.equal(await fs.readFile(join(f.root, 'state.db'), 'utf8'), 'unchanged database')
      await assert.rejects(
        /* 恢复保护不能让后续管理操作误启来源未知的 binary。 */ () =>
          f.manager.execute({ action: 'start', role: 'gateway' }),
        { code: 'service_busy' }
      )
    } finally {
      await f.cleanup()
    }
  }
)

test(
  'role exit after successful readiness causes rollback instead of deleting the usable old binary',
  { timeout: 45_000 },
  /* 使用真实自有子进程退出证明，不能把稍早成功的业务探针当作最终仍运行。 */ async () => {
    if (process.platform === 'win32') {
      return
    }
    const f = await setup()
    try {
      const original = await fs.stat(f.executable)
      const updater = createPosixUpdater({
        executable: f.executable,
        services: f.manager,
        verifyRoleReady: /* 模拟探针返回时真实进程已经退出，旧版恢复仍使用真实标记。 */ async (spec, version) => {
          await f.health(spec, version)
          if (version === newVersion) {
            await f.backend.stop(spec)
          }
        }
      })
      await assert.rejects(/* 最终监管状态必须使新版事务失败并恢复旧版。 */ () => updater.update(f.network, f.plan), {
        code: 'update_rolled_back'
      })
      await probeVersion(f.executable, oldVersion)
      assert.equal((await fs.stat(f.executable)).ino, original.ino)
      assert.equal(f.snapshots.get('gateway')!.state, 'running')
      assert.equal(f.versions.get('gateway'), oldVersion)
      assert.equal(f.snapshots.get('connector')!.state, 'stopped')
    } finally {
      await f.cleanup()
    }
  }
)

test(
  'new-version health failure atomically restores old binary and both roles, with Linux disabled boot preserved',
  { timeout: 45_000 },
  /* 不以 enable/install 重建原服务。 */ async () => {
    if (process.platform === 'win32') {
      return
    }
    const f = await setup(['gateway', 'connector'])
    try {
      const before = await fs.stat(f.executable)
      f.failNewHealth()
      const updater = createPosixUpdater({ executable: f.executable, services: f.manager, verifyRoleReady: f.health })
      await assert.rejects(/* 新进程确实启动后再故意拒绝业务就绪。 */ () => updater.update(f.network, f.plan), {
        code: 'update_rolled_back'
      })
      await probeVersion(f.executable, oldVersion)
      assert.equal((await fs.stat(f.executable)).ino, before.ino)
      for (const role of ['gateway', 'connector'] as const) {
        assert.equal(f.snapshots.get(role)!.state, 'running')
        assert.equal(f.versions.get(role), oldVersion)
      }
      assert.equal(f.snapshots.get('connector')!.enabled, process.platform === 'darwin')
    } finally {
      await f.cleanup()
    }
  }
)

for (const failSync of [false, true]) {
  test(
    `the transaction directory entry is synced after prepared and before shutdown (fail=${failSync})`,
    { timeout: 45_000 },
    /* 对真实临时目录句柄注入同步失败及顺序观测，不把它称为断电实测。 */ async () => {
      if (process.platform === 'win32') {
        return
      }
      const f = await setup()
      const order: string[] = []
      let prepared = false
      let injected = false
      const stop = f.backend.stop.bind(f.backend)
      f.backend.stop = /* 记录首个受控停服是否发生在父目录持久化之后。 */ async (spec) => {
        order.push('stop')
        await stop(spec)
      }
      try {
        const updater = createPosixUpdater({
          executable: f.executable,
          services: f.manager,
          verifyRoleReady: f.health,
          files: {
            ...fs,
            // prepared 记录已经同步到事务目录后，父目录入口仍须独立同步。
            open: async (...args: Parameters<typeof fs.open>) => {
              const file = await fs.open(...args)
              if (String(args[0]) === f.root) {
                const sync = file.sync.bind(file)
                file.sync = /* 只在 prepared 后的父目录持久化点注入一次故障。 */ async () => {
                  if (prepared) {
                    if (failSync && !injected) {
                      injected = true
                      throw Object.assign(new Error('fixture directory sync failure'), { code: 'EIO' })
                    }
                    order.push('parent-sync')
                  }
                  await sync()
                }
              }
              return file
            },
            // 记录真实 journal rename 后的阶段；安装文件交换另记，不能用子目录 fsync 顶替父目录。
            rename: async (from, to) => {
              await fs.rename(from, to)
              if (basename(String(to)) === 'journal.json') {
                const record = JSON.parse(await fs.readFile(to, 'utf8'))
                if (record.phase === 'prepared') {
                  prepared = true
                  order.push('prepared')
                }
              }
              if (to === f.executable) {
                order.push('replace')
              }
            }
          }
        })
        if (failSync) {
          await assert.rejects(/* 无法持久化入口时不能先停止角色。 */ () => updater.update(f.network, f.plan), {
            code: 'staging_failed'
          })
          assert.equal(injected, true)
          assert.equal(order.includes('stop'), false)
          assert.equal(order.includes('replace'), false)
          assert.equal(f.snapshots.get('gateway')!.state, 'running')
          await probeVersion(f.executable, oldVersion)
          assert.equal((await fs.stat(f.executable)).nlink, 1)
        } else {
          assert.equal((await updater.update(f.network, f.plan)).status, 'updated')
          assert(order.indexOf('prepared') < order.indexOf('parent-sync'))
          assert(order.indexOf('parent-sync') < order.indexOf('stop'))
          assert(order.indexOf('stop') < order.indexOf('replace'))
        }
      } finally {
        await f.cleanup()
      }
    }
  )
}

for (const applied of [false, true]) {
  test(
    `forward rename failure (applied=${applied}) restores the original binary and service`,
    { timeout: 45_000 },
    /* 不猜测失败 syscall 是否已产生副作用。 */ async () => {
      if (process.platform === 'win32') {
        return
      }
      const f = await setup()
      try {
        const updater = createPosixUpdater({
          executable: f.executable,
          services: f.manager,
          verifyRoleReady: f.health,
          files: {
            ...fs,
            rename: /* 只在真正的目标替换阶段注入失败。 */ async (from, to) => {
              if (basename(String(from)) === 'candidate' && to === f.executable) {
                if (applied) {
                  await fs.rename(from, to)
                }
                throw Object.assign(new Error('fixture rename failure'), { code: 'EIO' })
              }
              await fs.rename(from, to)
            }
          }
        })
        await assert.rejects(
          /* 无论 syscall 是否先执行，都必须按实际 inode 恢复。 */ () => updater.update(f.network, f.plan),
          { code: 'update_rolled_back' }
        )
        await probeVersion(f.executable, oldVersion)
        assert.equal(f.versions.get('gateway'), oldVersion)
        assert.equal(f.snapshots.get('gateway')!.state, 'running')
      } finally {
        await f.cleanup()
      }
    }
  )
}

test(
  'partial stop failure compensates already stopped roles without changing the binary',
  { timeout: 45_000 },
  /* 第一角色停后第二角色失败仍须恢复原意图。 */ async () => {
    if (process.platform === 'win32') {
      return
    }
    const f = await setup(['gateway', 'connector'])
    try {
      f.failStop('connector')
      await assert.rejects(
        /* 不把部分静止当成功。 */ () =>
          createPosixUpdater({ executable: f.executable, services: f.manager, verifyRoleReady: f.health }).update(
            f.network,
            f.plan
          ),
        { code: 'update_rolled_back' }
      )
      await probeVersion(f.executable, oldVersion)
      assert.equal(f.snapshots.get('gateway')!.state, 'running')
      assert.equal(f.snapshots.get('connector')!.state, 'running')
    } finally {
      await f.cleanup()
    }
  }
)

test(
  'the existing CLI hook performs configured POSIX update while --check remains read only',
  { timeout: 45_000 },
  /* 同一入口实际调用受控状态机，不注入裸 apply。 */ async () => {
    if (process.platform === 'win32') {
      return
    }
    const f = await setup([])
    try {
      const output: string[] = []
      const host = {
        ...f.network,
        currentVersion: oldVersion,
        platform: process.platform,
        arch: process.arch,
        libc: process.platform === 'linux' ? ('glibc' as const) : null,
        posixUpdater: createPosixUpdater({ executable: f.executable, services: f.manager }),
        write: /* 捕获固定诊断，绝不写真实 MCP 通道。 */ (message: string) => {
          output.push(message)
        }
      }
      const before = await fs.stat(f.executable)
      assert.equal(await handleUpdateCommand(['update', '--check'], host), 0)
      assert.equal((await fs.stat(f.executable)).ino, before.ino)
      assert.equal(f.calls.length, 0)
      assert.equal(await handleUpdateCommand(['update'], host), 0)
      assert(output.join('').includes('status=updated version=0.1.1'))
      await probeVersion(f.executable, newVersion)
    } finally {
      await f.cleanup()
    }
  }
)

for (const startup of ['exit', 'timeout'] as const) {
  test(
    `fixture startup ${startup} reports its cause and removes the failed setup`,
    { timeout: 45_000 },
    /* 只替换本测试自编译缓存中的旧样例，结束后恢复；不执行产品更新或改系统服务。 */ async () => {
      if (process.platform === 'win32') {
        return
      }
      const binary = await compiled()
      const backup = join(binary.directory, 'startup-original')
      await fs.rename(binary.old, backup)
      try {
        await fs.writeFile(
          binary.old,
          '#!/bin/sh\nprintf "fixture-startup-root:%s\\n" "$PWD" >&2\n' +
            (startup === 'exit' ? 'exit 7\n' : 'exec /bin/sleep 30\n'),
          { mode: 0o750 }
        )
        let failedRoot: string | undefined
        await assert.rejects(
          /* 初始角色启动失败必须经过 setup 自己的清理，而不是依赖尚未返回的 f.cleanup。 */ () => setup(),
          /* 退出与超时保持不同分类，真实 stderr 给出本例临时根。 */ (error) => {
            assert(error instanceof Error && 'stderr' in error && typeof error.stderr === 'string')
            assert('exitCode' in error && 'signal' in error)
            failedRoot = /^fixture-startup-root:([^\n]+)\n$/u.exec(error.stderr)?.[1]
            assert(failedRoot)
            if (startup === 'exit') {
              assert.match(error.message, /^fixture exited before readiness /u)
              assert.equal(error.exitCode, 7)
              assert.equal(error.signal, null)
            } else {
              assert.match(error.message, /^fixture readiness timeout /u)
              assert.equal(error.exitCode, null)
              assert.equal(error.signal, null)
            }
            return true
          }
        )
        await assert.rejects(/* 子进程真正 close 后，失败 fixture 根应已回收。 */ () => fs.stat(failedRoot!), {
          code: 'ENOENT'
        })
      } finally {
        await fs.rm(binary.old, { force: true })
        await fs.rename(backup, binary.old)
      }
    }
  )
}
