/** 用持久受保护 Luvus root 显式启动正式受控 child，并在独立一次批准后发行有限内存 custody。 */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Socket } from 'node:net'
import type { AttemptBinding, ContractSource } from '../wire/types.js'
import { boundedJson } from '../wire/index.js'
import { parseNativeJson } from '../native-contract/index.js'
import type { TrustedNativeContext } from '../native-contract/index.js'
import type { NativeContractRecord } from '../integration/luvus-wire.js'
import { deadline } from '../connector/luvus/io.js'
import { localLimits } from '../connector/luvus/local.js'
import { LuvusAdapterError } from '../connector/luvus/types.js'
import type {
  EndpointIdentity,
  LuvusLocalConfig,
  NativeTransportEvidence,
  PeerIdentity
} from '../connector/luvus/types.js'
import type { LuvusBoundDelegation } from '../connector/luvus/delegation.js'
import type { Connection } from '../transport/index.js'
import type { CompiledContract } from '../native-contract/index.js'
import { NativeInstanceContext } from './native-instance-context.js'
import { NativeCustodyContext } from './native-context.js'
import type { LuvusIssuanceMetadata } from './native-instance.js'
import { assertManagedRoot, claimManagedRoot } from './native-root.js'
import type { ManagedLuvusRoot } from './native-root.js'
import { checkedNativeCustodyIntent, consumeNativeCustodyApproval } from './native-custody.js'
import type { NativeCustodyAuthorizer, NativeCustodyIntent } from './native-custody.js'
import { assertControlledLuvus, controlledLuvusRpc, startControlledLuvus } from './native-control.js'
import type { ControlledLuvusSession } from './native-control.js'
import { OwnedProcessShutdownError } from './native-process.js'

export const MANAGED_LUVUS_REVISION = 'managed-owned-luvus-0.14.3-1'
export const MANAGED_LUVUS_CLASSIFICATION = 'managed-owned-rpc-1'
const processBrand = Symbol('managed-luvus-process')
const custodyBrand = Symbol('restricted-luvus-custody')
const localOwners = new WeakMap<LocalOwnerLuvusInstance, () => boolean>()
const deliveredCustodies = new WeakSet<RestrictedLuvusCustody>()
export type RestrictedLuvusRequest = Readonly<{
  scopes: readonly ('read' | 'orchestration')[]
  methods: readonly string[]
  token_ttl_s: number
}>
export type RestrictedLuvusIssuance = LuvusIssuanceMetadata &
  Readonly<{
    approval_id: string
    actor: string
    confirmation_id: string
  }>
export interface RestrictedLuvusCustody {
  readonly [custodyBrand]: true
  readonly config: LuvusLocalConfig & { readonly transport: 'ipc' }
  readonly contract: NativeContractRecord
  readonly issuance: RestrictedLuvusIssuance
  source(binding: AttemptBinding): TrustedNativeContext
  verifyPeer(socket: Socket, endpoint: EndpointIdentity, binding: AttemptBinding): Promise<PeerIdentity>
  assertEvidence(binding: AttemptBinding, evidence: NativeTransportEvidence): void
  delegation(binding: AttemptBinding): LuvusBoundDelegation
  ready(): boolean
  close(): void
}
export interface LocalOwnerLuvusInstance {
  readonly config: LuvusLocalConfig & { readonly transport: 'ipc' }
  readonly contract: NativeContractRecord
  source(binding: AttemptBinding): TrustedNativeContext
  catalogSource(
    connection: Connection,
    policies: Readonly<{ caller_policy_revision: string; local_policy_revision: string }>
  ): TrustedNativeContext
  verifyPeer(socket: Socket, endpoint: EndpointIdentity, binding: AttemptBinding): Promise<PeerIdentity>
  assertEvidence(binding: AttemptBinding, evidence: NativeTransportEvidence): void
  nativeAuth(binding: AttemptBinding, evidence: NativeTransportEvidence): Readonly<{ kind: 'local_owner' }>
  ready(): boolean
}
/** 内部真实 managed/attach 工厂在实际 peer 检查完成后登记闭包，不向产品入口开放 JSON 注册。 */
export function registerLocalOwnerLuvus(owner: LocalOwnerLuvusInstance, live: () => boolean): void {
  if (localOwners.has(owner) || !live()) {
    throw new LuvusAdapterError('local_owner_unavailable')
  }
  localOwners.set(owner, live)
}
/** 仅接受本次受控进程明确交付的 Owner；没有 token 不是自动选择此模式的理由。 */
export function assertLocalOwnerLuvus(owner: LocalOwnerLuvusInstance): void {
  const live = localOwners.get(owner)
  if (!live || !live()) {
    throw new LuvusAdapterError('local_owner_unavailable')
  }
}
export interface ControlledLuvusProcess {
  readonly [processBrand]: true
  readonly root_id: string
  readonly root_revision: number
  readonly config: LuvusLocalConfig & { readonly transport: 'ipc' }
  readonly contract: NativeContractRecord
  issueRestricted(request: RestrictedLuvusRequest, authorize: NativeCustodyAuthorizer): Promise<RestrictedLuvusCustody>
  // 宿主显式选择本机 Owner 操作，不签发 token、添加批准或创建持续访问。
  localOwner(): LocalOwnerLuvusInstance
  ready(): boolean
  close(): Promise<void>
}

