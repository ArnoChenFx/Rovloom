// Connector 在线认领：向运行中的 Gateway 发起配对认领、展示核对码、等待管理员在管理面批准后领取并持久化设备凭据。
// 与离线 setup 的区别只在签发通道：不经过 Gateway 终端、不使用一次性配对码；Gateway 全程不重启、不停机。
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { digest } from '../contracts.js'
import { createFileCredentialSink } from '../transport/credentials.js'
import type { DeviceCredential } from '../transport/identity.js'
import { boundedJson, fields, id, object, uint } from '../wire/index.js'
import { CliError, configDocument, parseConfig, readConfig, type ConnectorConfig } from './config.js'
import { privateDirectory } from './first-config.js'
import type { SetupTerminal } from './setup-terminal.js'
import { readSetupJson, setupFileStamp, writeSetupFile, writeSetupJson } from './setup-files.js'
import { runtimeReference } from './runtime-files.js'
import { post } from './setup-connector.js'
import { readRuntimeConfig } from './runtime-config.js'

// 认领恢复记录只含非秘密目标与认领秘密本身；认领秘密是单用途短时材料，与设备凭据同目录同权限保存，交付完成后立即删除。
type ClaimRecord = {
  schema_version: 1
  claim_id: string
  machine_id: string
  pairing_id: string
  gateway_url: string
  secret?: string
  phase: 'waiting' | 'credential_saved' | 'paired'
}

// 严格核对恢复记录；地址改变或未知字段时拒绝续用，避免把认领秘密发给另一个 Gateway。
function record(value: unknown, config: ConnectorConfig): ClaimRecord {
  const row = object(value)
  fields(row, ['schema_version', 'claim_id', 'machine_id', 'pairing_id', 'gateway_url', 'phase'], ['secret'])
  id(row.claim_id)
  id(row.machine_id)
  id(row.pairing_id)
  if (
    row.schema_version !== 1 ||
    row.gateway_url !== config.gateway_url ||
    !['waiting', 'credential_saved', 'paired'].includes(String(row.phase)) ||
    (row.phase !== 'paired' && (typeof row.secret !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(row.secret)))
  ) {
    throw new CliError('configuration_required')
  }
  return row as ClaimRecord
}

// 轮询等待的人类在环预算；真正的到期由 Gateway 账本判定并以状态返回，本预算只防止本地无限等待。
const POLL_BUDGET_MS = 600_000
const POLL_INTERVAL_MS = 2000

