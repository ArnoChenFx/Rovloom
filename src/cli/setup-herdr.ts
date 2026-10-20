// Herdr首次准备只使用实际binary/schema和既有编译、私有路径及账本工厂；不启动Agent或复制普通HOME认证。
import { join } from 'node:path'
import { compileHerdrSchemas } from '../connector/herdr/compiler-api.js'
import { herdrDeadline, runHerdrCommand } from '../connector/herdr/io.js'
import { HerdrLocalError, measureHerdrInstallation, verifyHerdrInstallation } from '../connector/herdr/local.js'
import type { HerdrLocalConfig } from '../connector/herdr/local.js'
import { observedHerdrSource } from '../connector/herdr/review.js'
import { parseHerdrProviderRefConfig } from '../connector/herdr/provider.js'
import type { HerdrProviderRefConfig } from '../connector/herdr/provider.js'
import { LuvusDispatchClaims } from '../connector/luvus/claims.js'
import { ConnectorAdmissionReceipts } from '../transport/admission-receipts.js'
import type { DeviceCredential } from '../transport/identity.js'
import type { ProviderPolicies } from '../wire/types.js'
import { boundedJson, fields, hash, object } from '../wire/index.js'
import { CliError, type ConnectorConfig } from './config.js'
import { privateDirectory } from './first-config.js'
import type { HerdrProductionOwnerConfig } from './production-herdr.js'
import { readSetupJson, writeSetupFile, writeSetupJson } from './setup-files.js'
import { assertSetupNativePath, setupBinary } from './setup-native.js'
import { setupReference, setupTarget } from './setup-policy.js'
import { runtimeReference } from './runtime-files.js'
import type { SetupTerminal } from './setup-terminal.js'

export type HerdrSetupRemote = Readonly<{
  kind: 'herdr'
  config: Omit<HerdrProviderRefConfig, 'schema_path' | 'connector'>
  schema_bundle: string
}>
export type PreparedSetupHerdr = Readonly<{
  schema_version: 1
  attempt_id: string
  machine_id: string
  phase: 'prepared'
  settings: NonNullable<ConnectorConfig['native']>
  reference: string
  local: HerdrProductionOwnerConfig
  remote: HerdrSetupRemote
}>

// 版本只作诊断；只降低原固定版本命令不支持/独立超时，安装、取消或IO错误保持失败。
async function version(config: HerdrLocalConfig, signal: AbortSignal): Promise<string> {
  const scope = herdrDeadline(signal, 1000)
  try {
    const raw = await runHerdrCommand(config, 'version', scope.signal)
    const label = raw
      .toString('utf8')
      .trim()
      .replace(/^herdr\s+/i, '')
    return label.length > 0 &&
      label.length <= 128 &&
      [...label].every(
        /* 诊断标签不能向本机终端注入控制字符。 */ (character) =>
          character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
      )
      ? label
      : 'unavailable'
  } catch (error) {
    if (
      error instanceof HerdrLocalError &&
      (error.code === 'herdr_cli_exit' || (error.code === 'herdr_timeout' && !signal.aborted))
    ) {
      return 'unavailable'
    }
    throw error
  } finally {
    scope.close()
  }
}

// 同一配对和设置才可继续已准备状态；初始化半完成保留原journal，不重建丢失的账本或墓碑。
function prepared(value: unknown, config: ConnectorConfig, attempt: string, machine: string): PreparedSetupHerdr {
  const row = object(value)
  fields(row, ['schema_version', 'attempt_id', 'machine_id', 'phase', 'settings', 'reference', 'local', 'remote'])
  if (
    row.schema_version !== 1 ||
    row.attempt_id !== attempt ||
    row.machine_id !== machine ||
    row.phase !== 'prepared' ||
    row.reference !== setupReference(attempt, 'herdr') ||
    boundedJson(row.settings) !== boundedJson(config.native ?? {})
  ) {
    throw new CliError('configuration_required')
  }
  return row as PreparedSetupHerdr
}

