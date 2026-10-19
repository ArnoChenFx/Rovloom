/** Gateway 的认证 Connector 通道来源；只证明当前通道和配置契约，不证明远端本机 binary/peer 测量。 */
import type { Connection, SocketChannel } from '../../transport/index.js'
import { assertBinding, boundedJson, fail } from '../../wire/index.js'
import type { AttemptBinding, V2Target } from '../../wire/types.js'

export type HerdrLocalSource = Readonly<{ role: 'local_installation'; binding: AttemptBinding; token: object }>
export type HerdrGatewaySource = Readonly<{ role: 'authenticated_connector'; binding: AttemptBinding; token: object }>
export type HerdrSource = HerdrLocalSource | HerdrGatewaySource
const gatewaySources = new WeakMap<HerdrGatewaySource, () => void>()

/** 仅资源工厂的受保护 session 宿主可交付通道；业务 JSON 不能构造函数、owner 或内部来源品牌。 */
export function createHerdrGatewaySourceOwner(
  options: Readonly<{
    channel: SocketChannel
    connection: Connection
    target: V2Target
    binding_revision: number
    contract_ref: string
    assertCurrent(): void
  }>
) {
  const connection = structuredClone(options.connection)
  const target = boundedJson(options.target)
  const channel = options.channel
  const configuredRevision = options.binding_revision
  const configuredContract = options.contract_ref
  const token = Object.freeze({})
  let closed = false

  /** 必须仍是同一个已认证 socket epoch，且宿主配置和完整契约保持当前有效。 */
  function assertCurrent(): void {
    if (closed) {
      fail('native_source_untrusted')
    }
    try {
      options.assertCurrent()
      const current = channel.connection()
      if (
        closed ||
        current.authenticated !== true ||
        current.active !== true ||
        boundedJson(current) !== boundedJson(connection)
      ) {
        fail('native_source_untrusted')
      }
    } catch (error) {
      closed = true
      throw error
    }
  }
  assertCurrent()
  return Object.freeze({
    assertCurrent,
    /** 来源只覆盖本配置的完整 Target/ref/revision，不从响应字段或 caller 自报值发行。 */
    source(binding: AttemptBinding): HerdrGatewaySource | undefined {
      assertCurrent()
      if (
        binding.provider_kind !== 'herdr' ||
        binding.binding_revision !== configuredRevision ||
        binding.contract_ref !== configuredContract ||
        boundedJson(binding.target) !== target
      ) {
        return undefined
      }
      assertBinding(binding, {
        ...binding,
        machine_id: connection.machine_id,
        recovery_generation: connection.recovery_generation,
        connection_epoch: connection.connection_epoch
      })
      const source: HerdrGatewaySource = Object.freeze({
        role: 'authenticated_connector',
        binding: structuredClone(binding),
        token
      })
      gatewaySources.set(source, assertCurrent)
      return source
    },
    /** owner 关闭即时撤销已发行品牌；不操作远端进程或业务账本。 */
    close(): void {
      closed = true
    }
  })
}

/** 只有内部发行且其原 owner/epoch 仍有效的 Gateway 来源能进入普通 Wire 证据校验。 */
export function isAuthenticatedHerdrSource(source: HerdrGatewaySource): boolean {
  const check = gatewaySources.get(source)
  if (!check) {
    return false
  }
  try {
    check()
    return true
  } catch {
    return false
  }
}
