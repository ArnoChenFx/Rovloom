// 独立测试进程只持有 Connector receipt 文件与受保护 fixture 配置，不导入 Gateway Store 或生产原生实例。
import { createInterface } from 'node:readline'
import { createConnector, ConnectorAdmissionReceipts } from '../../src/transport/index.js'
import type { DeviceCredential, ConnectorWireSession } from '../../src/transport/index.js'
import type { ProviderBinding, V2Target, AttemptBinding } from '../../src/wire/types.js'
import { createLuvusWireAdapter } from '../../src/integration/luvus-wire.js'
import {
  ConnectorAttemptBook,
  connectorAdmissionAdapter,
  createConnectorAdmissionBackend
} from '../../src/runtime/connector-attempts.js'
import { contractRef } from '../../src/wire/index.js'
import { auth, compiled, G, json, request, view } from '../native-contract/helpers.js'
import { source } from '../wire/helpers.js'

type Config = {
  url: string
  credential: DeviceCredential
  target: V2Target
  provider: ProviderBinding
  path: string
  clock: number
  contextual?: boolean
}
let configuration: Config | undefined
let client: ReturnType<typeof createConnector> | undefined
let receipts: ConnectorAdmissionReceipts | undefined
let readyTimer: ReturnType<typeof setInterval> | undefined
let executions = 0

/** 子进程只报告固定事件和合成计数，不输出凭据、请求、配置或原生正文。 */
function report(type: string, extra: Record<string, unknown> = {}): void {
  process.stdout.write(JSON.stringify({ type, ...extra }) + '\n')
}

/** 明确关闭所属 Connector/receipt writer；测试管道不是产品入口或新设备协议。 */
function stop(): void {
  if (readyTimer) {
    clearInterval(readyTimer)
  }
  client?.stop()
  receipts?.close()
}

