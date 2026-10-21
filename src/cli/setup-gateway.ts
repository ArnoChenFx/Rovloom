// 在唯一产品Gateway双库上接入本机终端配对与实测来源批准；不设置默认管理员或修改原认证门禁。
import { createHash, randomBytes } from 'node:crypto'
import type { openGatewayState } from '../runtime/state.js'
import type { RuntimeCliGateway } from './runtime.js'
import { boundedJson, fields, object } from '../wire/index.js'
import { CliError, type GatewayConfig } from './config.js'
import { SetupApproval } from './setup-approval.js'
import { GatewayPairingHttp, type SetupNativeRequest } from './pairing-http.js'
import { SetupTerminal } from './setup-terminal.js'
import { publishSetupSchemas, reviewSetupManifest } from './setup-manifest.js'
import { readSetupJson, writeSetupJson } from './setup-files.js'
import { runtimeReference } from './runtime-files.js'
import { readRuntimeConfig } from './runtime-config.js'

type State = ReturnType<typeof openGatewayState>

// 相同计划的重入只接纳完全相同的程序数据；未知条目、部分内容或外部改动不被覆盖。
function publish(path: string, value: unknown, maximum = 16_384): void {
  const current = readSetupJson(path, maximum)
  if (current === undefined) {
    writeSetupJson(path, value, false, maximum)
  } else if (boundedJson(current, maximum) !== boundedJson(value, maximum)) {
    throw new CliError('configuration_required')
  }
}

export class GatewaySetup {
  readonly approval: SetupApproval
  #begun = false
  #active: GatewayPairingHttp | undefined
  #timer: ReturnType<typeof setInterval> | undefined
  #reload: (() => void) | undefined
  reconfigure: Promise<void> = new Promise(/* 未提交配置时不唤醒角色重开。 */ () => {})

  // 只有正式prepare取得的真实本地终端可以构造；网络请求不能选择批准来源。
  constructor(
    readonly config: GatewayConfig,
    readonly terminal: SetupTerminal
  ) {
    this.approval = new SetupApproval(terminal, config.state_dir)
  }

  // 绑定已取得唯一writer的实际state；每次重开先撤下旧handler，避免跨库/epoch复用。
  attach(state: State): GatewayPairingHttp {
    this.approval.attach(state)
    this.reconfigure = new Promise(
      /* 只由同一实例完整提交native配置后唤醒。 */ (resolve) => {
        this.#reload = resolve
      }
    )
    const http = new GatewayPairingHttp(
      state,
      this.approval,
      /* 原生来源仍由配对设备证明和独立本机确认共同约束。 */ (request) => this.native(state, request)
    )
    this.#active = http
    return http
  }

