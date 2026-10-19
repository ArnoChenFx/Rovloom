// 衔接 Wire 与真实原生校验器，隔离派发上下文、仅响应上下文及其回收预算。
import {
  checkDispatch,
  checkResultBoundary,
  createNativeValidator,
  inspectRequestGate
} from '../native-contract/index.js'
import { checkResultRetention } from '../native-contract/safety.js'
import type {
  Check,
  CapabilityView,
  CheckedControl,
  CheckedStream,
  CompiledContract,
  DispatchAuthorization,
  DispatchCandidate,
  DispatchPermit,
  ResponseOnlyContext,
  NativeBinding,
  NativeValidator,
  TrustedNativeContext
} from '../native-contract/index.js'
import {
  advanceStream,
  assertBinding,
  assertProviderAccess,
  boundedJson,
  contractRef,
  decodeWireFrame,
  decodeWireObject,
  encodeWireFrame,
  fail,
  hash,
  id,
  LIMITS,
  MessageWindow,
  object,
  ObjectAssembler,
  planResponseEvidence,
  providerFor,
  providerScopeAllowed,
  uint,
  validateAttempt,
  WireError
} from '../wire/index.js'
import type {
  AttemptBinding,
  AttemptIdentity,
  AuthenticatedContext,
  AuthenticatedEnvelope,
  ContractRecord,
  Direction,
  JsonObject,
  NativePayloadValidator,
  NativeValidationContext,
  ProviderBinding,
  ProviderPolicies,
  ResolvedAttempt,
  StreamFeature,
  V2Target,
  WireEnvelope
} from '../wire/types.js'
import type { LedgerInvalidation } from '../storage/model.js'
import type { ResponseAnchor } from '../wire/evidence.js'
import type { StreamState } from '../wire/lifecycle.js'

export type TrustedAttempt = {
  binding: AttemptBinding
  principal_id: string
  method: string
  mode: 'strict' | 'raw-contract'
  transport: 'rpc' | 'stream'
  feature?: StreamFeature
  stream_id?: string
  native_request: JsonObject
}

export type NativeContractRecord = {
  wire: ContractRecord
  compiled: CompiledContract
  capabilities: unknown
  capability_revision: string
}

type Authority = Omit<
  DispatchAuthorization,
  'source' | 'principal_id' | 'caller_policy' | 'local_policy' | 'mode' | 'now'
>
// 仅由宿主认证、双端配置及账本实现。这里没有默认授权、设备广告或从消息导入上下文的工厂。
// persistence 模块只提供持久化事实；当前认证、配置与原生来源仍必须由宿主独立实现。
export interface NativeWireBackend {
  // 取得宿主已认证连接，调用方仍须核对当前 epoch 与恢复 generation。
  connection(): AuthenticatedContext['connection']
  // 按调用与尝试 ID 查询仍有请求原文的可信账本记录。
  attempt(callId: string, attemptId: string): TrustedAttempt | undefined
  // 查询网关登记的目标 provider 绑定及其当前 revision。
  provider(target: V2Target): ProviderBinding | undefined
  // 查询连接器本机配置，用于与网关 provider 绑定逐项核对。
  localProvider(target: V2Target): ProviderBinding | undefined
  // 按固定引用查找 Wire 来源、离线编译契约及当前能力广告。
  contract(ref: string): NativeContractRecord | undefined
  // 独立核验指定尝试所连接的原生 endpoint 和身份。
  nativeSource(callId: string, attemptId: string): TrustedNativeContext | undefined
  // 取得指定 principal 当前的调用方与本地双端策略。
  policies(principal: string): ProviderPolicies
  // 提供独立核验的派发、秘密边界和分类权限事实，不能从消息自报导入。
  authority(attempt: TrustedAttempt, binding: NativeBinding): Authority
  // 取得当前结果读取方身份，避免借用原调用者的派发许可。
  currentPrincipal(): string | undefined
  // 返回宿主可信时钟，用于不可延长的期限检查。
  now(): number
  // 查询调用原文的可见状态，过期或删除后不能由派发许可恢复。
  contentStatus(binding: AttemptBinding): 'available' | 'expired' | 'discarded' | 'unavailable'
  // 只查询原派发锚点及固定保留期限，不取回请求或响应正文。
  responseAnchor?(binding: AttemptBinding): ResponseAnchor | undefined
  // 订阅已提交的内容回收、绑定失效及关闭通知，返回取消订阅入口。
  subscribeInvalidation?(listener: (event: LedgerInvalidation) => void): () => void
}

type State = {
  attempt: TrustedAttempt
  validator: NativeValidator
  view: CapabilityView
  source: TrustedNativeContext
  handle: object
  sourceToken: object
  candidate?: DispatchCandidate
  permit?: DispatchPermit
  stream?: CheckedStream
  closed: boolean
  ack?: string
  validatorCaps: unknown
  snapshotBytes: number
  wireStream?: StreamState
  retention?: { content_expires_at: number; dedup_expires_at: number }
  controls: Map<string, { frame: string; candidate: CheckedControl; permit?: DispatchPermit }>
}
type ResponseState = {
  attempt: Omit<TrustedAttempt, 'native_request'>
  validator: NativeValidator
  source: TrustedNativeContext
  handle: object
  sourceToken: object
  sealed: ResponseOnlyContext
  capsDigest: string
  expires: number
  contentExpires: number
  snapshotBytes: number
}
type AssemblySlot = { assembler: ObjectAssembler | undefined; expires: number; reserved: number }
type AssemblyEntry = { connection: string; machine: string; objects: Map<string, AssemblySlot>; reserved: number }
// 限制序列化字节数后复制输入，隔离外部对象修改与私有状态。
const copy = <T>(value: T, maxBytes: number = LIMITS.frame_bytes): T => JSON.parse(boundedJson(value, maxBytes)) as T

// 将原生 Check 失败转换为固定 Wire 错误，只向外传递稳定错误码。
function unwrap<T>(result: Check<T>): T {
  if (!result.ok) {
    fail(result.error.code)
  }
  return result.value
}

