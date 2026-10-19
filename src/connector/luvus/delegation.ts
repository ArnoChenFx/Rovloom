/** 绑定外部可信 custody 交付的有限委托；本模块不发行 token、不证明 native 归属或授予权限。 */
import { isDeepStrictEqual } from 'node:util'
import { boundedJson } from '../../wire/index.js'
import type { NativeBinding, TrustedNativeContext } from '../../native-contract/index.js'
import { LuvusAdapterError } from './types.js'

export type LuvusDelegationContext = Readonly<{
  config_ref: string
  binding: NativeBinding
}>
export type LuvusDelegationInput = LuvusDelegationContext &
  Readonly<{
    // 只允许当前已审普通 RPC 所需 scope；不会从 scope 推导 method 或执行许可。
    scopes: readonly ('read' | 'orchestration')[]
    methods: readonly string[]
    issued_at: number
    expires_at: number
    token: string
  }>

/** 保留有界上下文副本；绑定来自受保护来源，不能从 Wire/调用参数导入。 */
function context(value: LuvusDelegationContext): LuvusDelegationContext {
  const copy = JSON.parse(
    boundedJson({ config_ref: value.config_ref, binding: value.binding }, 16_384)
  ) as LuvusDelegationContext
  const native = copy.binding
  if (
    typeof copy.config_ref !== 'string' ||
    copy.config_ref.length < 1 ||
    copy.config_ref.length > 256 ||
    native?.kind !== 'luvus' ||
    native.target?.profile !== 'session' ||
    typeof native.server_generation !== 'string' ||
    !native.server_generation ||
    !/^[a-f0-9]{64}$/.test(native.contract?.binary_sha256) ||
    !/^[a-f0-9]{64}$/.test(native.contract?.schema_sha256)
  ) {
    throw new LuvusAdapterError('native_delegation_invalid')
  }
  return copy
}

/** 只在同一完整来源、方法和固定期限内交付内存 secret；close/过期/回拨后永久失效。 */
export class LuvusBoundDelegation {
  readonly #context: LuvusDelegationContext
  readonly #methods: ReadonlySet<string>
  readonly #issued: number
  readonly #expires: number
  #token: string | undefined
  #clock: number

  /** 接收现成受限 token 和真实 custody 的元数据；调用此构造器本身不构成认证。 */
  constructor(input: LuvusDelegationInput) {
    try {
      this.#context = context(input)
      if (
        !Array.isArray(input.methods) ||
        !input.methods.length ||
        input.methods.length > 128 ||
        !Array.isArray(input.scopes) ||
        !input.scopes.length ||
        input.scopes.length > 2 ||
        new Set(input.scopes).size !== input.scopes.length ||
        input.scopes.some(
          /* scope 只能收窄到本实现审过的两个值，禁止 Owner/admin/all 和通配符。 */ (scope) =>
            !['read', 'orchestration'].includes(scope)
        ) ||
        !Number.isSafeInteger(input.issued_at) ||
        input.issued_at < 0 ||
        !Number.isSafeInteger(input.expires_at) ||
        input.expires_at <= input.issued_at ||
        typeof input.token !== 'string' ||
        !input.token.length ||
        Buffer.byteLength(input.token) > 4096
      ) {
        throw new LuvusAdapterError('native_delegation_invalid')
      }
      for (const method of input.methods) {
        if (typeof method !== 'string' || !/^[a-z][a-z0-9_.:-]{0,127}$/.test(method)) {
          throw new LuvusAdapterError('native_delegation_invalid')
        }
      }
      if (new Set(input.methods).size !== input.methods.length) {
        throw new LuvusAdapterError('native_delegation_invalid')
      }
      this.#methods = new Set(input.methods)
      this.#issued = input.issued_at
      this.#expires = input.expires_at
      this.#clock = input.issued_at
      this.#token = input.token
    } catch (error) {
      throw error instanceof LuvusAdapterError ? error : new LuvusAdapterError('native_delegation_invalid')
    }
  }

  /** 当前完整来源须由正式实例来源另行验证；旧快照、有限 scope 或本对象不能替代 Wire 许可。 */
  assertCurrent(current: LuvusDelegationContext, source: TrustedNativeContext, method: string, now: number): void {
    try {
      if (
        !this.#token ||
        !Number.isSafeInteger(now) ||
        now < this.#clock ||
        now < this.#issued ||
        now >= this.#expires
      ) {
        this.close()
        throw new LuvusAdapterError('native_delegation_unavailable')
      }
      this.#clock = now
      if (
        source?.authenticated !== true ||
        source.source_verified !== true ||
        !this.#methods.has(method) ||
        !isDeepStrictEqual(this.#context, context(current)) ||
        !isDeepStrictEqual(this.#context.binding, source.binding)
      ) {
        throw new LuvusAdapterError('native_delegation_mismatch')
      }
      // 宿主属性访问也可能触发关闭；不能用先前的可用检查覆盖这次同步撤销。
      if (!this.#token) {
        throw new LuvusAdapterError('native_delegation_unavailable')
      }
    } catch (error) {
      throw error instanceof LuvusAdapterError ? error : new LuvusAdapterError('native_delegation_unavailable')
    }
  }

  /** 仅在已证明同一 socket 的宿主 nativeAuth 内使用；最终完整帧仍由原 validator 校验预算。 */
  read(current: LuvusDelegationContext, source: TrustedNativeContext, method: string, now: number): string {
    this.assertCurrent(current, source, method, now)
    const token = this.#token
    if (!token) {
      throw new LuvusAdapterError('native_delegation_unavailable')
    }
    return token
  }

  /** 不可逆移除本对象持有的 secret 引用；实际 native 撤销仍归原 custody/实例所有者。 */
  close(): void {
    this.#token = undefined
  }
}
