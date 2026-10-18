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
// Store v3 不满足本接口；#5 提供可信持久化 resolver 前，本模块只是可测试的接入边界。
export interface NativeWireBackend {
  connection(): AuthenticatedContext['connection']
  attempt(callId: string, attemptId: string): TrustedAttempt | undefined
  provider(target: V2Target): ProviderBinding | undefined
  localProvider(target: V2Target): ProviderBinding | undefined
  contract(ref: string): NativeContractRecord | undefined
  nativeSource(callId: string, attemptId: string): TrustedNativeContext | undefined
  policies(principal: string): ProviderPolicies
  authority(attempt: TrustedAttempt, binding: NativeBinding): Authority
  currentPrincipal(): string | undefined
  now(): number
  contentStatus(binding: AttemptBinding): 'available' | 'expired' | 'discarded' | 'unavailable'
  responseAnchor?(binding: AttemptBinding): ResponseAnchor | undefined
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
  controls: Map<string, { frame: string; candidate: CheckedControl; permit?: DispatchPermit }>
}
const copy = <T>(value: T, maxBytes: number = LIMITS.frame_bytes): T => JSON.parse(boundedJson(value, maxBytes)) as T

function unwrap<T>(result: Check<T>): T {
  if (!result.ok) {
    fail(result.error.code)
  }
  return result.value
}

