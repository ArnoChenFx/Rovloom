// 在自有私有临时根编译原生样例，使用真实子进程与文件锁模拟登记角色；不调用系统服务注册设施。
import * as fs from 'node:fs/promises'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { ServiceManager } from '../../../src/service/manager.js'
import { registrationFiles } from '../../../src/service/files.js'
import {
  ServiceError,
  type ServiceBackend,
  type ServiceRole,
  type ServiceSnapshot,
  type ServiceSpec
} from '../../../src/service/types.js'
import { checkForUpdate } from '../../../src/update/plan.js'
import { updatePlatform } from '../../../src/update/contract.js'
import { officialAssetUrl, type UpdateNetwork } from '../../../src/update/network.js'
import { fixture } from '../fixtures.js'

export const oldVersion = '0.1.0-dev'
export const newVersion = '0.1.1'
declare const Bun: { build(options: unknown): Promise<{ success: boolean }> }
let binaries: Promise<{ directory: string; old: string; next: string }> | undefined

// 每个测试进程只编译一次两份带版本标识的原生 fixture，不执行任何下载脚本。
export function compiled(): Promise<{ directory: string; old: string; next: string }> {
  binaries ??= /* 编译输出只落在测试自有私有目录。 */ (async () => {
    const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'rovloom-posix-binaries-')))
    const paths = { directory, old: join(directory, 'old'), next: join(directory, 'next') }
    for (const [version, output] of [
      [oldVersion, paths.old],
      [newVersion, paths.next]
    ]) {
      const result = await Bun.build({
        entrypoints: [fileURLToPath(new URL('./probe.ts', import.meta.url))],
        target: 'bun',
        compile: {
          outfile: output!,
          autoloadDotenv: false,
          autoloadBunfig: false,
          autoloadTsconfig: false,
          autoloadPackageJson: false
        },
        define: { UPDATE_PROBE_VERSION: JSON.stringify(version) },
        env: 'disable'
      })
      assert.equal(result.success, true)
    }
    return paths
  })()
  return binaries
}

// 明确回收本测试编译的 binary；调用者须先结束所有自己的 fixture 子进程。
export async function cleanupBinaries(): Promise<void> {
  const owned = binaries
  binaries = undefined
  if (owned) {
    await fs.rm((await owned).directory, { recursive: true, force: true })
  }
}

