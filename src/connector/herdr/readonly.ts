/** Herdr 首切片的原生编解码与 Wire 接缝；共享 candidate 门禁仍负责阻止生产派发。 */
import type { NativeWireBackend, TrustedAttempt } from '../../integration/luvus-wire.js'
import {
  assertBinding,
  assertProviderAccess,
  boundedJson,
  contractRef,
  fail,
  fields,
  object,
  parseJson,
  providerFor,
  text,
  validateAttempt,
  validateContractSource
} from '../../wire/index.js'
import type {
  AttemptBinding,
  AttemptIdentity,
  AuthenticatedContext,
  ContractRecord,
  ContractSource,
  Direction,
  JsonObject,
  NativePayloadValidator,
  NativeValidationContext,
  ResolvedAttempt
} from '../../wire/types.js'

/** 固定版本的评审范围；这是待接线切片，不能替代 registry 的 validated 或本地授权。 */
export const HERDR_READONLY_REVIEW = Object.freeze({
  version: '0.9.5',
  protocol: 22,
  binary_sha256: '14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d',
  schema_sha256: '9e2af207e9aa8183d4aeca5fde9cc48e7909bb40cdbd7cf21608a6d3ea78075b',
  adapter_revision: 'herdr-readonly-1',
  classification_revision: 'herdr-0.9.5-readonly-1',
  methods: Object.freeze(['ping']),
  protocol_methods: Object.freeze(['ping', 'session.snapshot']),
  frame_bytes: 65_536,
  guarantees: Object.freeze({
    event_recovery: 'unavailable',
    terminal_fence: 'unavailable',
    cancel: 'unavailable',
    prompt_completion: 'unavailable'
  })
})

/** 宿主从安装 schema 完整根编译的校验器；编译须先满足独立 worker 的资源门禁。 */
export interface HerdrSchemas {
  readonly binary_sha256: string
  readonly schema_sha256: string
  readonly dialect: 'https://json-schema.org/draft/2020-12/schema'
  /** 校验完整 request 根，不使用 describe 裁剪或仅 method/params 分支。 */
  request(value: JsonObject): boolean
  /** 校验原生 success_response 或 error_response 完整根，不包装成 UHP。 */
  response(value: JsonObject): boolean
}

/** 与共享 ContractRecord 共用来源和摘要，不另建 provider/设备身份。 */
export type HerdrContractRecord = { wire: ContractRecord; schemas: HerdrSchemas }

/** token 是宿主独立核对 endpoint/peer/binary 后持有的对象，不接受消息中的自报证明。 */
export type HerdrNativeSource = { binding: AttemptBinding; token: object }

/** 复用 Store attempt 与当前认证；宿主负责本地实例来源、契约编译及完整上下文。 */
export interface HerdrReadonlyBackend extends Pick<
  NativeWireBackend,
  'attempt' | 'now' | 'currentPrincipal' | 'contentStatus'
> {
  /** 每次重新读取认证和双端精确 grants；resolveProvider 须先核对 registry 与本机配置同值。 */
  context(principal: string, direction: Direction): AuthenticatedContext
  /** 只从受信 registry 取安装契约；缺少完整编译器时返回 unavailable。 */
  contract(ref: string): HerdrContractRecord | undefined
  /** 按原 attempt 独立解析本机配置及来源，实例/连接变化必须替换 token。 */
  nativeSource(binding: AttemptBinding): HerdrNativeSource | undefined
}

/** 校验固定外部来源与分类 revision；未知版本、原生 generation 或 catalog 声明均拒绝。 */
function reviewedSource(source: ContractSource, schemas: HerdrSchemas): void {
  validateContractSource(source)
  const review = HERDR_READONLY_REVIEW
  if (
    source.provider_kind !== 'herdr' ||
    source.protocol_family !== 'herdr-json' ||
    source.binary_version !== review.version ||
    source.server_version !== review.version ||
    source.native_protocol_version !== String(review.protocol) ||
    source.binary_sha256 !== review.binary_sha256 ||
    source.schema_sha256 !== review.schema_sha256 ||
    source.adapter_revision !== review.adapter_revision ||
    source.classification_revision !== review.classification_revision ||
    source.runtime_generation !== null ||
    source.support_basis !== 'schema_and_version' ||
    schemas.binary_sha256 !== source.binary_sha256 ||
    schemas.schema_sha256 !== source.schema_sha256 ||
    schemas.dialect !== 'https://json-schema.org/draft/2020-12/schema'
  ) {
    fail('herdr_contract_unreviewed')
  }
}

