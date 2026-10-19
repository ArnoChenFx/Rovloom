// 装配唯一账本、路由、认证设备通道及原请求结果门禁；不实现 HTTP/MCP 协议或管理写服务。
import { Router } from '../router.js'
import { GatewayError } from '../contracts.js'
import { createGateway, createDeviceLifecycleAdapter } from '../transport/index.js'
import { createProviderResultAccess } from './results.js'
import { closeSession, ready, OFFER } from '../transport/common.js'
import type { Session, Readiness, Adapter } from '../transport/common.js'
import { DEFAULT_LIMITS } from '../native-contract/index.js'
import type { TrustedAttempt } from '../integration/luvus-wire.js'
import type { Call } from '../store.js'
import type { ProviderBinding, ProviderSnapshot, V2Target } from '../wire/types.js'
import { boundedJson, contractRef, fail, LIMITS, uint, validateProvider, validateTarget } from '../wire/index.js'
import { createTrustedRequestScope } from './request-scope.js'
import type {
  GatewayRuntimeOptions,
  ProviderGatewayRuntimeOptions,
  RuntimeCallInput,
  RuntimeCatalogProvider,
  RemoteLuvusRuntimeProvider,
  RuntimeProvider,
  RuntimeProviderBinding
} from './types.js'

/** 在受信宿主显式交付已打开资源后启动常驻 listener；客户端寿命与角色寿命无关。 */
export async function createGatewayRuntime(options: GatewayRuntimeOptions) {
  return assembleGateway(options)
}

/** 由 provider 交付已审 Wire 会话，共用唯一身份、账本、路由和结果读取服务。 */
export async function createProviderGatewayRuntime(options: ProviderGatewayRuntimeOptions) {
  return assembleGateway(options)
}

