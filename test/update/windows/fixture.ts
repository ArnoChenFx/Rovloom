// 隔离 Windows 闭环样例；固定测试分支不作为产品 CLI、服务后端或发行入口。
import * as fs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'
import { ServiceManager } from '../../../src/service/manager.js'
import { registrationFiles } from '../../../src/service/files.js'
import type { ServiceBackend, ServiceRole, ServiceSnapshot, ServiceSpec } from '../../../src/service/types.js'
import { handleUpdateCommand } from '../../../src/update/command.js'
import { createWindowsUpdater, handleWindowsUpdateHelperCommand } from '../../../src/update/windows/transaction.js'
import { WINDOWS_HELPER_COMMAND } from '../../../src/update/windows/protocol.js'
import { nativeWindowsParent } from '../../../src/update/windows/parent.js'
import { checkForUpdate } from '../../../src/update/plan.js'
import { updatePlatform, updateExitCode } from '../../../src/update/contract.js'
import { officialAssetUrl, type UpdateNetwork } from '../../../src/update/network.js'
import { fixture } from '../fixtures.js'

declare const WINDOWS_FIXTURE_VERSION: string
const oldVersion = '0.1.0-dev'
const newVersion = '0.1.1'

// 等待自有私有目录中的测试标记，所有等待均有固定上界。
async function marker(path: string, timeout = 15000): Promise<string> {
  const until = performance.now() + timeout
  while (performance.now() < until) {
    try {
      return await fs.readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
    await pause(20)
  }
  throw new Error('fixture_marker_timeout')
}

// 使用真实编译 PE 载荷注入官方元数据；不请求尚未存在的外部 Release 资产。
async function network(root: string): Promise<UpdateNetwork> {
  const platform = updatePlatform('win32', process.arch)
  const f = fixture(platform, newVersion)
  const bytes = await fs.readFile(join(root, 'next.exe'))
  f.manifest.assets[0]!.size = bytes.length
  f.manifest.assets[0]!.sha256 = createHash('sha256').update(bytes).digest('hex')
  f.release.assets[1]!.size = bytes.length
  return {
    fetch: /* 限于已编译的自有二进制和内存官方元数据模型。 */ async (url, init) =>
      url === officialAssetUrl(f.tag, f.name) ? new Response(bytes) : f.network.fetch(url, init)
  }
}

// 服务监管是模型；启动/停止与版本就绪由 helper 持有的真实自有 child 句柄及标记证明。
async function services(root: string, executable: string) {
  const mode = JSON.parse(await fs.readFile(join(root, 'mode.json'), 'utf8')) as {
    healthFailure: boolean
    unknownTarget: boolean
    journalFailure?: boolean
    restoreUnknownTarget?: boolean
  }
  const snapshots = new Map<ServiceRole, ServiceSnapshot>()
  const children = new Map<ServiceRole, { child: ChildProcess; nonce: string; closed: Promise<void> }>()
  const locks = registrationFiles(root, true)
  let initialized = false
  let tampered = false
  // 记录只含测试动作和版本，不把日志或标记提交到仓库。
  const record = async (op: string, role: ServiceRole, version?: string) =>
    fs.appendFile(join(root, 'observations.jsonl'), JSON.stringify({ op, role, version }) + '\n')
  for (const role of ['gateway', 'connector'] as const) {
    snapshots.set(role, {
      spec: {
        version: 1,
        platform: 'win32',
        role,
        executable,
        config: join(root, `${role}.json`),
        directory: root,
        account: 'S-1-5-19'
      },
      state: 'stopped',
      enabled: role === 'connector'
    })
  }
  const backend: ServiceBackend = {
    platform: 'win32',
    // 在 helper 已核验自身/父/事务目录之后才启动自有角色样例。
    authorize: async () => {
      if (!initialized) {
        initialized = true
        for (const snapshot of snapshots.values()) {
          await backend.start(snapshot.spec)
        }
      }
    },
    // 实际独占锁文件复用既有注册设施；不安装 Task Scheduler 任务。
    lock: async (role, operation) => locks.lock(`rovloom-${role}`, operation),
    // 只接受本样例预先建立的固定声明，不放宽真实安装权限。
    preflight: async (spec) => {
      if (spec.executable !== executable || spec.platform !== 'win32') {
        throw new Error('fixture_spec')
      }
    },
    // 状态模型不得把已关闭真实子进程继续报告为运行。
    inspect: async (role) => {
      const snapshot = snapshots.get(role)!
      const child = children.get(role)?.child
      if (child && (child.exitCode !== null || child.signalCode !== null)) {
        snapshot.state = 'stopped'
      }
      return { ...snapshot, spec: { ...snapshot.spec } }
    },
    create: /* 更新不能创建注册。 */ async () => {
      throw new Error('fixture_created_registration')
    },
    enable: /* 更新不能重写 boot 标志。 */ async () => {
      throw new Error('fixture_changed_boot')
    },
    remove: /* 更新不能删除控制登记。 */ async () => {
      throw new Error('fixture_removed_registration')
    },
    // 使用固定测试角色分支创建真实样例，不按 PID/进程名寻找进程。
    start: async (spec) => {
      const nonce = randomBytes(12).toString('hex')
      const child = spawn(executable, ['--fixture-service', spec.role, root, nonce], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore'
      })
      const closed = new Promise<void>(
        /* 真实 close 后才允许停止完成或移除临时根。 */ (resolve, reject) => {
          child.once('error', reject)
          child.once('close', /* 真实 close 才结算停止观察。 */ () => resolve())
        }
      )
      children.set(spec.role, { child, nonce, closed })
      await marker(join(root, `ready-${nonce}.json`))
      snapshots.get(spec.role)!.state = 'running'
      await record('start', spec.role, JSON.parse(await marker(join(root, `ready-${nonce}.json`))).version)
    },
    // 仅由自有 child 主动响应其 nonce 标记后退出；不发送任意进程终止请求。
    stop: async (spec) => {
      const owned = children.get(spec.role)
      if (owned) {
        await fs.writeFile(join(root, `stop-${owned.nonce}`), '')
        await owned.closed
        children.delete(spec.role)
      }
      snapshots.get(spec.role)!.state = 'stopped'
      await record('stop', spec.role)
    }
  }
  return {
    manager: new ServiceManager(backend),
    // 真实版本角色标记必须来自当前启动 nonce，不能拿 supervisor running 代替。
    ready: async (spec: ServiceSpec, expected: string) => {
      const owned = children.get(spec.role)!
      const value = JSON.parse(await marker(join(root, `ready-${owned.nonce}.json`)))
      if (value.version !== expected || value.role !== spec.role || value.nonce !== owned.nonce) {
        throw new Error('fixture_wrong_version')
      }
      if (expected === newVersion && spec.role === 'gateway' && mode.healthFailure) {
        if (mode.journalFailure && !tampered) {
          tampered = true
          const directory = dirname(process.execPath)
          const journal = JSON.parse(await fs.readFile(join(directory, 'journal.json'), 'utf8'))
          // 只在本 fixture 的私有目录占用下次独占记录名，模拟 journal 失败；不改 ACL、时间或产品写入 API。
          await fs.mkdir(join(directory, `journal-${journal.sequence + 1}.tmp`))
        }
        if (mode.unknownTarget && !tampered) {
          tampered = true
          for (const snapshot of snapshots.values()) {
            await backend.stop(snapshot.spec)
          }
          await fs.rename(executable, join(root, 'external-moved.exe'))
          await fs.copyFile(join(root, 'next.exe'), executable)
        }
        throw new Error('fixture_new_health_failed')
      }
      if (expected === oldVersion && spec.role === 'connector' && mode.restoreUnknownTarget && !tampered) {
        tampered = true
        for (const snapshot of snapshots.values()) {
          await backend.stop(snapshot.spec)
        }
        // 仅在已回滚后的旧版就绪窗口替换自有安装；未知对象使用相同旧字节/ACL，不能靠 --version 或摘要发现。
        await fs.rename(executable, join(root, 'restored-moved.exe'))
        await fs.copyFile(process.execPath, executable)
        for (const snapshot of snapshots.values()) {
          await backend.start(snapshot.spec)
        }
        await record('replaced_during_old_restore', spec.role, expected)
      }
      await record('ready', spec.role, expected)
    },
    // 测试先观察恢复结果，再请求 fixture 宿主回收其全部真实子进程。
    cleanup: async () => {
      for (const snapshot of snapshots.values()) {
        await backend.stop(snapshot.spec)
      }
    },
    snapshots: /* 仅复制测试观察，不扩展生产 updater 接口。 */ () =>
      [...snapshots.values()].map(/* 返回独立测试快照。 */ (snapshot) => ({ ...snapshot }))
  }
}

