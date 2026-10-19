/** 复用原请求读取许可和持久结果服务，逐次授权普通 Luvus RPC 的句柄、分页与显式丢弃。 */
import { GatewayError } from '../../contracts.js'
import { Router } from '../../router.js'
import type { LocalPolicies, Principal } from '../../router.js'
import type { ResultPage, Store } from '../../store.js'
import type { Call } from '../../storage/model.js'
import type { Adapter } from '../../transport/common.js'
import { DEFAULT_LIMITS, parseNativeJson } from '../../native-contract/index.js'
import { assertBinding, boundedJson, id } from '../../wire/index.js'
import type { AttemptBinding, JsonObject } from '../../wire/types.js'

export type LuvusResultMetadata = Readonly<Pick<ResultPage, 'result_id' | 'bytes' | 'hash' | 'expires'>>
export type LuvusResultPage = Readonly<ResultPage>
export type LuvusOriginalRead = Readonly<{
  binding: AttemptBinding
  /** 只消费原 Wire 的当前读取与保留门禁；旧宿主缺保留入口时仍由运行时明确拒绝创建句柄。 */
  wire: Pick<Adapter, 'checkResult'> & Partial<Pick<Adapter, 'checkResultRetention'>>
}>
export type LuvusResultAccessOptions = Readonly<{
  store: Store
  localPolicies: LocalPolicies
  /** 返回当前已认证主体，不从结果读取参数采信身份或策略。 */
  principal(): Principal
  /** 仅查找原请求持有的真实 Wire 上下文；缺失时不得从数据库或 JSON 恢复许可。 */
  resolveOriginalRead(callId: string): LuvusOriginalRead | undefined
}>

/** 拒绝异步宿主 port 并消费其晚到拒绝，防止把未完成的授权当作成功继续执行。 */
function synchronous<T>(value: T): T {
  if (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  ) {
    Promise.resolve(value).catch(/* 消费被拒绝的异步 port，不保留或回显底层错误。 */ () => {})
    throw new GatewayError('result_port_invalid')
  }
  return value
}

