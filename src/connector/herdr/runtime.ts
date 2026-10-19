/** 将 Herdr 已评审 RPC 挂到既有 ConnectorWireSession，复用 Store/Wire 和持久唯一发送账本。 */
import { LuvusDispatchClaims } from '../luvus/claims.js'
import { LuvusAdapterError } from '../luvus/types.js'
import { readLinuxPeer } from '../local/linux-peer.js'
import { boundedJson, WireError } from '../../wire/index.js'
import type { AttemptBinding, AuthenticatedEnvelope } from '../../wire/types.js'
import type { WireExecutionResult } from '../../transport/connector.js'
import { HerdrInstallation } from './installation.js'
import { checkHerdrSignal, exchangeHerdr, herdrDeadline, withHerdrSocket } from './io.js'
import { HerdrLocalError } from './local.js'
import { createHerdrReadonlyAdapter } from './readonly.js'
import type { HerdrReadonlyBackend } from './readonly.js'
import { createHerdrWireAdapter } from './wire.js'

/** 实例只作用于当前认证 epoch；宿主分别提供 readiness 与关闭流程，不创建 Gateway 或新认证模型。 */
export function createHerdrRuntime(
  installation: HerdrInstallation,
  backend: HerdrReadonlyBackend,
  claims: LuvusDispatchClaims
) {
  if (!(installation instanceof HerdrInstallation) || !(claims instanceof LuvusDispatchClaims)) {
    throw new HerdrLocalError('herdr_runtime_host_required')
  }
  installation.assert()
  const localBackend: HerdrReadonlyBackend = {
    ...backend,
    /** Gateway 的通道来源只用于远端响应治理，不能转成本机 Herdr 执行许可。 */
    nativeSource(binding) {
      const source = backend.nativeSource(binding)
      if (source && source.role !== 'local_installation') {
        throw new HerdrLocalError('herdr_local_source_required')
      }
      return source
    }
  }
  const core = createHerdrReadonlyAdapter(localBackend)
  const adapter = createHerdrWireAdapter(localBackend, core)
  // 执行 hook 自有消息窗口；共享 core permit，避免 transport 已观察的消息变成二次原生执行。
  const execution = createHerdrWireAdapter(localBackend, core)
  const seen = new Set<string>()
  const active = new Set<AbortController>()
  let closed = false
  let highWater = -1

  /** 不回退的原 Store 时钟同时约束调度、持久 claim 与原 deadline。 */
  function now(): number {
    const value = backend.now()
    if (!Number.isSafeInteger(value) || value < 0 || value < highWater) {
      throw new HerdrLocalError('clock_untrusted')
    }
    highWater = value
    return value
  }

  /** 在每次写入前校验原始 Wire 帧、安装和同一原生 peer；不缓存授权作为后续许可。 */
  async function executeWire(input: string, signal: AbortSignal): Promise<WireExecutionResult> {
    let dispatched = false
    let scope: ReturnType<typeof herdrDeadline> | undefined
    const controller = new AbortController()
    const cancel = /** 关闭本次桥接等待，不发送任何原生控制请求。 */ () => controller.abort(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) {
      cancel()
    }
    active.add(controller)
    try {
      if (closed) {
        throw new HerdrLocalError('herdr_runtime_closed')
      }
      checkHerdrSignal(controller.signal)
      const decoded = execution.decode(input, 'gateway_to_connector')
      if (decoded.type !== 'request' || !('connection_epoch' in decoded)) {
        throw new HerdrLocalError('herdr_request_required')
      }
      const frame = decoded as Extract<AuthenticatedEnvelope, { type: 'request' }>
      const binding: AttemptBinding = {
        machine_id: frame.machine_id,
        recovery_generation: frame.recovery_generation,
        connection_epoch: frame.connection_epoch,
        ...frame.payload.attempt
      }
      if (!installation.source(binding)) {
        throw new HerdrLocalError('herdr_local_binding_mismatch')
      }
      const key = boundedJson(binding)
      if (seen.has(key)) {
        throw new HerdrLocalError('attempt_already_observed')
      }
      if (seen.size >= 4096 || active.size > 8) {
        throw new HerdrLocalError('herdr_runtime_limit')
      }
      if (execution.observeMessage(frame, 'gateway_to_connector') !== 'new') {
        throw new HerdrLocalError('duplicate_message')
      }
      const remaining = binding.registration.deadline - now()
      if (remaining <= 0) {
        throw new HerdrLocalError('herdr_timeout')
      }
      seen.add(key)
      scope = herdrDeadline(controller.signal, remaining)
      const ioSignal = scope.signal
      const context = core.resolve(frame.payload.attempt)
      const request = { ...frame.payload.native_request, id: binding.native_request_id }
      const endpoint = installation.assert(undefined, true)
      const raw = await withHerdrSocket(
        endpoint,
        ioSignal,
        /** 从实际连接读取内核 peer，再准备唯一原生请求。 */ async (socket) => {
          const peer = await readLinuxPeer(socket)
          installation.assert(peer, true)
          checkHerdrSignal(ioSignal)
          return exchangeHerdr(
            socket,
            ioSignal,
            /** 唯一发送墓碑和最终请求均在同一个同步写入边界准备。 */ () => {
              /** 既有 Store/Wire 门禁和本机来源任何变化都禁止继续发送。 */
              function current(): void {
                checkHerdrSignal(ioSignal)
                if (closed || adapter.stats().closed) {
                  throw new HerdrLocalError('herdr_runtime_closed')
                }
                execution.decode(input, 'gateway_to_connector')
                installation.assert(peer)
                if (now() >= binding.registration.deadline) {
                  throw new HerdrLocalError('herdr_timeout')
                }
              }
              current()
              const bytes = core.encodeRequest(request, context)
              const anchor = backend.responseAnchor(binding)
              if (!anchor) {
                throw new HerdrLocalError('attempt_anchor_unavailable')
              }
              // 复用既有通用完整 binding 墓碑；表名沿用旧版本，既不导入 UHP schema，也不创建第二账本。
              claims.claim(binding, anchor.dedup_expires_at)
              installation.assert(peer, true)
              current()
              return {
                bytes,
                /** 紧贴实际 write 的最后复核后标记可能已发送；失败不自动重放。 */
                beforeWrite() {
                  current()
                  dispatched = true
                }
              }
            }
          )
        }
      )
      checkHerdrSignal(ioSignal)
      installation.assert()
      const response = core.decodeResponse(raw, context)
      return Object.freeze({ binding, native_response: response })
    } catch (error) {
      const code =
        error instanceof HerdrLocalError || error instanceof WireError || error instanceof LuvusAdapterError
          ? error.code
          : 'herdr_runtime_unavailable'
      throw new HerdrLocalError(code, dispatched ? 'outcome_unknown' : 'not_dispatched')
    } finally {
      scope?.close()
      signal.removeEventListener('abort', cancel)
      active.delete(controller)
      // core 由 transport 保留到响应编码与 Store 证据提交；这里释放会使正常回包丢失原 permit。
    }
  }

  return Object.freeze({
    adapter,
    executeWire,
    /** 只关闭所属桥接和等待；实例、Store 与共享持久 claims 仍归宿主所有。 */
    close(): void {
      closed = true
      for (const controller of active) {
        controller.abort('closed')
      }
      execution.close()
      adapter.close()
    }
  })
}

export { HerdrInstallation, createHerdrHostServices } from './installation.js'
export { launchHerdrProcess } from './local.js'
