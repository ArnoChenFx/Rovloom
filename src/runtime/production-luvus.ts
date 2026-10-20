/** 装配唯一 CLI 已解析的本机 Owner 或远端 pin，不复制入口协议或打开第二个 Gateway writer。 */
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { LuvusDispatchClaims, LuvusAdapterError } from '../connector/luvus/index.js'
import type { NativeWireBackend } from '../integration/luvus-wire.js'
import { ConnectorAdmissionReceipts } from '../transport/index.js'
import type { Connection } from '../transport/index.js'
import type { ProviderPolicies } from '../wire/types.js'
import { boundedJson, contractRef, fields, hash, id, object, uint, validatePolicies } from '../wire/index.js'
import {
  ConnectorAttemptBook,
  createConnectorAdmissionLedger,
  bindConnectorAdmissionLedger
} from './connector-attempts.js'
import { attachExistingLuvus } from './native-attach.js'
import type { AttachedLuvusInstance } from './native-attach.js'
import { createLuvusOperationsProvider } from './luvus-operations-provider.js'
import type { ManagementSessionAuthority } from './management-session.js'
import { assertManagedControlDirectory, openManagedLuvusRoot } from './native-root.js'
import type { ManagedLuvusRoot } from './native-root.js'
import { OwnedProcessShutdownError } from './native-process.js'
import { startManagedLuvus } from './native-source.js'
import type { ControlledLuvusProcess } from './native-source.js'
import type { ConnectorRuntimeOptions, RemoteLuvusRuntimeProvider, RuntimeProvider } from './types.js'
import { checkedRemoteLuvusConfig, createPinnedRemoteLuvus } from './remote-luvus.js'
import type { LuvusProductionRemoteConfig } from './remote-luvus.js'
import { pinTerminalExecution } from '../connector/terminal-execution.js'

export type LuvusProductionReference = Readonly<{ reference: string; value: unknown }>
export type LuvusProductionOwnerConfig = Readonly<{
  kind: 'luvus'
  authentication: 'local_owner'
  native: Readonly<{
    mode: 'managed' | 'attach'
    root_record: string
    expected_root_id: string
    expected_root_revision: number
  }>
  peer_policy_revision: string
  principal_id: string
  policies: ProviderPolicies
  // 首次 create 与正常 open 必须显式选择；丢失任一持久库不能自动重建。
  storage_mode: 'create' | 'open'
}>
type CheckedReference = Readonly<{ reference: string; value: LuvusProductionOwnerConfig }>
type GatewayReference = CheckedReference | Readonly<{ reference: string; value: LuvusProductionRemoteConfig }>
type CliState = Readonly<{ state_dir: string; allow_terminal_execution?: boolean }>

/** 有界复制已解析引用，只校验 provider 自己的配置，不重新读取或解析 CLI 配置文件。 */
function references(input: readonly LuvusProductionReference[], mode: 'managed' | 'attach'): CheckedReference[] {
  try {
    const copied: LuvusProductionReference[] = JSON.parse(boundedJson(input, 1_048_576))
    if (!Array.isArray(copied) || copied.length > 64 || (mode === 'managed' && copied.length !== 1)) {
      throw new LuvusAdapterError('production_reference_count_invalid')
    }
    const names = new Set<string>()
    return copied.map(
      /** 所有引用先完成形状与角色校验，再打开任何原生或持久资源。 */ (entry) => {
        fields(object(entry), ['reference', 'value'])
        id(entry.reference)
        if (names.has(entry.reference)) {
          throw new LuvusAdapterError('production_reference_duplicate')
        }
        names.add(entry.reference)
        const value = object(entry.value)
        fields(value, [
          'kind',
          'authentication',
          'native',
          'peer_policy_revision',
          'principal_id',
          'policies',
          'storage_mode'
        ])
        const native = object(value.native)
        fields(native, ['mode', 'root_record', 'expected_root_id', 'expected_root_revision'])
        id(native.expected_root_id)
        uint(native.expected_root_revision, true)
        id(value.principal_id)
        id(value.peer_policy_revision)
        validatePolicies(value.policies as ProviderPolicies)
        if (
          value.kind !== 'luvus' ||
          value.authentication !== 'local_owner' ||
          native.mode !== mode ||
          typeof native.root_record !== 'string' ||
          !['create', 'open'].includes(value.storage_mode as string)
        ) {
          throw new LuvusAdapterError('production_reference_invalid')
        }
        return { reference: entry.reference, value: value as LuvusProductionOwnerConfig }
      }
    )
  } catch (error) {
    throw error instanceof LuvusAdapterError ? error : new LuvusAdapterError('production_reference_invalid')
  }
}

