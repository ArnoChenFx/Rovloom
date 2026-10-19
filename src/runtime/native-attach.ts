/** 只连接明确配置的已有本机 Luvus，核对实际 peer/启动身份与契约；关闭只释放本观察者。 */
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { compileBundle, createNativeValidator, parseNativeJson } from '../native-contract/index.js'
import { boundedJson, object } from '../wire/index.js'
import { LuvusAdapterError, readLinuxLuvusPeer } from '../connector/luvus/index.js'
import type { EndpointIdentity, LuvusLocalConfig, NativeTransportEvidence } from '../connector/luvus/index.js'
import type { AttemptBinding } from '../wire/types.js'
import {
  inspectEndpoint,
  localLimits,
  pinConfig,
  recheckEndpoint,
  verifyInstallation
} from '../connector/luvus/local.js'
import { aborted, deadline, runFixedProcess, runSocket } from '../connector/luvus/io.js'
import { parseRpcFrame } from '../connector/luvus/adapter.js'
import { NativeInstanceContext } from './native-instance-context.js'
import { observeLinuxLuvusProcess } from './native-process.js'
import type { ObservedNativeProcess } from './native-process.js'
import { MANAGED_LUVUS_REVISION, registerLocalOwnerLuvus, observedLuvusContract } from './native-source.js'
import type { LocalOwnerLuvusInstance } from './native-source.js'
import { FIXED_LUVUS_SCHEMA_SHA256, FIXED_LUVUS_SHA256 } from './native-control.js'
import type { NativeContractRecord } from '../integration/luvus-wire.js'

export interface AttachedLuvusInstance extends LocalOwnerLuvusInstance {
  close(): void
}

/** 外部实例只有只读观察寿命，没有 child 启停接口、token 发行或自动恢复。 */
class AttachedLuvus extends NativeInstanceContext implements AttachedLuvusInstance {
  readonly #observation: ObservedNativeProcess
  #closed = false

  /** 只能在固定 schema 与实际同 socket 能力响应均通过后交付 Owner。 */
  constructor(
    config: LuvusLocalConfig & { readonly transport: 'ipc' },
    observation: ObservedNativeProcess,
    endpoint: EndpointIdentity,
    contract: NativeContractRecord
  ) {
    super(
      config,
      observation,
      endpoint,
      /* 原 pidfd 与 /proc 身份每次使用都保持有效。 */ () => observation.assertLive(),
      contract
    )
    this.#observation = observation
    registerLocalOwnerLuvus(this, AttachedLuvus.prototype.ready.bind(this))
    Object.freeze(this)
  }

  /** 显式关闭或实际来源丢失后，旧句柄永远不能重新变成可用。 */
  protected assertAccess(): void {
    if (this.#closed) {
      throw new LuvusAdapterError('native_attach_closed')
    }
  }

  /** 来源失效只关闭本观察者持有的 pidfd，不操作被观察的原生实例。 */
  protected invalidateAccess(): void {
    this.close()
  }

  /** 显式 Owner 模式继续要求同一真实 RPC socket 的证据，不以缺少 token 推断。 */
  nativeAuth(binding: AttemptBinding, evidence: NativeTransportEvidence): Readonly<{ kind: 'local_owner' }> {
    this.assertEvidence(binding, evidence)
    return Object.freeze({ kind: 'local_owner' })
  }

  /** 实际进程、固定路径与 endpoint 都仍有效时才报告就绪。 */
  ready(): boolean {
    try {
      this.assertInstance()
      return true
    } catch {
      return false
    }
  }

  /** 只失效本对象和关闭自己持有的观察 fd，重复调用也不终止原 native。 */
  close(): void {
    if (!this.#closed) {
      this.#closed = true
      this.#observation.close()
    }
  }
}