  // 设备listener和MCP真实启动后再显示一次性码；只写已核验TTY，不写普通stdout或诊断日志。
  async listening(gateway: RuntimeCliGateway, mcpUrl: string): Promise<void> {
    const current = this.approval.active()
    if (!this.#begun && current?.phase !== 'configured' && current?.phase !== 'ready') {
      this.#begun = true
      this.terminal.show(
        'Gateway MCP: ' + mcpUrl + '\nConnector endpoint: ' + gateway.transport.url.replace(/\/connector$/, '') + '\n'
      )
      const issued = await this.approval.issue()
      if (issued.code) {
        this.terminal.show(
          'One-time pairing code (5 minutes; keep private) / 一次性配对码（5分钟，请保密）:\n' +
            issued.code +
            '\nRun rovloom connector in another local terminal and enter the Gateway address and code.\n在 Connector 的本地终端输入 Gateway 地址与该码；随后回到此终端批准实测安装。\n'
        )
      } else {
        this.terminal.show(
          'Resuming the existing setup; no new enrollment or credential is issued. / 继续原设置，不重新签发。\n'
        )
      }
    }
    const plan = this.approval.active()
    if (plan?.phase === 'ready') {
      this.terminal.finishQuestions()
      return
    }
    if (plan?.phase === 'configured') {
      this.terminal.finishQuestions()
      let previous = ''
      this.#timer = setInterval(
        /* 只读正式transport观察；HTTP响应或静态配置不能自报ready。 */ () => {
          try {
            const device = gateway.transport
              .status()
              .devices.find(/* 精确原machine才可完成此计划。 */ (entry) => entry.machine_id === plan.machine_id)
            const current = device?.authenticated
              ? 'connector_authenticated native_pending'
              : 'gateway_waiting_for_connector'
            if (current !== previous) {
              previous = current
              this.terminal.show(current + '\n')
            }
            if (
              device?.authenticated &&
              device.ready &&
              (plan.providers ?? ['luvus']).every(
                /* 所选来源必须分别实际ready；单一健康来源不能代替混合配置全部就绪。 */ (kind) =>
                  device.providers.some(
                    /* 只核对原machine上的精确provider。 */ (entry) => entry.provider_id === kind && entry.ready
                  )
              )
            ) {
              this.approval.finishReady(plan.attempt_id)
              this.terminal.show('connector_ready / Connector 已通过真实认证且全部所选原生 provider 就绪。\n')
              clearInterval(this.#timer)
              this.#timer = undefined
            }
          } catch {
            this.terminal.io.stderr.write('setup_observation_unavailable\n')
            clearInterval(this.#timer)
            this.#timer = undefined
          }
        },
        250
      )
    }
  }

  // 配对设备交付原schema字节和测量身份，Gateway自己编译核验；仅本机明确批准后创建同一完整路由权限。
  private async native(state: State, request: SetupNativeRequest): Promise<unknown> {
    const { reviewed, kinds, authorization, fingerprint } = await reviewSetupManifest(
      request.input,
      request.plan,
      request.credential.machine_id,
      this.config.state_dir,
      request.signal
    )
    if (request.plan.phase === 'configured') {
      if (request.plan.native_fingerprint !== fingerprint) {
        throw new CliError('configuration_required')
      }
      return { state: 'configured', fingerprint }
    }
    if (request.signal.aborted) {
      throw new CliError('configuration_required')
    }
    // 已有不同registry或caller不能被首次引导扩大权限或覆盖；每个来源都必须属于同一批准清单。
    const providers = readRuntimeConfig(this.config).providers
    if (
      providers.some(
        /* 恢复时只允许原attempt完全相同的条目。 */ (entry) =>
          !reviewed.some(
            /* 仅同一原条目的完全相同配置可继续。 */ (expected) =>
              expected.reference === entry.reference &&
              boundedJson(entry.value, 1_048_576) === boundedJson(expected.value, 1_048_576)
          )
      )
    ) {
      throw new CliError('configuration_required')
    }
    await this.approval.approveNative(
      request.plan.attempt_id,
      kinds,
      fingerprint,
      "Allow this paired device's measured native installations (" +
        reviewed
          .map(
            /* 显示实际来源、完整Target及安装摘要，所有者能核对每份独立权限范围。 */ (entry) =>
              entry.kind +
              ' ' +
              entry.label +
              ', Target ' +
              boundedJson(entry.target) +
              ', binary SHA-256 ' +
              entry.binary_sha256
          )
          .join('; ') +
        `) for reviewed workspace/Agent operations and one local MCP caller? Terminal execution is controlled by the Connector machine owner's local configuration. / 批准这些实测原生来源、各自窗口/Agent 操作及一个本机 MCP caller（终端执行由 Connector 本机所有者配置决定）？`,
      request.signal
    )
    this.terminal.assertOwner()
    if (request.signal.aborted) {
      throw new CliError('configuration_required')
    }
    await publishSetupSchemas(reviewed, request.signal)
    const hostname = this.config.mcp_hostname === '::1' ? '[::1]' : this.config.mcp_hostname
    const resource = new URL('http://' + hostname + ':' + this.config.mcp_port + '/mcp').href
    const clientPath = runtimeReference(this.config.state_dir, 'mcp-client')
    const original = readSetupJson(clientPath)
    const client =
      original === undefined
        ? {
            schema_version: 1,
            kind: 'mcp-client-credential',
            attempt_id: request.plan.attempt_id,
            resource,
            principal_id: authorization.principal_id,
            token: randomBytes(32).toString('base64url'),
            issued_at: Date.now(),
            expires_at: Date.now() + 30 * 86400_000
          }
        : object(original)
    fields(client, [
      'schema_version',
      'kind',
      'attempt_id',
      'resource',
      'principal_id',
      'token',
      'issued_at',
      'expires_at'
    ])
    if (
      client.schema_version !== 1 ||
      client.kind !== 'mcp-client-credential' ||
      client.attempt_id !== request.plan.attempt_id ||
      client.resource !== resource ||
      client.principal_id !== authorization.principal_id ||
      typeof client.token !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(client.token) ||
      !Number.isSafeInteger(client.issued_at) ||
      !Number.isSafeInteger(client.expires_at) ||
      Number(client.expires_at) <= Date.now()
    ) {
      throw new CliError('configuration_required')
    }
    publish(clientPath, client)
    publish(runtimeReference(this.config.state_dir, 'mcp-callers'), {
      schema_version: 1,
      kind: 'mcp-caller-source',
      resource,
      local_policy: authorization.policies.local,
      callers: [
        {
          principal: { id: authorization.principal_id, policy: authorization.policies.caller },
          token_sha256: createHash('sha256')
            .update(client.token as string)
            .digest('hex'),
          issued_at: client.issued_at,
          expires_at: client.expires_at
        }
      ]
    })
    publish(
      runtimeReference(this.config.state_dir, 'providers'),
      {
        schema_version: 1,
        role: 'gateway',
        providers: reviewed.map(
          /* 只保存已核验清单的程序配置；Gateway文件路径始终由本机程序选择。 */ (entry) => ({
            reference: entry.reference,
            value: entry.value
          })
        )
      },
      1_048_576
    )
    for (const entry of reviewed) {
      const binding = state.store.provider(entry.target.machine_id, entry.target.provider_id)
      if (!binding) {
        state.store.defineProvider(entry.binding)
      } else if (boundedJson(binding) !== boundedJson(entry.binding)) {
        throw new CliError('configuration_required')
      }
    }
    this.approval.finishNative(request.plan.attempt_id, fingerprint)
    this.terminal.show(
      'Native configuration saved; Gateway will reopen its real providers. / 原生配置已保存，Gateway 将重开实际 provider。\nMCP credential file / MCP 凭据文件: ' +
        clientPath +
        '\nMCP URL: ' +
        (this.config.mcp_public_url ?? resource) +
        '\nTargets: ' +
        boundedJson(reviewed.map(/* 显示每个完整目标，不能合并成provider或session通配符。 */ (entry) => entry.target)) +
        '\nBinding revision: 1' +
        '\nBearer (private): ' +
        client.token +
        '\n'
    )
    // 不将响应写出当作业务确认；若本响应因重开丢失，客户端只查询原attempt，不重复签发或初始化。
    setImmediate(/* 下一事件轮才关闭旧listener，先让原认证/响应调用完成其finally。 */ () => this.#reload?.())
    return { state: 'configured', fingerprint }
  }

  // 关闭原HTTP交付并等待其不确定凭据拒绝完成，然后撤下唯一state引用。
  async detach(state: State): Promise<void> {
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = undefined
    }
    const http = this.#active
    this.#active = undefined
    await http?.close()
    this.approval.detach(state)
  }
}
