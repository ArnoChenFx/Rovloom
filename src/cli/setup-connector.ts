// 正式Connector首次通过既有专用文件sink兑换配对；不从argv/env读取secret，不重发不确定身份或调用模型。
import { createFileCredentialSink, loadCredential } from '../transport/credentials.js'
import type { DeviceCredential } from '../transport/identity.js'
import { parseNativeJson } from '../native-contract/json.js'
import { boundedJson, fields, id, object, uint, hash } from '../wire/index.js'
import type { ProviderPolicies } from '../wire/types.js'
import { CliError, configDocument, parseConfig, readConfig, type ConnectorConfig } from './config.js'
import { privateDirectory } from './first-config.js'
import { SetupTerminal } from './setup-terminal.js'
import { readSetupJson, setupFileStamp, writeSetupFile, writeSetupJson } from './setup-files.js'
import { runtimeReference } from './runtime-files.js'
import { prepareSetupNative, assertSetupNativePath } from './setup-native.js'
import { setupPolicies, setupTarget } from './setup-policy.js'
import { readRuntimeConfig } from './runtime-config.js'
import { join } from 'node:path'

type Attempt = Readonly<{
  schema_version: 1
  attempt_id: string
  machine_id: string
  gateway_url: string
  phase: 'requesting' | 'credential_saved' | 'paired' | 'configured'
}>

// 有界、严格地读取专用端点响应，重复键/无效UTF8不会降为普通JSON.parse。
async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader()
  if (!reader || response.status !== 200) {
    await response.body?.cancel()
    throw new CliError('configuration_required')
  }
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const value = await reader.read()
      if (value.done) {
        break
      }
      bytes += value.value.length
      if (bytes > 16_384) {
        throw new CliError('configuration_required')
      }
      chunks.push(value.value)
    }
    const parsed = parseNativeJson(Buffer.concat(chunks, bytes), { object_bytes: 16_384 })
    if (!parsed.ok) {
      throw new CliError('configuration_required')
    }
    return object(parsed.value)
  } finally {
    await reader.cancel().catch(/* 只释放响应流，不输出远端文本或secret。 */ () => {})
    reader.releaseLock()
  }
}

// URL只由严格角色origin解析；系统TLS验证和fetch重定向拒绝保持开启，原body不会发给另一origin。
async function post(config: ConnectorConfig, path: string, value: unknown, signal: AbortSignal, timeout = 5000) {
  const origin = new URL(config.gateway_url)
  origin.protocol = origin.protocol === 'wss:' ? 'https:' : 'http:'
  return await responseJson(
    await fetch(new URL(path, origin), {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: boundedJson(value),
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)])
    })
  )
}

// 恢复位置只保留非秘密目标和原地址；地址改变、半完成请求或未知字段不能触发新的兑换。
function attempt(value: unknown, config: ConnectorConfig): Attempt {
  const row = object(value)
  fields(row, ['schema_version', 'attempt_id', 'machine_id', 'gateway_url', 'phase'])
  id(row.attempt_id)
  id(row.machine_id)
  if (
    row.schema_version !== 1 ||
    row.gateway_url !== config.gateway_url ||
    !['requesting', 'credential_saved', 'paired', 'configured'].includes(String(row.phase))
  ) {
    throw new CliError('configuration_required')
  }
  return row as Attempt
}

