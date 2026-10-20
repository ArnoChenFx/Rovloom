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
import { createNativeValidator, parseNativeJson } from '../native-contract/index.js'
import type { TrustedNativeContext } from '../native-contract/index.js'
import type { NativeContractRecord } from '../integration/luvus-wire.js'
import { boundedJson } from '../wire/index.js'
import type { AttemptBinding, ContractSource } from '../wire/types.js'
import { OwnedNativeProcess, ownedPathStamp } from './native-process.js'
import { NativeCustodyContext } from './native-context.js'
import { FIXED_LUVUS_SHA256, discoverLuvusInstallation } from './native-control.js'

export const DEVELOPMENT_LUVUS_SHA256 = FIXED_LUVUS_SHA256
export const DEVELOPMENT_LUVUS_REVISION = 'development-owned-luvus-0.14.3-1'
export const DEVELOPMENT_LUVUS_CLASSIFICATION = 'development-owned-rpc-1'
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
  if (!process.versions.bun || process.arch !== 'x64' || fixed.transport !== 'ipc') {
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

/** 开发入口复用同一实测来源/custody 核心，并在关闭时继续拥有并终止本轮 child。 */
class DevelopmentInstance extends NativeCustodyContext implements OwnedLuvusInstance {
  readonly [owned] = true as const
  readonly #process: OwnedNativeProcess
  #closing: Promise<void> | undefined

  /** 只接收本工厂真实启动和引导的资源，开发标记仍逐次独立核验。 */
  constructor(
    config: LuvusLocalConfig & { readonly transport: 'ipc' },
    child: OwnedNativeProcess,
    endpoint: EndpointIdentity,
    markers: readonly [string, string][],
    contract: NativeContractRecord,
    issuance: LuvusIssuanceMetadata,
    token: string
  ) {
    super(
      config,
      child,
      endpoint,
      /* 校验自有开发标记，不从调用 JSON 建立来源。 */ () => {
        for (const [path, stamp] of markers) {
          if (markerStamp(path) !== stamp) {
            throw new LuvusAdapterError('owned_marker_changed')
          }
        }
      },
      contract,
      issuance,
      token
    )
    this.#process = child
  }

  /** 关闭所有内存委托并只终止本轮直接 child；不删除运行状态或接管其它实例。 */
  close(): Promise<void> {
    this.clearCustody()
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
    const discovery = await discoverLuvusInstallation(fixed, {
      revision: DEVELOPMENT_LUVUS_REVISION,
      signal: scope.signal
    })
    const validator = createNativeValidator(discovery.compiled)
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
      !Number.isSafeInteger(protocol.minor) ||
      (protocol.minor as number) < 0
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
      binary_version: discovery.binaryVersion,
      binary_sha256: fixed.binary_sha256,
      schema_sha256: discovery.compiled.identity.schema_sha256,
      schema_origin: 'installed_cli',
      schema_command: 'luvus uhp schema',
      server_version: null,
      native_protocol_version: `${protocol.major}.${protocol.minor}`,
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
      compiled: discovery.compiled,
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