/** 创建无正文或期限缓存的结果访问层；所有读许可、句柄归属和期限均按实际操作重新取得。 */
export function createLuvusResultAccess(options: LuvusResultAccessOptions) {
  if (
    !options?.store ||
    typeof options.localPolicies !== 'function' ||
    typeof options.principal !== 'function' ||
    typeof options.resolveOriginalRead !== 'function'
  ) {
    throw new GatewayError('result_port_invalid')
  }
  const store = options.store

  /** 快照宿主当前认证主体；一次操作中身份切换必须失败，策略则始终使用最新快照。 */
  function principal(expectedId?: string): Principal {
    const current = JSON.parse(boundedJson(synchronous(options.principal()))) as Principal
    if (typeof current?.id !== 'string' || !current.id.trim() || !current.policy) {
      throw new GatewayError('unauthenticated')
    }
    if (expectedId !== undefined && current.id !== expectedId) {
      throw new GatewayError('unauthenticated')
    }
    return current
  }

  /** 为一次授权绑定主体快照，本地策略回调改变身份、策略或专门权限时立即拒绝。 */
  function router(reader: Principal, observe?: (policy: ReturnType<LocalPolicies>) => void): Router {
    return new Router(
      store,
      /* 先快照当前本地策略，随后核验回调没有改变本次授权所使用的完整主体事实。 */ (target) => {
        const live = synchronous(options.localPolicies(target))
        const local = JSON.parse(boundedJson(live)) as ReturnType<LocalPolicies>
        if (boundedJson(principal(reader.id)) !== boundedJson(reader)) {
          throw new GatewayError('forbidden')
        }
        observe?.(live)
        return local
      }
    )
  }

  /** 运行一次同步结果操作，将未知宿主异常收敛为不含正文或凭据的安全错误。 */
  function operation<T>(action: (principal: Principal) => T): T {
    try {
      return action(principal())
    } catch (error) {
      throw error instanceof GatewayError ? error : new GatewayError('result_unavailable')
    }
  }

  /** 按真实归属和当前双端 ACL 读取调用，仅允许本模块处理 Luvus 的结果。 */
  function call(principal: Principal, callId: string, observe?: (policy: ReturnType<LocalPolicies>) => void): Call {
    id(callId)
    router(principal, observe).get(principal, callId)
    // Router 在读取调用后才执行策略回调；回调可能同步提交丢弃或清理，因此不能返回其旧正文快照。
    const value = store.call(principal.id, callId)
    if (value.provider_kind !== 'luvus') {
      throw new GatewayError('provider_kind_mismatch')
    }
    return value
  }

  /** 仅转接原 Wire 的当前读取及独立保留门禁，不从分类 JSON 或持久数据恢复原 permit。 */
  function nativeResult(
    original: LuvusOriginalRead,
    binding: AttemptBinding,
    response: JsonObject,
    retain: boolean
  ): void {
    if (synchronous(original.wire.checkResult(binding, response)) !== undefined) {
      throw new GatewayError('result_port_invalid')
    }
    if (retain) {
      if (typeof original.wire.checkResultRetention !== 'function') {
        throw new GatewayError('result_retention_context_unavailable')
      }
      if (synchronous(original.wire.checkResultRetention(binding, response)) !== undefined) {
        throw new GatewayError('result_port_invalid')
      }
    }
  }

  /** 用原始完整 binding 关联 Store 锚点，并对保存的完整响应执行原许可及当前原生读取门禁。 */
  function readable(reader: Principal, callId: string, retain = false): Call {
    const current = call(principal(reader.id), callId)
    if (current.state !== 'responded' || current.content_status !== 'available' || current.response === null) {
      throw new GatewayError('result_not_ready')
    }
    const original = synchronous(options.resolveOriginalRead(callId))
    if (!original || typeof original.wire?.checkResult !== 'function') {
      throw new GatewayError('result_context_unavailable')
    }
    const binding = JSON.parse(boundedJson(original.binding)) as AttemptBinding
    if (binding.call_id !== callId || binding.provider_kind !== 'luvus') {
      throw new GatewayError('attempt_binding_mismatch')
    }
    assertBinding(binding, store.responseAnchor(binding).binding)
    if (Buffer.byteLength(current.response) > DEFAULT_LIMITS.object_bytes) {
      throw new GatewayError('native_response_invalid')
    }
    const response = parseNativeJson(Buffer.from(current.response))
    if (!response.ok || !response.value || typeof response.value !== 'object' || Array.isArray(response.value)) {
      throw new GatewayError('native_response_invalid')
    }
    nativeResult(original, binding, response.value as JsonObject, retain)
    // 宿主读取门禁可能更新当前事实；返回前再次核对双端 ACL，且整段流程没有 await。
    const finalReader = principal(reader.id)
    let local: { value: ReturnType<LocalPolicies>; stamp: string } | undefined
    const final = call(
      finalReader,
      callId,
      /* 仅保存本次授权的活策略值及摘要，供末次原生门禁返回后同步检查；不跨操作保留。 */ (value) => {
        local = { value, stamp: boundedJson(value) }
      }
    )
    if (final.state !== 'responded' || final.content_status !== 'available' || final.response === null) {
      throw new GatewayError('result_not_ready')
    }
    // 最后一次策略回调也可能关闭原 Wire 或撤销原生来源；不能以回调前已通过的门禁作为交付依据。
    const live = synchronous(options.resolveOriginalRead(callId))
    if (!live || live.wire !== original.wire) {
      throw new GatewayError('result_context_unavailable')
    }
    assertBinding(binding, live.binding)
    nativeResult(live, binding, response.value as JsonObject, retain)
    if (
      boundedJson(principal(reader.id)) !== boundedJson(finalReader) ||
      !local ||
      boundedJson(local.value) !== local.stamp
    ) {
      throw new GatewayError('forbidden')
    }
    const checked = store.call(reader.id, callId)
    if (checked.state !== 'responded' || checked.content_status !== 'available' || checked.response === null) {
      throw new GatewayError('result_not_ready')
    }
    return checked
  }

  /** 校验 Store 实际句柄元数据形状与内容期限上界，不推导或保存另一份期限。 */
  function metadata(value: LuvusResultMetadata, call: Call, resultId: string): LuvusResultMetadata {
    if (
      !value ||
      value.result_id !== resultId ||
      !Number.isSafeInteger(value.bytes) ||
      value.bytes <= 0 ||
      typeof value.hash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.hash) ||
      !Number.isSafeInteger(value.expires) ||
      value.expires <= store.clock() ||
      value.expires > call.content_expires
    ) {
      throw new GatewayError('result_metadata_mismatch')
    }
    return Object.freeze({ result_id: value.result_id, bytes: value.bytes, hash: value.hash, expires: value.expires })
  }

  return Object.freeze({
    /** 仅在原 Wire 独立保留能力也通过时创建或复用句柄；能力缺失则拒绝，期限均不刷新。 */
    open(callId: string): LuvusResultMetadata {
      return operation(
        /* 在持久创建前核对原生读许可，创建后重新授权，最终只返回 Store 的实际元数据。 */ (principal) => {
          readable(principal, callId, true)
          const saved = router(principal).saveResult(principal, callId)
          const current = readable(principal, callId, true)
          return metadata(saved, current, saved.result_id)
        }
      )
    },

    /** 按字节有界分页，联合实际句柄 TTL、Store 摘要、原生读取许可和当前双端 ACL 后返回 base64。 */
    read(resultId: string, cursor = 0, maxBytes = 65_536): LuvusResultPage {
      return operation(
        /* 全程同步执行句柄解析、元数据读取和最终授权，不新建或续期任何结果。 */ (principal) => {
          id(resultId)
          const owned = store.resultCall(principal.id, resultId)
          call(principal, owned.call_id)
          router(principal).readResult(principal, resultId, cursor, maxBytes)
          const current = readable(principal, owned.call_id)
          // 最后一道策略回调可能已使实际句柄失效；授权结束后重新读页，禁止交付回调前准备的副本。
          const page = store.readResult(principal.id, resultId, cursor, maxBytes)
          metadata(page, current, resultId)
          return Object.freeze(page)
        }
      )
    },

    /** 以当前调用归属、双端读取 ACL 和独立 discard_response 权限丢弃内容，不借用原生派发许可。 */
    discard(callId: string): void {
      operation(
        /* 即使原生读取上下文已回收，也只由 Router 的专门删除权限决定是否清理，不返回正文。 */ (principal) => {
          call(principal, callId)
          router(principal).discardResponse(principal, callId)
        }
      )
    }
  })
}