function guarded<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return (...args) => {
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
const key = (value: AttemptIdentity) => value.call_id + ':' + value.attempt_id

function attemptIdentity(binding: AttemptBinding): AttemptIdentity {
  const { machine_id: _machine, recovery_generation: _recovery, connection_epoch: _epoch, ...attempt } = binding
  return attempt
}

export function createLuvusWireAdapter(
  backend: NativeWireBackend,
  limits: { attempts: number; control_ids: number; snapshot_bytes?: number } = {
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
  let retainedBytes = 0

  // 计量保留 JSON 快照；不把此计量冒称 JS heap/worker 的硬内存隔离。
  function reserve(bytes: number): void {
    if (retainedBytes + bytes > snapshotLimit) {
      fail('adapter_limit')
    }
    retainedBytes += bytes
  }
  const states = new Map<string, State>()
  const handles = new WeakMap<object, State>()
  const assemblers = new Map<Direction, { connection: string; assembler: ObjectAssembler }>()
  const windows = new Map<Direction, { connection: string; window: MessageWindow }>()

  let undo: Map<string, State | undefined> | undefined
  function remember(name: string): void {
    if (!undo || undo.has(name)) {
      return
    }
    const state = states.get(name)
    undo.set(
      name,
      state && {
        ...state,
        controls: new Map([...state.controls].map(([nativeId, input]) => [nativeId, { ...input }]))
      }
    )
  }

  // codec/native 回调可能先改状态，后续 envelope、序号或去重检查才失败。
  // 只回滚本次触及的 attempt；此前成功操作及其 permit 仍保留。
  function atomic<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args) => {
      if (undo) {
        fail('native_adapter_unavailable')
      }
      const pending = new Map<string, State | undefined>()
      const before = retainedBytes
      undo = pending
      try {
        return fn(...args)
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
      }
    }
  }

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

  function provider(target: V2Target): ProviderBinding | undefined {
    const gateway = backend.provider(copy(target))
    const local = backend.localProvider(copy(target))
    if (!gateway || !local || boundedJson(gateway) !== boundedJson(local)) {
      fail('provider_binding_mismatch')
    }
    return copy(gateway)
  }

  function source(
    attempt: TrustedAttempt,
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
    return { registry, source: copy(proven) }
  }

  function context(direction: Direction, principal?: string): AuthenticatedContext {
    const ctx: AuthenticatedContext = {
      phase: 'authenticated',
      direction,
      connection: copy(backend.connection()),
      ...(principal ? { policies: copy(backend.policies(principal)) } : {}),
      resolveProvider: provider,
      resolveContract: (ref) => backend.contract(ref)?.wire,
      validators: { luvus: validator },
      resolveAttempt: (value) => {
        const resolved = resolve(value)
        const state = states.get(key(value))!
        ctx.policies = copy(backend.policies(state.attempt.principal_id))
        return resolved
      },
      resolveNativeSource: (binding) => {
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

  function resolve(value: AttemptIdentity): ResolvedAttempt {
    const attempt = record(value)
    const ctx = context('gateway_to_connector', attempt.principal_id)
    const current = source(attempt, ctx)
    let state = states.get(key(value))
    remember(key(value))
    if (!state) {
      if (states.size >= limits.attempts) {
        fail('adapter_limit')
      }
      const native = createNativeValidator(current.registry.compiled)
      const view = unwrap(native.bindCapabilities(current.registry.capabilities, current.source))
      const snapshotBytes =
        2 *
        Buffer.byteLength(
          boundedJson({
            attempt,
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
        snapshotBytes
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
        .filter((g) => boundedJson(g.target) === boundedJson(attempt.binding.target) && g.actions.includes('dispatch'))
        .flatMap((g) => g.methods)
        .filter((m, i, all) => all.indexOf(m) === i),
      host: binding.target.profile === 'host'
    })
    return {
      ...copy(backend.authority(copy(attempt), binding)),
      source: state.source,
      principal_id: attempt.principal_id,
      now: backend.now(),
      caller_policy: project(ctx.policies!.caller),
      local_policy: project(ctx.policies!.local),
      mode: attempt.mode === 'raw-contract' ? 'raw_contract' : 'strict'
    }
  }

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
    requestGate(request, c) {
      const state = stateFor(c)
      const gate = unwrap(inspectRequestGate(candidate(request, state), authorization(state)))
      return {
        ...gate,
        schema_status: gate.schema_status === 'incomplete' ? 'generic' : gate.schema_status
      }
    },

    validateRequest(request, c) {
      const state = stateFor(c)
      const checked = unwrap(checkDispatch(candidate(request, state), authorization(state)))
      // 编解码/重组会重复验证；保留第一份 permit，ack 不能改用另一份后发许可。
      state.permit ??= checked
    },

    validateResponse(response, c) {
      const state = stateFor(c)
      if (c.trusted_source !== state.sourceToken) {
        fail('native_source_untrusted')
      }
      unwrap(state.validator.checkResponse(permit(state), response, state.source))
    },

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

  // RPC 只有原请求；stream 必须给出实际待交付的原生响应/事件，不能隐式借开流许可。
  function result(binding: AttemptBinding, nativeFrame?: JsonObject): void {
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
    decode(input: string | Uint8Array, direction: Direction): WireEnvelope {
      const checked = decodeWireFrame(input, context(direction))
      close(checked)
      return checked
    },

    encode(frame: WireEnvelope, direction: Direction): string {
      const snapshot = copy(frame)
      const raw = encodeWireFrame(snapshot, context(direction))
      close(snapshot)
      return raw
    },

    decodeObject(input: Uint8Array, direction: Direction) {
      const checked = decodeWireObject(input, context(direction))
      close(checked)
      return checked
    },

    acceptChunk(input: string | Uint8Array, direction: Direction) {
      const ctx = context(direction)
      const frame = decodeWireFrame(input, ctx)
      if (frame.type !== 'object_chunk' || !('connection_epoch' in frame)) {
        fail('invalid_chunk')
      }
      const stamp = boundedJson(ctx.connection)
      let entry = assemblers.get(direction)
      if (!entry || entry.connection !== stamp) {
        entry = { connection: stamp, assembler: new ObjectAssembler() }
        assemblers.set(direction, entry)
      }
      const completed = entry.assembler.push(frame, ctx, backend.now())
      if (completed?.kind === 'envelope') {
        close(completed.envelope)
      }
      return completed
    },
    checkResult: result,
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

    observeMessage(frame: AuthenticatedEnvelope, direction: Direction) {
      const ctx = context(direction)
      const stamp = boundedJson(ctx.connection)
      let entry = windows.get(direction)
      if (!entry || entry.connection !== stamp) {
        entry = { connection: stamp, window: new MessageWindow() }
        windows.set(direction, entry)
      }
      return entry.window.observe(copy(frame, LIMITS.object_bytes), ctx, backend.now())
    },

    planEvidence(frame: Extract<AuthenticatedEnvelope, { type: 'response' }>) {
      const snapshot = copy(frame, LIMITS.object_bytes)
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
      return planResponseEvidence(snapshot, ctx, backend.responseAnchor?.(attempt.binding), backend.now(), {
        classification_status: 'trusted_complete',
        retain_content_authorized: retain
      })
    },

    release(binding: AttemptBinding) {
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

  return Object.freeze({
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