// 包装宿主入口并屏蔽非 Wire 异常，避免底层异常泄露私有内容。
function guarded<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return /* 执行宿主操作并保留固定 Wire 错误，将其它异常统一收敛为适配器不可用。 */ (...args) => {
    try {
      return fn(...args)
    } catch (error) {
      if (error instanceof WireError) {
        throw error
      }
      fail('native_adapter_unavailable')
    }
  }
}
// 用调用与尝试 ID 组合本进程缓存键，使同调用的不同尝试分离。
const key = (value: AttemptIdentity) => value.call_id + ':' + value.attempt_id

// 从完整绑定剥离连接外壳字段，保留 Wire 尝试身份用于独立核对。
function attemptIdentity(binding: AttemptBinding): AttemptIdentity {
  const { machine_id: _machine, recovery_generation: _recovery, connection_epoch: _epoch, ...attempt } = binding
  return attempt
}

// 建立共享容量上限的执行与仅响应缓存，订阅账本失效通知并启动可关闭的定时回收。
export function createLuvusWireAdapter(
  backend: NativeWireBackend,
  limits: { attempts: number; control_ids: number; snapshot_bytes?: number; maintenance_interval_ms?: number } = {
    attempts: 128,
    control_ids: 128
  }
) {
  uint(limits.attempts, true)
  uint(limits.control_ids, true)
  if (limits.attempts > 4096 || limits.control_ids > 4096) {
    fail('adapter_limit')
  }
  const snapshotLimit = limits.snapshot_bytes ?? 16_777_216
  uint(snapshotLimit, true)
  if (snapshotLimit > LIMITS.buffered_bytes) {
    fail('adapter_limit')
  }
  const maintenanceInterval = limits.maintenance_interval_ms ?? 1000
  uint(maintenanceInterval, true)
  if (maintenanceInterval > 60_000) {
    fail('adapter_limit')
  }
  let retainedBytes = 0

  // 计量保留 JSON 快照；不把此计量冒称 JS heap/worker 的硬内存隔离。
  function reserve(bytes: number): void {
    if (retainedBytes + bytes > snapshotLimit) {
      fail('adapter_limit')
    }
    retainedBytes += bytes
  }
  const states = new Map<string, State>()
  const responseStates = new Map<string, ResponseState>()
  const responseHandles = new WeakMap<object, ResponseState>()
  let closed = false
  let maintenance: ReturnType<typeof setInterval> | undefined
  let unsubscribe: (() => void) | undefined
  const pendingInvalidations = new Map<string, LedgerInvalidation>()
  const handles = new WeakMap<object, State>()
  const assemblers = new Map<Direction, AssemblyEntry>()
  const windows = new Map<Direction, { connection: string; window: MessageWindow }>()
  let observedTime = -1

  // 独立检查宿主时钟为单调安全整数，避免 NaN、回拨或溢出延长私有上下文与分片期限。
  function time(): number {
    try {
      const value = backend.now()
      uint(value)
      if (value < observedTime || !Number.isSafeInteger(value + LIMITS.transfer_timeout_ms)) {
        fail('clock_untrusted')
      }
      observedTime = value
      return value
    } catch {
      // 原子校验期间排队关闭，finally 在回滚后统一释放，避免恢复已不可信的原请求状态。
      invalidate({ kind: 'closed' })
      fail('clock_untrusted')
    }
  }

  // 释放该对象的全部组装引用，但继续保留有界 ID 墓碑，拒绝原传输在短期内重新开始。
  function closeAssembly(entry: AssemblyEntry, slot: AssemblySlot, now: number): void {
    if (slot.assembler) {
      entry.reserved -= slot.reserved
      slot.reserved = 0
      slot.assembler = undefined
      slot.expires = now + LIMITS.transfer_timeout_ms
    }
  }

  // 部分内容尚不能可信解析到调用；按可信设备作用域丢弃在途正文，不受其它设备的广播通知影响。
  function flushAssemblies(now: number, machine: string): void {
    for (const entry of assemblers.values()) {
      if (entry.machine !== machine) {
        continue
      }
      for (const slot of entry.objects.values()) {
        closeAssembly(entry, slot, now)
      }
    }
  }

  // 按首片固定截止时间主动释放空闲组装器，再按独立期限清理只含元数据的对象墓碑。
  function maintainAssemblies(now: number): void {
    for (const entry of assemblers.values()) {
      for (const [objectId, slot] of entry.objects) {
        if (now >= slot.expires) {
          if (slot.assembler) {
            closeAssembly(entry, slot, now)
          } else {
            entry.objects.delete(objectId)
          }
        }
      }
    }
  }

  // 只返回传输预约和对象数量，不暴露分片 Buffer、请求或响应正文。
  function transferStats() {
    let transfer_bytes = 0
    let active_transfers = 0
    let object_tombstones = 0
    for (const entry of assemblers.values()) {
      transfer_bytes += entry.reserved
      for (const slot of entry.objects.values()) {
        if (slot.assembler) {
          active_transfers++
        } else {
          object_tombstones++
        }
      }
    }
    return { transfer_bytes, active_transfers, object_tombstones }
  }

  let undo: Map<string, State | undefined> | undefined
  // 首次触及尝试时保存回滚快照，复制控制项以隔离后续许可修改。
  function remember(name: string): void {
    if (!undo || undo.has(name)) {
      return
    }
    const state = states.get(name)
    undo.set(
      name,
      state && {
        ...state,
        controls: new Map(
          [...state.controls].map(
            /* 复制每个控制项的可变许可字段，使失败操作不会污染回滚快照。 */ ([nativeId, input]) => [
              nativeId,
              { ...input }
            ]
          )
        )
      }
    )
  }

  // 用本次回滚表阻止同步重入；原生校验先成功、外层关联或序号检查后失败时，恢复触及的执行状态。
  // 入口维护先于回滚快照，操作中收到的账本失效通知在结束后应用，二者不会随本次失败撤销。
  function atomic<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return /* 先执行期限回收，再保存本次变更；失败恢复尝试及预算，最后应用已提交的失效通知。 */ (...args) => {
      if (closed) {
        fail('adapter_closed')
      }
      if (undo) {
        fail('native_adapter_unavailable')
      }
      maintain()
      if (closed) {
        fail('adapter_closed')
      }
      const pending = new Map<string, State | undefined>()
      const before = retainedBytes
      undo = pending
      try {
        const result = fn(...args)
        if (closed) {
          fail('adapter_closed')
        }
        return result
      } catch (error) {
        for (const [name, saved] of pending) {
          const current = states.get(name)
          if (current) {
            handles.delete(current.handle)
          }
          if (saved) {
            states.set(name, saved)
            handles.set(saved.handle, saved)
          } else {
            states.delete(name)
          }
        }
        retainedBytes = before
        throw error
      } finally {
        undo = undefined
        const invalidations = [...pendingInvalidations.values()]
        pendingInvalidations.clear()
        for (const event of invalidations) {
          invalidate(event)
        }
      }
    }
  }

  // 移除执行句柄并返还快照预算；有 RPC 许可时一并撤销原生候选及其全部许可。
  function dropExecution(name: string): void {
    const state = states.get(name)
    if (!state) {
      return
    }
    if (state.permit && state.attempt.transport === 'rpc') {
      state.validator.releaseRequestContext(state.permit)
    }
    handles.delete(state.handle)
    retainedBytes -= state.snapshotBytes
    states.delete(name)
  }
  // 销毁密封响应句柄并返还快照预算，阻止继续使用已失效的元数据。
  function dropResponse(name: string): void {
    const state = responseStates.get(name)
    if (!state) {
      return
    }
    state.validator.releaseResponseContext(state.sealed)
    responseHandles.delete(state.handle)
    retainedBytes -= state.snapshotBytes
    responseStates.delete(name)
  }
  // 从真实 RPC 许可密封不含请求正文的响应约束，再撤销执行状态并切换缓存。
  // 缺许可或固定期限、密封返回拒绝、替换快照超额时，丢弃执行状态而不建立仅响应缓存。
  function compact(name: string): void {
    const state = states.get(name)
    if (!state || state.attempt.transport !== 'rpc') {
      return
    }
    flushAssemblies(time(), state.attempt.binding.machine_id)
    if (!state.permit || !state.retention) {
      dropExecution(name)
      return
    }
    const sealed = state.validator.sealResponseContext(state.permit)
    if (!sealed.ok) {
      dropExecution(name)
      return
    }
    const attempt: ResponseState['attempt'] = {
      binding: {
        machine_id: state.attempt.binding.machine_id,
        recovery_generation: state.attempt.binding.recovery_generation,
        connection_epoch: state.attempt.binding.connection_epoch,
        call_id: state.attempt.binding.call_id,
        attempt_id: state.attempt.binding.attempt_id,
        native_request_id: state.attempt.binding.native_request_id,
        target: state.attempt.binding.target,
        provider_kind: state.attempt.binding.provider_kind,
        binding_revision: state.attempt.binding.binding_revision,
        contract_ref: state.attempt.binding.contract_ref,
        registration: state.attempt.binding.registration
      },
      principal_id: state.attempt.principal_id,
      method: state.attempt.method,
      mode: state.attempt.mode,
      transport: 'rpc'
    }
    const capsDigest = hash(boundedJson(state.validatorCaps))
    const snapshotBytes =
      2 *
        Buffer.byteLength(
          boundedJson({
            attempt,
            source: state.source,
            capsDigest,
            expires: state.retention.dedup_expires_at,
            contentExpires: state.retention.content_expires_at
          })
        ) +
      sealed.value.retained_bytes
    if (retainedBytes - state.snapshotBytes + snapshotBytes > snapshotLimit) {
      state.validator.releaseResponseContext(sealed.value)
      dropExecution(name)
      return
    }
    const response: ResponseState = {
      attempt,
      validator: state.validator,
      source: state.source,
      handle: Object.freeze({}),
      sourceToken: Object.freeze({}),
      sealed: sealed.value,
      capsDigest,
      expires: state.retention.dedup_expires_at,
      contentExpires: state.retention.content_expires_at,
      snapshotBytes
    }
    dropExecution(name)
    retainedBytes += snapshotBytes
    responseStates.set(name, response)
    responseHandles.set(response.handle, response)
  }
  // 内容回收只压缩 RPC；调用或设备失效销毁两类缓存，关闭还会停维护并退订。
  // 校验中先排队合并通知，关闭立即阻止新入口，实际回收延至回滚表解除后执行。
  function invalidate(event: LedgerInvalidation): void {
    if (undo) {
      if (event.kind === 'closed') {
        closed = true
      }
      const name =
        event.kind === 'closed'
          ? 'closed'
          : boundedJson([event.machine_id, event.kind === 'device_fence' ? null : event.call_id])
      if (pendingInvalidations.get(name)?.kind === 'fence' && event.kind === 'content') {
        return
      }
      pendingInvalidations.set(name, event)
      return
    }
    if (event.kind === 'closed') {
      closed = true
      if (maintenance) {
        clearInterval(maintenance)
        maintenance = undefined
      }
      unsubscribe?.()
      unsubscribe = undefined
      for (const name of states.keys()) {
        dropExecution(name)
      }
      for (const name of responseStates.keys()) {
        dropResponse(name)
      }
      assemblers.clear()
      windows.clear()
      return
    }
    try {
      flushAssemblies(time(), event.machine_id)
    } catch {
      invalidate({ kind: 'closed' })
      return
    }
    for (const [name, state] of states) {
      if (
        state.attempt.binding.machine_id === event.machine_id &&
        (event.kind === 'device_fence' || state.attempt.binding.call_id === event.call_id)
      ) {
        if (event.kind === 'content') {
          compact(name)
        } else {
          dropExecution(name)
        }
      }
    }
    if (event.kind === 'fence' || event.kind === 'device_fence') {
      for (const [name, state] of responseStates) {
        if (
          state.attempt.binding.machine_id === event.machine_id &&
          (event.kind === 'device_fence' || state.attempt.binding.call_id === event.call_id)
        ) {
          dropResponse(name)
        }
      }
    }
  }
  // 校验中或关闭后不维护；其余时间按固定期限回收分片、压缩 RPC 原文并销毁到期的仅响应缓存。
  // 内容查询遇到 storage_degraded 时保留现状，但已知原文期限仍先行生效；其它查询失败丢弃执行状态。
  function maintain(): void {
    if (undo || closed) {
      return
    }
    let now: number
    try {
      now = time()
    } catch {
      invalidate({ kind: 'closed' })
      return
    }
    maintainAssemblies(now)
    for (const [name, state] of states) {
      if (state.attempt.transport !== 'rpc') {
        continue
      }
      if (state.retention && now >= state.retention.content_expires_at) {
        compact(name)
        continue
      }
      try {
        if (backend.contentStatus(state.attempt.binding) !== 'available') {
          compact(name)
        }
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'storage_degraded')) {
          dropExecution(name)
        }
      }
    }
    for (const [name, state] of responseStates) {
      if (now >= state.expires) {
        dropResponse(name)
      }
    }
  }
  // 只用当前连接、独立来源及原锚点复核密封上下文，拒绝期限被改写或能力漂移。
  function refreshResponse(state: ResponseState) {
    const ctx = context('connector_to_gateway', state.attempt.principal_id)
    assertBinding({ ...ctx.connection, ...attemptIdentity(state.attempt.binding) }, state.attempt.binding)
    const anchor = backend.responseAnchor?.(state.attempt.binding)
    if (!anchor) {
      fail('attempt_anchor_unavailable')
    }
    assertBinding(anchor.binding, state.attempt.binding)
    if (
      anchor.method !== state.attempt.method ||
      anchor.mode !== state.attempt.mode ||
      anchor.content_expires_at !== state.contentExpires ||
      anchor.dedup_expires_at !== state.expires ||
      time() >= state.expires
    ) {
      fail('attempt_binding_mismatch')
    }
    const current = source(state.attempt, ctx)
    if (
      boundedJson(current.source) !== boundedJson(state.source) ||
      hash(boundedJson(current.registry.capabilities)) !== state.capsDigest
    ) {
      fail('capability_stale')
    }
  }

  // 复制账本尝试，核对当前连接、登记方法与请求正文及传输形态，并要求 principal 非空。
  function record(value: AttemptIdentity): TrustedAttempt {
    validateAttempt(value)
    const found = backend.attempt(value.call_id, value.attempt_id)
    if (!found) {
      fail('attempt_anchor_unavailable')
    }
    const result = copy(found)
    const connection = copy(backend.connection())
    if (connection.authenticated !== true || connection.active !== true) {
      fail('authentication_required')
    }
    assertBinding({ ...connection, ...value }, result.binding)
    if (result.binding.target.machine_id !== result.binding.machine_id) {
      fail('target_machine_mismatch')
    }
    if (
      result.method !== result.native_request.method ||
      !result.principal_id ||
      Object.hasOwn(result.native_request, 'id') ||
      Object.hasOwn(result.native_request, 'auth')
    ) {
      fail('invalid_attempt_record')
    }
    if (!['strict', 'raw-contract'].includes(result.mode) || !['rpc', 'stream'].includes(result.transport)) {
      fail('invalid_attempt_record')
    }
    if (result.transport === 'stream') {
      id(result.stream_id)
      let methods: readonly string[] = []
      if (result.feature === 'events') {
        methods = ['events.subscribe', 'terminal.backend.events.subscribe']
      } else if (result.feature === 'terminal_observe') {
        methods = ['terminal.backend.observe']
      } else if (result.feature === 'terminal_control') {
        methods = ['terminal.backend.control']
      }
      if (!methods.includes(result.method)) {
        fail('attempt_transport_mismatch')
      }
    } else if (result.feature !== undefined || result.stream_id !== undefined) {
      fail('attempt_transport_mismatch')
    }
    return result
  }

  // 要求网关和本机配置完全相同，再向 Wire 提供 provider 绑定。
  function provider(target: V2Target): ProviderBinding | undefined {
    const gateway = backend.provider(copy(target))
    const local = backend.localProvider(copy(target))
    if (!gateway || !local || boundedJson(gateway) !== boundedJson(local)) {
      fail('provider_binding_mismatch')
    }
    return copy(gateway)
  }

  // 交叉核对固定契约、provider 与宿主独立认证的原生来源，构造可信原生绑定。
  function source(
    attempt: Omit<TrustedAttempt, 'native_request'>,
    ctx: AuthenticatedContext
  ): { source: TrustedNativeContext; registry: NativeContractRecord } {
    providerFor(attempt.binding, ctx)
    const registry = backend.contract(attempt.binding.contract_ref)
    if (!registry || contractRef(registry.wire.source) !== attempt.binding.contract_ref) {
      fail('contract_binding_mismatch')
    }
    const origin = registry.wire.source
    if (
      registry.compiled.identity.binary_sha256 !== origin.binary_sha256 ||
      registry.compiled.identity.schema_sha256 !== origin.schema_sha256
    ) {
      fail('contract_binding_mismatch')
    }
    const target = attempt.binding.target
    const binding: NativeBinding = {
      kind: 'luvus',
      provider_id: target.provider_id,
      binding_revision: attempt.binding.binding_revision,
      contract_source_ref: attempt.binding.contract_ref,
      target:
        target.profile === 'host'
          ? { machine_id: target.machine_id, profile: 'host' }
          : { machine_id: target.machine_id, profile: 'session', session: target.session },
      server_generation: origin.runtime_generation,
      connection_epoch: attempt.binding.connection_epoch,
      recovery_generation: attempt.binding.recovery_generation,
      capability_revision: registry.capability_revision,
      caller_policy_revision: attempt.binding.registration.caller_policy_revision,
      local_policy_revision: attempt.binding.registration.local_policy_revision,
      classification_revision: origin.classification_revision!,
      contract: registry.compiled.identity
    }
    // 原生 endpoint/身份实证必须独立查询，不能把 wire 的自报 binding 转成两个 true。
    const proven = backend.nativeSource(attempt.binding.call_id, attempt.binding.attempt_id)
    if (!proven || proven.authenticated !== true || proven.source_verified !== true) {
      fail('native_source_untrusted')
    }
    if (boundedJson(proven.binding) !== boundedJson(binding)) {
      fail('native_identity_mismatch')
    }
    return {
      registry,
      source: copy({ authenticated: proven.authenticated, source_verified: proven.source_verified, binding })
    }
  }

  // 为当前消息方向构造认证上下文，仅在响应方向解析已密封的 RPC 句柄。
  function context(direction: Direction, principal?: string): AuthenticatedContext {
    const ctx: AuthenticatedContext = {
      phase: 'authenticated',
      direction,
      connection: copy(backend.connection()),
      ...(principal ? { policies: copy(backend.policies(principal)) } : {}),
      resolveProvider: provider,
      // 从宿主固定契约注册表解析 Wire 来源，不接受消息自报契约。
      resolveContract: (ref) => backend.contract(ref)?.wire,
      validators: { luvus: validator },
      // 响应方向优先解析仅响应句柄，其它路径必须回到原请求账本并复核完整绑定。
      resolveAttempt: (value) => {
        const response = responseStates.get(key(value))
        if (response) {
          if (direction !== 'connector_to_gateway') {
            fail('response_context_not_executable')
          }
          assertBinding({ ...ctx.connection, ...value }, response.attempt.binding)
          refreshResponse(response)
          ctx.policies = copy(backend.policies(response.attempt.principal_id))
          return {
            binding: copy(response.attempt.binding),
            method: response.attempt.method,
            mode: response.attempt.mode,
            transport: 'rpc',
            native_handle: response.handle
          }
        }
        const resolved = resolve(value)
        const state = states.get(key(value))!
        ctx.policies = copy(backend.policies(state.attempt.principal_id))
        return resolved
      },
      // 按执行或密封状态核对独立来源，再返回该状态私有的来源令牌。
      resolveNativeSource: (binding) => {
        const response = responseStates.get(key(binding))
        if (response) {
          assertBinding(binding, response.attempt.binding)
          refreshResponse(response)
          return response.sourceToken
        }
        const state = states.get(key(binding))
        if (!state) {
          fail('native_handle_unavailable')
        }
        assertBinding(binding, state.attempt.binding)
        refresh(state)
        return state.sourceToken
      }
    }
    return ctx
  }

  // 重新读取原尝试并核对来源与能力快照，拒绝缓存建立后的身份或原文修改。
  function refresh(state: State) {
    const attempt = record(attemptIdentity(state.attempt.binding))
    if (boundedJson(attempt) !== boundedJson(state.attempt)) {
      fail('attempt_binding_mismatch')
    }
    const ctx = context('gateway_to_connector', attempt.principal_id)
    const current = source(attempt, ctx)
    if (
      boundedJson(current.source) !== boundedJson(state.source) ||
      boundedJson(current.registry.capabilities) !== boundedJson(state.validatorCaps)
    ) {
      fail('capability_stale')
    }
    return { ctx, current, attempt }
  }

  // 按真实账本建立或复核有界执行缓存，缓存原锚点期限并返回私有原生句柄。
  function resolve(value: AttemptIdentity): ResolvedAttempt {
    const attempt = record(value)
    const ctx = context('gateway_to_connector', attempt.principal_id)
    const current = source(attempt, ctx)
    let state = states.get(key(value))
    remember(key(value))
    if (!state) {
      if (states.size + responseStates.size >= limits.attempts) {
        fail('adapter_limit')
      }
      const native = createNativeValidator(current.registry.compiled)
      const view = unwrap(native.bindCapabilities(current.registry.capabilities, current.source))
      const anchor = attempt.transport === 'rpc' ? backend.responseAnchor?.(attempt.binding) : undefined
      if (anchor) {
        assertBinding(anchor.binding, attempt.binding)
        uint(anchor.content_expires_at, true)
        uint(anchor.dedup_expires_at, true)
        if (anchor.method !== attempt.method || anchor.mode !== attempt.mode) {
          fail('attempt_binding_mismatch')
        }
      }
      const retention = anchor
        ? { content_expires_at: anchor.content_expires_at, dedup_expires_at: anchor.dedup_expires_at }
        : undefined
      const snapshotBytes =
        2 *
        Buffer.byteLength(
          boundedJson({
            attempt,
            ...(retention ? { retention } : {}),
            source: current.source,
            capabilities: current.registry.capabilities
          })
        )
      reserve(snapshotBytes)
      state = {
        attempt,
        validator: native,
        view,
        source: current.source,
        handle: Object.freeze({}),
        sourceToken: Object.freeze({}),
        closed: false,
        controls: new Map(),
        validatorCaps: copy(current.registry.capabilities),
        snapshotBytes,
        retention
      }
      states.set(key(value), state)
      handles.set(state.handle, state)
    }
    refresh(state)
    return {
      binding: copy(state.attempt.binding),
      method: attempt.method,
      mode: attempt.mode,
      transport: attempt.transport,
      ...(attempt.feature ? { feature: attempt.feature, stream_id: attempt.stream_id } : {}),
      native_handle: state.handle
    }
  }

  // 根据私有句柄及完整 Wire 上下文取得同一执行状态，拒绝复制或跨尝试句柄。
  function stateFor(c: NativeValidationContext): State {
    if (!c.native_handle || typeof c.native_handle !== 'object') {
      fail('native_handle_unavailable')
    }
    const state = handles.get(c.native_handle)
    if (!state) {
      fail('native_handle_mismatch')
    }
    remember(key(state.attempt.binding))
    assertBinding(c.binding, state.attempt.binding)
    if (
      c.method !== state.attempt.method ||
      c.mode !== state.attempt.mode ||
      c.transport !== state.attempt.transport ||
      c.feature !== state.attempt.feature ||
      c.stream_id !== state.attempt.stream_id
    ) {
      fail('attempt_binding_mismatch')
    }
    refresh(state)
    if (state.closed) {
      fail('stream_closed')
    }
    return state
  }

  // 从当前双端策略和宿主权限构造原生派发授权，不继承旧的读取权限。
  function authorization(state: State): DispatchAuthorization {
    const { ctx, attempt } = refresh(state)
    const binding = state.source.binding
    if (
      ctx.policies!.caller.revision !== binding.caller_policy_revision ||
      ctx.policies!.local.revision !== binding.local_policy_revision
    ) {
      fail('policy_revision_stale')
    }
    // 只投影当前完整 Target 上的 dispatch grants；流 input 和结果读取另过各自门禁。
    const project = (side: ProviderPolicies['caller']) => ({
      machines: [binding.target.machine_id],
      sessions: binding.target.profile === 'session' ? [binding.target.session] : [],
      methods: side.grants
        .filter(
          /* 只保留目标完全相同且含 dispatch 动作的当前 grant。 */ (g) =>
            boundedJson(g.target) === boundedJson(attempt.binding.target) && g.actions.includes('dispatch')
        )
        .flatMap(/* 展开当前目标已授权的原生方法，供双端方法集合校验。 */ (g) => g.methods)
        .filter(/* 去除双端策略投影中的重复方法，保持方法集合稳定。 */ (m, i, all) => all.indexOf(m) === i),
      host: binding.target.profile === 'host'
    })
    return {
      ...copy(backend.authority(copy(attempt), binding)),
      source: state.source,
      principal_id: attempt.principal_id,
      now: time(),
      caller_policy: project(ctx.policies!.caller),
      local_policy: project(ctx.policies!.local),
      mode: attempt.mode === 'raw-contract' ? 'raw_contract' : 'strict'
    }
  }

  // 只允许消息使用已登记的原请求正文及原生 ID，随后缓存真实校验候选。
  function candidate(request: JsonObject, state: State): DispatchCandidate {
    const expected = {
      ...state.attempt.native_request,
      id: state.attempt.binding.native_request_id
    }
    if (boundedJson(request) !== boundedJson(expected)) {
      fail('attempt_request_mismatch')
    }
    return (state.candidate ??= unwrap(state.validator.checkRawRequest(state.view, request)))
  }

  // 要求已存在真实派发许可，不从消息或响应反向创建执行能力。
  function permit(state: State): DispatchPermit {
    if (!state.permit) {
      fail('dispatch_permit_unavailable')
    }
    return state.permit
  }

  // 合法 input 先登记独立候选；其派发许可仍由 checkDispatch 按当前授权建立。
  function validateControlFrame(frame: JsonObject, state: State): void {
    if (!state.stream) {
      fail('stream_not_ready')
    }
    const checked = unwrap(state.validator.checkControl(state.stream, frame))
    const nativeId = frame.id as string
    const previous = state.controls.get(nativeId)
    const json = boundedJson(frame)
    if (nativeId === state.attempt.binding.native_request_id || (previous && previous.frame !== json)) {
      fail('native_id_conflict')
    }
    if (!previous && state.controls.size >= limits.control_ids) {
      fail('adapter_limit')
    }
    if (!previous) {
      const bytes = 2 * Buffer.byteLength(json)
      reserve(bytes)
      state.snapshotBytes += bytes
      state.controls.set(nativeId, { frame: json, candidate: checked })
    }
  }

  // 开流 ack、input ack 和事件分别关联各自的 permit/stream，不能互相借用。
  function validateStreamOutput(frame: JsonObject, state: State): void {
    if (Object.hasOwn(frame, 'id')) {
      if (frame.id === state.attempt.binding.native_request_id) {
        const json = hash(boundedJson(frame))
        if (state.ack && state.ack !== json) {
          fail('native_ack_conflict')
        }
        const ack = unwrap(state.validator.checkResponse(permit(state), frame, state.source))
        if (Object.hasOwn(frame, 'result')) {
          state.stream ??= unwrap(state.validator.openStream(permit(state), ack))
        }
        state.ack ??= json
      } else {
        const input = state.controls.get(frame.id as string)
        if (!state.stream || !input?.permit) {
          fail('control_ack_unbound')
        }
        unwrap(state.validator.checkResponse(input.permit, frame, state.source))
      }
    } else {
      if (!state.stream) {
        fail('stream_not_ready')
      }
      unwrap(state.validator.checkEvent(state.stream, frame, state.source))
    }
  }

  const validator = Object.freeze<NativePayloadValidator>({
    // 把真实原生请求候选的分类与 schema 结果提供给 Wire 请求门禁。
    requestGate(request, c) {
      const state = stateFor(c)
      const gate = unwrap(inspectRequestGate(candidate(request, state), authorization(state)))
      return {
        ...gate,
        schema_status: gate.schema_status === 'incomplete' ? 'generic' : gate.schema_status
      }
    },

    // 执行当前双端原生派发授权，并保留首次生成的真实许可用于响应绑定。
    validateRequest(request, c) {
      const state = stateFor(c)
      const checked = unwrap(checkDispatch(candidate(request, state), authorization(state)))
      // 编解码/重组会重复验证；保留第一份 permit，ack 不能改用另一份后发许可。
      state.permit ??= checked
    },

    // 按私有句柄选择执行许可或密封响应约束，均复核来源令牌；密封校验不会恢复派发或读取能力。
    validateResponse(response, c) {
      const retained =
        c.native_handle && typeof c.native_handle === 'object' ? responseHandles.get(c.native_handle) : undefined
      if (retained) {
        assertBinding(c.binding, retained.attempt.binding)
        if (
          c.method !== retained.attempt.method ||
          c.mode !== retained.attempt.mode ||
          c.transport !== 'rpc' ||
          c.feature !== undefined ||
          c.stream_id !== undefined
        ) {
          fail('attempt_binding_mismatch')
        }
        refreshResponse(retained)
        if (c.trusted_source !== retained.sourceToken) {
          fail('native_source_untrusted')
        }
        unwrap(retained.validator.checkResponseOnly(retained.sealed, response, retained.source))
        return
      }
      const state = stateFor(c)
      if (c.trusted_source !== state.sourceToken) {
        fail('native_source_untrusted')
      }
      unwrap(state.validator.checkResponse(permit(state), response, state.source))
    },

    // 按输入或输出方向选择控制帧及流事件校验，并核对独立来源令牌。
    validateStreamFrame(frame, c) {
      const state = stateFor(c)
      if (c.trusted_source !== state.sourceToken) {
        fail('native_source_untrusted')
      }
      if (c.direction === 'input') {
        validateControlFrame(frame, state)
      } else {
        validateStreamOutput(frame, state)
      }
    },

    // 针对当前控制输入重新检查 stream_input 权限及原生授权，保存该输入的独立许可。
    checkDispatch(frame, c) {
      const state = stateFor(c)
      const { ctx } = refresh(state)
      assertProviderAccess(state.attempt.binding, state.attempt.method, 'stream_input', ctx)
      const input = state.controls.get(frame.id as string)
      if (!input || input.frame !== boundedJson(frame)) {
        fail('native_control_invalid')
      }
      const checked = unwrap(checkDispatch(input.candidate, authorization(state)))
      input.permit ??= checked
    }
  })
  // 处理已认证的 stream_close，标记关闭并清除未再可用的控制项。
  function close(frame: WireEnvelope): void {
    if (frame.type !== 'stream_close' || !('connection_epoch' in frame)) {
      return
    }
    const name = key(frame.payload.attempt)
    const state = states.get(name)
    if (state) {
      remember(name)
      state.closed = true
      state.controls.clear()
    }
  }

  // 执行态按当前主体、分类和内容权限检查读取；仅响应态核对绑定与主体后始终拒绝内容读取。
  // 流读取必须指定原生帧；控制确认使用对应输入许可，事件核对原生流，开流确认沿用原许可。
  function result(binding: AttemptBinding, nativeFrame?: JsonObject): void {
    const response = responseStates.get(key(binding))
    if (response) {
      assertBinding(binding, response.attempt.binding)
      if (backend.currentPrincipal() !== response.attempt.principal_id) {
        fail('forbidden')
      }
      fail('content_unavailable')
    }
    const state = states.get(key(binding))
    if (!state) {
      fail('dispatch_permit_unavailable')
    }
    assertBinding(binding, state.attempt.binding)
    const { ctx } = refresh(state)
    const principal = backend.currentPrincipal()
    if (principal !== state.attempt.principal_id) {
      fail('forbidden')
    }
    const authority = authorization(state)
    const status = backend.contentStatus(binding)
    let granted = permit(state)
    if (!state.candidate) {
      fail('dispatch_permit_unavailable')
    }
    let candidate = state.candidate
    if (state.attempt.transport === 'stream' && nativeFrame === undefined) {
      fail('result_selector_required')
    }
    if (nativeFrame !== undefined) {
      const frame = object(copy(nativeFrame, LIMITS.object_bytes))
      if (state.attempt.transport === 'stream' && !Object.hasOwn(frame, 'id')) {
        if (!state.stream) {
          fail('stream_not_ready')
        }
        unwrap(state.validator.checkEvent(state.stream, frame, state.source))
      } else {
        if (frame.id !== binding.native_request_id) {
          const input = state.controls.get(frame.id as string)
          if (!state.stream || !input?.permit) {
            fail('control_ack_unbound')
          }
          candidate = input.candidate
          granted = input.permit
        }
        unwrap(state.validator.checkResponse(granted, frame, state.source))
      }
    }
    const gate = unwrap(inspectRequestGate(candidate, authority))
    if (gate.classification_status !== 'trusted_complete') {
      fail('classification_unavailable')
    }
    if (!gate.secret_result_authorized) {
      fail('secret_boundary_required')
    }
    if (status === 'unavailable') {
      fail('content_unavailable')
    }
    // 原派发 permit 不能替代当前读取授权，也不能让过期/丢弃的内容重新可见。
    const allowed = providerScopeAllowed(binding, state.attempt.method, 'read', ctx.policies)
    unwrap(
      checkResultBoundary(granted, {
        principal_id: principal,
        caller_policy_allowed: allowed,
        local_policy_allowed: allowed,
        classification_source_verified: authority.classification_source_verified,
        classification_revision: state.source.binding.classification_revision,
        channel: authority.result_channel,
        content_status: status
      })
    )
  }

  const api = {
    // 按当前认证上下文解码完整 Wire 帧，并同步成功的流关闭状态。
    decode(input: string | Uint8Array, direction: Direction): WireEnvelope {
      const checked = decodeWireFrame(input, context(direction))
      close(checked)
      return checked
    },

    // 复制并完整校验待编码帧后生成 Wire 文本，同步流关闭状态。
    encode(frame: WireEnvelope, direction: Direction): string {
      const snapshot = copy(frame)
      const raw = encodeWireFrame(snapshot, context(direction))
      close(snapshot)
      return raw
    },

    // 对重组后的对象再次执行 Wire 和原生校验，再同步流关闭状态。
    decodeObject(input: Uint8Array, direction: Direction) {
      const checked = decodeWireObject(input, context(direction))
      close(checked)
      return checked
    },

    // 按方向和连接维护逐对象组装器，固定首片期限、总预约和 ID 墓碑，完成后执行完整对象校验。
    acceptChunk(input: string | Uint8Array, direction: Direction) {
      const ctx = context(direction)
      const frame = decodeWireFrame(input, ctx)
      if (frame.type !== 'object_chunk' || !('connection_epoch' in frame)) {
        fail('invalid_chunk')
      }
      const stamp = boundedJson(ctx.connection)
      const now = time()
      let entry = assemblers.get(direction)
      if (!entry || entry.connection !== stamp) {
        entry = { connection: stamp, machine: ctx.connection.machine_id, objects: new Map(), reserved: 0 }
        assemblers.set(direction, entry)
      }
      let slot = entry.objects.get(frame.payload.object_id)
      if (slot && !slot.assembler) {
        fail('object_closed')
      }
      if (!slot) {
        if (frame.payload.index !== 0) {
          fail('chunk_out_of_order')
        }
        let active = 0
        for (const value of entry.objects.values()) {
          if (value.assembler) {
            active++
          }
        }
        if (
          active >= LIMITS.transfers ||
          entry.objects.size >= LIMITS.dedup_entries ||
          entry.reserved + frame.payload.total_bytes > LIMITS.buffered_bytes
        ) {
          fail('object_capacity')
        }
        slot = {
          assembler: new ObjectAssembler(),
          expires: now + LIMITS.transfer_timeout_ms,
          reserved: frame.payload.total_bytes
        }
        entry.objects.set(frame.payload.object_id, slot)
        entry.reserved += slot.reserved
      }
      const assembler = slot.assembler!
      try {
        const completed = assembler.push(frame, ctx, now)
        if (completed?.kind === 'envelope') {
          close(completed.envelope)
        }
        return completed
      } finally {
        if (assembler.activeTransfers === 0) {
          closeAssembly(entry, slot, now)
        }
      }
    },
    checkResult: result,
    // 校验流消息并推进尝试的 Wire 生命周期，错误类型不能留下原生许可。
    advanceStream(frame: AuthenticatedEnvelope, direction: Direction) {
      const snapshot = copy(frame, LIMITS.object_bytes)
      const ctx = context(direction)
      const checked = decodeWireObject(Buffer.from(boundedJson(snapshot, LIMITS.object_bytes)), ctx)
      if (!['stream_open', 'stream_data', 'stream_input', 'stream_close'].includes(checked.type)) {
        fail('invalid_stream_transition')
      }
      const attempt = (checked.payload as PayloadWithAttempt).attempt
      const state = states.get(key(attempt))
      if (!state) {
        fail('attempt_anchor_unavailable')
      }
      state.wireStream = advanceStream(state.wireStream, checked, ctx)
      close(checked)
      return copy(state.wireStream)
    },

    // 按方向与连接维护消息去重窗口，冲突时由外层原子包装回滚新许可。
    observeMessage(frame: AuthenticatedEnvelope, direction: Direction) {
      const ctx = context(direction)
      const stamp = boundedJson(ctx.connection)
      let entry = windows.get(direction)
      if (!entry || entry.connection !== stamp) {
        entry = { connection: stamp, window: new MessageWindow() }
        windows.set(direction, entry)
      }
      return entry.window.observe(copy(frame, LIMITS.object_bytes), ctx, time())
    },

    // 基于原锚点生成可信响应证据；密封上下文强制仅保留元数据且不授权内容交付。
    planEvidence(frame: Extract<AuthenticatedEnvelope, { type: 'response' }>) {
      const snapshot = copy(frame, LIMITS.object_bytes)
      const retained = responseStates.get(key(snapshot.payload.attempt))
      if (retained) {
        refreshResponse(retained)
        return planResponseEvidence(
          snapshot,
          context('connector_to_gateway'),
          backend.responseAnchor?.(retained.attempt.binding),
          time(),
          { classification_status: 'trusted_complete', retain_content_authorized: false }
        )
      }
      const attempt = record(snapshot.payload.attempt)
      const ctx = context('connector_to_gateway')
      const state = states.get(key(attempt.binding))
      if (!state) {
        fail('dispatch_permit_unavailable')
      }
      let retain = false
      try {
        result(attempt.binding, snapshot.payload.native_response)
        unwrap(checkResultRetention(permit(state), authorization(state)))
        retain = true
      } catch {
        /* 撤权/过期/禁存仍允许可信最小证据。 */
      }
      return planResponseEvidence(snapshot, ctx, backend.responseAnchor?.(attempt.binding), time(), {
        classification_status: 'trusted_complete',
        retain_content_authorized: retain
      })
    },

    // 释放指定尝试的适配器缓存与预算；仅响应分支同时撤销密封登记，执行分支仅移除缓存关联。
    release(binding: AttemptBinding) {
      const response = responseStates.get(key(binding))
      if (response) {
        assertBinding(binding, response.attempt.binding)
        dropResponse(key(binding))
        return
      }
      const state = states.get(key(binding))
      if (!state) {
        return
      }
      remember(key(binding))
      assertBinding(binding, state.attempt.binding)
      retainedBytes -= state.snapshotBytes
      handles.delete(state.handle)
      states.delete(key(binding))
    }
  }

  unsubscribe = backend.subscribeInvalidation?.(invalidate)
  if (!closed) {
    maintenance = setInterval(
      // 即使账本清理提交失败，空闲适配器也按可信时钟回收原文；无法可信维护时销毁全部上下文。
      () => {
        try {
          maintain()
        } catch {
          invalidate({ kind: 'closed' })
        }
      },
      maintenanceInterval
    )
    maintenance.unref()
  }
  return Object.freeze({
    maintain: guarded(maintain),
    // 标记关闭并停维护、退订及清空缓存；校验中调用时，实体回收延至外层操作结束。
    close: () => invalidate({ kind: 'closed' }),
    // 仅返回上下文数量、快照计量及关闭状态，不暴露请求、响应或身份内容。
    stats: () => ({
      executions: states.size,
      responses: responseStates.size,
      snapshot_bytes: retainedBytes,
      ...transferStats(),
      closed
    }),
    decode: guarded(atomic(api.decode)),
    encode: guarded(atomic(api.encode)),
    decodeObject: guarded(atomic(api.decodeObject)),
    acceptChunk: guarded(atomic(api.acceptChunk)),
    checkResult: guarded(atomic(api.checkResult)),
    advanceStream: guarded(atomic(api.advanceStream)),
    observeMessage: guarded(atomic(api.observeMessage)),
    planEvidence: guarded(atomic(api.planEvidence)),
    release: guarded(atomic(api.release))
  })
}

type PayloadWithAttempt = { attempt: AttemptIdentity }
