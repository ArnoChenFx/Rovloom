// 在一个认证 epoch 内按完整受保护路由委托原会话，不创建 Wire、许可、账本或第二条设备连接。
import type { Adapter, Connection, ConnectorWireSession, Session } from '../transport/index.js'
import { closeSession, ReceiveWindow } from '../transport/common.js'
import { boundedJson, fail, hash, LIMITS, object, parseJson, validateProvider, validateTarget } from '../wire/index.js'
import type { AttemptIdentity, Direction, ProviderBinding, V2Target } from '../wire/types.js'

export type ProviderSessionGroup<T extends Session = Session> = Readonly<{
  providers: readonly Readonly<{ binding: ProviderBinding; target: V2Target }>[]
  session: T
}>

/** 原 Gateway 会话保持各自来源与权限，组合层只选择同一个已认证连接中的原端口。 */
export function composeGatewaySessions(
  connection: Connection,
  groups: readonly ProviderSessionGroup[],
  now: () => number
) {
  return compose(connection, groups, now, false)
}

/** 原 Connector 执行和一次性 receipt 仍交给其原 owner，整个角色只使用一个 transport。 */
export function composeConnectorSessions(
  connection: Connection,
  groups: readonly ProviderSessionGroup<ConnectorWireSession>[],
  now: () => number
): ConnectorWireSession {
  return compose(connection, groups, now, true) as ConnectorWireSession
}