/** 使用固定安装的 schema/发现命令和唯一明确 session；不启动 server 或读取其它会话内容。 */
export async function attachExistingLuvus(
  config: LuvusLocalConfig,
  options: Readonly<{ signal?: AbortSignal }> = {}
): Promise<AttachedLuvusInstance> {
  let observation: ObservedNativeProcess | undefined
  let scope: ReturnType<typeof deadline> | undefined
  try {
    const fixed = pinConfig(config)
    if (
      fixed.transport !== 'ipc' ||
      fixed.binary_sha256 !== FIXED_LUVUS_SHA256 ||
      process.arch !== 'x64' ||
      !process.versions.bun
    ) {
      throw new LuvusAdapterError('native_attach_installation_unsupported')
    }
    const limits = localLimits(fixed.limits)
    scope = deadline(options.signal, limits.timeout_ms)
    aborted(scope.signal)
    await verifyInstallation(fixed)
    aborted(scope.signal)
    const schema = await runFixedProcess(fixed, limits, 'schema', scope.signal)
    if (
      schema.exit_code !== 0 ||
      createHash('sha256').update(schema.stdout).digest('hex') !== FIXED_LUVUS_SCHEMA_SHA256
    ) {
      throw new LuvusAdapterError('native_control_schema_mismatch')
    }
    const compiled = await compileBundle(
      schema.stdout,
      {
        identity: {
          binary_sha256: FIXED_LUVUS_SHA256,
          schema_sha256: FIXED_LUVUS_SCHEMA_SHA256,
          revision: MANAGED_LUVUS_REVISION
        }
      },
      scope.signal
    )
    if (!compiled.ok) {
      throw new LuvusAdapterError(compiled.error.code)
    }
    const listing = await runFixedProcess(fixed, limits, 'sessions', scope.signal)
    const parsed = parseNativeJson(listing.stdout, { object_bytes: Math.min(limits.discovery_bytes, 1_048_576) })
    if (listing.exit_code !== 0 || !parsed.ok) {
      throw new LuvusAdapterError('native_control_discovery_invalid')
    }
    const rows = object(parsed.value).sessions
    if (!Array.isArray(rows) || rows.length > 256) {
      throw new LuvusAdapterError('native_control_discovery_invalid')
    }
    const matches = rows.filter(
      /* 列表仅用于固定 session 的地址发现，广告 PID 永不参与进程身份。 */ (row) =>
        object(row).name === fixed.target.session
    )
    if (matches.length !== 1 || object(matches[0]).running !== true) {
      throw new LuvusAdapterError('native_session_unavailable')
    }
    const address = object(object(matches[0]).endpoint)
    if (address.transport !== 'unix_socket' || typeof address.address !== 'string') {
      throw new LuvusAdapterError('native_endpoint_unsupported')
    }
    const endpoint = await inspectEndpoint(fixed, address.address)
    const id = randomUUID()
    const bytes = Buffer.from(boundedJson({ id, method: 'uhp.capabilities', params: {} }, limits.request_bytes) + '\n')
    const reply = await runSocket(
      endpoint.address,
      limits.response_bytes,
      scope.signal,
      /** 写入前从该实际 socket 的 SO_PEERCRED 建立只读 pidfd/启动身份观察。 */ async (socket) => {
        await recheckEndpoint(fixed, endpoint)
        observation = observeLinuxLuvusProcess(socket, fixed)
        return {
          bytes,
          /** 最后一次 await 后继续复核同一内核 peer，防切换或旧 PID 冒充。 */ beforeWrite() {
            observation!.assertLive()
            if (!isDeepStrictEqual(readLinuxLuvusPeer(socket), observation!.identity())) {
              throw new LuvusAdapterError('attached_peer_mismatch')
            }
          }
        }
      }
    )
    observation!.assertLive()
    await recheckEndpoint(fixed, endpoint)
    aborted(scope.signal)
    const frame = parseRpcFrame(reply, limits.response_bytes)
    if (frame.id !== id || !createNativeValidator(compiled.value).checkResponseShape(frame).ok || frame.error) {
      throw new LuvusAdapterError('native_source_capabilities_invalid')
    }
    const contract = observedLuvusContract(fixed, compiled.value, { frame, result: object(frame.result) })
    observation!.assertLive()
    return new AttachedLuvus(
      fixed as LuvusLocalConfig & { readonly transport: 'ipc' },
      observation!,
      endpoint,
      contract
    )
  } catch (error) {
    observation?.close()
    throw error instanceof LuvusAdapterError ? error : new LuvusAdapterError('native_attach_failed')
  } finally {
    scope?.close()
  }
}