/** 从同一真实能力响应建立完整 envelope 契约，generation 只认当前受控 child 的原生值。 */
function observedContract(
  control: ControlledLuvusSession,
  observed: Readonly<{ frame: Record<string, unknown>; result: Record<string, unknown> }>
): NativeContractRecord {
  assertControlledLuvus(control)
  return observedLuvusContract(control.config, control.compiled, observed, control.binaryVersion)
}

/** 共享真实能力快照到安装契约的纯映射；调用者必须先建立自身实际 socket/process 来源。 */
export function observedLuvusContract(
  config: LuvusLocalConfig,
  compiled: CompiledContract,
  observed: Readonly<{ frame: Record<string, unknown>; result: Record<string, unknown> }>,
  binaryVersion = 'unavailable'
): NativeContractRecord {
  const value = observed.result
  const protocol = value.protocol as Record<string, unknown> | undefined
  if (
    typeof value.server_generation !== 'string' ||
    !value.server_generation.length ||
    value.server_generation.length > 512 ||
    value.session !== config.target.session ||
    protocol?.name !== 'luvus-uhp' ||
    protocol.major !== 1 ||
    !Number.isSafeInteger(protocol.minor) ||
    (protocol.minor as number) < 0
  ) {
    throw new LuvusAdapterError('native_source_capabilities_invalid')
  }
  const maximum = Math.min(localLimits(config.limits).discovery_bytes, 1_048_576)
  const snapshot = parseNativeJson(boundedJson(observed.frame, maximum), { object_bytes: maximum })
  if (!snapshot.ok) {
    throw new LuvusAdapterError('native_source_capabilities_invalid')
  }
  const source: ContractSource = Object.freeze({
    provider_kind: 'luvus',
    protocol_family: 'uhp',
    binary_version: binaryVersion,
    binary_sha256: config.binary_sha256,
    schema_sha256: compiled.identity.schema_sha256,
    schema_origin: 'installed_cli',
    schema_command: 'luvus uhp schema',
    server_version:
      typeof value.version === 'string' && value.version.length > 0 && value.version.length <= 128
        ? value.version
        : null,
    native_protocol_version: `${protocol.major}.${protocol.minor}`,
    runtime_generation: value.server_generation,
    adapter_revision: MANAGED_LUVUS_REVISION,
    classification_revision: MANAGED_LUVUS_CLASSIFICATION,
    support_basis: 'live_catalog'
  })
  return Object.freeze({
    wire: Object.freeze({ source, support_status: 'validated' as const }),
    compiled,
    capabilities: snapshot.value,
    capability_revision: createHash('sha256').update(boundedJson(value, maximum)).digest('hex')
  })
}