// 初次交付先持久保存再提交准确ack；ack响应丢失时仅查询同一已保存身份，不重新redeem。
async function pair(
  config: ConnectorConfig,
  terminal: SetupTerminal
): Promise<{
  current: Attempt
  credential: DeviceCredential
  authorization: { principal_id: string; policies: ProviderPolicies }
}> {
  const path = runtimeReference(config.state_dir, 'pairing')
  const credentialPath = runtimeReference(config.state_dir, 'device')
  const previous = readSetupJson(path)
  let current: Attempt
  let credential: DeviceCredential
  if (previous === undefined) {
    const value = await terminal.ask('One-time pairing code / 一次性配对码: ', true)
    const parts = value.split('.')
    if (parts.length !== 3) {
      throw new CliError('configuration_required')
    }
    const [machine, original, enrollment] = parts
    id(machine)
    id(original)
    if (!enrollment || !/^[A-Za-z0-9_-]{32,256}$/.test(enrollment)) {
      throw new CliError('configuration_required')
    }
    if (
      !(await terminal.confirm(
        'Trust this Gateway address for one-time device enrollment and reviewed native setup? / 信任此 Gateway 地址并兑换一次性设备配对？'
      ))
    ) {
      throw new CliError('configuration_required')
    }
    current = {
      schema_version: 1,
      attempt_id: original,
      machine_id: machine,
      gateway_url: config.gateway_url,
      phase: 'requesting'
    }
    writeSetupJson(path, current)
    const delivery = await post(
      config,
      '/pairing/redeem',
      { attempt_id: original, machine_id: machine, enrollment },
      terminal.io.signal
    )
    fields(delivery, [
      'attempt_id',
      'delivery_id',
      'revision',
      'machine_id',
      'recovery_generation',
      'credential',
      'state',
      'expires_at'
    ])
    id(delivery.delivery_id)
    id(delivery.recovery_generation)
    uint(delivery.revision, true)
    if (
      delivery.attempt_id !== original ||
      delivery.machine_id !== machine ||
      delivery.state !== 'persist_and_acknowledge' ||
      typeof delivery.credential !== 'string' ||
      !/^[A-Za-z0-9_-]{32,256}$/.test(delivery.credential) ||
      !Number.isSafeInteger(delivery.expires_at) ||
      Number(delivery.expires_at) <= Date.now()
    ) {
      throw new CliError('configuration_required')
    }
    credential = {
      machine_id: machine,
      recovery_generation: delivery.recovery_generation,
      credential: delivery.credential
    }
    const sink = createFileCredentialSink(credentialPath, credential)
    try {
      const ack = await sink.deliver(credential, terminal.io.signal, {
        delivery_id: delivery.delivery_id,
        revision: delivery.revision
      })
      current = { ...current, phase: 'credential_saved' }
      writeSetupJson(path, current, true)
      try {
        const receipt = await post(
          config,
          '/pairing/ack',
          { attempt_id: original, authentication: credential, acknowledgement: ack },
          terminal.io.signal
        )
        fields(receipt, ['machine_id', 'delivery_id', 'state', 'attempt_id'])
        if (
          receipt.machine_id !== machine ||
          receipt.delivery_id !== delivery.delivery_id ||
          receipt.state !== 'delivered' ||
          receipt.attempt_id !== original
        ) {
          throw new CliError('configuration_required')
        }
      } catch {
        // 仅原attempt的已保存身份可查询原结果；未确认不能重新兑换或保存第二份secret。
        terminal.assertOwner()
      }
    } finally {
      sink.close()
    }
  } else {
    current = attempt(previous, config)
    if (current.phase === 'requesting') {
      throw new CliError('configuration_required')
    }
    credential = loadCredential(credentialPath)
    if (credential.machine_id !== current.machine_id) {
      throw new CliError('configuration_required')
    }
  }
  const status = await post(
    config,
    '/pairing/status',
    { attempt_id: current.attempt_id, authentication: credential },
    terminal.io.signal
  )
  fields(status, ['attempt_id', 'machine_id', 'recovery_generation', 'phase', 'authorization'])
  if (
    status.attempt_id !== current.attempt_id ||
    status.machine_id !== credential.machine_id ||
    status.recovery_generation !== credential.recovery_generation ||
    !['paired', 'native_approved', 'configured'].includes(String(status.phase))
  ) {
    throw new CliError('configuration_required')
  }
  const authorization = object(status.authorization)
  fields(authorization, ['principal_id', 'policies'])
  id(authorization.principal_id)
  const expected = setupPolicies(
    { attempt_id: current.attempt_id, actor: authorization.principal_id },
    setupTarget(credential.machine_id)
  )
  if (boundedJson(authorization) !== boundedJson(expected)) {
    throw new CliError('configuration_required')
  }
  current = { ...current, phase: 'paired' }
  writeSetupJson(path, current, true)
  return { current, credential, authorization: expected }
}

// 真实TTY首次地址/配对后发现并准备native；程序管理的refs和凭据不写入唯一业务配置。
export async function setupConnector(config: ConnectorConfig, terminal: SetupTerminal): Promise<ConnectorConfig> {
  if (readRuntimeConfig(config).providers.length > 0) {
    terminal.finishQuestions()
    return config
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
  assertSetupNativePath(config, terminal)
  privateDirectory(config.state_dir)
  privateDirectory(join(config.state_dir, 'managed'))
  const paired = await pair(config, terminal)
  terminal.show('pairing_completed / 设备身份已持久配对；接下来发现实际 Luvus。\n')
  const native = await prepareSetupNative(
    config,
    terminal,
    paired.credential,
    paired.current.attempt_id,
    paired.authorization
  )
  const installation = { reference: native.reference, value: native.remote }
  const expected = hash(boundedJson(installation))
  try {
    const applied = await post(
      config,
      '/pairing/native',
      { attempt_id: paired.current.attempt_id, authentication: paired.credential, installation },
      terminal.io.signal,
      300_000
    )
    fields(applied, ['state', 'fingerprint'])
    if (applied.state !== 'configured' || applied.fingerprint !== expected) {
      throw new CliError('configuration_required')
    }
  } catch {
    // Gateway重开可能丢失响应；不重做初始化，下一次启动查询原attempt的持久阶段。
    terminal.show(
      'Native setup response unavailable; retain the original setup and rerun Connector to check it. / 原生设置响应不可用；保留原状态，重新运行 Connector 核对。\n'
    )
    throw new CliError('configuration_required')
  }
  writeSetupJson(
    runtimeReference(config.state_dir, 'providers'),
    { schema_version: 1, role: 'connector', providers: [{ reference: native.reference, value: native.local }] },
    false,
    1_048_576
  )
  writeSetupJson(runtimeReference(config.state_dir, 'pairing'), { ...paired.current, phase: 'configured' }, true)
  terminal.show(
    'Native state prepared; starting the real Connector. Watch Gateway for connector_ready. / 原生状态已准备；启动正式 Connector，以 Gateway 的实际就绪提示为准。\n'
  )
  terminal.finishQuestions()
  return config
}
