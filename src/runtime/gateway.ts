// 装配唯一账本、路由、认证设备通道及原请求结果门禁；不实现 HTTP/MCP 协议或管理写服务。
import { Router } from '../router.js'
import { GatewayError } from '../contracts.js'
import { createGateway, createDeviceLifecycleAdapter } from '../transport/index.js'
import { createLuvusResultAccess } from '../connector/luvus/index.js'
import type { TrustedAttempt } from '../integration/luvus-wire.js'
import type { Call } from '../store.js'
import type { ProviderBinding, V2Target } from '../wire/types.js'
import { boundedJson, contractRef, fail, validateProvider, validateTarget } from '../wire/index.js'
import { createTrustedRequestScope } from './request-scope.js'
import type { GatewayRuntimeOptions, RuntimeCallInput, RuntimeProvider } from './types.js'

/** 在受信宿主显式交付已打开资源后启动常驻 listener；客户端寿命与角色寿命无关。 */
export async function createGatewayRuntime(options: GatewayRuntimeOptions) {
  const store = options.lifecycle.store
  const scope = createTrustedRequestScope(options.identities)
  const router = new Router(store, localPolicies)
  const providers = new Map<string, RuntimeProvider>()
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
    const current = attempt ? providers.get(key(attempt.binding.target))?.source(attempt.binding) : undefined
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
      const name = key(binding)
      const ref = contractRef(provider.contract.wire.source)
      const previous = contracts.get(ref)
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
              wire: provider.contract.wire,
              identity: provider.contract.compiled.identity,
              capabilities: provider.contract.capabilities,
              revision: provider.contract.capability_revision
            }))
      ) {
        fail('runtime_provider_conflict')
      }
      if (
        binding.kind !== 'luvus' ||
        boundedJson(store.provider(binding.machine_id, binding.provider_id)) !== boundedJson(binding)
      ) {
        fail('provider_binding_mismatch')
      }
      providers.set(name, {
        ...provider,
        binding: Object.freeze(binding),
        target: Object.freeze(structuredClone(provider.target))
      })
      if (!previous) {
        contracts.set(ref, provider.contract)
      }
    }
    transport = createGateway({
      ...options.listener,
      store,
      router,
      principal,
      identity: options.lifecycle.identityHost,
      channels: options.channels,
      retainOriginalRead: true,
      /** 每个实际认证 socket 建立独立 backend/Wire；身份随该 socket fence 失效。 */
      session(connection, channel) {
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
            const provider = providers.get(key(attempt.binding.target))
            if (!provider) {
              fail('provider_binding_unavailable')
            }
            const authority = provider.authority(attempt, binding)
            if (closing) {
              throw new GatewayError('runtime_closed')
            }
            return authority
          },
          /** 普通结果读取只能使用当前已认证请求的主体。 */
          currentPrincipal() {
            try {
              return principal().id
            } catch {
              return undefined
            }
          }
        }
        const native = createDeviceLifecycleAdapter(options.lifecycle, channel, services)
        const adapter = {
          ...native.adapter,
          /** 原文保留以原持久 caller 的当前权限独立评估，不借用任何 HTTP 客户端的最近身份。 */
          planEvidence(frame: Parameters<typeof native.adapter.planEvidence>[0]) {
            const attempt = store.attempt(frame.payload.attempt.call_id, frame.payload.attempt.attempt_id)
            if (!attempt) {
              return native.adapter.planEvidence(frame)
            }
            // 保留门禁与交付门禁分开；同步专用主体仅在此账本提交调用栈内生效。
            retaining = attempt.principal_id
            try {
              return native.adapter.planEvidence(frame)
            } finally {
              retaining = undefined
            }
          }
        }
        let retaining: string | undefined
        const readPrincipal = services.currentPrincipal
        // backend 持有 services 的函数值，因此在创建 adapter 前就通过此闭包读取同步保留主体。
        native.backend.currentPrincipal =
          /** 仅 planEvidence 的同步保留栈可使用持久归属；其余入口强制请求作用域。 */
          () => retaining ?? readPrincipal()
        return {
          adapter,
          /** 逐 provider 核对 canonical binding、双端配置和独立 native 健康。 */
          readiness() {
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
                /** 丢失来源或 canonical fence 不匹配时保持该实例不可派发。 */
                (provider) => {
                  const nativeReady =
                    !!localProvider(provider.target) &&
                    localPolicies(provider.target).revision === policyRevision &&
                    provider.peer_policy_revision === peerRevision &&
                    provider.ready()
                  return {
                    expected:
                      store.provider(provider.binding.machine_id, provider.binding.provider_id) ?? provider.binding,
                    local: provider.binding,
                    native_ready: !closing && nativeReady
                  }
                }
              )
            }
          },
          /** 原 Wire 由 transport 先关闭；这里不终止独立 native 实例。 */
          close() {}
        }
      }
    })
    const active = transport
    const results = createLuvusResultAccess({
      store,
      localPolicies,
      principal,
      resolveOriginalRead: active.resolveOriginalRead
    })
    return Object.freeze({
      store,
      router,
      transport: active,
      principal,
      runAuthenticated: scope.runAuthenticated,
      results,
      closed,
      close,
      /** 原子准入仅 created=true 才派发；重复 key 不再次发送、不刷新任何期限。 */
      admit(input: RuntimeCallInput) {
        if (!localProvider(input.target)) {
          fail('provider_binding_mismatch')
        }
        const admitted = router.admit(principal(), input.target, input.native_request, input.options)
        if (admitted.created) {
          active.dispatch(admitted.call.call_id)
        }
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
