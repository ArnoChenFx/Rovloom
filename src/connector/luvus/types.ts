/** 定义本地适配配置、传输身份证据、宿主可信接口和不携带敏感内容的失败语义。 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Socket } from 'node:net'
import type { NativeWireBackend } from '../../integration/luvus-wire.js'
import type { AttemptBinding, V2Target } from '../../wire/types.js'

export type LuvusLocalConfig = Readonly<{
  target: V2Target & { profile: 'session' }
  binding_revision: number
  config_ref: string
  binary: string
  binary_sha256: string
  state_root: string
  home: string
  cwd: string
  transport: 'ipc' | 'cli'
  // 本机所有者显式开启直接终端执行；省略时关闭，不影响独立授权的普通 Agent 对话。
  allow_terminal_execution?: boolean
  // 仅由本机所有者配置的 Agent 安装目录，前置于固定 PATH；不开放 RPC 环境覆盖。
  agent_bin_dir?: string
  limits?: Partial<LuvusLocalLimits>
}>
export type LuvusLocalLimits = Readonly<{
  request_bytes: number
  response_bytes: number
  stderr_bytes: number
  discovery_bytes: number
  timeout_ms: number
  attempts: number
}>
export type EndpointIdentity = Readonly<{
  address: string
  uid: number
  // 包含所有父目录的身份；不只比较最后一个 socket 文件名。
  stamp: string
}>
export type PeerIdentity = Readonly<{ pid: number; uid: number; gid: number }>
export type NativeTransportEvidence = Readonly<{
  endpoint: EndpointIdentity
  transport: 'ipc' | 'cli'
  peer?: PeerIdentity
  proxy_pid?: number
}>
export type LuvusNativeAuth = string | Readonly<{ kind: 'local_owner' }>
export interface LuvusRpcHost {
  backend: NativeWireBackend
  // 可选受保护同步配置读取器；存在时每个边界重新读取，返回非 true 或抛错均不能开启。
  terminalExecution?(): boolean
  // 必须显式交付 token 或当前受控本机 Owner 模式；缺 token 不会触发隐式降级。
  nativeAuth(binding: AttemptBinding, evidence: NativeTransportEvidence): Promise<LuvusNativeAuth>
  // 宿主必须原子登记唯一派发并重查当前认证、策略、generation 和 deadline。
  // 回调成功不代表原生已经执行，失败后不得自动重试这个 attempt。
  claimDispatch(binding: AttemptBinding, evidence: NativeTransportEvidence): Promise<void>
  // 必须从已连接的同一 socket 独立测量；不能从 endpoint JSON 推断 peer。
  verifyPeer?(socket: Socket, endpoint: EndpointIdentity, binding: AttemptBinding): Promise<PeerIdentity>
  // 在 stdin 写入前独立证明代理归属；官方 proxy 此时尚未连接 native，不能等待 peer 或仅凭 child.pid 放行。
  verifyProxy?(
    child: ChildProcessWithoutNullStreams,
    endpoint: EndpointIdentity,
    binding: AttemptBinding
  ): Promise<void>
}
export type LocalFailureOutcome = 'not_dispatched' | 'outcome_unknown'

export class LuvusAdapterError extends Error {
  /** 创建只包含安全错误码和本地结果语义的异常，不携带原始请求或底层输出。 */
  constructor(
    readonly code: string,
    readonly outcome: LocalFailureOutcome = 'not_dispatched'
  ) {
    // 不把路径、token、参数、stdout/stderr 或底层异常拼入普通错误。
    super(code)
    this.name = 'LuvusAdapterError'
  }
}
