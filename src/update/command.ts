// 给唯一 CLI 提供窄命令接缝；不复制角色 parser，不装配第二 CLI 或系统服务实现。
import { UpdateError, updateExitCode, updatePlatform } from './contract.js'
import { checkForUpdate } from './plan.js'
import type { UpdateNetwork } from './network.js'

export type UpdateCommandHost = UpdateNetwork & {
  currentVersion: string
  platform: string
  arch: string
  // 同步写入固定诊断；宿主仍负责真实流错误和背压。
  write(message: string): void
}

export const UPDATE_HELP =
  'rovloom update --check | rovloom update\n' + '检查只读版本元数据；原地更新等待受信 service/runtime 替换事务接线。\n'

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
    const plan = await checkForUpdate(host, host.currentVersion, updatePlatform(host.platform, host.arch))
    host.write(`current=${plan.currentVersion} target=${plan.targetVersion} status=${plan.status}\n`)
    if (args[1] === '--check' || plan.status !== 'available') {
      return 0
    }
    // 没有跨角色注册事务及 Windows 受控替换宿主，不能仅因下载成功宣称升级成功。
    throw new UpdateError('replacement_unavailable')
  } catch (error) {
    host.write(`update: ${error instanceof UpdateError ? error.code : 'update_failed'}\n`)
    return updateExitCode(error)
  }
}
