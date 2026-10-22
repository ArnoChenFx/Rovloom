// 将真实本地终端的首次引导接到唯一CLI；离线命令和非TTY运行不创建确认对象或读取stdin。
import type { RoleConfig, GatewayConfig } from './config.js'
import type { CliIo, CliPrepareOptions, RunningConnector } from './run.js'
import { SetupTerminal } from './setup-terminal.js'
import { GatewaySetup } from './setup-gateway.js'
import { setupConnector } from './setup-connector.js'
import { repairConnector } from './setup-repair.js'
import { CliError } from './config.js'
import { LuvusAdapterError } from '../connector/luvus/types.js'
import { HerdrLocalError } from '../connector/herdr/local.js'
import { readRuntimeConfig } from './runtime-config.js'
import { readSetupJson } from './setup-files.js'
import { runtimeReference } from './runtime-files.js'

export class CliSetup {
  #terminal: SetupTerminal | undefined
  #gateway: GatewaySetup | undefined
  #observation: ReturnType<typeof setInterval> | undefined

  // 仅角色命令在读到实际用户文件后调用；缺少OS TTY时保留原明确待配置行为。
  async prepare(config: RoleConfig, path: string, io: CliIo, options?: CliPrepareOptions): Promise<RoleConfig> {
    const terminal = SetupTerminal.open(path, config, io)
    if (!terminal) {
      // 重新配对必须有已核验的本地终端；没有时明确拒绝，而不是悄悄按普通启动继续。
      if (options?.repair || options?.addDevice) {
        throw new CliError('configuration_required')
      }
      return config
    }
    this.#terminal = terminal
    if (config.role === 'connector') {
      if (options?.repair) {
        await repairConnector(config, terminal)
        terminal.finishQuestions()
        return config
      }
      return await setupConnector(config, terminal)
    }
    if (options?.addDevice) {
      // 在已完成的引导之上加入下一台设备；没有任何引导记录时请直接运行 rovloom gateway 完成首次配对。
      if (readSetupJson(runtimeReference(config.state_dir, 'setup-active')) === undefined) {
        throw new CliError('configuration_required')
      }
      this.#gateway = new GatewaySetup(config, terminal, { addDevice: true })
      return config
    }
    if (options?.repair) {
      // 只能重新配对引导式配对过的设备：必须已有 Gateway 的引导记录。
      if (readSetupJson(runtimeReference(config.state_dir, 'setup-active')) === undefined) {
        throw new CliError('configuration_required')
      }
      this.#gateway = new GatewaySetup(config, terminal, { repair: true })
      return config
    }
    if (
      readRuntimeConfig(config).providers.length &&
      readSetupJson(runtimeReference(config.state_dir, 'setup-active')) === undefined
    ) {
      terminal.finishQuestions()
      return config
    }
    this.#gateway = new GatewaySetup(config, terminal)
    return config
  }

  // 只为同一已核验配置交付当前本机对象，不能从JSON还原初始化批准。
  gateway(config: GatewayConfig): GatewaySetup | undefined {
    return this.#gateway?.config === config ? this.#gateway : undefined
  }

  // 原生失败只交付现有适配器的有界固定代码；不打印child输出、异常message/stack、路径或请求。
  nativeFailed(error: unknown): void {
    if ((error instanceof LuvusAdapterError || error instanceof HerdrLocalError) && /^[a-z_]{1,80}$/.test(error.code)) {
      this.#terminal?.show('native_unavailable ' + error.code + '\n')
    }
  }

  // 仅观察正式Connector持有的transport，不认证HTTP、不创建新epoch、不根据静态配置自报ready。
  observe(running: RunningConnector): void {
    if (!running.transport || !this.#terminal) {
      return
    }
    let previous = ''
    this.#observation = setInterval(
      /* 状态变化才输出固定阶段和布尔值，不输出设备凭据、epoch或原生正文。 */ () => {
        try {
          const status = running.transport!.status()
          const ready = status.providers.some(
            /* 采用原transport已经核验的当前provider就绪值。 */ (provider) => provider.ready
          )
          const current = status.phase + ':' + ready + ':' + (status.failure ?? '')
          if (current !== previous) {
            previous = current
            this.#terminal!.show(
              'connector_transport ' +
                status.phase +
                ' provider_ready=' +
                String(ready) +
                (status.capacity
                  ? ' capacity=' + status.capacity.resource + ' reclaim_at=' + String(status.capacity.reclaim_at)
                  : '') +
                (status.failure ? ' reason=' + status.failure : '') +
                '\n'
            )
          }
        } catch {
          clearInterval(this.#observation)
          this.#observation = undefined
        }
      },
      250
    )
    void running.closed.then(
      /* 原owner结束即停止观察，不延长其生命周期。 */ () => {
        clearInterval(this.#observation)
        this.#observation = undefined
      },
      /* 只停止观察，原close/closed仍交付相同失败。 */ () => {
        clearInterval(this.#observation)
        this.#observation = undefined
      }
    )
  }

  // 主进程所有退出路径恢复终端模式，不结束共享stdio或清理用户数据。
  close(): void {
    clearInterval(this.#observation)
    this.#observation = undefined
    this.#terminal?.close()
    this.#terminal = undefined
    this.#gateway = undefined
  }
}
