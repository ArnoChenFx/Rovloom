// 已配对 Connector 的重新配对：用 Gateway 为同一设备签发的一次性码换取新凭据并覆盖本机旧凭据；不重做原生发现与批准。
import { createFileCredentialSink, loadCredential } from '../transport/credentials.js'
import type { DeviceCredential } from '../transport/identity.js'
import { fields, id, uint } from '../wire/index.js'
import { CliError, type ConnectorConfig } from './config.js'
import { readRuntimeConfig } from './runtime-config.js'
import { runtimeReference } from './runtime-files.js'
import { post } from './setup-connector.js'
import type { SetupTerminal } from './setup-terminal.js'

export async function repairConnector(config: ConnectorConfig, terminal: SetupTerminal): Promise<void> {
  const credentialPath = runtimeReference(config.state_dir, 'device')
  // 只有已完成首次配对（有设备凭据和原生来源）的 Connector 才能重新配对。
  if (!config.gateway_url || readRuntimeConfig(config).providers.length === 0) {
    throw new CliError('configuration_required')
  }
  const old = loadCredential(credentialPath)
  terminal.show(
    'This Connector is paired as ' +
      old.machine_id +
      '. Re-pairing replaces only its Gateway credential; native setup is kept. Stop any other running Connector for this device first. / 此 Connector 已配对为 ' +
      old.machine_id +
      '。重新配对只更换与 Gateway 的凭据，保留原生设置；请先停止该设备上其它正在运行的 Connector。\n'
  )
  const value = await terminal.ask(
    'One-time re-pairing code from rovloom gateway --repair-device / 来自 rovloom gateway --repair-device 的一次性码: ',
    true
  )
  const parts = value.split('.')
  if (parts.length !== 3) {
    throw new CliError('configuration_required')
  }
  const [machine, attempt, enrollment] = parts
  id(machine)
  id(attempt)
  // 码必须属于本机已配对的同一设备，否则这是另一台设备的码，不能覆盖本机身份。
  if (machine !== old.machine_id || !enrollment || !/^[A-Za-z0-9_-]{32,256}$/.test(enrollment)) {
    throw new CliError('configuration_required')
  }
  if (
    !(await terminal.confirm(
      'Trust this Gateway address and replace this device credential with a new one? / 信任此 Gateway 地址并用新凭据替换本机设备凭据？'
    ))
  ) {
    throw new CliError('configuration_required')
  }
  const delivery = await post(
    config,
    '/pairing/redeem',
    { attempt_id: attempt, machine_id: machine, enrollment },
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
    delivery.attempt_id !== attempt ||
    delivery.machine_id !== machine ||
    delivery.state !== 'persist_and_acknowledge' ||
    typeof delivery.credential !== 'string' ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(delivery.credential) ||
    !Number.isSafeInteger(delivery.expires_at) ||
    Number(delivery.expires_at) <= Date.now()
  ) {
    throw new CliError('configuration_required')
  }
  const credential: DeviceCredential = {
    machine_id: machine,
    recovery_generation: delivery.recovery_generation,
    credential: delivery.credential
  }
  const sink = createFileCredentialSink(credentialPath, credential, true)
  try {
    // 新凭据持久落盘（原子替换）后才确认；此时 Gateway 已使旧凭据失效，所以旧文件不再有保留价值。
    const ack = await sink.deliver(credential, terminal.io.signal, {
      delivery_id: delivery.delivery_id,
      revision: delivery.revision
    })
    try {
      const receipt = await post(
        config,
        '/pairing/ack',
        { attempt_id: attempt, authentication: credential, acknowledgement: ack },
        terminal.io.signal
      )
      fields(receipt, ['machine_id', 'delivery_id', 'state', 'attempt_id'])
      if (
        receipt.machine_id !== machine ||
        receipt.delivery_id !== delivery.delivery_id ||
        receipt.state !== 'delivered' ||
        receipt.attempt_id !== attempt
      ) {
        throw new CliError('configuration_required')
      }
    } catch {
      // 确认响应不确定时不重新兑换；若 Connector 之后无法认证，重新运行 --repair-device / --repair。
      terminal.assertOwner()
      terminal.show(
        'Gateway confirmation unavailable; if this Connector cannot authenticate, run the re-pairing again. / 未收到 Gateway 的确认；若 Connector 之后无法认证，请重新执行重新配对。\n'
      )
    }
  } finally {
    sink.close()
  }
  terminal.show('device_repaired / 设备凭据已更换；正在启动 Connector。\n')
}