// 使用既有双角色 spec/manager 原语及实际锁文件；OS 监管层由自有 child handle 代替。
export async function setup(running: readonly ServiceRole[] = ['gateway']) {
  const binary = await compiled()
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'rovloom-posix-update-')))
  const executable = join(root, 'rovloom')
  await fs.copyFile(binary.old, executable)
  await fs.chmod(executable, 0o750)
  const bytes = await fs.readFile(binary.next)
  const platform = updatePlatform(process.platform, process.arch, process.platform === 'linux' ? 'glibc' : null)
  const f = fixture(platform, newVersion)
  f.manifest.assets[0]!.size = bytes.length
  f.manifest.assets[0]!.sha256 = createHash('sha256').update(bytes).digest('hex')
  f.release.assets[1]!.size = bytes.length
  const network: UpdateNetwork = {
    fetch: /* 真实编译样例通过注入载荷提供，不请求外部资产。 */ async (url, init) =>
      url === officialAssetUrl(f.tag, f.name) ? new Response(bytes) : f.network.fetch(url, init)
  }
  const plan = await checkForUpdate(network, oldVersion, platform)
  const snapshots = new Map<ServiceRole, ServiceSnapshot>()
  const children = new Map<ServiceRole, { child: ChildProcess; closed: Promise<void> }>()
  const versions = new Map<ServiceRole, string>()
  const calls: string[] = []
  let clock = 0
  let stopFailure: ServiceRole | undefined
  let newHealthFailure = false
  const files = registrationFiles(root)
  for (const role of ['gateway', 'connector'] as const) {
    await fs.writeFile(join(root, `${role}.json`), `unchanged ${role} configuration`)
    snapshots.set(role, {
      spec: {
        version: 1,
        platform: process.platform as 'linux' | 'darwin',
        role,
        executable,
        config: join(root, `${role}.json`),
        directory: root,
        account: 'rovloom'
      },
      state: 'stopped',
      // macOS disabled 的运行态不能由 bootstrap 等价恢复，该初态由 native 组合回归单独验证。
      enabled: role === 'gateway' || (process.platform === 'darwin' && running.includes(role)),
      loaded: false
    })
  }
  await fs.writeFile(join(root, 'state.db'), 'unchanged database')
  const backend: ServiceBackend = {
    platform: process.platform as 'linux' | 'darwin',
    // 只授权测试自有状态模型，不能代表真实 root/systemd/launchd 权限。
    authorize: async () => {},
    // 实际独占文件锁使不同 manager 实例相互可见。
    lock: async (role, operation) => files.lock(`rovloom-${role}`, operation),
    // 测试不触碰系统账户和真实配置；原生 binary 验证在 updater 单独执行。
    preflight: async (spec) => {
      assert.equal(spec.executable, executable)
    },
    // 每次返回独立快照，不允许 updater 改写控制记录。
    inspect: async (role) => ({ ...snapshots.get(role)!, spec: { ...snapshots.get(role)!.spec } }),
    // 更新过程绝不创建注册。
    create: async () => assert.fail('update created registration'),
    // 更新过程绝不改变开机启动。
    enable: async () => assert.fail('update changed boot flag'),
    // 更新过程绝不移除登记控制记录。
    remove: async () => assert.fail('update removed registration'),
    // 仅启动自己编译并复制到私有根的进程，保存 child 对象而非接受任意 PID。
    start: async (spec) => {
      calls.push(`start:${spec.role}`)
      if (process.platform === 'darwin' && !snapshots.get(spec.role)!.enabled) {
        throw new ServiceError('service_start_failed')
      }
      const child = spawn(executable, ['--fixture-service'], { cwd: root, env: {}, stdio: ['ignore', 'pipe', 'pipe'] })
      const closed = new Promise<void>(
        /* 即使先观察到退出状态，也必须等管道和直接 child 真正 close。 */ (resolve) =>
          child.once('close', /* 只记录本次 spawn 的真实关闭。 */ () => resolve())
      )
      children.set(spec.role, { child, closed })
      let stderr = ''
      const capture = /* 读取启动错误，保留有界尾部而不让 stderr 管道堵住 child。 */ (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-2048)
      }
      child.stderr!.on('data', capture)
      const failure = /* 原期限和真实退出原因分开；超时后的自有 KILL 不能冒充提前退出原因。 */ (message: string) =>
        Object.assign(
          new Error(
            `${message} (exit=${child.exitCode}, signal=${child.signalCode}, stderr=${JSON.stringify(stderr)})`
          ),
          { exitCode: child.exitCode, signal: child.signalCode, stderr }
        )
      try {
        await new Promise<void>(
          /* 有界等待此直接子进程的固定就绪标记。 */ (resolve, reject) => {
            const earlyClose = /* 已关闭且没有标记时立即报告真实原因，不继续等到超时。 */ () => {
              clearTimeout(timer)
              reject(failure('fixture exited before readiness'))
            }
            const timer = setTimeout(
              /* 保持原五秒期限；后续 catch 负责终止并等待真实 close。 */ () =>
                reject(failure('fixture readiness timeout')),
              5000
            )
            child.once('close', earlyClose)
            child.once(
              'error',
              /* spawn 失败与提前退出分开报告，stderr 只附带已捕获的有界启动输出。 */ () => {
                clearTimeout(timer)
                child.removeListener('close', earlyClose)
                reject(failure('fixture spawn failed'))
              }
            )
            child.stdout!.once(
              'data',
              /* 样例只发送一行固定版本标记。 */ (chunk: Buffer) => {
                clearTimeout(timer)
                child.removeListener('close', earlyClose)
                const match = /^fixture-ready:([^\n]+)\n$/u.exec(chunk.toString())
                if (!match) {
                  reject(new Error('fixture readiness invalid'))
                  return
                }
                versions.set(spec.role, match[1]!)
                snapshots.get(spec.role)!.state = 'running'
                snapshots.get(spec.role)!.loaded = process.platform === 'darwin'
                resolve()
              }
            )
          }
        )
      } catch (error) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL')
        }
        await closed
        children.delete(spec.role)
        throw error
      } finally {
        child.stderr!.removeListener('data', capture)
      }
    },
    // 等到自己启动的进程真正 close，不按名字/任意 PID 杀进程。
    stop: async (spec) => {
      calls.push(`stop:${spec.role}`)
      if (stopFailure === spec.role) {
        stopFailure = undefined
        throw new ServiceError('system_command_failed')
      }
      const owned = children.get(spec.role)
      if (owned) {
        if (owned.child.exitCode === null && owned.child.signalCode === null) {
          owned.child.kill('SIGTERM')
        }
        await owned.closed
      }
      children.delete(spec.role)
      snapshots.get(spec.role)!.state = 'stopped'
      snapshots.get(spec.role)!.loaded = false
    }
  }
  const manager = new ServiceManager(backend, {
    now: /* 监管稳定时段由模型时钟提供，不称作真实系统服务验收。 */ () => clock,
    wait: /* 真实子进程就绪/退出在 backend 单独等待，此处仅推进监管模型。 */ async (ms) => {
      clock += ms
    }
  })
  try {
    for (const role of running) {
      await backend.start(snapshots.get(role)!.spec)
    }
  } catch (error) {
    for (const role of children.keys()) {
      await backend.stop(snapshots.get(role)!.spec)
    }
    await fs.rm(root, { recursive: true, force: true })
    throw error
  }
  calls.length = 0
  return {
    root,
    executable,
    network,
    plan,
    manager,
    backend,
    snapshots,
    versions,
    calls,
    // 控制下一次停止故障，供补偿路径回归。
    failStop: (role: ServiceRole) => {
      stopFailure = role
    },
    // 控制新版业务验证，旧版恢复仍必须真正运行并报告原版本。
    failNewHealth: () => {
      newHealthFailure = true
    },
    // 这个探针读取真实自有进程的版本，不以 running alone 代替业务标记。
    health: async (spec: ServiceSpec, version: string) => {
      assert.equal(snapshots.get(spec.role)?.state, 'running')
      assert.equal(versions.get(spec.role), version)
      if (version === newVersion && newHealthFailure) {
        throw new Error('new fixture health failed')
      }
    },
    // 清理只涉及此 fixture 的 child 和临时目录。
    cleanup: async () => {
      stopFailure = undefined
      for (const role of children.keys()) {
        await backend.stop(snapshots.get(role)!.spec)
      }
      await fs.rm(root, { recursive: true, force: true })
    }
  }
}
