/** 显式开发启动器只为自有空白 Linux 实例建立来源和短期内存委托；不提供生产 custody。 */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, lstatSync, openSync, readdirSync, unlinkSync } from 'node:fs'
import { join, relative, isAbsolute, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Socket } from 'node:net'
import { LuvusBoundDelegation, readLinuxLuvusPeer, LuvusAdapterError } from '../connector/luvus/index.js'
import type {
  EndpointIdentity,
  LuvusLocalConfig,
  NativeTransportEvidence,
  PeerIdentity
} from '../connector/luvus/index.js'
import {
  localLimits,
  pinConfig,
  verifyInstallation,
  inspectEndpoint,
  recheckEndpoint
} from '../connector/luvus/local.js'
import { deadline, runFixedProcess, runSocket } from '../connector/luvus/io.js'
import { parseRpcFrame } from '../connector/luvus/adapter.js'
import { compileBundle, createNativeValidator, parseNativeJson } from '../native-contract/index.js'
import type { NativeBinding, TrustedNativeContext } from '../native-contract/index.js'
import type { NativeContractRecord } from '../integration/luvus-wire.js'
import { assertBinding, boundedJson, contractRef } from '../wire/index.js'
import type { AttemptBinding, ContractSource } from '../wire/types.js'
import { OwnedNativeProcess, ownedPathStamp } from './native-process.js'

export const DEVELOPMENT_LUVUS_SHA256 = '895073022da8edd231c9d4c810d68627b954b61e4e9f9f2d5d19e2c2fcf282a9'
export const DEVELOPMENT_LUVUS_REVISION = 'development-owned-luvus-0.14.3-1'
export const DEVELOPMENT_LUVUS_CLASSIFICATION = 'development-owned-rpc-1'
const officialSchema = '00e3bb8862b9f3602164bdbe3f11cd7b466e7f7098aa2942dd3878d0b1abdbe6'
const owned = Symbol('owned-development-luvus')
const markerName = '.rovloom-development-owner'

export type DevelopmentLuvusOptions = Readonly<{
  acknowledge_nonproduction: true
  token_ttl_s: number
  scopes?: readonly ['read'] | readonly ['read', 'orchestration']
}>
export type LuvusIssuanceMetadata = Readonly<{
  issued_at: number
  expires_at: number
  scopes: readonly ('read' | 'orchestration')[]
  methods: readonly string[]
}>
export interface OwnedLuvusInstance {
  readonly [owned]: true
  readonly config: LuvusLocalConfig & { readonly transport: 'ipc' }
  readonly contract: NativeContractRecord
  readonly issuance: LuvusIssuanceMetadata
  source(binding: AttemptBinding): TrustedNativeContext
  verifyPeer(socket: Socket, endpoint: EndpointIdentity, binding: AttemptBinding): Promise<PeerIdentity>
  assertEvidence(binding: AttemptBinding, evidence: NativeTransportEvidence): void
  delegation(binding: AttemptBinding): LuvusBoundDelegation
  ready(): boolean
  close(): Promise<void>
}

/** 只对已接纳的有界字节或 JSON 快照求摘要，不记录配置、响应或秘密。 */
function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

/** 固定本地开发 opt-in、官方版本与最小 scope；不接受生产/CLI 隐式降级。 */
function developmentConfig(
  config: LuvusLocalConfig,
  options: DevelopmentLuvusOptions
): LuvusLocalConfig & { readonly transport: 'ipc' } {
  if (
    options?.acknowledge_nonproduction !== true ||
    !Number.isSafeInteger(options.token_ttl_s) ||
    options.token_ttl_s < 1 ||
    options.token_ttl_s > 300 ||
    (options.scopes !== undefined &&
      !isDeepStrictEqual(options.scopes, ['read']) &&
      !isDeepStrictEqual(options.scopes, ['read', 'orchestration']))
  ) {
    throw new LuvusAdapterError('development_opt_in_required')
  }
  const fixed = pinConfig(config)
  if (
    !process.versions.bun ||
    process.arch !== 'x64' ||
    fixed.transport !== 'ipc' ||
    fixed.binary_sha256 !== DEVELOPMENT_LUVUS_SHA256
  ) {
    throw new LuvusAdapterError('development_installation_unsupported')
  }
  const roots = [fixed.home, fixed.cwd, fixed.state_root]
  for (const first of roots) {
    for (const second of roots) {
      if (first !== second) {
        const inside = relative(first, second)
        if (!inside.startsWith('..' + sep) && inside !== '..' && !isAbsolute(inside)) {
          throw new LuvusAdapterError('development_roots_overlap')
        }
      }
    }
  }
  if (new Set(roots).size !== roots.length) {
    throw new LuvusAdapterError('development_roots_overlap')
  }
  return fixed as LuvusLocalConfig & { readonly transport: 'ipc' }
}