// 本机明确批准后仅发现安装并创建隔离状态；实际server/peer来源由原生产工厂在正式启动时建立。
export async function prepareSetupHerdr(
  config: ConnectorConfig,
  terminal: SetupTerminal,
  credential: DeviceCredential,
  attempt: string,
  authorization: Readonly<{ principal_id: string; policies: ProviderPolicies }>
): Promise<PreparedSetupHerdr> {
  terminal.assertOwner()
  const path = runtimeReference(config.state_dir, 'herdr-setup')
  const existing = readSetupJson(path, 1_048_576)
  if (existing !== undefined) {
    return prepared(existing, config, attempt, credential.machine_id)
  }
  const binary = setupBinary(config, 'herdr')
  if (
    !(await terminal.confirm(
      'Discover this Herdr installation and create its isolated local state (terminal execution disabled)? / 发现 Herdr 并创建隔离状态（关闭终端执行）？'
    ))
  ) {
    throw new CliError('configuration_required')
  }
  assertSetupNativePath(config, terminal)
  const root = join(config.state_dir, 'hr')
  privateDirectory(root)
  for (const name of ['h', 'c', 's', 'k', 't', 'w', 'control']) {
    privateDirectory(join(root, name))
  }
  const target = setupTarget(credential.machine_id, 'herdr')
  const reference = setupReference(attempt, 'herdr')
  const local: HerdrLocalConfig = {
    target,
    binding_revision: 1,
    config_ref: reference,
    binary,
    home: join(root, 'h'),
    config_home: join(root, 'c'),
    state_home: join(root, 's'),
    cache_home: join(root, 'k'),
    temporary_home: join(root, 't'),
    cwd: join(root, 'w'),
    allow_terminal_execution: false,
    ...(config.native?.agent_bin_dir ? { agent_bin_dir: config.native.agent_bin_dir } : {})
  }
  const measured = measureHerdrInstallation(local)
  const scope = herdrDeadline(terminal.io.signal, 10_000)
  let raw: Buffer
  let source: HerdrProviderRefConfig['expected_source']
  try {
    const label = await version(local, scope.signal)
    raw = await runHerdrCommand(local, 'schema', scope.signal)
    const compiled = await compileHerdrSchemas(raw, scope.signal)
    if (verifyHerdrInstallation(local, measured.sha256) !== measured.stamp || compiled.schema_sha256 !== hash(raw)) {
      throw new CliError('configuration_required')
    }
    source = observedHerdrSource(label, measured.sha256, compiled.schema_sha256, compiled.protocol)
  } finally {
    scope.close()
  }
  const shared: HerdrSetupRemote['config'] = {
    version: 1,
    target,
    binding_revision: 1,
    config_ref: reference,
    expected_source: source,
    peer_policy_revision: authorization.policies.local.revision
  }
  const control = join(root, 'control')
  const schemaPath = join(control, 'schema.json')
  const limits = { entries: 1024, bytes: 4_194_304 }
  const claimsRef = {
    path: join(control, 'claims.db'),
    mode: 'open' as const,
    ledger_id: hash(boundedJson([reference, target, source, 'claims'])),
    limits
  }
  const receiptsRef = {
    path: join(control, 'admissions.json'),
    mode: 'open' as const,
    ledger_id: hash(boundedJson([reference, target, source, 'receipts'])),
    limits
  }
  const provider = parseHerdrProviderRefConfig({
    ...shared,
    schema_path: schemaPath,
    connector: {
      local,
      principal_id: authorization.principal_id,
      claims: claimsRef,
      receipts: receiptsRef
    }
  })
  terminal.assertOwner()
  writeSetupJson(path, {
    schema_version: 1,
    attempt_id: attempt,
    machine_id: credential.machine_id,
    phase: 'initializing'
  })
  writeSetupFile(schemaPath, raw)
  const claims = new LuvusDispatchClaims({ ...claimsRef, mode: 'create', now: Date.now })
  try {
    const receipts = new ConnectorAdmissionReceipts({
      ...receiptsRef,
      mode: 'create',
      now: Date.now,
      routes: [{ target, principal_id: authorization.principal_id }]
    })
    receipts.close()
  } finally {
    claims.close()
  }
  const result: PreparedSetupHerdr = {
    schema_version: 1,
    attempt_id: attempt,
    machine_id: credential.machine_id,
    phase: 'prepared',
    settings: config.native ?? {},
    reference,
    local: {
      kind: 'herdr',
      config: provider as HerdrProductionOwnerConfig['config'],
      native: { mode: 'managed' },
      policies: authorization.policies
    },
    remote: { kind: 'herdr', config: shared, schema_bundle: raw.toString('utf8') }
  }
  writeSetupJson(path, result, true, 1_048_576)
  return result
}