/** Gateway 的远端 pin 与既有本机 attach 显式区分；先校验全部已解析引用，不读取第二份产品配置。 */
function gatewayReferences(input: readonly LuvusProductionReference[]): GatewayReference[] {
  try {
    const copied: LuvusProductionReference[] = JSON.parse(boundedJson(input, 1_048_576))
    if (!Array.isArray(copied) || copied.length > 64) {
      throw new LuvusAdapterError('production_reference_count_invalid')
    }
    const names = new Set<string>()
    return copied.map(
      /** 每个配置名只绑定一个明确实例，不允许远端 pin 与本机 root 互为别名。 */ (entry) => {
        fields(object(entry), ['reference', 'value'])
        id(entry.reference)
        if (names.has(entry.reference)) {
          throw new LuvusAdapterError('production_reference_duplicate')
        }
        names.add(entry.reference)
        return object(entry.value).authentication === 'remote_connector'
          ? { reference: entry.reference, value: checkedRemoteLuvusConfig(entry.reference, entry.value) }
          : references([entry], 'attach')[0]!
      }
    )
  } catch (error) {
    throw error instanceof LuvusAdapterError ? error : new LuvusAdapterError('production_reference_invalid')
  }
}

/** 原生配置只来自受保护 root record；引用不得别名到另一个 binding.config_ref。 */
function openRoot(entry: CheckedReference): ManagedLuvusRoot {
  const native = entry.value.native
  const root = openManagedLuvusRoot({
    record_path: native.root_record,
    expected_root_id: native.expected_root_id,
    expected_root_revision: native.expected_root_revision
  })
  if (root.config.config_ref !== entry.reference) {
    root.close()
    throw new LuvusAdapterError('production_config_ref_mismatch')
  }
  return root
}

/** 原始启动失败与未完成清理同时可观察，并保留原 release 闭包对未确认资源的所有权引用。 */
export class LuvusProductionStartupError extends LuvusAdapterError {
  /** 原错误不拼入公开消息；shutdown 保持同一幂等释放结果，不自动并行重试。 */
  constructor(
    readonly startupError: unknown,
    readonly shutdown: Readonly<{ release(): Promise<void> }>,
    readonly cleanupError: unknown
  ) {
    super('production_startup_cleanup_failed')
  }
}

/** 清理每个资源，即使其中一项失败也不跳过其它资源；同一 release 永远共享同一结果。 */
function releaseOnce(cleanup: () => Promise<void>, stop?: () => void): () => Promise<void> {
  let closing: Promise<void> | undefined
  return /** 显式角色关闭只执行一次；保留失败和资源引用，不把未确认退出改判成功。 */ () => {
    if (!closing) {
      stop?.()
      closing = Promise.resolve().then(cleanup)
      void closing.catch(/** 同时支持显式等待与启动失败收尾，消费未订阅的关闭拒绝。 */ () => {})
    }
    return closing
  }
}

/** 启动失败也必须等待完整清理；物理释放失败时保留可观测的同一 shutdown 所有者。 */
async function startupFailure(error: unknown, release: () => Promise<void>): Promise<never> {
  try {
    await release()
  } catch (cleanupError) {
    throw new LuvusProductionStartupError(error, Object.freeze({ release }), cleanupError)
  }
  throw error
}

