// 实现 Gateway 设备 listener，连接可信认证、逐 provider ready 与事务派发/响应账本。
import { randomUUID } from 'node:crypto'
import type { Store } from '../store.js'
import type { Router, Principal } from '../router.js'
import { commitLuvusResponse } from '../integration/persistence.js'
import { decodeWireFrame, encodeWireFrame, negotiate, fail, LIMITS, validateOffer } from '../wire/index.js'
import type { AuthenticatedEnvelope, VersionOffer } from '../wire/types.js'
import type { IdentityHost } from './identity.js'
import { ChannelRegistry } from './channel-host.js'
import type { SocketChannel } from './channel-host.js'
import { budget, envelope, loopback, OFFER, positive, providerHealth, ready, ReceiveWindow, runtime } from './common.js'
import type { Connection, Listener, ServerSocket, Session } from './common.js'

type Peer = {
  opened: number
  last: number
  sequence: number
  sent: number
  messages: number
  window: number
  connection?: Connection
  lease?: string
  session?: Session
  channel?: SocketChannel
  ws?: ServerSocket<Peer>
  closed: boolean
  received: ReceiveWindow
}
export type GatewayOptions = {
  hostname: string
  port: number
  developmentLoopback?: boolean
  tls?: { cert: string; key: string }
  identity: IdentityHost
  channels?: ChannelRegistry
  store: Store
  router: Router
  /** 从当前宿主认证上下文取得 caller，禁止根据工具 JSON 或设备帧构造。 */
  principal(): Principal
  /** 为当前认证连接创建独立 adapter、可信 readiness 和资源清理接口。 */
  session(connection: Connection, channel: SocketChannel): Session
  offer?: VersionOffer
  limits?: Partial<{
    connections: number
    unauthenticated: number
    auth_per_minute: number
    messages_per_second: number
    handshake_ms: number
    heartbeat_ms: number
    idle_ms: number
    frame_bytes: number
    inflight: number
  }>
}

