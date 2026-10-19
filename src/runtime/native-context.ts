/** 共用受控实例基础并保留既有不可续期内存 custody；新的 Owner 操作不经过此授权层。 */
import { LuvusBoundDelegation, LuvusAdapterError } from '../connector/luvus/index.js'
import type { EndpointIdentity, LuvusLocalConfig } from '../connector/luvus/index.js'
import type { NativeContractRecord } from '../integration/luvus-wire.js'
import { boundedJson } from '../wire/index.js'
import type { AttemptBinding } from '../wire/types.js'
import type { OwnedNativeProcess } from './native-process.js'
import type { LuvusIssuanceMetadata } from './native-instance.js'
import { NativeInstanceContext } from './native-instance-context.js'

/** 保留真实 custody 的原签发范围和时间；不更改旧 token 来源或到期行为。 */
export abstract class NativeCustodyContext extends NativeInstanceContext {
  readonly #delegations = new Map<string, LuvusBoundDelegation>()
  #token: string | undefined
  #clock: number
  /** 继续接收既有签发材料，来源与 peer 检查由同一公用实例基础提供。 */
  constructor(
    config: LuvusLocalConfig & { readonly transport: 'ipc' },
    child: OwnedNativeProcess,
    endpoint: EndpointIdentity,
    ownership: () => void,
    contract: NativeContractRecord,
    readonly issuance: LuvusIssuanceMetadata,
    token: string
  ) {
    super(config, child, endpoint, ownership, contract)
    this.#token = token
    this.#clock = issuance.issued_at
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
      this.assertInstance()
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

  /** 只核验原 custody 的固定时钟和到期，受控实例检查仍由公用基础执行。 */
  protected assertAccess(): void {
    const now = Date.now()
    if (!this.#token || now < this.#clock || now >= this.issuance.expires_at) {
      throw new LuvusAdapterError('owned_instance_unavailable')
    }
    this.#clock = now
  }
  /** 保持旧行为：任何来源失效都永久丢弃本 custody 及其已交付 token。 */
  protected invalidateAccess(): void {
    this.#clear()
  }
}
