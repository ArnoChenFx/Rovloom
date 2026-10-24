// Connector 在线认领：向运行中的 Gateway 发起配对认领、展示核对码、等待管理员在管理面批准后领取并持久化设备凭据，
// 随后以同一认领为 attempt 完成在线原生激活（授权查询交叉核对 → 实测清单提交 → 本地 provider 落盘）。
// 与离线 setup 的区别只在签发与批准通道：不经过 Gateway 终端、不使用一次性配对码；Gateway 全程不重启、不停机。
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { digest } from '../contracts.js'
import { createFileCredentialSink, loadCredential } from '../transport/credentials.js'
import type { DeviceCredential } from '../transport/identity.js'
import { boundedJson, fields, hash, id, object, uint } from '../wire/index.js'
import { cliMessages, formatMessage } from './messages.js'
import {
  CliError,
  configDocument,
  parseConfig,
  readConfig,
  selectedNativeProviders,
  type ConnectorConfig
} from './config.js'
import { assertSetupNativePath, prepareSetupNative } from './setup-native.js'
import { prepareSetupHerdr } from './setup-herdr.js'
import { selectedSetupPolicies, setupSessionsFor } from './setup-policy.js'
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
  expires_at?: number
  credential_hash?: string
  recovery_generation?: string
  phase: 'waiting' | 'credential_saved' | 'paired' | 'configured'
}

// 严格核对恢复记录；地址改变或未知字段时拒绝续用，避免把认领秘密发给另一个 Gateway。
function record(value: unknown, config: ConnectorConfig): ClaimRecord {
  const row = object(value)
  fields(
    row,
    ['schema_version', 'claim_id', 'machine_id', 'pairing_id', 'gateway_url', 'phase'],
    ['secret', 'expires_at', 'credential_hash', 'recovery_generation']
  )
  id(row.claim_id)
  id(row.machine_id)
  id(row.pairing_id)
  if (
    (row.expires_at !== undefined && (!Number.isSafeInteger(row.expires_at) || Number(row.expires_at) < 0)) ||
    ((row.credential_hash !== undefined || row.recovery_generation !== undefined) &&
      (typeof row.credential_hash !== 'string' ||
        !/^[0-9a-f]{64}$/.test(row.credential_hash) ||
        typeof row.recovery_generation !== 'string')) ||
    row.schema_version !== 1 ||
    row.gateway_url !== config.gateway_url ||
    !['waiting', 'credential_saved', 'paired', 'configured'].includes(String(row.phase)) ||
    (row.phase !== 'paired' &&
      row.phase !== 'configured' &&
      (typeof row.secret !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(row.secret)))
  ) {
    throw new CliError('configuration_required')
  }
  if (row.recovery_generation !== undefined) {
    id(row.recovery_generation)
  }
  return row as ClaimRecord
}

// 轮询等待的人类在环预算；真正的到期由 Gateway 账本判定并以状态返回，本预算只防止本地无限等待。
const POLL_BUDGET_MS = 600_000
const POLL_INTERVAL_MS = 2000

