// 实现主动出站的 Connector 通道，隔离连接 epoch、原生执行与退避重连，禁止自动重放。
import { randomUUID } from 'node:crypto'
import { boundedJson, decodeWireFrame, encodeWireFrame, fail, LIMITS, validateOffer } from '../wire/index.js'
import type { AttemptBinding, AuthenticatedEnvelope, JsonObject, VersionOffer } from '../wire/types.js'
import type { DeviceCredential } from './identity.js'
import {
  budget,
  closeSession,
  endpoint,
  envelope,
  OFFER,
  positive,
  providerHealth,
  ready,
  ReceiveWindow,
  socket
} from './common.js'
import type { Connection, Session, Socket } from './common.js'

export type ConnectorOptions = {
  url: string
  developmentLoopback?: boolean
  ca?: string
  /** 从受保护启动输入取得稳定设备凭据，不能按自报 hostname 创建身份。 */
  credential(): DeviceCredential
  /** 为当前认证连接创建独立 adapter、可信 readiness 和资源清理接口。 */
  session(connection: Connection): Session
  /** 只向已校验请求注入受信原生 auth；调用方随后检查完整 JSON 帧预算。 */
  nativeInput(request: JsonObject, binding: AttemptBinding): JsonObject
  /** 按账本固定 binding 选择受信本机 adapter，接收观察中止并返回原生响应。 */
  execute(raw: string, signal: AbortSignal, binding: AttemptBinding): Promise<JsonObject>
  offer?: VersionOffer
  /** 提供有界退避的随机采样，不影响请求授权或派发去重。 */
  random?: () => number
  /** 提供独立可信时间，调用方仍须检查单调性和固定到期边界。 */
  now?: () => number
  limits?: Partial<{
    heartbeat_ms: number
    idle_ms: number
    handshake_ms: number
    reconnect_ms: number
    reconnect_max_ms: number
    inflight: number
    frame_bytes: number
    native_bytes: number
    messages_per_second: number
  }>
}
/** 建立受信配置驱动的出站通道，管理握手、心跳、限额和退避；重连不迁入或重放原请求。 */
export function createConnector(options: ConnectorOptions) {
  const url = endpoint(options.url, options.developmentLoopback).href
  const limits = {
    heartbeat_ms: 5000,
    idle_ms: 20_000,
    handshake_ms: 5000,
    reconnect_ms: 250,
    reconnect_max_ms: 30_000,
    inflight: 8,
    frame_bytes: LIMITS.frame_bytes,
    native_bytes: LIMITS.frame_bytes,
    messages_per_second: 256,
    ...options.limits
  }
  Object.values(limits).forEach(
    /** 逐项验证 Connector 资源配置，拒绝非正数或不安全整数。 */
    (v) => positive(v)
  )
  positive(limits.frame_bytes, LIMITS.frame_bytes)
  positive(limits.native_bytes, LIMITS.frame_bytes)
  const offer = structuredClone(options.offer ?? OFFER)
  validateOffer(offer)
  const instance = randomUUID()
  let ws: Socket | undefined
  let connection: Connection | undefined
  let session: Session | undefined
  let stopped = false
  let phase = 'disconnected'
  let next = 0
  let retries = 0
  let opened = 0
  let last = 0
  let sentAt = 0
  let sent = 0
  let sequence = 0
  let messages = 0
  let messageWindow = 0
  const running = new Map<string, { controller: AbortController; binding: AttemptBinding }>()
  const seen = new Set<string>()
  let received = new ReceiveWindow()
  let observedTime = 0
  /** 读取宿主可信时间并保持进程内高水位，回拨时拒绝继续执行。 */
  function trustedTime(): number {
    const now = (options.now ?? Date.now)()
    if (!Number.isSafeInteger(now) || now < observedTime) {
      fail('clock_untrusted')
    }
    observedTime = now
    return now
  }
  /** 中止旧会话观察、关闭宿主资源并清空连接去重状态；未完成原生工作仍占并发额度。 */
  function clearSession(): void {
    for (const { controller } of running.values()) {
      controller.abort()
    }
    try {
      closeSession(session)
    } catch {
      /* 关闭错误不进入日志。 */
    }
    session = undefined
    connection = undefined
    seen.clear()
    received = new ReceiveWindow()
  }
  /** 移除当前 socket 并清理会话，按有界抖动退避安排重连；停止状态不再重连。 */
  function close(): void {
    const previous = ws
    ws = undefined
    clearSession()
    phase = stopped ? 'stopped' : 'disconnected'
    if (!stopped) {
      const random = (options.random ?? Math.random)()
      const jitter = Number.isFinite(random) ? Math.max(0, Math.min(1, random)) : 1
      next =
        performance.now() +
        Math.max(1, jitter * Math.min(limits.reconnect_max_ms, limits.reconnect_ms * 2 ** Math.min(retries++, 16)))
    }
    previous?.close(1000, 'transport_closed')
    previous?.terminate()
  }
  /** 用当前认证上下文编码并写出单帧，预算或背压异常交给调用者收敛关闭。 */
  function write(frame: AuthenticatedEnvelope): void {
    if (!session || !connection || !ws || ws.readyState !== 1) {
      fail('connection_unavailable')
    }
    const raw = budget(session.adapter.encode(frame, 'connector_to_gateway'), limits.frame_bytes)
    if (ws.bufferedAmount + Buffer.byteLength(raw) > limits.frame_bytes || ws.send(raw) <= 0) {
      fail('transport_backpressure')
    }
  }
  /** 消费单次 attempt，复验 ready/deadline 并在 auth 注入后检查完整预算；旧会话响应不再交付。 */
  async function request(
    frame: Extract<AuthenticatedEnvelope, { type: 'request' }>,
    active: Connection,
    current: Session
  ): Promise<void> {
    const binding: AttemptBinding = { ...active, ...frame.payload.attempt }
    const name = binding.call_id + ':' + binding.attempt_id
    if (seen.has(name)) {
      fail('attempt_replay_rejected')
    }
    if (seen.size >= 4096 || running.size >= limits.inflight) {
      fail('transport_concurrency_limit')
    }
    if (!ready(current, active, binding.target.provider_id)) {
      fail('provider_not_ready')
    }
    if (trustedTime() >= binding.registration.deadline) {
      fail('deadline_exceeded')
    }
    seen.add(name)
    const controller = new AbortController()
    running.set(name, { controller, binding })
    try {
      const original = { ...frame.payload.native_request, id: binding.native_request_id }
      const injected = options.nativeInput(structuredClone(original), structuredClone(binding))
      const { auth: _auth, ...withoutAuth } = injected
      if (boundedJson(withoutAuth) !== boundedJson(original)) {
        fail('native_input_mismatch')
      }
      const raw = budget(boundedJson(injected, limits.native_bytes), limits.native_bytes)
      if (trustedTime() >= binding.registration.deadline) {
        fail('deadline_exceeded')
      }
      write(envelope(active, 'accepted', { attempt: frame.payload.attempt }))
      const execution = structuredClone(binding)
      // 注入、完整编码和 accepted 发送均可能耗时；跨宿主执行边界前最后复验。
      if (
        controller.signal.aborted ||
        connection !== active ||
        session !== current ||
        stopped ||
        !ready(current, active, binding.target.provider_id)
      ) {
        fail('provider_not_ready')
      }
      if (trustedTime() >= binding.registration.deadline) {
        fail('deadline_exceeded')
      }
      const response = await options.execute(raw, controller.signal, execution)
      if (controller.signal.aborted || connection !== active || session !== current || stopped) {
        return
      }
      write(envelope(active, 'response', { attempt: frame.payload.attempt, native_response: response }))
    } finally {
      running.delete(name)
      current.adapter.release(binding)
    }
  }
  /** 从受保护启动回调读取稳定身份，创建 socket 并安装只作用于该连接的事件处理器。 */
  function connect(): void {
    let credential: DeviceCredential
    try {
      credential = structuredClone(options.credential())
    } catch {
      close()
      return
    }
    const messageId = randomUUID()
    let current: Socket
    try {
      current = socket(url, options.ca)
    } catch {
      close()
      return
    }
    ws = current
    phase = 'connecting'
    opened = last = sentAt = performance.now()
    sent = sequence = messages = 0
    messageWindow = opened
    current.onopen =
      /** 在链路建立后发送绑定本次消息 ID 的 authenticate，凭据不进入 URL 或普通输出。 */
      () => {
        if (ws !== current || stopped) {
          return
        }
        try {
          const raw = encodeWireFrame(
            {
              protocol_major: offer.major,
              protocol_minor: offer.minor,
              type: 'authenticate',
              message_id: messageId,
              payload: {
                machine_id: credential.machine_id,
                recovery_generation: credential.recovery_generation,
                connector_instance_id: instance,
                device_credential: credential.credential,
                offer
              }
            },
            { phase: 'preauth', direction: 'connector_to_gateway' }
          )
          current.send(budget(raw, limits.frame_bytes))
        } catch {
          close()
        }
      }
    current.onmessage =
      /** 处理 welcome 和已认证业务帧，核对方向、epoch、序号和重复消息后才进入执行路径。 */
      (event) => {
        if (ws !== current || stopped) {
          return
        }
        try {
          if (typeof event.data !== 'string') {
            fail('text_frame_required')
          }
          budget(event.data, limits.frame_bytes)
          const now = performance.now()
          if (now - messageWindow >= 1000) {
            messageWindow = now
            messages = 0
          }
          if (++messages > limits.messages_per_second) {
            fail('message_rate_limit')
          }
          if (!connection) {
            const frame = decodeWireFrame(event.data, {
              phase: 'preauth',
              direction: 'gateway_to_connector',
              offer,
              handshake_message_id: messageId
            })
            if (
              frame.type !== 'welcome' ||
              frame.payload.machine_id !== credential.machine_id ||
              frame.payload.recovery_generation !== credential.recovery_generation
            ) {
              fail('authentication_required')
            }
            const { in_reply_to: _reply, selected, ...identity } = frame.payload
            connection = { ...identity, authenticated: true, active: true, negotiated: selected }
            session = options.session(structuredClone(connection))
            phase = 'authenticated'
            last = now
            return
          }
          if (!session) {
            fail('connection_unavailable')
          }
          if (received.observe(event.data, now) === 'duplicate') {
            return
          }
          const frame = session.adapter.decode(event.data, 'gateway_to_connector')
          if (!('connection_epoch' in frame)) {
            fail('authentication_required')
          }
          if (session.adapter.observeMessage(frame, 'gateway_to_connector') === 'duplicate') {
            return
          }
          if (frame.type === 'heartbeat') {
            if (frame.payload.sequence !== sequence++) {
              fail('heartbeat_sequence_mismatch')
            }
            last = now
          } else if (frame.type === 'request') {
            void request(frame, connection, session).catch(
              /** 仅关闭仍对应当前 socket 的失败执行，避免旧会话异常影响新连接。 */
              () => {
                if (ws === current) {
                  close()
                }
              }
            )
          } else {
            fail('transport_feature_unavailable')
          }
        } catch {
          close()
        }
      }
    current.onclose =
      /** 将当前 socket 的关闭事件收敛到清理和重连；过期 socket 的事件被忽略。 */
      () => {
        if (ws === current) {
          close()
        }
      }
    current.onerror =
      /** 隐藏底层网络错误原文，并让当前连接按统一关闭路径回收资源。 */
      () => {
        if (ws === current) {
          close()
        }
      }
  }
  const timer = setInterval(
    /** 用单个 timer 推进握手超时、心跳、观察中止和退避连接，不排队旧业务。 */
    () => {
      if (stopped) {
        return
      }
      const now = performance.now()
      if (!ws) {
        if (now >= next) {
          connect()
        }
        return
      }
      try {
        if (!connection) {
          if (now - opened >= limits.handshake_ms) {
            close()
          }
          return
        }
        if (!session || now - last >= limits.idle_ms) {
          close()
          return
        }
        for (const { controller, binding } of running.values()) {
          if (
            !ready(session, connection, binding.target.provider_id) ||
            trustedTime() >= binding.registration.deadline
          ) {
            controller.abort()
          }
        }
        if (now - sentAt >= limits.heartbeat_ms) {
          write(envelope(connection, 'heartbeat', { sequence: sent++ }))
          sentAt = now
        }
        if (ready(session, connection)) {
          phase = 'ready'
          if (now - opened >= limits.idle_ms) {
            retries = 0
          }
        } else {
          phase = 'authenticated'
        }
      } catch {
        close()
      }
    },
    Math.min(100, limits.heartbeat_ms, limits.handshake_ms, limits.reconnect_ms)
  )
  connect()
  return {
    /** 返回有界连接与 provider 健康观测，不包含凭据或原生内容。 */
    status() {
      return {
        phase,
        running: running.size,
        reconnects: retries,
        machine_id: connection?.machine_id,
        connection_epoch: connection?.connection_epoch,
        providers: connection && session ? providerHealth(connection, session.readiness()) : []
      }
    },
    disconnect: close,
    /** 幂等停止 timer、socket 和观察资源；不会据此宣称原生动作已回滚。 */
    stop(): void {
      if (stopped) {
        return
      }
      stopped = true
      clearInterval(timer)
      close()
    }
  }
}