/** 静态创建唯一 CLI 的生产来源；Gateway 可仅持远端 pin，Connector 才核验并持有实际 managed child。 */
export function createLuvusProductionSources() {
  return Object.freeze({
    /** 第三参数保持唯一 CLI 的管理 authority 接缝；普通 Owner 操作不消费批准或发行 token。 */
    async gateway(
      _config: CliState,
      input: readonly LuvusProductionReference[],
      _authority?: ManagementSessionAuthority
    ): Promise<
      Readonly<{
        providers: readonly (RuntimeProvider | RemoteLuvusRuntimeProvider)[]
        admission_context: true
        release(): Promise<void>
      }>
    > {
      const entries = gatewayReferences(input)
      const roots = new Map<GatewayReference, ManagedLuvusRoot>()
      const attached: AttachedLuvusInstance[] = []
      const remote: Awaited<ReturnType<typeof createPinnedRemoteLuvus>>[] = []
      const release = releaseOnce(
        /** 关闭观察者与 root 句柄；绝不停止 Connector 拥有的既有 native。 */ async () => {
          const errors: unknown[] = []
          for (const instance of remote) {
            instance.close()
          }
          for (const instance of attached) {
            try {
              instance.close()
            } catch (error) {
              errors.push(error)
            }
          }
          for (const root of roots.values()) {
            root.close()
          }
          if (errors.length) {
            throw new AggregateError(errors, 'production_release_failed')
          }
        }
      )
      try {
        // 全部 root 引用先核实，避免在后续错误引用前部分启动或接管实例。
        for (const entry of entries) {
          if (entry.value.authentication === 'local_owner') {
            roots.set(entry, openRoot({ reference: entry.reference, value: entry.value }))
          }
        }
        const targets = new Set<string>()
        const machineModes = new Map<string, string>()
        for (const entry of entries) {
          const configuredTarget =
            entry.value.authentication === 'remote_connector' ? entry.value.target : roots.get(entry)!.config.target
          const mode = entry.value.authentication
          const previousMode = machineModes.get(configuredTarget.machine_id)
          if (previousMode && previousMode !== mode) {
            throw new LuvusAdapterError('production_machine_source_conflict')
          }
          machineModes.set(configuredTarget.machine_id, mode)
          const target = boundedJson(configuredTarget)
          if (targets.has(target)) {
            throw new LuvusAdapterError('production_target_duplicate')
          }
          targets.add(target)
        }
        const providers: (RuntimeProvider | RemoteLuvusRuntimeProvider)[] = []
        for (const entry of entries) {
          if (entry.value.authentication === 'remote_connector') {
            const instance = await createPinnedRemoteLuvus(entry.value)
            remote.push(instance)
            providers.push(instance.provider)
          } else {
            const instance = await attachExistingLuvus(roots.get(entry)!.config)
            attached.push(instance)
            providers.push(createLuvusOperationsProvider(instance, entry.value.peer_policy_revision))
          }
        }
        return Object.freeze({ providers: Object.freeze(providers), admission_context: true as const, release })
      } catch (error) {
        return startupFailure(error, release)
      }
    },
    /** 单个 Connector 固定一个实际 IPC adapter；每个新认证 epoch 都重建后端，跨 epoch 只共享持久事实。 */
    async connector(
      config: CliState,
      input: readonly LuvusProductionReference[]
    ): Promise<Omit<ConnectorRuntimeOptions, 'transport'> & { readonly admission_context: true }> {
      // CLI单文件开关独立于已登记安装settings；省略时保留底层工厂的原配置契约。
      const terminalExecution =
        config.allow_terminal_execution === undefined
          ? undefined
          : /** 每次最终检查读取本次装配的显式本机值，不接收RPC参数。 */ () =>
              pinTerminalExecution(config.allow_terminal_execution)
      terminalExecution?.()
      const [entry] = references(input, 'managed')
      const selected = entry!
      const root = openRoot(selected)
      let processOwner: ControlledLuvusProcess | undefined
      let claims: LuvusDispatchClaims | undefined
      let admissions: ConnectorAdmissionReceipts | undefined
      let unconfirmedStartup: OwnedProcessShutdownError | undefined
      const sessions = new Set<ReturnType<typeof createConnectorAdmissionLedger>>()
      let stopping = false
      const release = releaseOnce(
        /** 所有 epoch 停止后释放持久句柄，真实 child 退出确认前保留 root 归属。 */ async () => {
          const errors: unknown[] = []
          for (const resource of [...sessions, admissions, claims]) {
            try {
              resource?.close()
            } catch (error) {
              errors.push(error)
            }
          }
          sessions.clear()
          let exited = processOwner === undefined && unconfirmedStartup === undefined
          try {
            if (processOwner) {
              await processOwner.close()
              exited = true
            }
          } catch (error) {
            errors.push(error)
          }
          if (exited) {
            root.close()
          }
          if (unconfirmedStartup) {
            errors.push(unconfirmedStartup)
          }
          if (errors.length) {
            throw new AggregateError(errors, 'production_release_failed')
          }
        },
        /** 关闭 fence 同步生效，不能在异步清理的首个 microtask 前再创建新 epoch。 */ () => {
          stopping = true
        }
      )
      try {
        const fixed = root.config
        assertManagedControlDirectory(fixed, config.state_dir)
        const routes = [{ target: fixed.target, principal_id: selected.value.principal_id }]
        const ledgerId = hash(boundedJson([selected.reference, root.root_id, root.root_revision, fixed.target]))
        // 正常启动只 open；任何缺库、崩溃锁或容量问题先拒绝，不能为了继续启动而清墓碑。
        claims = new LuvusDispatchClaims({
          path: join(config.state_dir, 'luvus-claims.db'),
          mode: selected.value.storage_mode,
          ledger_id: ledgerId,
          limits: { entries: 1024, bytes: 4_194_304 },
          now: Date.now
        })
        admissions = new ConnectorAdmissionReceipts({
          path: join(config.state_dir, 'luvus-admissions.json'),
          mode: selected.value.storage_mode,
          ledger_id: ledgerId,
          limits: { entries: 1024, bytes: 4_194_304 },
          now: Date.now,
          routes
        })
        const receipts = admissions
        const dispatchClaims = claims
        const book = new ConnectorAttemptBook({
          dedupExpires: /** 去重截止只取认证原 Store 快照，不用本机 now+TTL 续期。 */ (binding) =>
            receipts.dedupExpires(binding),
          now: Date.now
        })
        processOwner = await startManagedLuvus(root)
        const owner = processOwner.localOwner()
        const provider = createLuvusOperationsProvider(owner, selected.value.peer_policy_revision)
        const reference = contractRef(provider.contract.wire.source)
        const snapshot = Object.freeze([
          Object.freeze({
            binding: provider.binding,
            target: provider.target,
            source: provider.contract.wire.source,
            capabilities: object(provider.contract.capabilities),
            capability_revision: provider.contract.capability_revision
          })
        ])
        /** 双方策略只来自已解析受保护配置，按完整路由的固定 principal 返回独立快照。 */
        function policies(principal: string): ProviderPolicies {
          if (stopping || principal !== selected.value.principal_id) {
            throw new LuvusAdapterError('production_principal_unavailable')
          }
          return structuredClone(selected.value.policies)
        }
        return Object.freeze({
          admission_context: true as const,
          provider_snapshot: true as const,
          /** welcome 实际认证连接必须协商完整 receipt；缺能力在原 ledger 内拒绝，不降级为相对保留期。 */
          session(connection: Connection): ReturnType<ConnectorRuntimeOptions['session']> {
            if (stopping) {
              throw new LuvusAdapterError('production_source_closed')
            }
            const ledger = createConnectorAdmissionLedger({
              connection,
              routes,
              policies,
              receipts,
              book,
              now: Date.now
            })
            try {
              const backend: NativeWireBackend = {
                ...ledger,
                provider: /** 仅此真实本机配置的完整 Target 能解析同一 canonical binding。 */ (target) =>
                  isDeepStrictEqual(target, fixed.target) ? provider.binding : undefined,
                localProvider: /** 本机绑定独立来自 root 配置，不能采信请求中的 provider 广告。 */ (target) =>
                  isDeepStrictEqual(target, fixed.target) ? provider.binding : undefined,
                contract: /** 每个 epoch 只使用本次真实 native 契约，不按方法名称猜来源。 */ (ref) =>
                  ref === reference ? provider.contract : undefined,
                nativeSource: /** 只有原 ledger 已核实的候选或锚点才能取得同源 native context。 */ (call, attempt) => {
                  const row = ledger.attempt(call, attempt)
                  return row ? provider.source(row.binding) : undefined
                },
                policies,
                authority: provider.authority
              }
              bindConnectorAdmissionLedger(backend, ledger)
              sessions.add(ledger)
              return {
                authentication: 'local_owner' as const,
                config: fixed,
                ...(terminalExecution ? { terminalExecution } : {}),
                terminalExecutionState: /** 只报告原本机guard的有效值，不构造原生能力或许可。 */ () => [
                  {
                    binding: provider.binding,
                    enabled: terminalExecution ? terminalExecution() : fixed.allow_terminal_execution === true
                  }
                ],
                backend,
                admissions: receipts,
                claims: dispatchClaims,
                providerSnapshot:
                  /** 每个 epoch 交付同一份真实实测快照；实际实例失效须关闭 WSS，不更新原 generation。 */ () => {
                    if (stopping || !provider.ready()) {
                      throw new LuvusAdapterError('production_source_closed')
                    }
                    return snapshot
                  },
                nativeAuth: /** 显式本机 Owner 仍须核验真实同 socket 证据，缺 token 不触发任何回退。 */ (
                  binding,
                  evidence
                ) => owner.nativeAuth(binding, evidence),
                verifyPeer: /** 每条实际 IPC 连接重新测量内核 peer，保持同一 root/generation。 */ (
                  socket,
                  endpoint,
                  binding
                ) => owner.verifyPeer(socket, endpoint, binding),
                assertEvidence: /** 最后写出和 claim 都重验原 socket 与完整绑定。 */ (binding, evidence) =>
                  owner.assertEvidence(binding, evidence),
                dedupExpires: ledger.dedupExpires,
                readiness: /** 就绪复核原真实 Owner，政策修订取固定双方配置，不能自报永久 true。 */ () => ({
                  policy_revision: selected.value.policies.local.revision,
                  peer_policy_revision: selected.value.peer_policy_revision,
                  providers: [{ expected: provider.binding, local: provider.binding, native_ready: provider.ready() }]
                }),
                close: /** 关闭只释放本 epoch 请求正文；原 receipt、claims 和 native 工作均不重放。 */ () => {
                  ledger.close()
                  sessions.delete(ledger)
                }
              }
            } catch (error) {
              ledger.close()
              throw error
            }
          },
          release
        })
      } catch (error) {
        if (error instanceof OwnedProcessShutdownError && !error.exit_confirmed) {
          unconfirmedStartup = error
        }
        return startupFailure(error, release)
      }
    }
  })
}