/** 在线认领入口：处理凭据配对并在同一命令内续跑在线原生激活；无认领记录时既有身份明确拒绝，避免覆盖。 */
export async function claimConnector(config: ConnectorConfig, terminal: SetupTerminal): Promise<ConnectorConfig> {
  const credentialPath = runtimeReference(config.state_dir, 'device')
  if (!config.gateway_url) {
    const previous = setupFileStamp(terminal.configPath)
    if (boundedJson(configDocument(readConfig(terminal.configPath))) !== boundedJson(configDocument(config))) {
      throw new CliError('config_changed')
    }
    const address = await terminal.ask(cliMessages(terminal.io.language)['setup.gatewayAddressPrompt'])
    config = parseConfig({ ...configDocument(config), gateway: { url: address } }) as ConnectorConfig
    writeSetupFile(terminal.configPath, JSON.stringify(configDocument(config), null, 2) + '\n', true, previous)
  }
  privateDirectory(config.state_dir)
  privateDirectory(join(config.state_dir, 'managed'))
  const path = runtimeReference(config.state_dir, 'pairing-claim')
  const previous = readSetupJson(path)
  // 没有认领记录时，既有 provider 配置或设备凭据都意味着这台 Connector 已另行配对，拒绝覆盖；
  // 有认领记录时按记录阶段续跑（凭据与 provider 文件可能已由本认领在激活途中落盘）。
  if (previous === undefined && (readRuntimeConfig(config).providers.length > 0 || existsSync(credentialPath))) {
    throw new CliError('configuration_required')
  }
  let current = previous === undefined ? undefined : record(previous, config)
  if (existsSync(credentialPath)) {
    if (!current || !matchesSavedCredential(current, credentialPath)) {
      throw new CliError('configuration_required')
    }
    if (current.phase === 'configured') {
      terminal.show(cliMessages(terminal.io.language)['setup.claim.pairingCompletedActivated'])
      return config
    }
    if (current.phase === 'paired') {
      // 配对已落账，原生激活未完成：以同一认领继续，不重新认领或更换凭据。
      return await activate(config, terminal, current)
    }
    // 写入凭据后的任何中断都只补原认领的确认，不重新交付或覆盖身份。
    if (current.phase !== 'credential_saved') {
      current = { ...current, phase: 'credential_saved' }
      writeSetupJson(path, current, true)
    }
    const paired = await acknowledge(config, terminal, current)
    return await activate(config, terminal, paired)
  }
  if (current && current.phase !== 'waiting') {
    throw new CliError('configuration_required')
  }
  current ??= await startClaim(config, terminal, path, false)
  let deadline = Date.now() + POLL_BUDGET_MS
  for (;;) {
    if (terminal.io.signal.aborted) {
      throw new CliError('configuration_required')
    }
    if (current.expires_at !== undefined && Date.now() >= current.expires_at) {
      current = await restartClaim(config, terminal, path, credentialPath)
      deadline = Date.now() + POLL_BUDGET_MS
      continue
    }
    if (Date.now() > deadline) {
      terminal.show(cliMessages(terminal.io.language)['setup.claim.waitEnded'])
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
      // 网络抖动保留原认领；已知原始到期时间不因重启或重试刷新。
      status = undefined
    }
    if (status?.status === 'approved') {
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
      // 在交付前持久记录预期身份；随后即使只写成凭据，也能证明该文件属于原认领。
      current = {
        ...current,
        credential_hash: digest(credential.credential),
        recovery_generation: credential.recovery_generation
      }
      writeSetupJson(path, current, true)
      const sink = createFileCredentialSink(credentialPath, credential)
      try {
        await sink.deliver(credential, terminal.io.signal, { delivery_id: current.claim_id, revision: status.revision })
      } finally {
        sink.close()
      }
      current = { ...current, phase: 'credential_saved' }
      writeSetupJson(path, current, true)
      const paired = await acknowledge(config, terminal, current)
      return await activate(config, terminal, paired)
    }
    if (status?.status === 'delivered') {
      // Gateway 的成功不能替代本机凭据存在且精确匹配的证据。
      if (!existsSync(credentialPath) || !matchesSavedCredential(current, credentialPath)) {
        throw new CliError('configuration_required')
      }
      const paired = await acknowledge(config, terminal, current)
      return await activate(config, terminal, paired)
    }
    if (status?.status === 'failed' || status?.status === 'cancelled' || status?.status === 'expired') {
      current = await restartClaim(config, terminal, path, credentialPath)
      deadline = Date.now() + POLL_BUDGET_MS
      continue
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

/** 恢复只接受同一机器、恢复代次和凭据摘要，不能借认领覆盖或确认其他身份。 */
function matchesSavedCredential(current: ClaimRecord, path: string): boolean {
  const credential = loadCredential(path)
  return (
    credential.machine_id === current.machine_id &&
    credential.recovery_generation === current.recovery_generation &&
    digest(credential.credential) === current.credential_hash
  )
}

/** 原认领已终结或达到原始期限后，由操作者明确开始新意图；拒绝时原记录不变。 */
async function restartClaim(
  config: ConnectorConfig,
  terminal: SetupTerminal,
  path: string,
  credentialPath: string
): Promise<ClaimRecord> {
  if (
    terminal.io.signal.aborted ||
    existsSync(credentialPath) ||
    !(await terminal.confirm(cliMessages(terminal.io.language)['setup.claim.restartConfirm']))
  ) {
    throw new CliError('configuration_required')
  }
  return startClaim(config, terminal, path, true)
}

/** 只在首次运行或用户明确重新申请后创建一份新认领，认领秘密不进入终端输出。 */
async function startClaim(
  config: ConnectorConfig,
  terminal: SetupTerminal,
  path: string,
  replace: boolean
): Promise<ClaimRecord> {
  const pairing_id = await terminal.ask(cliMessages(terminal.io.language)['setup.claim.pairingIdPrompt'])
  id(pairing_id)
  if (!(await terminal.confirm(cliMessages(terminal.io.language)['setup.claim.trustConfirm']))) {
    throw new CliError('configuration_required')
  }
  // 认领秘密由本机生成：原文只用于状态查询与确认领取，Gateway 只保存其摘要。
  const secret = randomBytes(32).toString('base64url')
  const created = await post(config, '/pairing/claim', { pairing_id, secret_hash: digest(secret) }, terminal.io.signal)
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
  const current: ClaimRecord = {
    schema_version: 1,
    claim_id: created.claim_id,
    machine_id: created.machine_id,
    pairing_id,
    gateway_url: config.gateway_url,
    secret,
    expires_at: Number(created.expires_at),
    phase: 'waiting'
  }
  writeSetupJson(path, current, replace)
  terminal.show(
    formatMessage(cliMessages(terminal.io.language)['setup.claim.claimCodeBlock'], {
      code: created.user_code,
      machine: current.machine_id
    })
  )
  return current
}

// 确认领取并删除本地认领秘密；确认响应丢失时以状态查询的 delivered 为准收敛。
async function acknowledge(
  config: ConnectorConfig,
  terminal: SetupTerminal,
  current: ClaimRecord
): Promise<ClaimRecord> {
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
  const { secret: _secret, ...rest } = current
  const paired: ClaimRecord = { ...rest, phase: 'paired' }
  writeSetupJson(runtimeReference(config.state_dir, 'pairing-claim'), paired, true)
  terminal.show(cliMessages(terminal.io.language)['setup.connector.pairingCompleted'])
  return paired
}

// 在线原生激活：以认领 ID 为 attempt 查询 Gateway 授权并交叉核对本机推导，再准备实测清单提交激活，
// 最后写下与离线 setup 相同的本地 providers 与 pairing 记录，Connector 正式启动即以真实 provider 运行。
async function activate(
  config: ConnectorConfig,
  terminal: SetupTerminal,
  current: ClaimRecord
): Promise<ConnectorConfig> {
  assertSetupNativePath(config, terminal)
  const credential = loadCredential(runtimeReference(config.state_dir, 'device'))
  if (credential.machine_id !== current.machine_id) {
    throw new CliError('configuration_required')
  }
  const status = await post(
    config,
    '/pairing/claim/activation/status',
    {
      attempt_id: current.claim_id,
      authentication: credential,
      providers: selectedNativeProviders(config),
      sessions: setupSessionsFor(config)
    },
    terminal.io.signal
  )
  fields(status, ['attempt_id', 'machine_id', 'recovery_generation', 'phase', 'authorization'], ['lineage'])
  if (status.lineage !== undefined) {
    id(status.lineage)
  }
  if (
    status.attempt_id !== current.claim_id ||
    status.machine_id !== credential.machine_id ||
    status.recovery_generation !== credential.recovery_generation ||
    !['paired', 'configured'].includes(String(status.phase))
  ) {
    throw new CliError('configuration_required')
  }
  const authorization = object(status.authorization)
  fields(authorization, ['principal_id', 'policies'])
  id(authorization.principal_id)
  const expected = selectedSetupPolicies(
    {
      attempt_id: current.claim_id,
      actor: authorization.principal_id as string,
      ...(status.lineage ? { lineage: status.lineage as string } : {})
    },
    credential.machine_id,
    selectedNativeProviders(config),
    setupSessionsFor(config)
  )
  // Gateway 返回的授权必须与本机按同一主体/谱系推导的逐字节一致，网关不能单方面放大权限。
  if (boundedJson(authorization) !== boundedJson(expected)) {
    throw new CliError('configuration_required')
  }
  const prepared = []
  for (const kind of selectedNativeProviders(config)) {
    prepared.push(
      await (kind === 'luvus' ? prepareSetupNative : prepareSetupHerdr)(
        config,
        terminal,
        credential,
        current.claim_id,
        expected
      )
    )
  }
  const installations = prepared.map((native) => ({ reference: native.reference, value: native.remote }))
  const installation =
    installations.length === 1 && selectedNativeProviders(config)[0] === 'luvus' ? installations[0]! : { installations }
  const fingerprint = hash(boundedJson(installation, 1_048_576))
  try {
    const applied = await post(
      config,
      '/pairing/claim/activation/native',
      { attempt_id: current.claim_id, authentication: credential, installation },
      terminal.io.signal,
      300_000
    )
    fields(applied, ['state', 'fingerprint'])
    if (applied.state !== 'configured' || applied.fingerprint !== fingerprint) {
      throw new CliError('configuration_required')
    }
  } catch {
    // Gateway 激活后会重开，响应可能丢失；不重做认领，下一次运行按原认领查询持久阶段收敛。
    terminal.show(cliMessages(terminal.io.language)['setup.claim.activationResponseUnavailable'])
    throw new CliError('configuration_required')
  }
  const providersPath = runtimeReference(config.state_dir, 'providers')
  const providersDocument = {
    schema_version: 1,
    role: 'connector',
    providers: prepared.map((native) => ({ reference: native.reference, value: native.local }))
  }
  const existingProviders = readSetupJson(providersPath, 1_048_576)
  if (existingProviders === undefined) {
    writeSetupJson(providersPath, providersDocument, false, 1_048_576)
  } else if (boundedJson(existingProviders, 1_048_576) !== boundedJson(providersDocument, 1_048_576)) {
    throw new CliError('configuration_required')
  }
  const pairingPath = runtimeReference(config.state_dir, 'pairing')
  const pairingDocument = {
    schema_version: 1,
    attempt_id: current.claim_id,
    machine_id: current.machine_id,
    gateway_url: config.gateway_url,
    phase: 'configured'
  }
  const existingPairing = readSetupJson(pairingPath)
  if (existingPairing === undefined) {
    writeSetupJson(pairingPath, pairingDocument)
  } else if (boundedJson(existingPairing) !== boundedJson(pairingDocument)) {
    throw new CliError('configuration_required')
  }
  writeSetupJson(runtimeReference(config.state_dir, 'pairing-claim'), { ...current, phase: 'configured' }, true)
  terminal.show(cliMessages(terminal.io.language)['setup.claim.nativeStatePrepared'])
  terminal.finishQuestions()
  return config
}