/** 建立 Gateway listener 并组合可信认证、ready 与持久 RPC 账本；任何未提交的派发许可都不写出。 */
export function createGateway(options: GatewayOptions) {
  if (!options.tls && !(options.developmentLoopback && loopback(options.hostname))) {
    fail('tls_required')
  }
  const limits = {
    connections: 64,
    unauthenticated: 8,
    auth_per_minute: 120,
    messages_per_second: 256,
    handshake_ms: 5000,
    heartbeat_ms: 5000,
    idle_ms: 20_000,
    frame_bytes: LIMITS.frame_bytes,
    inflight: 128,
    ...options.limits
  }
  Object.values(limits).forEach(
    /** 逐项验证 Gateway 配额配置，避免非法数值削弱连接或发送限额。 */
    (v) => positive(v)
  )
  positive(limits.frame_bytes, LIMITS.frame_bytes)
  const offer = structuredClone(options.offer ?? OFFER)
  validateOffer(offer)
  const peers = new Set<Peer>()
  const channels = options.channels ?? new ChannelRegistry()
  const machines = new Map<string, Peer>()
  const inflight = new Map<string, AuthenticatedEnvelope & { type: 'request' }>()
  let authWindow = performance.now()
  let authAttempts = 0
  let stopped = false

  /** 先移除连接可用性，再按原 epoch 断开账本和释放 adapter/socket；已派发动作保持保守状态。 */
  function close(peer: Peer, disconnectLedger = true): void {
    if (peer.closed) {
      return
    }
    peer.closed = true
    peers.delete(peer)
    if (peer.connection) {
      if (machines.get(peer.connection.machine_id) === peer) {
        machines.delete(peer.connection.machine_id)
      }
      // 先使业务不可用，再清理 socket/adapter；失败也不允许新派发。
      if (disconnectLedger) {
        try {
          options.identity.disconnect(peer.connection)
        } catch {
          /* 存储降级保持拒绝。 */
        }
      }
      for (const [call, frame] of inflight) {
        if (frame.connection_epoch === peer.connection.connection_epoch) {
          try {
            peer.session?.adapter.release({ ...peer.connection, ...frame.payload.attempt })
          } catch {
            /* 关闭时只清资源。 */
          }
          inflight.delete(call)
        }
      }
    }
    try {
      peer.channel?.close()
    } catch {
      /* 宿主清理错误不暴露原文。 */
    }
    peer.session = undefined
    peer.ws?.close(1008, 'transport_closed')
    peer.ws?.terminate()
  }
  /** 复验 socket 的宿主认证租期及 Store fence，缺任一当前事实均拒绝业务。 */
  function assertPeer(peer: Peer): asserts peer is Peer & { connection: Connection; session: Session; lease: string } {
    if (peer.closed || !peer.connection || !peer.session || !peer.lease || !peer.channel) {
      fail('authentication_required')
    }
    const current = peer.channel.connection()
    if (
      current.machine_id !== peer.connection.machine_id ||
      current.recovery_generation !== peer.connection.recovery_generation ||
      current.connection_epoch !== peer.connection.connection_epoch
    ) {
      fail('connection_binding_mismatch')
    }
    options.identity.assert(peer.connection, peer.lease)
  }
  /** 对已认证连接编码并计量整帧，发送背压时关闭通道并拒绝继续写出。 */
  function write(peer: Peer, frame: AuthenticatedEnvelope): void {
    assertPeer(peer)
    const raw = budget(peer.session.adapter.encode(frame, 'gateway_to_connector'), limits.frame_bytes)
    if (
      !peer.ws ||
      peer.ws.getBufferedAmount() + Buffer.byteLength(raw) > limits.frame_bytes ||
      peer.ws.send(raw) <= 0
    ) {
      close(peer)
      fail('transport_backpressure')
    }
  }
  /** 处理预认证与已认证文本帧；校验来源/方向/去重后才提交 accepted 或持久响应证据。 */
  function receive(peer: Peer, input: string | Uint8Array): void {
    try {
      if (peer.closed) {
        return
      }
      const now = performance.now()
      if (now - peer.window >= 1000) {
        peer.window = now
        peer.messages = 0
      }
      if (++peer.messages > limits.messages_per_second) {
        fail('message_rate_limit')
      }
      if (typeof input !== 'string') {
        fail('text_frame_required')
      }
      budget(input, limits.frame_bytes)
      if (!peer.connection) {
        if (now - authWindow >= 60_000) {
          authWindow = now
          authAttempts = 0
        }
        if (++authAttempts > limits.auth_per_minute) {
          fail('authentication_rate_limit')
        }
        const frame = decodeWireFrame(input, {
          phase: 'preauth',
          direction: 'connector_to_gateway'
        })
        // 配对秘密仅在专用受保护 custody 交付，不扩展现有 Wire 响应。
        if (frame.type !== 'authenticate') {
          fail('protected_pairing_required')
        }
        const selected = negotiate(offer, frame.payload.offer)
        if (machines.has(frame.payload.machine_id)) {
          fail('duplicate_device_connection')
        }
        const authenticated = options.identity.authenticate(
          frame.payload.machine_id,
          frame.payload.recovery_generation,
          frame.payload.device_credential
        )
        if (
          authenticated.identity.machine_id !== frame.payload.machine_id ||
          authenticated.identity.recovery_generation !== frame.payload.recovery_generation
        ) {
          fail('connection_binding_mismatch')
        }
        const connection: Connection = {
          ...authenticated.identity,
          authenticated: true,
          active: true,
          negotiated: selected
        }
        // identity 宿主必须原子拒绝重复身份；这层 fence 再拒绝错误宿主覆盖已有连接。
        if (machines.has(connection.machine_id)) {
          options.identity.disconnect(connection)
          fail('duplicate_device_connection')
        }
        peer.connection = connection
        peer.lease = authenticated.lease
        if (!peer.channel) {
          fail('connection_binding_mismatch')
        }
        peer.channel.bind(connection)
        peer.session = options.session(structuredClone(connection), peer.channel)
        peer.channel.attach(peer.session)
        machines.set(connection.machine_id, peer)
        const welcome = encodeWireFrame(
          {
            protocol_major: 2,
            protocol_minor: 0,
            type: 'welcome',
            message_id: randomUUID(),
            payload: {
              ...authenticated.identity,
              in_reply_to: frame.message_id,
              selected
            }
          },
          {
            phase: 'preauth',
            direction: 'gateway_to_connector',
            offer: frame.payload.offer,
            handshake_message_id: frame.message_id
          }
        )
        if (!peer.ws || peer.ws.send(budget(welcome, limits.frame_bytes)) <= 0) {
          fail('transport_backpressure')
        }
        peer.last = now
        return
      }
      assertPeer(peer)
      if (peer.received.observe(input, now) === 'duplicate') {
        return
      }
      const decoded = peer.session.adapter.decode(input, 'connector_to_gateway')
      if (!('connection_epoch' in decoded)) {
        fail('authentication_required')
      }
      if (peer.session.adapter.observeMessage(decoded, 'connector_to_gateway') === 'duplicate') {
        return
      }
      if (decoded.type === 'heartbeat') {
        if (decoded.payload.sequence !== peer.sequence) {
          fail('heartbeat_sequence_mismatch')
        }
        peer.sequence++
        peer.last = now
        return
      }
      if (decoded.type !== 'accepted' && decoded.type !== 'response') {
        fail('transport_feature_unavailable')
      }
      const binding = { ...peer.connection, ...decoded.payload.attempt }
      if (decoded.type === 'accepted') {
        options.store.accepted(binding)
      } else {
        commitLuvusResponse(options.store, peer.session.adapter, decoded)
        inflight.delete(binding.call_id)
        peer.session.adapter.release(binding)
      }
    } catch {
      close(peer)
    }
  }
  const listener: Listener = runtime().serve<Peer>({
    hostname: options.hostname,
    port: options.port,
    ...(options.tls ? { tls: options.tls } : {}),
    /** 限制升级路径、Origin、总连接和未认证额度，仅为允许的请求建立有界 peer 状态。 */
    fetch(request, server) {
      const url = new URL(request.url)
      if (
        stopped ||
        request.method !== 'GET' ||
        url.pathname !== '/connector' ||
        url.search ||
        request.headers.has('origin')
      ) {
        return new Response(null, { status: 403 })
      }
      const now = performance.now()
      if (now - authWindow >= 60_000) {
        authWindow = now
        authAttempts = 0
      }
      if (
        authAttempts >= limits.auth_per_minute ||
        peers.size >= limits.connections ||
        [...peers].filter(
          /** 统计尚无设备认证上下文的 peer，防止握手连接占满资源。 */
          (p) => !p.connection
        ).length >= limits.unauthenticated
      ) {
        return new Response(null, { status: 503 })
      }
      const peer: Peer = {
        opened: now,
        last: now,
        sent: 0,
        sequence: 0,
        messages: 0,
        window: now,
        closed: false,
        received: new ReceiveWindow()
      }
      peers.add(peer)
      if (server.upgrade(request, { data: peer })) {
        return undefined
      }
      peers.delete(peer)
      return new Response(null, { status: 400 })
    },
    websocket: {
      maxPayloadLength: limits.frame_bytes,
      backpressureLimit: limits.frame_bytes,
      closeOnBackpressureLimit: true,
      perMessageDeflate: false,
      /** 把已升级 socket 绑定到预先保留的 peer，供后续帧和清理使用。 */
      open(ws) {
        ws.data.ws = ws
        try {
          ws.data.channel = channels.open(
            ws,
            /** 管理封锁只清该 socket 的 transport，不在 Store prepare 中重入主库断连。 */
            () => close(ws.data, false)
          )
        } catch {
          close(ws.data)
        }
      },
      /** 把该 socket 收到的帧交给其独立 peer 校验，避免跨连接混用身份。 */
      message(ws, message) {
        receive(ws.data, message)
      },
      /** 将 socket 关闭事件交给幂等资源回收路径，释放相应 epoch。 */
      close(ws) {
        close(ws.data)
      }
    }
  })
  const timer = setInterval(
    /** 周期清理未认证或失去心跳的连接，并复验凭据后发送有序心跳。 */
    () => {
      const now = performance.now()
      for (const peer of peers) {
        try {
          if (!peer.connection) {
            if (now - peer.opened >= limits.handshake_ms) {
              close(peer)
            }
            continue
          }
          assertPeer(peer)
          if (now - peer.last >= limits.idle_ms) {
            close(peer)
            continue
          }
          if (now - peer.opened >= limits.heartbeat_ms * (peer.sent + 1)) {
            write(peer, envelope(peer.connection, 'heartbeat', { sequence: peer.sent++ }))
          }
        } catch {
          close(peer)
        }
      }
    },
    Math.min(limits.handshake_ms, limits.heartbeat_ms, limits.idle_ms, 100)
  )

  return {
    channels,
    url: `${options.tls ? 'wss' : 'ws'}://${options.hostname.includes(':') ? '[' + options.hostname + ']' : options.hostname}:${listener.port}/connector`,
    /** 返回有界连接和 provider 健康状态；失效认证会触发关闭且不输出内容或 secret。 */
    status() {
      const devices = [...machines].map(
        /** 逐设备复验认证并读取可信 provider 健康，失效 peer 直接收敛为不可用。 */
        ([machine_id, peer]) => {
          try {
            assertPeer(peer)
            const providers = providerHealth(peer.connection, peer.session.readiness())
            return {
              machine_id,
              authenticated: true,
              ready: providers.some(
                /** 判断该设备是否存在可用实例，不把单个实例故障等同于设备整体离线。 */
                (p) => p.ready
              ),
              providers
            }
          } catch {
            close(peer)
            return { machine_id, authenticated: false, ready: false, providers: [] }
          }
        }
      )
      return {
        stopped,
        connections: peers.size,
        unauthenticated: [...peers].filter(
          /** 仅统计未完成设备认证的连接，供管理面观察握手占用。 */
          (p) => !p.connection
        ).length,
        inflight: inflight.size,
        devices
      }
    },
    /** 在管理变更后同步复验当前连接，关闭已失效身份而不误关仍在握手的 peer。 */
    refresh(): void {
      for (const peer of peers) {
        try {
          assertPeer(peer)
        } catch {
          if (peer.connection) {
            close(peer)
          }
        }
      }
    },
    /** 按稳定设备 ID 关闭当前连接，授权及凭据是否撤销由独立管理操作决定。 */
    disconnect(machine: string): void {
      const peer = machines.get(machine)
      if (peer) {
        close(peer)
      }
    },
    /** 从宿主 principal 经 Router 授权并提交 Store binding 后才编码发送；后续失败保持 unknown。 */
    dispatch(callId: string) {
      const principal = options.principal()
      const call = options.router.get(principal, callId)
      const peer = machines.get(call.machine_id)
      if (!peer) {
        fail('connection_unavailable')
      }
      assertPeer(peer)
      const target = JSON.parse(call.target_json)
      if (!ready(peer.session, peer.connection, target.provider_id)) {
        fail('provider_not_ready')
      }
      if (inflight.size >= limits.inflight) {
        fail('transport_concurrency_limit')
      }
      const binding = options.router.dispatch(principal, callId, peer.connection.connection_epoch)
      // 只有事务成功返回的 binding 才允许建立帧并写出；任何后续失败均保守 unknown。
      try {
        const row = options.store.attempt(binding.call_id, binding.attempt_id)
        if (!row) {
          fail('attempt_anchor_unavailable')
        }
        const { machine_id: _machine, recovery_generation: _generation, connection_epoch: _epoch, ...attempt } = binding
        const frame = envelope(peer.connection, 'request', {
          attempt,
          expected_binding_revision: binding.binding_revision,
          native_request: row.native_request,
          validation: row.mode
        })
        inflight.set(callId, frame)
        write(peer, frame)
        return binding
      } catch {
        close(peer)
        fail('dispatch_outcome_unknown')
      }
    },
    /** 幂等停止维护 timer、全部 peer 和 listener，不启动任何原生回滚或重放。 */
    stop(): void {
      if (stopped) {
        return
      }
      stopped = true
      clearInterval(timer)
      for (const peer of peers) {
        close(peer)
      }
      listener.stop(true)
    }
  }
}