/** 两种角色共用路由与同步关闭 fence；原 adapter 执行完整协议、来源、授权和结果校验。 */
function compose(
  connection: Connection,
  input: readonly ProviderSessionGroup[],
  now: () => number,
  connector: boolean
) {
  const groups = input.map(
    /** 固定原会话对象与独立路由快照，防止配置别名改变选择。 */ (group) => ({
      session: group.session,
      providers: Object.freeze(
        group.providers.map(
          /** 只复制纯配置，原adapter和opaque句柄保持原所有权。 */ (provider) =>
            Object.freeze({
              binding: Object.freeze(structuredClone(provider.binding)),
              target: Object.freeze(structuredClone(provider.target))
            })
        )
      )
    })
  )
  const routes = new Map<string, { group: ProviderSessionGroup; binding: ProviderBinding; target: V2Target }>()
  const windows = new Map<Direction, ReceiveWindow>()
  let ended = false
  let cleanupFailed = false
  let adaptersClosed = false
  let operating = false
  let highWater = 0
  let pendingReceipt: ProviderSessionGroup | undefined
  let snapshots: readonly import('../wire/types.js').ProviderSnapshot[] | undefined
  const snapshotSources = new Map<ProviderSessionGroup, readonly import('../wire/types.js').ProviderSnapshot[]>()

  /** 关闭所有原端口，即使某一项失败也不跳过其它 owner；重入和重复关闭不重复释放。 */
  function closeAdapters(): void {
    if (adaptersClosed) {
      if (cleanupFailed) {
        fail('runtime_session_close_failed')
      }
      return
    }
    adaptersClosed = true
    ended = true
    pendingReceipt = undefined
    windows.clear()
    let failed = false
    for (const group of [...groups].reverse()) {
      try {
        const value: unknown = group.session.adapter.close()
        if (value !== undefined) {
          failed = true
          void Promise.resolve(value).catch(/** 消费违规异步关闭的晚到拒绝，原关闭仍报告失败。 */ () => {})
        }
      } catch {
        failed = true
      }
    }
    if (failed || cleanupFailed) {
      cleanupFailed = true
      fail('runtime_session_close_failed')
    }
  }

  let ownersClosed = false
  /** adapter 与 owner 独立计量；transport 先关 adapter 后仍会尝试每一个原 owner。 */
  function close(): void {
    let failed = false
    try {
      closeAdapters()
    } catch {
      failed = true
    }
    if (!ownersClosed) {
      ownersClosed = true
      for (const group of [...groups].reverse()) {
        try {
          const value: unknown = group.session.close()
          if (value !== undefined) {
            failed = true
            void Promise.resolve(value).catch(/** 消费违规异步owner清理拒绝，不冒充同步完成。 */ () => {})
          }
        } catch {
          failed = true
        }
      }
    }
    if (failed || cleanupFailed) {
      cleanupFailed = true
      fail('runtime_session_close_failed')
    }
  }

  /** 外部回调前后复核 epoch，组合上下文总量沿用原单会话的128上限。 */
  function assertOpen(): void {
    if (ended) {
      fail('adapter_closed')
    }
    let contexts = 0
    let bytes = 0
    for (const group of groups) {
      const stats = group.session.adapter.stats()
      if (ended || stats.closed) {
        fail('adapter_closed')
      }
      contexts += stats.executions + stats.responses
      const measured = stats as typeof stats & { snapshot_bytes?: number; attempt_bytes?: number }
      bytes += (measured.snapshot_bytes ?? 0) + (measured.attempt_bytes ?? 0)
    }
    if (contexts > 128 || bytes > 16_777_216) {
      try {
        close()
      } finally {
        fail('attempt_capacity')
      }
    }
  }

  /** 同步关联不得被 provider 重入替换；失败不留下可被另一帧消费的 receipt 选择。 */
  function invoke<T>(action: () => T): T {
    if (operating) {
      try {
        close()
      } finally {
        fail('runtime_session_reentry')
      }
    }
    operating = true
    try {
      assertOpen()
      const value = action()
      assertOpen()
      return value
    } catch (error) {
      pendingReceipt = undefined
      throw error
    } finally {
      operating = false
    }
  }

  /** target和kind都来自受保护注册组；帧中的提示只用于选原校验器，不能建立任何可信状态。 */
  function select(attempt: AttemptIdentity): ProviderSessionGroup {
    const route = routes.get(boundedJson(attempt.target))
    if (!route || attempt.provider_kind !== route.binding.kind) {
      fail('provider_binding_mismatch')
    }
    return route.group
  }

  /** 无attempt的治理帧仍由一个原 codec 完整核验连接；对象只交给唯一Luvus原组装器。 */
  function frameOwner(frame: unknown): ProviderSessionGroup {
    const value = object(frame)
    if (value.type === 'heartbeat' || value.type === 'error') {
      return groups[0]!
    }
    if (value.type === 'object_chunk') {
      const native = groups.filter(
        /** Herdr不支持对象，不能由组合层为其补造组装器或许可。 */ (group) =>
          group.providers.every(
            /** 对象只交给唯一原Luvus会话，不为Herdr补造传输。 */ (provider) => provider.binding.kind === 'luvus'
          )
      )
      if (native.length !== 1) {
        fail('runtime_object_session_unavailable')
      }
      return native[0]!
    }
    return select(object(object(value.payload).attempt) as AttemptIdentity)
  }

  try {
    if (!groups.length) {
      fail('runtime_session_unavailable')
    }
    for (const group of groups) {
      if (!group.providers.length) {
        fail('provider_binding_mismatch')
      }
      for (const provider of group.providers) {
        const binding = structuredClone(provider.binding)
        const target = structuredClone(provider.target)
        validateProvider(binding)
        validateTarget(target)
        const key = boundedJson(target)
        if (
          binding.machine_id !== connection.machine_id ||
          target.machine_id !== connection.machine_id ||
          binding.provider_id !== target.provider_id ||
          routes.has(key) ||
          [...routes.values()].some(
            /** 同一机器的provider标识不得在多个会话组重复。 */ (route) =>
              route.binding.provider_id === binding.provider_id
          )
        ) {
          fail('provider_binding_mismatch')
        }
        routes.set(key, { group, binding, target })
      }
    }
    assertOpen()
  } catch (error) {
    try {
      close()
    } catch {
      /* 原构建错误保留；所有已交付资源均已尝试回收。 */
    }
    throw error
  }

  const adapter: Adapter = {
    decode: /** 提示解析有界，返回值始终取原adapter完整解码，不重包帧。 */ (raw, direction) =>
      invoke(
        /** 原始字节只进入选中的原decoder，随后重验关闭fence。 */ () =>
          frameOwner(parseJson(raw)).session.adapter.decode(raw, direction)
      ),
    encode: /** 原对象原样交给对应原codec，保留完整请求和原生预算。 */ (frame, direction) =>
      invoke(
        /** 原帧交给原encoder，组合层不修改字段或权限。 */ () =>
          frameOwner(frame).session.adapter.encode(frame, direction)
      ),
    checkResult: /** 原始响应仍用本provider的原请求permit复验。 */ (binding, response) =>
      invoke(
        /** 原binding和响应交给对应原结果许可检查。 */ () =>
          select(binding).session.adapter.checkResult(binding, response)
      ),
    checkResultRetention: /** 可读与可保存继续由原adapter分别裁决。 */ (binding, response) =>
      invoke(
        /** 独立调用原保留门禁，不能以可读代替可保存。 */ () =>
          select(binding).session.adapter.checkResultRetention(binding, response)
      ),
    encodeResponseObject: /** 只复用选中provider的原对象预算与分片行为。 */ (frame, objectId) =>
      invoke(
        /** 原对象分片仍由对应原adapter完成。 */ () =>
          select(frame.payload.attempt).session.adapter.encodeResponseObject(frame, objectId)
      ),
    acceptChunk: /** 完整对象仍由唯一原组装器校验，再复核它属于相同受保护组。 */ (raw, direction) =>
      invoke(
        /** 原组装器完成后再次核对对象所属的受保护路由组。 */ () => {
          const group = frameOwner(parseJson(raw))
          const result = group.session.adapter.acceptChunk(raw, direction)
          if (result?.kind === 'envelope' && frameOwner(result.envelope) !== group) {
            fail('provider_binding_mismatch')
          }
          return result
        }
      ),
    observeMessage: /** 原去重后再用共享有界窗口拒绝跨provider消息ID冲突，不复制完整对象缓冲。 */ (frame, direction) =>
      invoke(
        /** 原消息观察后执行共享有界去重并记录同步receipt归属。 */ () => {
          if (pendingReceipt) {
            fail('admission_receipt_delivery_pending')
          }
          const group = frameOwner(frame)
          const result = group.session.adapter.observeMessage(frame, direction)
          const time = now()
          if (!Number.isSafeInteger(time) || time < highWater) {
            fail('clock_untrusted')
          }
          highWater = time
          let window = windows.get(direction)
          if (!window) {
            window = new ReceiveWindow()
            windows.set(direction, window)
          }
          const shared = window.observe(
            boundedJson({ message_id: frame.message_id, frame_sha256: hash(boundedJson(frame, LIMITS.object_bytes)) }),
            time
          )
          if (result === 'duplicate' || shared === 'duplicate') {
            return 'duplicate'
          }
          if (connector && frame.type === 'admission_receipt') {
            pendingReceipt = group
          }
          return 'new'
        }
      ),
    planEvidence: /** 证据只来自响应对应的原生会话和原Store锚点。 */ (frame) =>
      invoke(
        /** 证据规划只委托对应原请求上下文。 */ () => select(frame.payload.attempt).session.adapter.planEvidence(frame)
      ),
    release: /** 只释放完整目标所对应原adapter中的原attempt。 */ (binding) =>
      invoke(/** 释放只交给原binding所属adapter。 */ () => select(binding).session.adapter.release(binding)),
    close: closeAdapters,
    stats: /** 只合计计数；原始内容和原生句柄不离开各自owner。 */ () => ({
      closed: ended,
      executions: groups.reduce(
        /** 合计真实执行上下文数量，不暴露内容。 */ (count, group) => count + group.session.adapter.stats().executions,
        0
      ),
      responses: groups.reduce(
        /** 合计真实响应上下文数量，不建立新缓存。 */ (count, group) => count + group.session.adapter.stats().responses,
        0
      )
    })
  }

  const result: Session & Partial<ConnectorWireSession> = {
    adapter,
    readiness: /** 每组只报告自己的canonical binding，政策修订必须属于同一全局配置。 */ () =>
      invoke(
        /** 逐组核对路由覆盖与全局政策修订后合并原健康观测。 */ () => {
          const states = groups.map(
            /** 读取本组原就绪状态并拒绝缺失或重复的provider。 */ (group) => {
              const state = group.session.readiness()
              if (state.providers.length !== group.providers.length) {
                fail('provider_binding_mismatch')
              }
              const seen = new Set<string>()
              for (const provider of state.providers) {
                if (seen.has(provider.local.provider_id)) {
                  fail('provider_binding_mismatch')
                }
                seen.add(provider.local.provider_id)
                if (
                  !group.providers.some(
                    /** 本组只认可其原受保护canonical binding。 */ (entry) =>
                      boundedJson(entry.binding) === boundedJson(provider.local)
                  )
                ) {
                  fail('provider_binding_mismatch')
                }
              }
              return state
            }
          )
          if (
            states.some(
              /** 同一认证连接不能拼接不同全局政策修订。 */ (state) =>
                state.policy_revision !== states[0]!.policy_revision ||
                state.peer_policy_revision !== states[0]!.peer_policy_revision
            )
          ) {
            fail('policy_revision_conflict')
          }
          return {
            policy_revision: states[0]!.policy_revision,
            peer_policy_revision: states[0]!.peer_policy_revision,
            providers: states.flatMap(/** 合并已逐组验证的provider观测，保留各自状态。 */ (state) => state.providers)
          }
        }
      ),
    close
  }
  if (groups.some(/** 只在原端口存在时暴露快照接纳能力。 */ (group) => group.session.acceptProviderSnapshot)) {
    result.acceptProviderSnapshot = /** 快照仍由目标原owner核验pin与实际epoch。 */ (snapshot) =>
      invoke(
        /** 按完整目标把原快照交给原pin和epoch核验端口。 */ () => {
          const group = routes.get(boundedJson(snapshot.target))?.group
          if (!group?.session.acceptProviderSnapshot) {
            fail('runtime_snapshot_session_unavailable')
          }
          group.session.acceptProviderSnapshot(snapshot)
        }
      )
  }
  if (groups.some(/** 只转发真实owner交付的稳定快照getter。 */ (group) => group.session.providerSnapshot)) {
    result.providerSnapshot = /** 每次复核原稳定getter，不刷新generation或给Herdr补造广告。 */ () =>
      invoke(
        /** 逐次复核原getter引用，聚合数组固定且不刷新来源期限。 */ () => {
          const all = []
          for (const group of groups) {
            if (!group.session.providerSnapshot) {
              continue
            }
            const current = group.session.providerSnapshot()
            const previous = snapshotSources.get(group)
            if (previous && previous !== current) {
              fail('provider_snapshot_changed')
            }
            for (const snapshot of current) {
              const route = routes.get(boundedJson(snapshot.target))
              if (route?.group !== group || boundedJson(route.binding) !== boundedJson(snapshot.binding)) {
                fail('provider_binding_mismatch')
              }
            }
            snapshotSources.set(group, current)
            all.push(...current)
          }
          snapshots ??= Object.freeze(all)
          return snapshots
        }
      )
  }
  if (connector) {
    const sessions = groups as unknown as readonly ProviderSessionGroup<ConnectorWireSession>[]
    if (
      sessions.some(
        /** 全部原Connector会话必须实际具备接收和执行端口。 */ (group) =>
          !group.session.admissions || typeof group.session.executeWire !== 'function'
      )
    ) {
      closeSession(result)
      fail('admission_receipt_sink_required')
    }
    result.admissions = {
      accept: /** transport刚完成同步observe后，原proof只交给该帧所属原sink一次，不拆封或重新签名。 */ (proof) =>
        invoke(
          /** 同步取走本次receipt的唯一归属，并交付原opaque proof。 */ () => {
            const group = pendingReceipt as ProviderSessionGroup<ConnectorWireSession> | undefined
            pendingReceipt = undefined
            if (!group) {
              fail('admission_receipt_proof_required')
            }
            return group.session.admissions!.accept(proof)
          }
        ),
      assertRequest: /** 请求完整binding再次选同一原持久接收端。 */ (request) =>
        invoke(
          /** 完整原请求重新交由对应原持久接收端核验。 */ () => {
            return (select(request.binding).session as ConnectorWireSession).admissions!.assertRequest(request)
          }
        ),
      closeEpoch: /** 清理不穿过开放fence，原sink仍只收到实际认证连接。 */ (epoch) => {
        if (
          boundedJson({
            machine_id: epoch.machine_id,
            recovery_generation: epoch.recovery_generation,
            connection_epoch: epoch.connection_epoch
          }) !==
          boundedJson({
            machine_id: connection.machine_id,
            recovery_generation: connection.recovery_generation,
            connection_epoch: connection.connection_epoch
          })
        ) {
          fail('connection_binding_mismatch')
        }
        let failed = false
        for (const group of sessions) {
          try {
            const value: unknown = group.session.admissions!.closeEpoch?.(epoch)
            if (value !== undefined) {
              failed = true
              void Promise.resolve(value).catch(
                /** 原epoch fence违规异步时仍消费晚到拒绝，不能报告持久提交完成。 */ () => {}
              )
            }
          } catch {
            failed = true
          }
        }
        if (failed || cleanupFailed) {
          cleanupFailed = true
          fail('runtime_session_close_failed')
        }
      }
    }
    result.executeWire = /** 选中原会话后原始字节和signal保持不变；晚到结果仍受组合关闭fence约束。 */ async (
      raw,
      signal
    ) => {
      const group = invoke(
        /** 原始有界字节只用于选原会话，执行仍由其原端口完成。 */ () => frameOwner(parseJson(raw))
      ) as ProviderSessionGroup<ConnectorWireSession>
      const value = await group.session.executeWire(raw, signal)
      assertOpen()
      if (select(value.binding) !== group) {
        fail('provider_binding_mismatch')
      }
      return value
    }
  }
  return result
}