/** 批准后的有限 custody 只释放本地 secret，不停止常驻 child，也不把忘记 secret 声称为 native 撤销。 */
class RestrictedCustody extends NativeCustodyContext implements RestrictedLuvusCustody {
  readonly [custodyBrand] = true as const
  declare readonly issuance: RestrictedLuvusIssuance
  readonly #released: () => void
  #closed = false

  /** 只由真实受控进程在一次批准消费与真实 token 签发后交付，不能从 token JSON 重建实例来源。 */
  constructor(
    control: ControlledLuvusSession,
    contract: NativeContractRecord,
    issuance: RestrictedLuvusIssuance,
    token: string,
    released: () => void
  ) {
    super(
      control.config,
      control.process,
      control.endpoint,
      /* 每次来源使用都重新核验实际 owner lock、endpoint 与直接 child。 */ () => assertControlledLuvus(control),
      contract,
      issuance,
      token
    )
    this.#released = released
    deliveredCustodies.add(this)
    Object.freeze(this)
  }

  /** 同步撤销所有 epoch helper 的 secret，持续 child 仍由 ControlledLuvusProcess 所有。 */
  close(): void {
    if (this.#closed) {
      return
    }
    this.#closed = true
    this.clearCustody()
    this.#released()
  }
}

/** 内部 provider 接缝核对真实交付句柄和原实现的当前来源，JSON flags 或覆盖 ready 不能冒充 custody。 */
export function assertRestrictedLuvusCustody(custody: RestrictedLuvusCustody): void {
  if (!deliveredCustodies.has(custody) || !NativeCustodyContext.prototype.ready.call(custody)) {
    throw new LuvusAdapterError('native_custody_unavailable')
  }
}

/** 持有真实 child 与永久 owner 锁；启动、审批发行和关闭分别有独立的可验证边界。 */
class ManagedProcess extends NativeInstanceContext implements ControlledLuvusProcess {
  readonly [processBrand] = true as const
  readonly root_id: string
  readonly root_revision: number
  readonly #root: ManagedLuvusRoot
  readonly #control: ControlledLuvusSession
  readonly #lock: ReturnType<typeof claimManagedRoot>
  readonly #custodies = new Set<RestrictedCustody>()
  #stopping = false
  #issuing = false
  #issueAbort: AbortController | undefined
  #closing: Promise<void> | undefined

  /** 仅本工厂可交付同一 root 锁、真实 process handle 和同 socket 能力观察。 */
  constructor(
    root: ManagedLuvusRoot,
    control: ControlledLuvusSession,
    lock: ReturnType<typeof claimManagedRoot>,
    contract: NativeContractRecord
  ) {
    super(
      control.config,
      control.process,
      control.endpoint,
      /* 同一受控 root、直接 child 与真实 endpoint 继续由既有基础核对。 */ () => assertControlledLuvus(control),
      contract
    )
    this.#root = root
    this.#control = control
    this.#lock = lock
    this.root_id = root.root_id
    this.root_revision = root.root_revision
  }