/** 两种装配入口共用同一常驻生命周期；通用入口不解释 provider 原生协议。 */
async function assembleGateway(options: GatewayRuntimeOptions | ProviderGatewayRuntimeOptions) {
  const hostOptions = 'session' in options ? options : undefined
  const store = options.lifecycle.store
  const scope = createTrustedRequestScope(options.identities)
  const router = new Router(store, localPolicies)
  const providers = new Map<string, RuntimeProviderBinding>()
  const nativeProviders = new Map<string, RuntimeProvider>()
  const remoteProviders = new Map<string, RemoteLuvusRuntimeProvider>()
  const machineModes = new Map<string, 'local' | 'remote'>()
  const contracts = new Map<string, RuntimeProvider['contract']>()
  let closing: Promise<void> | undefined
  let transport: ReturnType<typeof createGateway> | undefined
  let finish!: () => void
  let rejectClosed!: (error: unknown) => void
  const closed = new Promise<void>(
    /** 只有显式角色关闭完成才终止常驻生命周期。 */
    (resolve, reject) => {
      finish = resolve
      rejectClosed = reject
    }
  )
  void closed.catch(/** 关闭失败始终被观察，调用者仍从同一 Promise 取得失败结果。 */ () => {})
  /** 在外部政策回调前后都核对关闭 fence，并复制其返回值，不能放行回调中的同步关闭。 */
  function localPolicies(target: V2Target) {
    if (closing) {
      throw new GatewayError('runtime_closed')
    }
    const policy = JSON.parse(boundedJson(options.localPolicies(structuredClone(target)))) as ReturnType<
      typeof options.localPolicies
    >
    if (closing) {
      throw new GatewayError('runtime_closed')
    }
    return policy
  }
  /** 使用完整机器/provider 键，不按名称或最近上线实例选目标。 */
  function key(target: Pick<V2Target, 'machine_id' | 'provider_id'>): string {
    return target.machine_id + '/' + target.provider_id
  }
  /** 复核当前 canonical binding，不把启动配置变成隐式注册、重绑或授权。 */
  function localProvider(target: V2Target): ProviderBinding | undefined {
    if (closing) {
      throw new GatewayError('runtime_closed')
    }
    const entry = providers.get(key(target))
    if (!entry || boundedJson(target) !== boundedJson(entry.target)) {
      return undefined
    }
    const configured = entry.binding
    const current = store.provider(target.machine_id, target.provider_id)
    return configured && current && boundedJson(configured) === boundedJson(current)
      ? structuredClone(configured)
      : undefined
  }
  /** 所有公开操作均从当前请求取身份，关闭开始即拒绝新操作。 */
  function principal() {
    if (closing) {
      throw new GatewayError('runtime_closed')
    }
    const current = scope.principal()
    if (closing) {
      throw new GatewayError('runtime_closed')
    }
    return current
  }
  /** 按持久原请求选择独立 native 来源，不能从响应或 caller JSON 建立来源。 */
  function source(callId: string, attemptId: string) {
    const attempt = store.attempt(callId, attemptId)
    const current = attempt ? nativeProviders.get(key(attempt.binding.target))?.source(attempt.binding) : undefined
    if (closing) {
      throw new GatewayError('runtime_closed')
    }
    return current
  }
  /** 分层只返回元数据；正文只能通过 results 及原 Wire 读取门禁。 */
  function metadata(call: Call): Call {
    return { ...call, response: null }
  }
  /** 共享关闭 Promise，失败也清理所有资源，不将关闭解释为原生撤销。 */
  function close(): Promise<void> {
    if (closing) {
      return closed
    }
    closing = closed
    void Promise.resolve().then(
      /** 先停止设备 listener 与 socket，再撤销请求作用域并释放宿主账本。 */
      async () => {
        let failed = false
        try {
          transport?.stop()
        } catch {
          failed = true
        } finally {
          scope.close()
          try {
            await options.release()
          } catch {
            failed = true
          }
        }
        if (failed) {
          rejectClosed(new GatewayError('gateway_runtime_close_failed'))
        } else {
          finish()
        }
      }
    )
    return closed
  }
  try {
    for (const provider of options.providers) {
      const binding = structuredClone(provider.binding)
      validateProvider(binding)
      validateTarget(provider.target)
      if (provider.target.machine_id !== binding.machine_id || provider.target.provider_id !== binding.provider_id) {
        fail('provider_binding_mismatch')
      }
      const responseBudget = hostOptions ? provider.max_response_bytes : DEFAULT_LIMITS.object_bytes
      uint(responseBudget)
      if (!responseBudget || responseBudget > LIMITS.object_bytes) {
        fail('transport_limit')
      }
      const name = key(binding)
      const remote =
        !hostOptions && 'remote_luvus' in provider && provider.remote_luvus === true
          ? (provider as RemoteLuvusRuntimeProvider)
          : undefined
      const native = hostOptions || remote ? undefined : (provider as RuntimeProvider)
      if (!hostOptions) {
        const mode = remote ? 'remote' : 'local'
        const previousMode = machineModes.get(binding.machine_id)
        if (previousMode && previousMode !== mode) {
          fail('runtime_provider_machine_mode_conflict')
        }
        machineModes.set(binding.machine_id, mode)
      }
      const ref = native ? contractRef(native.contract.wire.source) : undefined
      const previous = ref ? contracts.get(ref) : undefined
      // 同一引用不证明 live capability 相同；冲突必须拒绝，不能让另一实例的后写覆盖当前来源。
      if (
        providers.has(name) ||
        (previous &&
          boundedJson({
            wire: previous.wire,
            identity: previous.compiled.identity,
            capabilities: previous.capabilities,
            revision: previous.capability_revision
          }) !==
            boundedJson({
              wire: native!.contract.wire,
              identity: native!.contract.compiled.identity,
              capabilities: native!.contract.capabilities,
              revision: native!.contract.capability_revision
            }))
      ) {
        fail('runtime_provider_conflict')
      }
      if (
        (!hostOptions && binding.kind !== 'luvus') ||
        boundedJson(store.provider(binding.machine_id, binding.provider_id)) !== boundedJson(binding)
      ) {
        fail('provider_binding_mismatch')
      }
      providers.set(name, {
        ...provider,
        max_response_bytes: responseBudget,
        binding: Object.freeze(binding),
        target: Object.freeze(structuredClone(provider.target))
      })
      if (native && ref) {
        nativeProviders.set(name, native)
        if (!previous) {
          contracts.set(ref, native.contract)
        }
      } else if (remote) {
        remoteProviders.set(name, remote)
      }
    }
    const offer = structuredClone(options.listener.offer ?? OFFER)
    if (remoteProviders.size && !offer.capabilities.includes('provider_snapshot')) {
      offer.capabilities.push('provider_snapshot')
    }
    transport = createGateway({
      ...options.listener,
      offer,
      providerSnapshotMachines: [
        ...new Set(
          [...remoteProviders.values()].map(
            /** 仅明确配置远端来源的机器协商快照，本机 attach 会话保持自己的独立测量路径。 */
            (provider) => provider.binding.machine_id
          )
        )
      ],
      store,
      router,
      principal,
      identity: options.lifecycle.identityHost,
      channels: options.channels,
      retainOriginalRead: true,
      /** 每个实际认证 socket 建立独立 backend/Wire；身份随该 socket fence 失效。 */
      session(connection, channel) {
        let retaining: string | undefined
        const remoteEpochs = new Map<
          string,
          {
            epoch: ReturnType<RemoteLuvusRuntimeProvider['open']>
            live?: RuntimeProvider
          }
        >()
        /** 同一实际 socket 先失效，再移除该 epoch 的目录与契约；原调用不迁到新连接。 */
        function closeRemoteEpochs(): void {
          for (const [name, state] of remoteEpochs) {
            state.epoch.close()
            if (state.live && nativeProviders.get(name) === state.live) {
              nativeProviders.delete(name)
              const ref = contractRef(state.live.contract.wire.source)
              if (
                ![...nativeProviders.values()].some(
                  /** 其它固定 provider 仍使用该引用时保留自己的契约。 */
                  (provider) => contractRef(provider.contract.wire.source) === ref
                )
              ) {
                contracts.delete(ref)
              }
            }
          }
          remoteEpochs.clear()
        }
        /** 每个来源操作都回到当前 SocketChannel 与唯一 Store，不信任帧中的 authenticated 标志。 */
        function assertRemoteCurrent(provider: RemoteLuvusRuntimeProvider): void {
          if (
            closing ||
            boundedJson(channel.connection()) !== boundedJson(connection) ||
            !localProvider(provider.target)
          ) {
            fail('remote_luvus_epoch_unavailable')
          }
          store.assertConnection(connection)
          if (
            closing ||
            boundedJson(channel.connection()) !== boundedJson(connection) ||
            !localProvider(provider.target)
          ) {
            fail('remote_luvus_epoch_unavailable')
          }
        }
        /** 只接纳本 socket 所属机器的固定 pin；schema/opaque 由 Gateway 本地工厂创建，消息不能注册 provider。 */
        function acceptProviderSnapshot(snapshot: ProviderSnapshot): void {
          const name = key(snapshot.target)
          const configured = providers.get(name)
          if (
            !configured ||
            snapshot.target.machine_id !== connection.machine_id ||
            boundedJson(configured.binding) !== boundedJson(snapshot.binding) ||
            boundedJson(configured.target) !== boundedJson(snapshot.target) ||
            !localProvider(snapshot.target)
          ) {
            fail('provider_binding_mismatch')
          }
          const remote = remoteEpochs.get(name)
          if (!remote) {
            fail('remote_luvus_binding_mismatch')
          }
          const live = remote.epoch.accept(snapshot)
          const ref = contractRef(live.contract.wire.source)
          const previous = contracts.get(ref)
          if (
            previous &&
            boundedJson({
              wire: previous.wire,
              identity: previous.compiled.identity,
              capabilities: previous.capabilities,
              revision: previous.capability_revision
            }) !==
              boundedJson({
                wire: live.contract.wire,
                identity: live.contract.compiled.identity,
                capabilities: live.contract.capabilities,
                revision: live.contract.capability_revision
              })
          ) {
            fail('runtime_provider_conflict')
          }
          assertRemoteCurrent(remoteProviders.get(name)!)
          contracts.set(ref, live.contract)
          nativeProviders.set(name, live)
          remote.live = live
        }
        /** 保留证据只使用本同步栈内的原 caller；其余调用重新取得当前 HTTP 主体。 */
        function currentPrincipal() {
          if (retaining) {
            return retaining
          }
          try {
            return principal().id
          } catch {
            return undefined
          }
        }
        const services: Omit<Parameters<typeof createDeviceLifecycleAdapter>[2], 'connection'> = {
          localProvider,
          /** 仅查受保护契约注册表中的固定来源。 */
          contract: (ref) => contracts.get(ref),
          nativeSource: source,
          /** caller 及本机策略始终重新取当前来源；未认证的持久引用不能继续授权。 */
          policies(principalId) {
            const caller = options.identities.principal({ principal_id: principalId })
            if (!caller || caller.id !== principalId) {
              fail('unauthenticated')
            }
            const policies = [...providers.values()]
              .filter(
                /** 只组合此机器受保护配置中的目标，不从 caller grant 补造实例。 */
                (provider) => provider.binding.machine_id === connection.machine_id
              )
              .map(
                /** 对每个固定目标重新读取当前本机策略。 */
                (provider) => ({ policy: localPolicies(provider.target), target: provider.target })
              )
            const revision = policies[0]?.policy.revision
            if (
              !revision ||
              policies.some(/** 一个连接上的政策必须属于同一全局修订。 */ ({ policy }) => policy.revision !== revision)
            ) {
              fail('policy_revision_conflict')
            }
            return {
              caller: caller.policy,
              local: {
                revision,
                grants: policies.flatMap(
                  /** 每次查询只为该精确 tuple 提供权限，禁止其它查询里的多余 grant 覆盖当前撤权。 */ ({
                    policy,
                    target
                  }) =>
                    policy.grants.filter(
                      /** 保留当前被查询目标的完整 tuple。 */ (grant) =>
                        boundedJson(grant.target) === boundedJson(target)
                    )
                )
              }
            }
          },
          /** 分类权限从固定 provider 的独立宿主读取，普通请求不能提升 Owner/custody。 */
          authority(attempt, binding) {
            const provider = nativeProviders.get(key(attempt.binding.target))
            if (!provider) {
              fail('provider_binding_unavailable')
            }
            const authority = provider.authority(attempt, binding)
            if (closing) {
              throw new GatewayError('runtime_closed')
            }
            return authority
          },
          currentPrincipal
        }
        let owned: Session | undefined
        try {
          for (const [name, provider] of remoteProviders) {
            if (provider.binding.machine_id === connection.machine_id) {
              const epoch = provider.open(
                connection,
                /** 真实通道、canonical binding 与当前 epoch 逐次复验。 */ () => assertRemoteCurrent(provider)
              )
              remoteEpochs.set(name, { epoch })
            }
          }
          owned = hostOptions
            ? hostOptions.session(connection, channel, {
                store,
                router,
                localProvider,
                localPolicies,
                policies: services.policies,
                currentPrincipal
              })
            : {
                ...createDeviceLifecycleAdapter(
                  options.lifecycle as GatewayRuntimeOptions['lifecycle'],
                  channel,
                  services
                ),
                /** Luvus 就绪仍由固定 provider 的真实来源提供。 */
                readiness: configuredReadiness,
                /** Wire 由 transport 关闭，此处没有额外独立会话资源。 */
                close() {}
              }
          if (closing) {
            throw new GatewayError('runtime_closed')
          }
          const native: Session = owned
          const originalWire = native.adapter
          const releaseSession = native.close
          if (closing) {
            throw new GatewayError('runtime_closed')
          }
          const adapter = new Proxy({} as Adapter, {
            /** 保持 provider 方法的真实 this；仅在原证据保留栈中交付原 caller。 */
            get(_target, property) {
              if (property === 'planEvidence') {
                return planEvidence
              }
              const value = Reflect.get(originalWire, property, originalWire)
              return typeof value === 'function' ? value.bind(originalWire) : value
            }
          })
          /** 原文保留以原持久 caller 的当前权限独立评估，不借用最近 HTTP 身份。 */
          function planEvidence(frame: Parameters<typeof originalWire.planEvidence>[0]) {
            const attempt = store.attempt(frame.payload.attempt.call_id, frame.payload.attempt.attempt_id)
            const previous = retaining
            retaining = attempt?.principal_id
            try {
              const plan = originalWire.planEvidence(frame)
              const configured = attempt ? providers.get(key(attempt.binding.target)) : undefined
              const maxBytes = configured?.max_response_bytes ?? DEFAULT_LIMITS.object_bytes
              if (plan.evidence.response_bytes > maxBytes) {
                // 只收窄原 Wire 的保留意图：仍提交真实摘要，超 provider 预算不保存原文。
                return {
                  ...plan,
                  content: {
                    status: plan.content.status,
                    expires_at: plan.content.expires_at,
                    delivery: 'metadata_only' as const
                  }
                }
              }
              return plan
            } finally {
              retaining = previous
            }
          }
          /** 所有 provider 都同时核对当前配置、政策和独立原生来源。 */
          function configuredReadiness(): Readiness {
            const entries = [...providers.values()].filter(
              /** 此 socket 只能观察和承载所属机器的实例。 */
              (provider) => provider.binding.machine_id === connection.machine_id
            )
            const local = entries[0]
            const policyRevision = local ? localPolicies(local.target).revision : ''
            const peerRevision = local?.peer_policy_revision ?? ''
            return {
              policy_revision: policyRevision,
              peer_policy_revision: peerRevision,
              providers: entries.map(
                /** canonical、双端政策、来源和原生会话须同时保持就绪。 */
                (provider) => ({
                  expected:
                    store.provider(provider.binding.machine_id, provider.binding.provider_id) ?? provider.binding,
                  local: provider.binding,
                  native_ready:
                    provider.ready() === true &&
                    (!hostOptions || ready(native, connection, provider.binding.provider_id)) &&
                    !closing &&
                    !!localProvider(provider.target) &&
                    localPolicies(provider.target).revision === policyRevision &&
                    provider.peer_policy_revision === peerRevision &&
                    !closing
                })
              )
            }
          }
          return {
            adapter,
            readiness: configuredReadiness,
            ...(!hostOptions
              ? { acceptProviderSnapshot }
              : native.acceptProviderSnapshot
                ? {
                    acceptProviderSnapshot: native.acceptProviderSnapshot.bind(native)
                  }
                : {}),
            /** 仅释放当前 epoch 的 provider 会话，不推断原生动作已停止。 */
            close() {
              try {
                if (releaseSession.call(native) !== undefined) {
                  fail('synchronous_channel_block_required')
                }
              } finally {
                closeRemoteEpochs()
              }
            }
          }
        } catch (error) {
          try {
            closeSession(owned)
          } finally {
            closeRemoteEpochs()
          }
          throw error
        }
      }
    })
    const active = transport
    const results = createProviderResultAccess({
      store,
      localPolicies,
      principal,
      resolveOriginalRead: active.resolveOriginalRead,
      /** 每次读取重新核对当前受保护配置；所有 provider 共用 Store 的内容和 handle 总预算。 */
      provider(target) {
        const configured = providers.get(key(target))
        const binding = localProvider(target)
        return configured && binding
          ? {
              binding,
              max_response_bytes: configured.max_response_bytes ?? DEFAULT_LIMITS.object_bytes
            }
          : undefined
      }
    })
    const catalog: RuntimeCatalogProvider = Object.freeze({
      /** 目录复用唯一 Store 与当前实际认证 epoch；Owner 无 token 到期，实例/连接寿命逐次复核。 */
      resolve(target, requesting) {
        const provider = nativeProviders.get(key(target))
        const binding = localProvider(target)
        const connection = active.currentConnection(target.machine_id)
        if (!provider?.catalogSource || !binding?.enabled || !connection) {
          return undefined
        }
        if (boundedJson(principal()) !== boundedJson(requesting)) {
          fail('principal_changed')
        }
        const local = localPolicies(target)
        const native = provider.catalogSource(connection, {
          caller_policy_revision: requesting.policy.revision,
          local_policy_revision: local.revision
        })
        store.assertConnection(connection)
        if (
          boundedJson(principal()) !== boundedJson(requesting) ||
          boundedJson(localPolicies(target)) !== boundedJson(local) ||
          boundedJson(active.currentConnection(target.machine_id) ?? null) !== boundedJson(connection) ||
          boundedJson(localProvider(target) ?? null) !== boundedJson(binding) ||
          closing
        ) {
          fail('runtime_catalog_unavailable')
        }
        return Object.freeze({
          record: provider.contract,
          source: native,
          local_provider: binding,
          // 该字段满足既有目录有限整数格式；它不建立委托寿命，真实 Owner/epoch 失效即拒绝。
          expires_at: Number.MAX_SAFE_INTEGER
        })
      }
    })
    return Object.freeze({
      store,
      router,
      transport: active,
      principal,
      runAuthenticated: scope.runAuthenticated,
      results,
      catalog,
      closed,
      close,
      /** 原子准入仅 created=true 才派发；重复 key 不再次发送、不刷新任何期限。 */
      admit(input: RuntimeCallInput) {
        if (!localProvider(input.target)) {
          fail('provider_binding_mismatch')
        }
        const admitted = router.admit(principal(), input.target, input.native_request, input.options)
        if (admitted.created) {
          try {
            active.dispatch(admitted.call.call_id)
          } catch {
            // 登记已经提交；派发失败只保留账本实际状态，不重试，也不丢失可对账的调用引用。
          }
        }
        // 即使派发失败或命中旧 key，仍重新核对当前身份和读取权限，禁止用登记快照泄露旧 ID。
        return { created: admitted.created, call: metadata(router.get(principal(), admitted.call.call_id)) }
      },
      /** 即使已回应也只返回当前授权元数据，正文交付由 results 统一完成。 */
      get(callId: string) {
        return metadata(router.get(principal(), callId))
      },
      /** 取消仅显式命令触发；HTTP 断开与前端等待结束不会进入此端口。 */
      cancel(callId: string) {
        return metadata(active.cancel(callId))
      },
      /** 原请求索引只对当前所属 caller 开放，不恢复失效 permit 或跨 epoch 请求。 */
      originalAttempt(callId: string, attemptId: string): TrustedAttempt | undefined {
        const current = router.get(principal(), callId)
        return current.attempt_id === attemptId ? store.attempt(callId, attemptId) : undefined
      }
    })
  } catch (error) {
    await close()
    throw error
  }
}