/** 在线认领入口：只处理凭据配对；已完成配对或已配置 provider 的 Connector 明确拒绝，避免覆盖既有身份。 */
export async function claimConnector(config: ConnectorConfig, terminal: SetupTerminal): Promise<ConnectorConfig> {
  const credentialPath = runtimeReference(config.state_dir, 'device')
  if (readRuntimeConfig(config).providers.length > 0 || existsSync(credentialPath)) {
    throw new CliError('configuration_required')
  }
  if (!config.gateway_url) {
    const previous = setupFileStamp(terminal.configPath)
    if (boundedJson(configDocument(readConfig(terminal.configPath))) !== boundedJson(configDocument(config))) {
      throw new CliError('config_changed')
    }
    const address = await terminal.ask('Gateway address (ws://host:port or wss://host) / Gateway 地址: ')
    config = parseConfig({ ...configDocument(config), gateway: { url: address } }) as ConnectorConfig
    writeSetupFile(terminal.configPath, JSON.stringify(configDocument(config), null, 2) + '\n', true, previous)
  }
  privateDirectory(config.state_dir)
  privateDirectory(join(config.state_dir, 'managed'))
  const path = runtimeReference(config.state_dir, 'pairing-claim')
  const previous = readSetupJson(path)
  let current: ClaimRecord
  if (previous === undefined) {
    const pairing_id = await terminal.ask('Pairing application ID / 配对申请 ID: ')
    id(pairing_id)
    if (
      !(await terminal.confirm(
        'Trust this Gateway address for online device enrollment? / 信任此 Gateway 地址并在线认领设备配对？'
      ))
    ) {
      throw new CliError('configuration_required')
    }
    // 认领秘密由本机生成：原文只用于状态查询与确认领取，Gateway 只保存其摘要。
    const secret = randomBytes(32).toString('base64url')
    const created = await post(
      config,
      '/pairing/claim',
      { pairing_id, secret_hash: digest(secret) },
      terminal.io.signal
    )
    fields(created, ['claim_id', 'machine_id', 'user_code', 'expires_at'])
    id(created.claim_id)
    id(created.machine_id)
    if (
      typeof created.user_code !== 'string' ||
      !/^[A-Z0-9]{8}$/.test(created.user_code) ||
      !Number.isSafeInteger(created.expires_at)
    ) {
      throw new CliError('configuration_required')
    }
    current = {
      schema_version: 1,
      claim_id: created.claim_id,
      machine_id: created.machine_id,
      pairing_id,
      gateway_url: config.gateway_url,
      secret,
      phase: 'waiting'
    }
    writeSetupJson(path, current)
    terminal.show(
      'Claim code / 核对码: ' +
        created.user_code +
        '\nApprove this exact code for machine ' +
        current.machine_id +
        ' in the management page. / 请在管理页为该设备核对并批准此码。\n'
    )
  } else {
    current = record(previous, config)
    if (current.phase === 'paired') {
      terminal.show('pairing_completed / 设备身份已持久配对。\n')
      return config
    }
    terminal.show('Resuming the existing claim. / 继续原认领。\n')
  }
  if (current.phase === 'credential_saved') {
    // 凭据已落盘但确认可能丢失：只补发同一认领的确认，不重新领取或生成第二份凭据。
    await acknowledge(config, terminal, current)
    return config
  }
  const deadline = Date.now() + POLL_BUDGET_MS
  for (;;) {
    if (terminal.io.signal.aborted || Date.now() > deadline) {
      terminal.show(
        'Approval wait ended; rerun the same command to resume this claim. / 等待批准已结束；重新运行同一命令可继续原认领。\n'
      )
      throw new CliError('configuration_required')
    }
    let status: Record<string, unknown> | undefined
    try {
      status = await post(
        config,
        '/pairing/claim/status',
        { claim_id: current.claim_id, secret: current.secret },
        terminal.io.signal
      )
    } catch {
      // 轮询期网络抖动不终止认领；真正的终结由 Gateway 返回的终态或本地预算决定。
      status = undefined
    }
    if (status) {
      if (status.status === 'approved') {
        fields(status, ['status', 'credential', 'machine_id', 'recovery_generation', 'revision'])
        id(status.recovery_generation)
        uint(status.revision, true)
        if (
          status.machine_id !== current.machine_id ||
          typeof status.credential !== 'string' ||
          !/^[A-Za-z0-9_-]{32,256}$/.test(status.credential)
        ) {
          throw new CliError('configuration_required')
        }
        const credential: DeviceCredential = {
          machine_id: current.machine_id,
          recovery_generation: status.recovery_generation,
          credential: status.credential
        }
        const sink = createFileCredentialSink(credentialPath, credential)
        try {
          await sink.deliver(credential, terminal.io.signal, {
            delivery_id: current.claim_id,
            revision: status.revision
          })
        } finally {
          sink.close()
        }
        current = { ...current, phase: 'credential_saved' }
        writeSetupJson(path, current, true)
        await acknowledge(config, terminal, current)
        return config
      }
      if (status.status === 'delivered') {
        // 确认已在 Gateway 落账但本地阶段未推进时按已交付收敛，不重复领取。
        current = {
          schema_version: 1,
          claim_id: current.claim_id,
          machine_id: current.machine_id,
          pairing_id: current.pairing_id,
          gateway_url: current.gateway_url,
          phase: 'paired'
        }
        writeSetupJson(path, current, true)
        terminal.show('pairing_completed / 设备身份已持久配对；接下来发现所选原生安装。\n')
        return config
      }
      if (status.status === 'failed' || status.status === 'cancelled' || status.status === 'expired') {
        terminal.show(
          'Claim ' +
            status.status +
            '. / 认领已' +
            (status.status === 'expired' ? '过期' : '终止') +
            '，请让管理员重新创建申请后重试。\n'
        )
        throw new CliError('configuration_required')
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

// 确认领取并删除本地认领秘密；确认响应丢失时以状态查询的 delivered 为准收敛。
async function acknowledge(config: ConnectorConfig, terminal: SetupTerminal, current: ClaimRecord): Promise<void> {
  try {
    const receipt = await post(
      config,
      '/pairing/claim/ack',
      { claim_id: current.claim_id, secret: current.secret },
      terminal.io.signal
    )
    fields(receipt, ['status'])
    if (receipt.status !== 'delivered') {
      throw new CliError('configuration_required')
    }
  } catch {
    const status = await post(
      config,
      '/pairing/claim/status',
      { claim_id: current.claim_id, secret: current.secret },
      terminal.io.signal
    )
    if (status.status !== 'delivered') {
      throw new CliError('configuration_required')
    }
  }
  writeSetupJson(
    runtimeReference(config.state_dir, 'pairing-claim'),
    {
      schema_version: 1,
      claim_id: current.claim_id,
      machine_id: current.machine_id,
      pairing_id: current.pairing_id,
      gateway_url: current.gateway_url,
      phase: 'paired'
    },
    true
  )
  terminal.show('pairing_completed / 设备身份已持久配对；接下来发现所选原生安装。\n')
}