  /** Owner 与有限 custody 使用同一真实受控实例寿命。 */
  protected assertAccess(): void {
    this.#live()
  }
  /** Owner 不持有新发行 token；来源失效始终由原进程状态继续拒绝。 */
  protected invalidateAccess(): void {}
  /** 显式本机 Owner 句柄只用于受控实例的普通操作，不变更原有限签发接口。 */
  localOwner(): LocalOwnerLuvusInstance {
    this.#live()
    const owner: LocalOwnerLuvusInstance = Object.freeze({
      config: this.config,
      contract: this.contract,
      source: /* 每个原调用继续绑定同一实际 native 来源。 */ (binding: AttemptBinding) => this.source(binding),
      catalogSource: /* 目录只绑定当前实际认证连接及本次当前政策，不创建虚构 attempt。 */ (
        connection: Connection,
        policies: Readonly<{ caller_policy_revision: string; local_policy_revision: string }>
      ) => this.catalogSource(connection, policies),
      verifyPeer: /* 原 adapter 的同一 IPC socket 继续进行实际 peer 检查。 */ (
        socket: Socket,
        endpoint: EndpointIdentity,
        binding: AttemptBinding
      ) => this.verifyPeer(socket, endpoint, binding),
      assertEvidence: /* 写入前核对原 socket 与完整调用匹配。 */ (
        binding: AttemptBinding,
        evidence: NativeTransportEvidence
      ) => this.assertEvidence(binding, evidence),
      nativeAuth: /* 显式省略 native auth 字段才表示官方本机 Owner；peer 事实另行核验。 */ (
        binding: AttemptBinding,
        evidence: NativeTransportEvidence
      ) => {
        this.assertEvidence(binding, evidence)
        return Object.freeze({ kind: 'local_owner' as const })
      },
      ready: /* 当前受控进程失效时不沿用旧就绪状态。 */ () => this.ready()
    })
    registerLocalOwnerLuvus(owner, /* 只调用原实现的当前真实进程核验，不采信交付对象自报。 */ () => this.ready())
    return owner
  }
  /** 没有有限 custody 时进程仍可存活，但不能借此接口取得 token 或派发能力。 */
  ready(): boolean {
    try {
      this.#live()
      return true
    } catch {
      return false
    }
  }