if (process.argv[2] === '--version') {
  process.stderr.write(`Rovloom ${WINDOWS_FIXTURE_VERSION}\n`)
} else if (process.argv[2] === '--fixture-service') {
  const role = process.argv[3]!
  const root = process.argv[4]!
  const nonce = process.argv[5]!
  await fs.writeFile(
    join(root, `ready-${nonce}.json`),
    JSON.stringify({ role, nonce, version: WINDOWS_FIXTURE_VERSION })
  )
  await marker(join(root, `stop-${nonce}`), 60000)
} else if (process.argv[2] === WINDOWS_HELPER_COMMAND) {
  const root = dirname(dirname(process.execPath))
  const controlled = await services(root, join(root, 'rovloom.exe'))
  let code: number
  try {
    code = (await handleWindowsUpdateHelperCommand([WINDOWS_HELPER_COMMAND], {
      ...(await network(root)),
      services: controlled.manager,
      verifyRoleReady: controlled.ready,
      input: process.stdin,
      output: process.stdout,
      write: /* 固定公开诊断沿继承 stderr 返回测试。 */ (message) => {
        process.stderr.write(message)
      }
    }))!
  } catch (error) {
    code = updateExitCode(error)
  }
  await fs.writeFile(
    join(root, 'helper-result.json'),
    JSON.stringify({ code, snapshots: controlled.snapshots(), pid: process.pid, self: nativeWindowsParent.self() })
  )
  try {
    await marker(join(root, 'finish-helper'))
  } finally {
    await controlled.cleanup()
  }
  process.exitCode = code
} else if (process.argv[2] === '--fixture-update') {
  const root = dirname(process.execPath)
  const io = await network(root)
  const plan = await checkForUpdate(io, oldVersion, updatePlatform('win32', process.arch))
  let output = ''
  const code = await handleUpdateCommand(['update'], {
    ...io,
    currentVersion: oldVersion,
    platform: 'win32',
    arch: process.arch,
    windowsUpdater: createWindowsUpdater({ executable: process.execPath }),
    write: /* 仅保存公开 pending 诊断，不输出 secret。 */ (text) => {
      output += text
    }
  })
  await fs.writeFile(join(root, 'parent-result.json'), JSON.stringify({ code, output, plan }))
  if (output.includes('handoff_pending')) {
    await marker(join(root, 'allow-parent-exit'))
  }
  process.exitCode = code
} else {
  process.exitCode = 2
}