/** 在任何 CLI/server 启动前拒绝已有配置、凭据或工作内容，不读取这些文件的正文。 */
function assertBlankRoots(config: LuvusLocalConfig, claimed = false): void {
  const xdg = ['config', 'data', 'cache', 'runtime']
  const roots = [config.state_root, config.cwd, config.home]
  for (const path of [...roots, ...xdg.map(/* 列明唯一允许的空白 HOME 子目录。 */ (name) => join(config.home, name))]) {
    ownedPathStamp(path, 'directory')
    const names = readdirSync(path).sort()
    const allowed = path === config.home ? [...xdg] : []
    if (claimed && roots.includes(path)) {
      allowed.push(markerName)
    }
    if (!isDeepStrictEqual(names, allowed.sort())) {
      throw new LuvusAdapterError('development_root_not_blank')
    }
  }
}

/** 空白检查与 wx 独占标记共同防止两个合作宿主同时取得同一目录，标记后再次复核。 */
function claimBlankRoots(config: LuvusLocalConfig): readonly [string, string][] {
  assertBlankRoots(config)
  const roots = [config.state_root, config.cwd, config.home]
  const claims: [string, string][] = []
  try {
    for (const root of roots) {
      const path = join(root, markerName)
      const fd = openSync(path, 'wx', 0o600)
      closeSync(fd)
      claims.push([path, markerStamp(path)])
    }
    assertBlankRoots(config, true)
    return claims
  } catch {
    releaseMarkers(claims)
    throw new LuvusAdapterError('development_root_not_blank')
  }
}

/** 固定本轮独占标记的 inode、权限和属主，内容不含 token 或实例凭据。 */
function markerStamp(path: string): string {
  const info = lstatSync(path, { bigint: true })
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1n ||
    info.size !== 0n ||
    info.uid !== BigInt(process.geteuid!()) ||
    (info.mode & 0o777n) !== 0o600n
  ) {
    throw new LuvusAdapterError('owned_marker_changed')
  }
  return [info.dev, info.ino, info.uid, info.mode, info.ctimeNs].join(':')
}

/** 仅在初始化失败时移除仍属本轮的标记，不删除或接管其它状态。 */
function releaseMarkers(claims: readonly [string, string][]): void {
  for (const [path, stamp] of claims) {
    try {
      if (markerStamp(path) === stamp) {
        unlinkSync(path)
      }
    } catch {
      /* 标记被换走时绝不删除替代物。 */
    }
  }
}

/** 要求原生回复是成功的对象，秘密类回复只在私有引导闭包内暂存。 */
function resultObject(value: Record<string, unknown>): Record<string, unknown> {
  if (value.error || !value.result || typeof value.result !== 'object' || Array.isArray(value.result)) {
    throw new LuvusAdapterError('development_bootstrap_rejected')
  }
  return value.result as Record<string, unknown>
}

/** 持有真实 child、peer 证据和已签发的内存 token；同形 JSON 不能构造此对象。 */
class DevelopmentInstance implements OwnedLuvusInstance {
  readonly [owned] = true as const
  readonly config: LuvusLocalConfig & { readonly transport: 'ipc' }
  readonly contract: NativeContractRecord
  readonly issuance: LuvusIssuanceMetadata
  readonly #process: OwnedNativeProcess
  readonly #endpoint: EndpointIdentity
  readonly #endpointStamp: string
  readonly #markers: readonly [string, string][]
  readonly #evidence = new WeakMap<EndpointIdentity, { socket: Socket; binding: string; peer: PeerIdentity }>()
  readonly #delegations = new Map<string, LuvusBoundDelegation>()
  #token: string | undefined
  #clock: number
  #closing: Promise<void> | undefined