try {
  const lines = createInterface({ input: process.stdin })
  for await (const line of lines) {
    const command = JSON.parse(line)
    if (command.type === 'close') {
      stop()
      report('closed', { executions })
      break
    }
    if (command.type === 'snapshot' && receipts) {
      report('snapshot', { snapshot: receipts.snapshot(command.binding) })
      continue
    }
    if (command.type === 'clock' && configuration) {
      configuration.clock = command.clock
      report('clock')
      continue
    }
    if (command.type !== 'start' || client) {
      throw new Error('unexpected_fixture_command')
    }
    const config = command.config as Config
    configuration = config
    const origin = { ...source, runtime_generation: G, classification_revision: 'review1' }
    const reference = contractRef(origin)
    const capabilities = json('session-capabilities.json')
    capabilities.result.session = 'synthetic'
    capabilities.result.server_generation = G
    const contract = {
      wire: { source: origin, support_status: 'validated' as const },
      compiled,
      capabilities,
      capability_revision: 'caps1'
    }
    const baseline = auth(request(view(), { id: 'unused', method: 'task.add', params: { title: 'synthetic' } }))
    const policy = {
      grants: [
        {
          target: config.target,
          methods: ['task.add'],
          actions: ['dispatch', 'read', 'cancel'] as ('dispatch' | 'read' | 'cancel')[]
        }
      ]
    }
    receipts = new ConnectorAdmissionReceipts({
      path: config.path,
      mode: 'create',
      ledger_id: 'isolated_child_receipts',
      limits: { entries: 128, bytes: 1_048_576 },
      ...(config.contextual ? { routes: [{ target: config.target, principal_id: 'synthetic' }] } : {}),
      now: /** 与隔离 Gateway 的明确测试时钟一致，不读取共享进程状态。 */ () => config.clock
    })
    const sink = receipts
    if (config.contextual) {
      sink.subscribeInvalidation(
        /** 仅报告真实持久提交后的类型，便于父进程比较回滚与成功提交。 */ (event) => report('invalidated', { event })
      )
    }
    const book = new ConnectorAttemptBook({
      now: /** 固定测试时钟不会按重连刷新 Gateway 原截止。 */ () => config.clock,
      dedupExpires: /** 只读本进程独立持久 receipt，不打开 Gateway writer。 */ (binding) => sink.dedupExpires(binding)
    })
    client = createConnector({
      url: config.url,
      developmentLoopback: true,
      credential: /** stdin 只交付隔离配对凭据。 */ () => config.credential,
      offer: {
        major: 2,
        minor: 0,
        capabilities: ['rpc', 'admission_receipt', ...(config.contextual ? ['admission_context'] : [])],
        required: ['rpc', 'admission_receipt', ...(config.contextual ? ['admission_context'] : [])]
      },
      now: /** 使用显式测试时钟验证固定期限。 */ () => config.clock,
      limits: { heartbeat_ms: 100, idle_ms: 5000, handshake_ms: 1000, reconnect_ms: 1000 },
      /** 实际 welcome 才创建独立本机准入；请求候选及 Store 不从父进程传入。 */
      session(connection): ConnectorWireSession {
        const backend: ReturnType<typeof createConnectorAdmissionBackend> = createConnectorAdmissionBackend({
          connection,
          routes: [{ target: config.target, principal_id: 'synthetic' }],
          book,
          receipts: sink,
          source: {
            provider: /** 双端配置来自启动前固定的合成 fixture 副本。 */ () => config.provider,
            localProvider: /** 独立本机配置不由请求广告生成。 */ () => config.provider,
            contract: /** 仅接纳本进程离线 fixture 的固定契约引用。 */ (ref) =>
              ref === reference ? contract : undefined,
            policies: /** 固定路由 principal 对应两端精确目标策略。 */ () => ({
              caller: { ...policy, revision: 'caller1' },
              local: { ...policy, revision: 'local1' }
            }),
            nativeSource: /** 合成来源仅用于 Wire fixture，绝不当成生产 endpoint 认证。 */ (call, attempt) => {
              const admitted = backend.attempt(call, attempt)
              if (!admitted) {
                return undefined
              }
              const binding = admitted.binding
              return {
                authenticated: true,
                source_verified: true,
                binding: {
                  kind: 'luvus',
                  provider_id: config.target.provider_id,
                  binding_revision: config.provider.binding_revision,
                  contract_source_ref: reference,
                  target: { machine_id: config.target.machine_id, profile: 'session', session: 'synthetic' },
                  server_generation: G,
                  connection_epoch: connection.connection_epoch,
                  recovery_generation: connection.recovery_generation,
                  capability_revision: 'caps1',
                  caller_policy_revision: binding.registration.caller_policy_revision,
                  local_policy_revision: binding.registration.local_policy_revision,
                  classification_revision: 'review1',
                  contract: compiled.identity
                }
              }
            },
            authority: /** 复用明确 synthetic 原生授权，只验证 receipt 与原 Wire 的组合门禁。 */ () => baseline,
            now: /** 子进程无 Gateway 账本读取端口。 */ () => config.clock
          }
        })
        const adapter = connectorAdmissionAdapter(backend, createLuvusWireAdapter(backend))
        return {
          adapter,
          admissions: sink,
          readiness: /** 就绪仅来自本测试固定的双端 provider 副本。 */ () => ({
            policy_revision: 'local1',
            peer_policy_revision: 'local1',
            providers: [{ expected: config.provider, local: config.provider, native_ready: true }]
          }),
          /** hook 不运行真实 native；计数只能发生在已认证持久 receipt 和原 Wire 两道门禁之后。 */
          async executeWire(raw) {
            const frame = adapter.decode(raw, 'gateway_to_connector')
            if (frame.type !== 'request' || !('connection_epoch' in frame)) {
              throw new Error('unexpected_fixture_frame')
            }
            const binding: AttemptBinding = {
              machine_id: frame.machine_id,
              connection_epoch: frame.connection_epoch,
              recovery_generation: frame.recovery_generation,
              ...frame.payload.attempt
            }
            executions++
            report('executed', { expires: sink.dedupExpires(binding) })
            return {
              binding,
              native_response: {
                id: binding.native_request_id,
                error: { code: 'synthetic', message: 'isolated receipt execution' }
              }
            }
          },
          close: /** 断连只释放本 epoch 原文，receipt 文件继续保留。 */ () => backend.close()
        }
      }
    })
    readyTimer = setInterval(
      /** 只在真正 welcome/策略就绪后通知父进程。 */ () => {
        if (client!.status().phase === 'ready') {
          clearInterval(readyTimer)
          report('ready')
        }
      },
      5
    )
  }
} catch {
  stop()
  report('fixture_failed')
  process.exitCode = 1
} finally {
  stop()
}