  /** 对当前真实 generation 的独立批准先持久消费，再仅一次调用私有 token.create；不会自动续期或重放。 */
  async issueRestricted(
    request: RestrictedLuvusRequest,
    authorize: NativeCustodyAuthorizer
  ): Promise<RestrictedLuvusCustody> {
    this.#live()
    if (this.#issuing || this.#custodies.size >= 16 || typeof authorize !== 'function') {
      throw new LuvusAdapterError('native_custody_unavailable')
    }
    const copied = JSON.parse(boundedJson(request, 4096)) as RestrictedLuvusRequest
    if (Object.keys(copied).sort().join(',') !== 'methods,scopes,token_ttl_s') {
      throw new LuvusAdapterError('native_custody_intent_mismatch')
    }
    const intent: NativeCustodyIntent = checkedNativeCustodyIntent(this.#root, {
      root_id: this.root_id,
      root_revision: this.root_revision,
      config_ref: this.config.config_ref,
      config_digest: this.#root.config_digest,
      server_generation: this.contract.wire.source.runtime_generation!,
      scopes: copied.scopes,
      methods: copied.methods,
      token_ttl_s: copied.token_ttl_s
    })
    this.#issuing = true
    const abort = new AbortController()
    this.#issueAbort = abort
    const scope = deadline(abort.signal, localLimits(this.config.limits).timeout_ms)
    let token: string | undefined
    try {
      const approval = authorize(intent)
      // 非法异步 authorizer 不能逃逸请求范围，晚到拒绝必须消费，但不允许其恢复发行。
      if (approval && typeof (approval as unknown as { then?: unknown }).then === 'function') {
        void Promise.resolve(approval).catch(/* 异步批准不被接纳，消费潜在晚到拒绝。 */ () => {})
        throw new LuvusAdapterError('native_custody_approval_untrusted')
      }
      this.#live()
      const approved = consumeNativeCustodyApproval(this.#root, intent, approval)
      this.#live()
      const issuedAt = Date.now()
      const issued = await controlledLuvusRpc(
        this.#control,
        'uhp.token.create',
        { scopes: intent.scopes, ttl_s: intent.token_ttl_s },
        undefined,
        scope.signal
      )
      this.#live()
      const expires = typeof issued.result.expires_at === 'number' ? issued.result.expires_at * 1000 : NaN
      if (
        !isDeepStrictEqual(issued.result.scopes, intent.scopes) ||
        typeof issued.result.token !== 'string' ||
        !/^[!-~]{1,256}$/u.test(issued.result.token) ||
        !Number.isSafeInteger(expires) ||
        expires <= Date.now() ||
        expires > issuedAt + intent.token_ttl_s * 1000
      ) {
        throw new LuvusAdapterError('native_custody_issuance_invalid')
      }
      token = issued.result.token
      const observed = await controlledLuvusRpc(this.#control, 'uhp.capabilities', {}, token, scope.signal)
      this.#live()
      const contract = observedContract(this.#control, observed)
      if (contract.wire.source.runtime_generation !== intent.server_generation) {
        throw new LuvusAdapterError('native_custody_generation_changed')
      }
      const issuance: RestrictedLuvusIssuance = Object.freeze({
        ...approved,
        issued_at: issuedAt,
        expires_at: expires,
        scopes: intent.scopes,
        methods: intent.methods
      })
      const custody = new RestrictedCustody(
        this.#control,
        contract,
        issuance,
        token,
        /* 单独关闭 custody 只释放本进程对该内存能力的集合引用。 */ () => this.#custodies.delete(custody)
      )
      if (!custody.ready()) {
        custody.close()
        throw new LuvusAdapterError('native_custody_unavailable')
      }
      this.#custodies.add(custody)
      token = undefined
      return custody
    } catch (error) {
      token = undefined
      throw error instanceof LuvusAdapterError ? error : new LuvusAdapterError('native_custody_issuance_failed')
    } finally {
      scope.close()
      this.#issueAbort = undefined
      this.#issuing = false
    }
  }

  /** 显式关闭立即阻止发行并释放 secret，确认真实 child 退出后才释放 owner 锁；失败可显式重试。 */
  close(): Promise<void> {
    this.#stopping = true
    this.#issueAbort?.abort('closed')
    for (const custody of this.#custodies) {
      custody.close()
    }
    if (this.#closing) {
      return this.#closing
    }
    const attempt = this.#stop()
    this.#closing = attempt
    void attempt.then(
      /* 成功后重复 close 仍核验真实已退出状态。 */ () => {
        if (this.#closing === attempt) {
          this.#closing = undefined
        }
      },
      /* 失败只清本次等待，保留 owner 锁及 pidfd，不恢复来源或秘密。 */ () => {
        if (this.#closing === attempt) {
          this.#closing = undefined
        }
      }
    )
    return attempt
  }

  /** 当前关闭 fence、真实 root 和实际 child 归属都必须独立有效。 */
  #live(): void {
    if (this.#stopping) {
      throw new LuvusAdapterError('native_source_unavailable')
    }
    assertManagedRoot(this.#root)
    this.#lock.assert()
    assertControlledLuvus(this.#control)
  }

  /** 不把逻辑等待截止当作物理退出，只有受控 owner 返回确认后才可清理锁。 */
  async #stop(): Promise<void> {
    await this.#control.process.close()
    this.#lock.release(this.#control.process)
  }
}

/** 显式启动记录指定的持久 root；不认领已有 PID、不读业务列表、不发行 token 或恢复旧 custody。 */
export async function startManagedLuvus(root: ManagedLuvusRoot): Promise<ControlledLuvusProcess> {
  assertManagedRoot(root)
  const lock = claimManagedRoot(root)
  const scope = deadline(undefined, localLimits(root.config.limits).timeout_ms)
  let control: ControlledLuvusSession | undefined
  try {
    control = await startControlledLuvus(root.config, {
      revision: MANAGED_LUVUS_REVISION,
      signal: scope.signal,
      /* 启动与每次控制 RPC 都依赖真实保护记录及本轮独占锁。 */ assertOwnership: () => lock.assert()
    })
    const observed = await controlledLuvusRpc(control, 'uhp.capabilities', {}, undefined, scope.signal)
    const contract = observedContract(control, observed)
    return new ManagedProcess(root, control, lock, contract)
  } catch (error) {
    if (control) {
      await control.process.close()
      lock.release(control.process)
    } else if (!(error instanceof OwnedProcessShutdownError && !error.exit_confirmed)) {
      // 内部启动器确认没留下 child 后才能释放锁；cleanup_pending 错误保留所有权证据。
      lock.release()
    }
    throw error instanceof LuvusAdapterError ? error : new LuvusAdapterError('native_source_start_failed')
  } finally {
    scope.close()
  }
}