  /** 仅工厂可交付经过真实 bootstrap 的实例和不可续期签发元数据。 */
  constructor(
    config: LuvusLocalConfig & { readonly transport: 'ipc' },
    child: OwnedNativeProcess,
    endpoint: EndpointIdentity,
    markers: readonly [string, string][],
    contract: NativeContractRecord,
    issuance: LuvusIssuanceMetadata,
    token: string
  ) {
    this.config = config
    this.#process = child
    this.#endpoint = endpoint
    this.#endpointStamp = ownedPathStamp(endpoint.address, 'socket')
    this.#markers = markers
    this.contract = contract
    this.issuance = issuance
    this.#token = token
    this.#clock = issuance.issued_at
  }

  /** 每次先复核 child/路径/custody，再把该受保护事实绑定到完整登记 attempt。 */
  source(binding: AttemptBinding): TrustedNativeContext {
    this.#live()
    assertBinding(binding, binding)
    if (
      !isDeepStrictEqual(binding.target, this.config.target) ||
      binding.machine_id !== this.config.target.machine_id ||
      binding.provider_kind !== 'luvus' ||
      binding.binding_revision !== this.config.binding_revision ||
      binding.contract_ref !== contractRef(this.contract.wire.source)
    ) {
      throw new LuvusAdapterError('owned_binding_mismatch')
    }
    const source = this.contract.wire.source
    const native: NativeBinding = Object.freeze({
      kind: 'luvus',
      provider_id: this.config.target.provider_id,
      binding_revision: this.config.binding_revision,
      contract_source_ref: binding.contract_ref,
      target: Object.freeze({
        machine_id: this.config.target.machine_id,
        profile: 'session',
        session: this.config.target.session
      }),
      server_generation: source.runtime_generation,
      connection_epoch: binding.connection_epoch,
      recovery_generation: binding.recovery_generation,
      capability_revision: this.contract.capability_revision,
      caller_policy_revision: binding.registration.caller_policy_revision,
      local_policy_revision: binding.registration.local_policy_revision,
      classification_revision: source.classification_revision!,
      contract: this.contract.compiled.identity
    })
    return Object.freeze({ binding: native, authenticated: true, source_verified: true })
  }

