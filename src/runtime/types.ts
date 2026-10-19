// 定义角色宿主的稳定装配边界；配置解析、HTTP/MCP 协议与管理写服务由各自入口维护。
import type { NativeRequest } from '../contracts.js'
import type { NativeWireBackend, NativeContractRecord } from '../integration/luvus-wire.js'
import type { TrustedNativeContext } from '../native-contract/index.js'
import type { GatewayIdentitySource, CallerIdentity } from '../mcp/management.js'
import type { LocalPolicies, Principal } from '../router.js'
import type { CallAdmissionOptions, Store } from '../store.js'
import type {
  ChannelRegistry,
  DeviceLifecycleWiring,
  GatewayOptions,
  Connection,
  Readiness,
  WireConnectorOptions
} from '../transport/index.js'
import type {
  LuvusLocalConfig,
  LuvusBoundDelegation,
  LuvusDispatchClaims,
  LuvusRpcHost
} from '../connector/luvus/index.js'
import type { AttemptBinding, ProviderBinding, V2Target } from '../wire/types.js'

export type RuntimeProvider = Readonly<{
  binding: ProviderBinding
  target: V2Target
  // 来自独立受保护设备配置的预期政策修订，不从本机政策复制或设备广告自证。
  peer_policy_revision: string
  contract: NativeContractRecord
  // 每次从受保护本机来源复核实例；设备广告或请求 JSON 不能建立该事实。
  source(binding: AttemptBinding): TrustedNativeContext | undefined
  authority: NativeWireBackend['authority']
  // 来源丢失必须返回 false 或抛错，不以设备认证代替原生就绪。
  ready(): boolean
}>
export type GatewayRuntimeOptions = Readonly<{
  lifecycle: DeviceLifecycleWiring
  channels?: ChannelRegistry
  identities: GatewayIdentitySource
  localPolicies: LocalPolicies
  providers: readonly RuntimeProvider[]
  listener: Pick<GatewayOptions, 'hostname' | 'port' | 'tls' | 'developmentLoopback' | 'limits' | 'offer'>
  // 仅在显式关闭角色时释放所交付的 Store/身份库；HTTP 客户端断开不调用此端口。
  release(): Promise<void>
}>
export type RuntimeAdmissionOptions = Omit<CallAdmissionOptions, 'caller_policy_revision' | 'local_policy_revision'>
export type RuntimeCallInput = Readonly<{
  target: V2Target
  native_request: NativeRequest
  options: RuntimeAdmissionOptions
}>
export type AuthenticatedRuntimeOperation<T> = () => T | Promise<T>
export type TrustedRequestScope = {
  // 仅供完成认证的 HTTP/stdio adapter 使用；每次操作重新解析当前 principal，JSON 参数不得调用。
  runAuthenticated<T>(caller: CallerIdentity, operation: AuthenticatedRuntimeOperation<T>): Promise<T>
  // 当前请求之外、已结束的异步工作和开始关闭后均拒绝；不会记住最近 caller。
  principal(): Principal
}
export type ConnectorRuntimeOptions = Readonly<{
  transport: Omit<WireConnectorOptions, 'session'>
  // 每个 epoch 使用独立 backend；来源由可信宿主提供，不重复打开 Gateway writer。
  session(connection: Connection): Readonly<{
    backend: NativeWireBackend
    config: LuvusLocalConfig
    // 受控来源可在实际准入后按原 binding 延迟绑定委托，避免为启动会话编造 call/attempt。
    delegation: LuvusBoundDelegation | ((binding: AttemptBinding) => LuvusBoundDelegation)
    claims: LuvusDispatchClaims
    verifyPeer: NonNullable<LuvusRpcHost['verifyPeer']>
    // 固定 dedup 截止必须来自受保护准入记录；不得按重连时间重新计算。
    dedupExpires(binding: Parameters<LuvusRpcHost['claimDispatch']>[0]): number
    // 独立验证同一 socket 的实测证据后才可读 delegation 或登记 claim。
    assertEvidence: (
      binding: Parameters<LuvusRpcHost['claimDispatch']>[0],
      evidence: Parameters<LuvusRpcHost['claimDispatch']>[1]
    ) => void
    readiness(): Readiness
    close(): void
  }>
  // 停止重连和全部 epoch 资源之后释放长期 claims/custody；不能清除墓碑或自动撤销原生工作。
  release(): Promise<void>
}>
export type GatewayState = Readonly<{ store: Store; lifecycle: DeviceLifecycleWiring }>
