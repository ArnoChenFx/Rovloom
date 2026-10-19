/** 共用受控 Luvus 的同 socket peer、完整来源绑定及不可续期内存 custody，不发行或读取外部 token。 */
import { isDeepStrictEqual } from 'node:util'
import type { Socket } from 'node:net'
import { LuvusBoundDelegation, readLinuxLuvusPeer, LuvusAdapterError } from '../connector/luvus/index.js'
import type {
  EndpointIdentity,
  LuvusLocalConfig,
  NativeTransportEvidence,
  PeerIdentity
} from '../connector/luvus/index.js'
import { recheckEndpoint } from '../connector/luvus/local.js'
import type { NativeBinding, TrustedNativeContext } from '../native-contract/index.js'
import type { NativeContractRecord } from '../integration/luvus-wire.js'
import { assertBinding, boundedJson, contractRef } from '../wire/index.js'
import type { AttemptBinding } from '../wire/types.js'
import { OwnedNativeProcess, ownedPathStamp } from './native-process.js'
import type { LuvusIssuanceMetadata } from './native-instance.js'

/** 持有真实 child、peer 证据和已签发的内存 token；同形 JSON 不能构造此对象。 */
export abstract class NativeCustodyContext {
  readonly config: LuvusLocalConfig & { readonly transport: 'ipc' }
  readonly contract: NativeContractRecord
  readonly issuance: LuvusIssuanceMetadata
  readonly #process: OwnedNativeProcess
  readonly #endpoint: EndpointIdentity
  readonly #endpointStamp: string
  readonly #ownership: () => void
  readonly #evidence = new WeakMap<EndpointIdentity, { socket: Socket; binding: string; peer: PeerIdentity }>()
  readonly #delegations = new Map<string, LuvusBoundDelegation>()
  #token: string | undefined
  #clock: number

  /** 仅工厂可交付经过真实 bootstrap 的实例和不可续期签发元数据。 */
  constructor(
    config: LuvusLocalConfig & { readonly transport: 'ipc' },
    child: OwnedNativeProcess,
    endpoint: EndpointIdentity,
    ownership: () => void,
    contract: NativeContractRecord,
    issuance: LuvusIssuanceMetadata,
    token: string
  ) {
    this.config = config
    this.#process = child
    this.#endpoint = endpoint
    this.#endpointStamp = ownedPathStamp(endpoint.address, 'socket')
    this.#ownership = ownership
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

  /** 子类决定关闭是否终止进程，公用层只保证秘密同步撤销。 */
  abstract close(): void | Promise<void>

  /** 不可逆撤销本 custody，不代表 native token 已被上游撤销或进程已物理退出。 */
  protected clearCustody(): void {
    this.#clear()
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
      if (!this.#token || now < this.#clock || now >= this.issuance.expires_at) {
        throw new LuvusAdapterError('owned_instance_unavailable')
      }
      this.#clock = now
      this.#process.assertLive()
      if (ownedPathStamp(this.#endpoint.address, 'socket') !== this.#endpointStamp) {
        throw new LuvusAdapterError('owned_endpoint_mismatch')
      }
      this.#ownership()
    } catch (error) {
      this.#clear()
      throw error instanceof LuvusAdapterError ? error : new LuvusAdapterError('owned_instance_unavailable')
    }
  }
}
