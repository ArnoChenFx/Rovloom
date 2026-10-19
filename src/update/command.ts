// 给唯一 CLI 提供窄命令接缝；不复制角色 parser，不装配第二 CLI 或系统服务实现。
import { UpdateError, updateExitCode, updatePlatform } from './contract.js'
import { checkForUpdate } from './plan.js'
import type { UpdateNetwork } from './network.js'
import { PosixUpdater } from './posix/transaction.js'
import { WindowsUpdater } from './windows/transaction.js'

export type UpdateCommandHost = UpdateNetwork & {
  currentVersion: string
  platform: string
  arch: string
  // Linux 必须由受信运行时证明 glibc；musl 或未知不能套用同 OS/arch 的 binary。
  libc?: 'glibc' | null
  // 仅接受具体受控状态机，由可信运行时绑定安装路径和既有服务管理器。
  posixUpdater?: PosixUpdater
  windowsUpdater?: WindowsUpdater
  signal?: AbortSignal
  // 同步写入固定诊断；宿主仍负责真实流错误和背压。
  write(message: string): void
}

export const UPDATE_HELP =
  'rovloom update --check | rovloom update\n' +
  '检查只读版本元数据；POSIX 原地更新需要受信安装/服务事务，Windows 交接后以待完成码 4 退出，最终结果见 helper 回执；缺宿主明确拒绝。\n'

// 数字为本命令退出码，undefined 把其它参数原样交还现有 CLI；不支持 URL/路径/脚本参数。
export async function handleUpdateCommand(
  args: readonly string[],
  host: UpdateCommandHost
): Promise<number | undefined> {
  if (args[0] !== 'update') {
    return undefined
  }
  try {
    if (args.length === 2 && args[1] === '--help') {
      host.write(UPDATE_HELP)
      return 0
    }
    if (args.length > 2 || (args.length === 2 && args[1] !== '--check')) {
      throw new UpdateError('invalid_arguments')
    }
    const plan = await checkForUpdate(host, host.currentVersion, updatePlatform(host.platform, host.arch, host.libc))
    host.write(`current=${plan.currentVersion} target=${plan.targetVersion} status=${plan.status}\n`)
    if (args[1] === '--check' || plan.status !== 'available') {
      return 0
    }
    if (host.platform === 'win32') {
      if (!(host.windowsUpdater instanceof WindowsUpdater)) {
        throw new UpdateError('replacement_unavailable')
      }
      const result = await host.windowsUpdater.update(plan, host.signal)
      host.write(
        `status=${result.status} transaction=${result.transactionId} receipt=${JSON.stringify(result.receipt)} exit=4\n`
      )
      return 4
    }
    if (!(host.posixUpdater instanceof PosixUpdater)) {
      throw new UpdateError('replacement_unavailable')
    }
    const result = await host.posixUpdater.update(host, plan, host.signal)
    host.write(`status=${result.status} version=${result.version}\n`)
    return 0
  } catch (error) {
    host.write(`update: ${error instanceof UpdateError ? error.code : 'update_failed'}\n`)
    return updateExitCode(error)
  }
}