/** 协议回放限两个精确 RPC；snapshot 的协议可解析不表示已获执行分类。 */
function readonlyRequest(value: unknown): JsonObject {
  const request = object(parseJson(boundedJson(value, HERDR_READONLY_REVIEW.frame_bytes)))
  fields(request, ['id', 'method', 'params'])
  text(request.id, 128)
  if (!HERDR_READONLY_REVIEW.protocol_methods.includes(request.method as string)) {
    fail('herdr_method_unreviewed')
  }
  fields(object(request.params), [])
  return request
}

/** 原生协议组件可独立离线回放；它只做验证，不建立生产授权或连接。 */
export function createHerdrCodec(source: ContractSource, schemas: HerdrSchemas) {
  reviewedSource(source, schemas)
  const serverVersion = source.server_version
  const requestRoot = schemas.request
  const responseRoot = schemas.response
  return Object.freeze({
    /** 先检查精确被动参数和完整安装 schema，再生成单条有界 JSON LF。 */
    encode(request: JsonObject): Uint8Array {
      const checked = readonlyRequest(request)
      if (!requestRoot(checked)) {
        fail('herdr_native_request_invalid')
      }
      return Buffer.from(boundedJson(checked, HERDR_READONLY_REVIEW.frame_bytes - 1) + '\n')
    },
    /** EOF/超时由传输层报告；只接收单条完整原生响应，保留 result/error 和原生值。 */
    decode(bytes: Uint8Array, request: JsonObject): JsonObject {
      const checked = readonlyRequest(request)
      if (!requestRoot(checked)) {
        fail('herdr_native_request_invalid')
      }
      if (
        bytes.byteLength === 0 ||
        bytes.byteLength > HERDR_READONLY_REVIEW.frame_bytes ||
        bytes.at(-1) !== 10 ||
        bytes.subarray(0, -1).includes(10)
      ) {
        fail('herdr_native_framing')
      }
      const response = object(parseJson(bytes, HERDR_READONLY_REVIEW.frame_bytes))
      const error = Object.hasOwn(response, 'error')
      fields(response, ['id', error ? 'error' : 'result'])
      if (response.id !== checked.id || !responseRoot(response)) {
        fail('herdr_native_response_invalid')
      }
      if (error) {
        const body = object(response.error)
        text(body.code, 128)
        if (typeof body.message !== 'string') {
          fail('herdr_native_response_invalid')
        }
      } else {
        const result = object(response.result)
        const state = checked.method === 'ping' ? result : object(result.snapshot)
        if (
          result.type !== (checked.method === 'ping' ? 'pong' : 'session_snapshot') ||
          state.version !== serverVersion ||
          state.protocol !== HERDR_READONLY_REVIEW.protocol
        ) {
          fail('herdr_native_response_invalid')
        }
      }
      return response
    }
  })
}

/** 私有 attempt 状态只保存共享身份和不可序列化句柄，不缓存原生结果或重新派发队列。 */
type State = {
  key: string
  handle: object
  attempt: TrustedAttempt
  contract: HerdrContractRecord
  source: HerdrNativeSource
  sourceToken: object
  requestRoot: HerdrSchemas['request']
  responseRoot: HerdrSchemas['response']
  permitted: boolean
}

