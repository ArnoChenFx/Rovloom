// 组合 systemd、LaunchDaemon 与 Task Scheduler 后端；所有系统变更均须由显式 CLI 宿主调用。
import { join } from 'node:path'
import { registrationFiles, type RegistrationFiles } from './files.js'
import { renderDefinition } from './render.js'
import { checkedCommand, runSystemCommand, type CommandRunner } from './runner.js'
import { manifest, OWNER, parseManifest, serviceName, servicePlatform } from './spec.js'
import { inspectTask, taskCall } from './windows.js'
import {
  ServiceError,
  type ServiceBackend,
  type ServicePlatform,
  type ServiceRole,
  type ServiceSnapshot,
  type ServiceSpec
} from './types.js'

export type NativeServiceOptions = {
  platform: string
  // 核验唯一 CLI 单文件产物、角色/状态根及后台能力；Gateway 必须为持久 Streamable HTTP 宿主，不依赖 stdin EOF。
  verifyRuntime(spec: ServiceSpec): Promise<void>
  runner?: CommandRunner
  files?: RegistrationFiles
}

// 从 systemctl 的固定属性名读取状态，值保留完整路径且不按空白拆 argv。
function properties(text: string): Map<string, string> {
  const result = new Map<string, string>()
  for (const line of text.trimEnd().split('\n')) {
    const at = line.indexOf('=')
    if (at < 1 || result.has(line.slice(0, at))) {
      throw new ServiceError('system_command_failed')
    }
    result.set(line.slice(0, at), line.slice(at + 1))
  }
  return result
}

// 读取并逐字重建注册声明；单独所有权标记不足以接管一份被修改的注册。
async function readSpec(
  files: RegistrationFiles,
  file: string,
  role: ServiceRole,
  platform: ServicePlatform
): Promise<ServiceSpec | undefined> {
  const content = await files.read(file)
  if (content === undefined) {
    return undefined
  }
  const marker = content
    .split('\n')
    .find(
      /* 只读取固定注释格式中的项目清单。 */ (line) => line.startsWith(`# ${OWNER}`) || line.startsWith(`<!-- ${OWNER}`)
    )
  const value = marker?.startsWith('# ') ? marker.slice(2) : marker?.slice(5, -4)
  if (!value) {
    throw new ServiceError('service_conflict')
  }
  const spec = parseManifest(value, role, platform)
  if (renderDefinition(spec) !== content) {
    throw new ServiceError('service_conflict')
  }
  return spec
}