  /** 对 adapter 实际同一 socket 读取 SO_PEERCRED，并与直接 child 的启动身份核对。 */
  async verifyPeer(socket: Socket, endpoint: EndpointIdentity, binding: AttemptBinding): Promise<PeerIdentity> {
    this.source(binding)
    if (
      endpoint.address !== this.#endpoint.address ||
      endpoint.stamp !== this.#endpoint.stamp ||
      endpoint.uid !== this.#endpoint.uid
    ) {
      throw new LuvusAdapterError('owned_endpoint_mismatch')
    }
    await recheckEndpoint(this.config, endpoint)
    this.source(binding)
    const peer = readLinuxLuvusPeer(socket)
    if (!isDeepStrictEqual(peer, this.#process.identity())) {
      throw new LuvusAdapterError('owned_peer_mismatch')
    }
    this.#evidence.set(endpoint, { socket, binding: boundedJson(binding), peer })
    return peer
  }

  /** 只接受同一 endpoint 引用下仍活着的实测 socket，拒绝 JSON 复述或跨 attempt 借用。 */
  assertEvidence(binding: AttemptBinding, evidence: NativeTransportEvidence): void {
    this.source(binding)
    const proof = this.#evidence.get(evidence.endpoint)
    if (
      evidence.transport !== 'ipc' ||
      evidence.proxy_pid !== undefined ||
      !proof ||
      proof.binding !== boundedJson(binding) ||
      !isDeepStrictEqual(evidence.peer, proof.peer) ||
      !isDeepStrictEqual(readLinuxLuvusPeer(proof.socket), proof.peer) ||
      !isDeepStrictEqual(proof.peer, this.#process.identity())
    ) {
      throw new LuvusAdapterError('owned_evidence_untrusted')
    }
  }

  /** 每个完整 epoch/策略上下文独立绑定，沿用原始签发和到期时刻且不刷新原生 token。 */
  delegation(binding: AttemptBinding): LuvusBoundDelegation {
    const source = this.source(binding)
    const key = boundedJson(source.binding)
    let delegation = this.#delegations.get(key)
    if (!delegation) {
      if (this.#delegations.size >= 128) {
        throw new LuvusAdapterError('owned_delegation_limit')
      }
      delegation = new LuvusBoundDelegation({
        config_ref: this.config.config_ref,
        binding: source.binding,
        ...this.issuance,
        token: this.#token!
      })
      this.#delegations.set(key, delegation)
    }
    return delegation
  }

  /** 就绪来自每次实际身份与固定期限复核，来源丢失不会返回固定成功。 */
  ready(): boolean {
    try {
      this.#live()
      return true
    } catch {
      return false
    }
  }

  /** 关闭所有内存委托并只终止本轮直接 child；不删除运行状态或接管其它实例。 */
  close(): Promise<void> {
    this.#clear()
    if (this.#closing) {
      return this.#closing
    }
    const attempt = this.#process.close()
    this.#closing = attempt
    void attempt.then(
      /* 成功后重复关闭复用真实 child 已退出的事实，来源不会恢复。 */ () => {
        if (this.#closing === attempt) {
          this.#closing = undefined
        }
      },
      /* 失败只允许后续显式停止重试；秘密已撤销，拥有标记和真实 child 归属仍保留。 */ () => {
        if (this.#closing === attempt) {
          this.#closing = undefined
        }
      }
    )
    return attempt
  }

  /** 失效后永久释放本对象及其全部已交付 delegation 的秘密引用。 */
  #clear(): void {
    this.#token = undefined
    for (const delegation of this.#delegations.values()) {
      delegation.close()
    }
    this.#delegations.clear()
  }

  /** 同步复核受控 child、endpoint、目录标记和实际签发截止；回拨后永久失效。 */
  #live(): void {
    try {
      const now = Date.now()
      if (!this.#token || this.#closing || now < this.#clock || now >= this.issuance.expires_at) {
        throw new LuvusAdapterError('owned_instance_unavailable')
      }
      this.#clock = now
      this.#process.assertLive()
      if (ownedPathStamp(this.#endpoint.address, 'socket') !== this.#endpointStamp) {
        throw new LuvusAdapterError('owned_endpoint_mismatch')
      }
      for (const [path, stamp] of this.#markers) {
        if (markerStamp(path) !== stamp) {
          throw new LuvusAdapterError('owned_marker_changed')
        }
      }
    } catch (error) {
      this.#clear()
      throw error instanceof LuvusAdapterError ? error : new LuvusAdapterError('owned_instance_unavailable')
    }
  }
}

/** 仅显式非生产、自有空白目录可启动固定官方 server；Owner 引导口不会交付到公共 RPC。 */
export async function startDevelopmentLuvus(
  config: LuvusLocalConfig,
  options: DevelopmentLuvusOptions
): Promise<OwnedLuvusInstance> {
  let child: OwnedNativeProcess | undefined
  let markers: readonly [string, string][] = []
  let token: string | undefined
  const fixed = developmentConfig(config, options)
  const ttl = options.token_ttl_s
  const requestedScopes = Object.freeze([...(options.scopes ?? ['read'])]) as readonly ('read' | 'orchestration')[]
  // 在首个 await 前复制并再次核对，外部对象后续修改不能扩大 native custody。
  developmentConfig(fixed, {
    acknowledge_nonproduction: true,
    token_ttl_s: ttl,
    scopes: requestedScopes as DevelopmentLuvusOptions['scopes']
  })
  const limits = localLimits(fixed.limits)
  const scope = deadline(undefined, limits.timeout_ms)
  try {
    assertBlankRoots(fixed)
    await verifyInstallation(fixed)
    markers = claimBlankRoots(fixed)
    const schema = await runFixedProcess(fixed, limits, 'schema', scope.signal)
    if (schema.exit_code !== 0 || hash(schema.stdout) !== officialSchema) {
      throw new LuvusAdapterError('development_schema_mismatch')
    }
    const compiled = await compileBundle(
      schema.stdout,
      {
        identity: {
          binary_sha256: fixed.binary_sha256,
          schema_sha256: officialSchema,
          revision: DEVELOPMENT_LUVUS_REVISION
        }
      },
      scope.signal
    )
    if (!compiled.ok) {
      throw new LuvusAdapterError(compiled.error.code)
    }
    const validator = createNativeValidator(compiled.value)
    child = new OwnedNativeProcess(fixed)
    await child.started()
    const ownedChild = child
    let endpoint: EndpointIdentity | undefined
    while (!endpoint) {
      ownedChild.assertLive()
      const discovery = await runFixedProcess(fixed, limits, 'sessions', scope.signal)
      const parsed = parseNativeJson(discovery.stdout, { object_bytes: Math.min(limits.discovery_bytes, 1_048_576) })
      if (
        discovery.exit_code !== 0 ||
        !parsed.ok ||
        !parsed.value ||
        typeof parsed.value !== 'object' ||
        Array.isArray(parsed.value)
      ) {
        throw new LuvusAdapterError('development_discovery_invalid')
      }
      const sessions = (parsed.value as Record<string, unknown>).sessions
      if (!Array.isArray(sessions)) {
        throw new LuvusAdapterError('development_discovery_invalid')
      }
      const rows = sessions.filter(
        /* 只把固定 session 名称作为地址发现，不相信广告 PID。 */ (row) =>
          row?.name === fixed.target.session && row.running === true
      )
      if (rows.length > 1) {
        throw new LuvusAdapterError('development_discovery_invalid')
      }
      if (rows.length === 1) {
        endpoint = await inspectEndpoint(fixed, rows[0].endpoint?.address)
      } else {
        await new Promise(/* 等待本轮 server 建立 socket，仍受启动总期限约束。 */ (resolve) => setTimeout(resolve, 20))
      }
    }
    const pinnedEndpoint = endpoint
    const endpointStamp = ownedPathStamp(endpoint.address, 'socket')
    let ownerBootstrap = true
    /** 私有固定引导/核对 RPC，只能在同一实测 peer 上执行有限创建和只读白名单。 */
    async function bootstrap(
      method: 'uhp.token.create' | 'uhp.capabilities' | 'task.list' | 'automation.list' | 'module.list',
      params: Record<string, unknown> = {}
    ) {
      ownedChild.assertLive()
      if (
        scope.signal.aborted ||
        ownedPathStamp(pinnedEndpoint.address, 'socket') !== endpointStamp ||
        (!token && (method !== 'uhp.token.create' || !ownerBootstrap)) ||
        (token && method === 'uhp.token.create')
      ) {
        throw new LuvusAdapterError('development_bootstrap_closed')
      }
      if (!token) {
        ownerBootstrap = false
      }
      const id = randomUUID()
      const bytes = Buffer.from(boundedJson({ id, method, params, ...(token ? { auth: token } : {}) }) + '\n')
      const reply = await runSocket(
        pinnedEndpoint.address,
        limits.response_bytes,
        scope.signal,
        /** 写入前独立测量实际 socket，来源变化立即拒绝且不会重试 token 创建。 */ async (socket) => {
          await recheckEndpoint(fixed, pinnedEndpoint)
          ownedChild.assertLive()
          if (!isDeepStrictEqual(readLinuxLuvusPeer(socket), ownedChild.identity())) {
            throw new LuvusAdapterError('owned_peer_mismatch')
          }
          return {
            bytes,
            /** 最后一次 await 后再次核验固定进程和 endpoint，随后写入唯一帧。 */
            beforeWrite() {
              ownedChild.assertLive()
              if (
                ownedPathStamp(pinnedEndpoint.address, 'socket') !== endpointStamp ||
                !isDeepStrictEqual(readLinuxLuvusPeer(socket), ownedChild.identity())
              ) {
                throw new LuvusAdapterError('owned_peer_mismatch')
              }
            }
          }
        }
      )
      const frame = parseRpcFrame(reply, limits.response_bytes)
      if (frame.id !== id || !validator.checkResponseShape(frame).ok) {
        throw new LuvusAdapterError('development_response_invalid')
      }
      return { frame, result: resultObject(frame) }
    }
    const scopes = requestedScopes
    const issuedAt = Date.now()
    const issued = (await bootstrap('uhp.token.create', { scopes, ttl_s: ttl })).result
    const expires = typeof issued.expires_at === 'number' ? issued.expires_at * 1000 : NaN
    if (
      !isDeepStrictEqual(issued.scopes, scopes) ||
      typeof issued.token !== 'string' ||
      !/^[!-~]{1,256}$/u.test(issued.token) ||
      !Number.isSafeInteger(expires) ||
      expires <= Date.now() ||
      expires > Date.now() + ttl * 1000
    ) {
      throw new LuvusAdapterError('development_issuance_invalid')
    }
    token = issued.token
    const observedCapabilities = await bootstrap('uhp.capabilities')
    const capabilities = observedCapabilities.result
    const protocol = capabilities.protocol as Record<string, unknown> | undefined
    if (
      typeof capabilities.server_generation !== 'string' ||
      !capabilities.server_generation.length ||
      capabilities.server_generation.length > 512 ||
      capabilities.session !== fixed.target.session ||
      protocol?.name !== 'luvus-uhp' ||
      protocol.major !== 1 ||
      protocol.minor !== 0
    ) {
      throw new LuvusAdapterError('development_capabilities_invalid')
    }
    for (const method of ['task.list', 'automation.list', 'module.list'] as const) {
      const preflight = (await bootstrap(method)).result
      const rows = preflight.tasks ?? preflight.automations ?? preflight.modules
      if (!Array.isArray(rows) || rows.length !== 0) {
        throw new LuvusAdapterError('development_instance_not_blank')
      }
    }
    const source: ContractSource = Object.freeze({
      provider_kind: 'luvus',
      protocol_family: 'uhp',
      binary_version: '0.14.3',
      binary_sha256: fixed.binary_sha256,
      schema_sha256: officialSchema,
      schema_origin: 'installed_cli',
      schema_command: 'luvus uhp schema',
      server_version: '0.14.3',
      native_protocol_version: '1.0',
      runtime_generation: capabilities.server_generation,
      adapter_revision: DEVELOPMENT_LUVUS_REVISION,
      classification_revision: DEVELOPMENT_LUVUS_CLASSIFICATION,
      support_basis: 'live_catalog'
    })
    // validator 需要这次原生响应的真实 id/result envelope；仅 result 会丢失契约所需的响应形状。
    const immutableCaps = parseNativeJson(boundedJson(observedCapabilities.frame, limits.discovery_bytes), {
      object_bytes: Math.min(limits.discovery_bytes, 1_048_576)
    })
    if (!immutableCaps.ok) {
      throw new LuvusAdapterError('development_capabilities_invalid')
    }
    const contract = Object.freeze({
      wire: Object.freeze({ source, support_status: 'validated' as const }),
      compiled: compiled.value,
      capabilities: immutableCaps.value,
      capability_revision: hash(boundedJson(capabilities, limits.discovery_bytes))
    })
    const issuance = Object.freeze({
      issued_at: issuedAt,
      expires_at: expires,
      scopes,
      methods: Object.freeze(
        scopes.includes('orchestration') ? ['automation.list', 'task.add', 'task.update'] : ['automation.list']
      )
    })
    const instance = new DevelopmentInstance(fixed, ownedChild, pinnedEndpoint, markers, contract, issuance, token)
    token = undefined
    if (!instance.ready()) {
      await instance.close()
      throw new LuvusAdapterError('owned_instance_unavailable')
    }
    return instance
  } catch (error) {
    token = undefined
    // 未确认退出时 close 会有界拒绝并保留 child/pidfd 与拥有标记，不向 caller 宣称清理成功。
    await child?.close()
    releaseMarkers(markers)
    throw error instanceof LuvusAdapterError ? error : new LuvusAdapterError('development_bootstrap_failed')
  } finally {
    scope.close()
  }
}