/** 生产接缝继续调用共享 provider gate；当前 main 的 Herdr candidate 硬拒绝不会被绕过。 */
export function createHerdrReadonlyAdapter(backend: HerdrReadonlyBackend) {
  const handles = new Map<object, State>()
  const states = new Map<string, State>()

  /** 只投影共享 AttemptIdentity，保留 validateAttempt 对额外字段的严格拒绝。 */
  function identityOf(binding: AttemptBinding): AttemptIdentity {
    const { machine_id: _machine, recovery_generation: _recovery, connection_epoch: _epoch, ...identity } = binding
    return identity
  }

  /** 从可信账本恢复完整身份；不使用消息构造新 attempt，不迁移旧 provider。 */
  function anchor(identity: AttemptIdentity): TrustedAttempt {
    validateAttempt(identity)
    const found = backend.attempt(identity.call_id, identity.attempt_id)
    if (!found) {
      fail('attempt_anchor_unavailable')
    }
    const attempt = JSON.parse(boundedJson(found, HERDR_READONLY_REVIEW.frame_bytes)) as TrustedAttempt
    const ctx = backend.context(attempt.principal_id, 'gateway_to_connector')
    if (!ctx.connection.authenticated || !ctx.connection.active) {
      fail('authentication_required')
    }
    assertBinding({ ...ctx.connection, ...identity }, attempt.binding)
    if (
      attempt.binding.provider_kind !== 'herdr' ||
      attempt.binding.target.profile !== 'session' ||
      attempt.binding.target.machine_id !== attempt.binding.machine_id ||
      attempt.mode !== 'strict' ||
      attempt.transport !== 'rpc' ||
      attempt.feature !== undefined ||
      attempt.stream_id !== undefined ||
      attempt.native_request.method !== attempt.method
    ) {
      fail('herdr_attempt_unsupported')
    }
    fields(object(attempt.native_request), ['method', 'params'])
    readonlyRequest({ ...attempt.native_request, id: attempt.binding.native_request_id })
    if (!HERDR_READONLY_REVIEW.methods.includes(attempt.method)) {
      fail('herdr_method_unreviewed')
    }
    return attempt
  }

  /** 核对私有句柄与完整上下文；释放旧句柄也不能改用另一条 binding。 */
  function stateFor(context: NativeValidationContext): State {
    const state = handles.get(context.native_handle as object)
    if (!state) {
      fail('native_handle_unavailable')
    }
    assertBinding(context.binding, state.attempt.binding)
    if (
      context.method !== state.attempt.method ||
      context.mode !== 'strict' ||
      context.transport !== 'rpc' ||
      context.feature !== undefined ||
      context.stream_id !== undefined
    ) {
      fail('attempt_binding_mismatch')
    }
    return state
  }

  /** 复用同一完整 binding 的句柄，但从不把旧 epoch/recovery 改写为当前身份。 */
  function resolved(state: State): ResolvedAttempt {
    return {
      binding: JSON.parse(boundedJson(state.attempt.binding)) as AttemptBinding,
      method: state.attempt.method,
      mode: 'strict',
      transport: 'rpc',
      native_handle: state.handle
    }
  }

  /** 证据只查原 permit 与当前身份/来源；派发和内容交付另查各自的当前权限。 */
  function current(context: NativeValidationContext, access: 'resolve' | 'evidence' | 'dispatch' | 'read'): State {
    const state = stateFor(context)
    const attempt = anchor(identityOf(state.attempt.binding))
    if (boundedJson(attempt) !== boundedJson(state.attempt)) {
      fail('attempt_binding_mismatch')
    }
    const ctx = backend.context(
      attempt.principal_id,
      access === 'dispatch' || access === 'resolve' ? 'gateway_to_connector' : 'connector_to_gateway'
    )
    if (access !== 'resolve') {
      providerFor(attempt.binding, ctx)
    }
    if (access === 'dispatch' || access === 'read') {
      if (backend.currentPrincipal() !== attempt.principal_id) {
        fail('attempt_binding_mismatch')
      }
      assertProviderAccess(attempt.binding, attempt.method, access, ctx)
    }
    if (
      access === 'dispatch' &&
      (ctx.policies?.caller.revision !== attempt.binding.registration.caller_policy_revision ||
        ctx.policies?.local.revision !== attempt.binding.registration.local_policy_revision)
    ) {
      fail('policy_revision_stale')
    }
    const now = backend.now()
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      (access === 'dispatch' && now >= attempt.binding.registration.deadline)
    ) {
      fail('deadline_exceeded')
    }
    const contract = backend.contract(attempt.binding.contract_ref)
    const source = backend.nativeSource(attempt.binding)
    if (
      !contract ||
      contractRef(contract.wire.source) !== attempt.binding.contract_ref ||
      boundedJson(contract.wire) !== boundedJson(state.contract.wire) ||
      contract.schemas !== state.contract.schemas ||
      contract.schemas.request !== state.requestRoot ||
      contract.schemas.response !== state.responseRoot ||
      !source ||
      source.token !== state.source.token ||
      boundedJson(source.binding) !== boundedJson(attempt.binding)
    ) {
      fail('native_source_untrusted')
    }
    reviewedSource(contract.wire.source, contract.schemas)
    return state
  }

  /** 只准备原请求；是否真正写入由共享账本的 dispatch 边界与宿主传输保证一次执行。 */
  function checkedRequest(request: JsonObject, context: NativeValidationContext) {
    const state = current(context, 'dispatch')
    const expected = { ...state.attempt.native_request, id: state.attempt.binding.native_request_id }
    if (boundedJson(request) !== boundedJson(expected)) {
      fail('attempt_request_mismatch')
    }
    const bytes = createHerdrCodec(state.contract.wire.source, state.contract.schemas).encode(request)
    return { state, bytes }
  }

  /** 仅显式准备派发时建立 permit；Wire 的纯校验回调不改变已派发状态。 */
  function encodeRequest(request: JsonObject, context: NativeValidationContext): Uint8Array {
    const { state, bytes } = checkedRequest(request, context)
    state.permitted = true
    return bytes
  }

  /** 仅验证原生响应证据；当前读取权和保留状态由 checkResult/原 Store 事务分别处理。 */
  function decodeResponse(bytes: Uint8Array, context: NativeValidationContext): JsonObject {
    const state = current(context, 'evidence')
    if (!state.permitted) {
      fail('dispatch_permit_unavailable')
    }
    return createHerdrCodec(state.contract.wire.source, state.contract.schemas).decode(bytes, {
      ...state.attempt.native_request,
      id: state.attempt.binding.native_request_id
    })
  }

  const validator: NativePayloadValidator = Object.freeze({
    /** 执行分类仅覆盖固定来源的 ping；snapshot 和事件的未知副作用保持拒绝。 */
    requestGate(request: JsonObject, context: NativeValidationContext) {
      checkedRequest(request, context)
      return {
        classification_status: 'trusted_complete' as const,
        schema_status: 'complete' as const,
        transport_status: 'supported' as const,
        authorized: true,
        // 共享字段表示结果边界校验通过；ordinary ping 不要求也不签发秘密权限。
        secret_result_authorized: true,
        raw_contract_authorized: false
      }
    },
    /** 与编解码共享相同参数、来源和策略检查，不接受从 gate 缓存出的旧许可。 */
    validateRequest(request: JsonObject, context: NativeValidationContext) {
      checkedRequest(request, context)
    },
    /** Wire 回包还须匹配宿主持有的来源 token；不能由 caller 自报原生来源。 */
    validateResponse(response: JsonObject, context: NativeValidationContext) {
      const state = current(context, 'evidence')
      if (context.trusted_source !== state.sourceToken) {
        fail('native_source_untrusted')
      }
      decodeResponse(Buffer.from(boundedJson(response) + '\n'), context)
    }
  })

  return Object.freeze({
    validator,
    encodeRequest,
    decodeResponse,
    /** 注册有界私有句柄；只有后续共享 provider/授权门禁通过才会产生原生请求。 */
    resolve(identity: AttemptIdentity): ResolvedAttempt {
      const attempt = anchor(identity)
      const key = boundedJson(attempt.binding)
      const previous = states.get(key)
      if (previous) {
        const context = resolved(previous)
        current(context, 'resolve')
        return context
      }
      if (handles.size >= 128) {
        fail('adapter_limit')
      }
      const contract = backend.contract(attempt.binding.contract_ref)
      const source = backend.nativeSource(attempt.binding)
      if (
        !contract ||
        contractRef(contract.wire.source) !== attempt.binding.contract_ref ||
        !source ||
        !source.token ||
        typeof source.token !== 'object' ||
        boundedJson(source.binding) !== boundedJson(attempt.binding)
      ) {
        fail('native_source_untrusted')
      }
      reviewedSource(contract.wire.source, contract.schemas)
      const handle = Object.freeze({})
      const state: State = {
        key,
        handle,
        attempt,
        contract: { wire: JSON.parse(boundedJson(contract.wire)) as ContractRecord, schemas: contract.schemas },
        source: { binding: JSON.parse(boundedJson(source.binding)) as AttemptBinding, token: source.token },
        sourceToken: Object.freeze({}),
        requestRoot: contract.schemas.request,
        responseRoot: contract.schemas.response,
        permitted: false
      }
      handles.set(handle, state)
      states.set(key, state)
      return resolved(state)
    },
    /** 仅给可信 Wire 证据 resolver；无需当前读者，但来源对象不能序列化或扩大交付权。 */
    trustedSource(context: NativeValidationContext): object {
      return current(context, 'evidence').sourceToken
    },
    /** 实际交付前重查 Store 的原期限/discard；解析原生响应本身不建立可读内容。 */
    checkResult(context: NativeValidationContext): void {
      const state = current(context, 'read')
      if (!state.permitted || backend.contentStatus(state.attempt.binding) !== 'available') {
        fail('content_unavailable')
      }
    },
    /** 释放桥接句柄，不关闭 pane/agent，也不向 Herdr 发送 cancel。 */
    release(context: NativeValidationContext): void {
      if (handles.has(context.native_handle as object)) {
        const state = stateFor(context)
        handles.delete(state.handle)
        states.delete(state.key)
      }
    }
  })
}