// 创建可测试的原生设施后端；没有宿主后台验证器时保持拒绝。
export function createNativeServiceBackend(options: NativeServiceOptions): ServiceBackend {
  const platform = servicePlatform(options.platform)
  const run = options.runner ?? runSystemCommand
  const root =
    platform === 'linux'
      ? '/etc/systemd/system'
      : platform === 'darwin'
        ? '/Library/LaunchDaemons'
        : 'C:\\ProgramData\\Rovloom\\ServiceControl'
  const files = options.files ?? registrationFiles(root)
  // 将项目角色映射为唯一注册文件名。
  function filename(role: ServiceRole): string {
    return serviceName(role, platform) + (platform === 'linux' ? '.service' : '.plist')
  }
  // systemctl 始终使用系统域及固定服务名，不请求任意单元或交互提权。
  async function systemctl(args: string[], timeout = 35000) {
    return checkedCommand(run, {
      executable: '/usr/bin/systemctl',
      args: ['--system', '--no-ask-password', ...args],
      timeout
    })
  }
  // launchctl 只接受 system 域，不以 gui/user 域模拟开机启动。
  async function launchctl(args: string[], timeout = 35000) {
    return checkedCommand(run, { executable: '/bin/launchctl', args, timeout })
  }
  // 用公开 list 表格确认有无项目标签；非零查询从不被误判为未安装。
  async function launchInfo(
    role: ServiceRole
  ): Promise<{ loaded: boolean; state: ServiceSnapshot['state']; exitCode: number }> {
    const name = serviceName(role, platform)
    const list = await launchctl(['list'], 5000)
    const rows = list.stdout.trim().split('\n')
    if (!/^PID\s+Status\s+Label$/u.test(rows.shift() ?? '')) {
      throw new ServiceError('system_command_failed')
    }
    for (const line of rows) {
      const row = line.trim().split(/\s+/u)
      if (row.length !== 3) {
        throw new ServiceError('system_command_failed')
      }
      if (row[2] === name) {
        if (!/^-?\d+$/u.test(row[1]!) || !/^(?:-|[1-9]\d*)$/u.test(row[0]!)) {
          throw new ServiceError('system_command_failed')
        }
        const printed = await launchctl(['print', `system/${name}`], 5000)
        const paths = printed.stdout
          .split('\n')
          .filter(/* 核对已加载 job 的来源路径。 */ (line) => /^\s*path = /u.test(line))
        if (paths.length !== 1 || paths[0]!.trim() !== `path = ${join(root, filename(role))}`) {
          throw new ServiceError('service_conflict')
        }
        const code = Number(row[1])
        return { loaded: true, state: row[0] === '-' ? (code === 0 ? 'stopped' : 'failed') : 'running', exitCode: code }
      }
    }
    return { loaded: false, state: 'stopped', exitCode: 0 }
  }
  // 查询持久 disabled override；缺少项目项表示 plist 的默认启用状态。
  async function launchEnabled(role: ServiceRole): Promise<boolean> {
    const value = await launchctl(['print-disabled', 'system'], 5000)
    if (!value.stdout.includes('disabled services = {') || !value.stdout.trimEnd().endsWith('}')) {
      throw new ServiceError('system_command_failed')
    }
    const name = serviceName(role, platform)
    for (const line of value.stdout.split('\n')) {
      if (line.includes(`"${name}"`)) {
        if ([`"${name}" => true`, `"${name}" => disabled`].includes(line.trim())) {
          return false
        }
        if (![`"${name}" => false`, `"${name}" => enabled`].includes(line.trim())) {
          throw new ServiceError('system_command_failed')
        }
      }
    }
    return true
  }
  const backend: ServiceBackend = {
    platform,
    // 使用项目固定角色锁包围所有读写与等待，避免两个 CLI 实例互相覆盖。
    lock(role, operation) {
      return files.lock(serviceName(role, platform), operation)
    },
    // 无提权时立即拒绝，不运行 sudo、不改系统安全设置、不退回登录启动。
    async authorize() {
      if (platform === 'win32') {
        await taskCall(run, 'authorize', 'connector')
      } else if (!options.runner && process.getuid?.() !== 0) {
        throw new ServiceError('permission_denied')
      }
      await files.verify()
    },
    // 宿主核对产品/配置，POSIX仅查所选账户确实存在；普通文件访问权限由系统自身处理。
    async preflight(spec) {
      if (typeof options.verifyRuntime !== 'function') {
        throw new ServiceError('backend_unavailable')
      }
      if (platform === 'win32') {
        await taskCall(run, 'validate', spec.role, spec)
      } else {
        const id = await checkedCommand(run, { executable: '/usr/bin/id', args: ['-u', spec.account], timeout: 5000 })
        if (!/^[1-9]\d*$/u.test(id.stdout.trim()) || !Number.isSafeInteger(Number(id.stdout.trim()))) {
          throw new ServiceError('invalid_arguments')
        }
      }
      await options.verifyRuntime(spec)
    },
    // 同时验证磁盘声明与实际系统来源；未知覆盖、同名异物均作为冲突。
    async inspect(role) {
      if (platform === 'win32') {
        return inspectTask(run, role)
      }
      const spec = await readSpec(files, filename(role), role, platform)
      if (platform === 'darwin') {
        const info = await launchInfo(role)
        if (!spec && info.loaded) {
          throw new ServiceError('service_conflict')
        }
        return spec
          ? {
              spec,
              state: info.state,
              enabled: await launchEnabled(role),
              exitCode: info.exitCode,
              loaded: info.loaded
            }
          : undefined
      }
      const result = await run({
        executable: '/usr/bin/systemctl',
        args: [
          '--system',
          '--no-ask-password',
          'show',
          '--no-pager',
          '--all',
          '--property=LoadState,ActiveState,SubState,FragmentPath,DropInPaths,ExecMainStatus,MainPID,Job,UnitFileState',
          '--',
          filename(role)
        ],
        timeout: 5000
      })
      const data = properties(result.stdout)
      if (result.code !== 0 && !(result.code === 4 && data.get('LoadState') === 'not-found')) {
        throw new ServiceError('system_command_failed', result.code)
      }
      // systemctl show 将零 Job 输出为空值，非零 Job 输出十进制 uint32；缺失或未知格式不能视为静止。
      const job = data.get('Job')
      if (job === undefined || (job !== '' && (!/^[1-9]\d{0,9}$/u.test(job) || Number(job) > 0xffffffff))) {
        throw new ServiceError('system_command_failed')
      }
      const pending = job !== ''
      if (
        data.get('LoadState') === 'not-found' &&
        !data.get('FragmentPath') &&
        !data.get('DropInPaths') &&
        [0, 4].includes(result.code)
      ) {
        if (
          pending ||
          data.get('ActiveState') !== 'inactive' ||
          data.get('SubState') !== 'dead' ||
          data.get('MainPID') !== '0'
        ) {
          throw new ServiceError('service_conflict')
        }
        return spec ? { spec, state: 'stopped', enabled: false } : undefined
      }
      if (result.code !== 0) {
        throw new ServiceError('system_command_failed', result.code)
      }
      if (
        !spec ||
        data.get('LoadState') !== 'loaded' ||
        data.get('FragmentPath') !== join(root, filename(role)) ||
        data.get('DropInPaths') !== ''
      ) {
        throw new ServiceError('service_conflict')
      }
      const active = data.get('ActiveState')
      if (
        !['active', 'inactive', 'failed', 'activating', 'deactivating'].includes(active ?? '') ||
        !/^\d+$/u.test(data.get('MainPID') ?? '')
      ) {
        throw new ServiceError('system_command_failed')
      }
      const state = pending
        ? 'starting'
        : active === 'active' && data.get('SubState') === 'running'
          ? 'running'
          : active === 'inactive'
            ? 'stopped'
            : active === 'failed'
              ? 'failed'
              : active === 'activating'
                ? 'starting'
                : active === 'deactivating'
                  ? 'stopping'
                  : undefined
      if (!state || !/^\d+$/u.test(data.get('ExecMainStatus') ?? '')) {
        throw new ServiceError('system_command_failed')
      }
      if (
        ['stopped', 'failed'].includes(state) &&
        (data.get('MainPID') !== '0' || (state === 'stopped' && data.get('SubState') !== 'dead'))
      ) {
        throw new ServiceError('service_conflict')
      }
      return {
        spec,
        state,
        enabled: data.get('UnitFileState') === 'enabled',
        exitCode: Number(data.get('ExecMainStatus'))
      }
    },
    // 新注册以独占创建保障不覆盖；boot/start 完全分开。
    async create(spec) {
      if (platform === 'win32') {
        await taskCall(run, 'create', spec.role, spec)
      } else {
        await files.create(filename(spec.role), renderDefinition(spec))
      }
    },
    // 单独启用/禁用持久开机注册；不使用 --now，也不 bootstrap。
    async enable(spec, enabled) {
      await owned(spec)
      if (platform === 'win32') {
        await taskCall(run, 'enable', spec.role, spec, enabled)
      } else if (platform === 'darwin') {
        await launchctl([enabled ? 'enable' : 'disable', `system/${serviceName(spec.role, platform)}`])
      } else {
        await systemctl(['daemon-reload'])
        await systemctl([enabled ? 'enable' : 'disable', '--', filename(spec.role)])
      }
    },
    // 复用已加载 job；不以 kickstart -k 或重复实例替换运行中的服务。
    async start(spec) {
      await owned(spec)
      if (platform === 'win32') {
        await taskCall(run, 'start', spec.role, spec)
      } else if (platform === 'darwin') {
        const info = await launchInfo(spec.role)
        await launchctl(
          info.loaded
            ? ['kickstart', `system/${serviceName(spec.role, platform)}`]
            : ['bootstrap', 'system', join(root, filename(spec.role))]
        )
      } else {
        await systemctl(['daemon-reload'])
        await systemctl(['start', '--', filename(spec.role)])
      }
    },
    // 仅停止所选实例；Darwin重启保留loaded job，避免撤自启后bootout导致无法重载。
    async stop(spec, forRestart = false) {
      await owned(spec)
      if (platform === 'win32') {
        await taskCall(run, 'stop', spec.role, spec)
      } else if (platform === 'darwin') {
        if ((await launchInfo(spec.role)).loaded) {
          await launchctl(
            forRestart
              ? ['kill', 'SIGTERM', `system/${serviceName(spec.role, platform)}`]
              : ['bootout', `system/${serviceName(spec.role, platform)}`]
          )
        }
      } else {
        await systemctl(['stop', '--', filename(spec.role)])
      }
    },
    // 仅清理已撤销自启且不再承载运行实例的注册；不能为清理而停止或 bootout。
    async remove(spec) {
      const current = await owned(spec)
      if (current.enabled) {
        throw new ServiceError('service_conflict')
      }
      if (!['stopped', 'failed'].includes(current.state)) {
        return false
      }
      if (platform === 'win32') {
        const removed = await taskCall(run, 'remove', spec.role, spec)
        if (removed.absent !== true && removed.retained !== true) {
          throw new ServiceError('system_command_failed')
        }
        return removed.absent === true
      } else {
        if (platform === 'darwin' && (await launchInfo(spec.role)).loaded) {
          return false
        }
        await files.remove(filename(spec.role), renderDefinition(spec))
        if (platform === 'linux') {
          await systemctl(['daemon-reload'])
        }
        return true
      }
    }
  }
  // 在每个原生变更前再次核对当前注册，角色锁以外的管理员修改也不会被直接接管。
  async function owned(spec: ServiceSpec): Promise<ServiceSnapshot> {
    const current = await backend.inspect(spec.role)
    if (!current || manifest(current.spec) !== manifest(spec)) {
      throw new ServiceError('service_conflict')
    }
    return current
  }
  return backend
}
