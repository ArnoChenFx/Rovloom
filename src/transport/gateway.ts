// 实现 Gateway 设备 listener，连接可信认证、逐 provider ready 与事务派发/响应账本。
import { randomUUID } from 'node:crypto'
import type { Call, Store } from '../store.js'
import type { Router, Principal } from '../router.js'
import { commitLuvusResponse } from '../integration/persistence.js'
import {
  boundedJson,
  admissionRequestDigest,
  assertBinding,
  decodeWireFrame,
  encodeWireFrame,
  negotiate,
  fail,
  LIMITS,
  uint,
  validateOffer,
  WireError
} from '../wire/index.js'
import type { AttemptBinding, AuthenticatedEnvelope, VersionOffer } from '../wire/types.js'
import type { IdentityHost } from './identity.js'
import { ChannelRegistry } from './channel-host.js'
import type { SocketChannel } from './channel-host.js'
import { budget, envelope, loopback, OFFER, positive, providerHealth, ready, ReceiveWindow, runtime } from './common.js'
import type { Adapter, Connection, Listener, ServerSocket, Session } from './common.js'
import type { GatewayTransportObservationSource, GatewayTransportSnapshot, TransportObserved } from './observation.js'

/** 冻结新建的纯观测副本；调用方不能借快照修改 Gateway 私有连接和后续取样。 */
function freezeObservation<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) {
      freezeObservation(child)
    }
    Object.freeze(value)
  }
  return value
}

/** 仅包装 Gateway 内部已核对的事实，不向宿主导出 verified 工厂或冒称原生证明。 */
function observed<T>(at: number, value: T): TransportObserved<T> {
  return { verification: 'verified', observed_at: at, source: 'gateway_transport', value }
}

/** 缺少当前可信来源时返回未知，不沿用旧连接或旧 provider 的成功状态。 */
function unverified(reason_code: 'backend_unavailable' | 'not_recorded' | 'stale'): TransportObserved<never> {
  return { verification: 'unverified', reason_code }
}

export type OriginalRead = Readonly<{ binding: AttemptBinding; wire: Adapter }>
/** 仅供受保护结果服务按当前宿主身份解析实际活 Wire；缺原请求或读取权限时拒绝。 */
export type OriginalReadResolver = (callId: string) => OriginalRead | undefined

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
  epochReference?: string
  lastHeartbeatAt?: number
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
  /** 显式按 read_contexts 预算保留完成后的原 Wire 读取状态；默认完成即释放，不延长内容期限。 */
  retainOriginalRead?: boolean
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
    read_contexts: number
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
    read_contexts: 128,
    ...options.limits
  }
  Object.values(limits).forEach(
    /** 逐项验证 Gateway 配额配置，避免非法数值削弱连接或发送限额。 */
    (v) => positive(v)
  )
  positive(limits.frame_bytes, LIMITS.frame_bytes)
  positive(limits.read_contexts, LIMITS.dedup_entries)
  const offer = structuredClone(options.offer ?? OFFER)
  validateOffer(offer)
  const peers = new Set<Peer>()
  const channels = options.channels ?? new ChannelRegistry()
  const machines = new Map<string, Peer>()
  const inflight = new Map<string, AuthenticatedEnvelope & { type: 'request' }>()
  const reads = new Map<string, { binding: AttemptBinding; wire: Adapter; peer: Peer; expires: number }>()
  let authWindow = performance.now()
  let authAttempts = 0
  let stopped = false
  let observationClock = -1
  let samplingObservation = false

  /** 以 Store 同一可信毫秒时钟记录接收和取样时间；拒绝回拨，不从帧或调用参数接收时间。 */
  function observationNow(): number {
    const now = options.store.clock()
    uint(now)
    if (now < observationClock) {
      fail('clock_untrusted')
    }
    observationClock = now
    return now
  }

  /** 只分类不可用原因，不回显宿主异常或把失效猜成已撤销、认证失败或设备离线。 */
  function unknownDevice(machine_id: string, error: unknown): GatewayTransportSnapshot['devices'][number] {
    let backend = false
    try {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      backend =
        typeof code === 'string' &&
        ['storage_degraded', 'storage_closed', 'recovery_quarantined', 'clock_untrusted'].includes(code)
    } catch {
      /* 宿主异常的 getter 也不属于可信观测，不执行类型转换或泄漏嵌套异常。 */
    }
    return {
      machine_id,
      connection: unverified(backend ? 'backend_unavailable' : 'stale'),
      authentication: unverified(backend ? 'backend_unavailable' : 'stale'),
      providers: []
    }
  }

  /** 先移除连接可用性，再按原 epoch 断开账本和释放 adapter/socket；已派发动作保持保守状态。 */
  function close(peer: Peer, disconnectLedger = true): void {
    if (peer.closed) {
      return
    }
    peer.closed = true
    peers.delete(peer)
    for (const [call, original] of reads) {
      if (original.peer === peer) {
        reads.delete(call)
      }
    }
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
  /** 只读取 live peer 和当前身份/绑定；未知保持未知，取样不会关闭通道或发起原生工作。 */
  const observations: GatewayTransportObservationSource = Object.freeze({
    /** 每次取样独立核验；重入拒绝，不让宿主回调创建无限递归观测。 */
    snapshot(): GatewayTransportSnapshot {
      if (samplingObservation) {
        fail('transport_observation_unavailable')
      }
      samplingObservation = true
      try {
        let at: number
        let generation: string
        try {
          at = observationNow()
          const health = options.store.health()
          if (health.mode !== 'active') {
            fail('transport_observation_unavailable')
          }
          generation = health.generation
        } catch {
          fail('transport_observation_unavailable')
        }
        const devices: GatewayTransportSnapshot['devices'][number][] = []
        const samples: {
          index: number
          peer: Peer & { connection: Connection; session: Session; lease: string }
          connection: Connection
          bindings: Map<string, string>
        }[] = []
        if (!stopped) {
          // 固定候选集合；宿主回调新建连接不能延长本次遍历或变成无认证采样来源。
          const candidates = [...machines]
          for (const [machine_id, peer] of candidates) {
            try {
              assertPeer(peer)
              if (
                machines.get(machine_id) !== peer ||
                !peer.epochReference ||
                performance.now() - peer.last >= limits.idle_ms
              ) {
                fail('stale_transport_observation')
              }
            } catch (error) {
              devices.push(unknownDevice(machine_id, error))
              continue
            }
            let providers: GatewayTransportSnapshot['devices'][number]['providers'] = []
            const bindings = new Map<string, string>()
            try {
              const readiness = peer.session.readiness()
              const health = providerHealth(peer.connection, readiness)
              const wireAvailable = !peer.session.adapter.stats().closed
              providers = health.map(
                /** 将当前 Store binding 与宿主双端配置交叉核对，不把旧 revision 的 ready 投影给新绑定。 */
                (provider, index) => {
                  const expected = readiness.providers[index]!.expected
                  let revision = expected.binding_revision
                  try {
                    const current = options.store.provider(machine_id, provider.provider_id)
                    if (!current) {
                      return {
                        provider_id: provider.provider_id,
                        binding_revision: revision,
                        dispatch_ready: unverified('not_recorded')
                      }
                    }
                    revision = current.binding_revision
                    bindings.set(provider.provider_id, boundedJson(current))
                    return {
                      provider_id: provider.provider_id,
                      binding_revision: revision,
                      dispatch_ready:
                        boundedJson(current) === boundedJson(expected)
                          ? observed(at, wireAvailable && provider.ready)
                          : unverified('stale')
                    }
                  } catch {
                    return {
                      provider_id: provider.provider_id,
                      binding_revision: revision,
                      dispatch_ready: unverified('backend_unavailable')
                    }
                  }
                }
              )
            } catch {
              /* 没有可信 provider 集合时不捏造 ready、原生错误或不可达原因。 */
            }
            samples.push({ index: devices.length, peer, connection: peer.connection, bindings })
            devices.push({
              machine_id,
              connection: observed(at, {
                state: 'online' as const,
                connection_epoch_ref: peer.epochReference!,
                last_heartbeat_at: peer.lastHeartbeatAt ?? null
              }),
              authentication: observed(at, { state: 'authenticated' as const, last_failure: null }),
              providers
            })
          }
        }
        // 先完成所有宿主回调；后处理某个 peer 时，回调可能已关闭或变更较早采样的另一 peer。
        for (const { index, peer } of samples) {
          try {
            assertPeer(peer)
          } catch (error) {
            devices[index] = unknownDevice(devices[index]!.machine_id, error)
          }
        }
        for (const { index, peer, connection, bindings } of samples) {
          const device = devices[index]!
          if (device.connection.verification !== 'verified') {
            continue
          }
          try {
            const current = peer.channel?.connection()
            if (
              peer.closed ||
              machines.get(device.machine_id) !== peer ||
              peer.connection !== connection ||
              !current ||
              current.machine_id !== connection.machine_id ||
              current.recovery_generation !== connection.recovery_generation ||
              current.connection_epoch !== connection.connection_epoch ||
              performance.now() - peer.last >= limits.idle_ms
            ) {
              fail('stale_transport_observation')
            }
            // 独立核对 Store fence，不能假设每个身份宿主的 assert 都会代查 Store。
            options.store.assertConnection(connection)
          } catch (error) {
            devices[index] = unknownDevice(device.machine_id, error)
            continue
          }
          let wireAvailable: boolean | undefined
          try {
            wireAvailable = !peer.session.adapter.stats().closed
          } catch {
            /* 适配器状态未知时不沿用旧派发许可，也不影响独立核验的连接事实。 */
          }
          devices[index] = {
            ...device,
            providers: device.providers.map(
              /** 最终阶段不再调用宿主 readiness；较晚回调改变的 canonical binding 必须撤回旧 ready。 */
              (provider) => {
                try {
                  const current = options.store.provider(device.machine_id, provider.provider_id)
                  if (!current) {
                    return { ...provider, dispatch_ready: unverified('not_recorded') }
                  }
                  if (boundedJson(current) !== bindings.get(provider.provider_id)) {
                    return {
                      provider_id: provider.provider_id,
                      binding_revision: current.binding_revision,
                      dispatch_ready: unverified('stale')
                    }
                  }
                  return {
                    ...provider,
                    dispatch_ready:
                      provider.dispatch_ready.verification !== 'verified'
                        ? provider.dispatch_ready
                        : wireAvailable === undefined
                          ? unverified('backend_unavailable')
                          : observed(at, wireAvailable && provider.dispatch_ready.value)
                  }
                } catch {
                  return { ...provider, dispatch_ready: unverified('backend_unavailable') }
                }
              }
            )
          }
        }
        try {
          const health = options.store.health()
          if (health.mode !== 'active' || health.generation !== generation) {
            fail('transport_observation_unavailable')
          }
        } catch {
          fail('transport_observation_unavailable')
        }
        return freezeObservation({
          observed_at: at,
          recovery_generation: generation,
          transport: observed(at, stopped ? ('unavailable' as const) : ('available' as const)),
          devices: stopped ? [] : devices
        })
      } finally {
        samplingObservation = false
      }
    }
  })
  /** 清除过期、清理或旧 fence 的读取引用；在途调用仍保留原 Wire 自身的仅响应补证状态。 */
  function pruneOriginalReads(): void {
    for (const [call, original] of reads) {
      let usable = false
      try {
        const anchor = options.store.responseAnchor(original.binding)
        usable =
          !original.peer.closed &&
          !original.wire.stats().closed &&
          anchor.content_status === 'available' &&
          options.store.clock() < original.expires
        if (usable) {
          try {
            original.wire.checkResult(original.binding)
          } catch (error) {
            // 只回收已失去原状态的引用；当前 caller 或读取 grant 被拒绝不能驱逐所有者上下文。
            if (
              error instanceof WireError &&
              (error.code === 'dispatch_permit_unavailable' || error.code === 'content_unavailable')
            ) {
              usable = false
            }
          }
        }
      } catch {
        /* 原锚点或存储门禁失效后不能继续提供读取上下文。 */
      }
      if (!usable) {
        reads.delete(call)
        if (!inflight.has(call)) {
          try {
            original.wire.release(original.binding)
          } catch {
            /* 原会话可能已经关闭，拒绝引用仍须被移除。 */
          }
        }
      }
    }
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
        peer.epochReference = randomUUID()
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
      let decoded = peer.session.adapter.decode(input, 'connector_to_gateway')
      if (!('connection_epoch' in decoded)) {
        fail('authentication_required')
      }
      if (decoded.type === 'object_chunk') {
        const completed = peer.session.adapter.acceptChunk(input, 'connector_to_gateway')
        if (!completed) {
          return
        }
        if (completed.kind !== 'envelope' || completed.envelope.type !== 'response') {
          fail('response_frame_required')
        }
        decoded = completed.envelope
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
        try {
          peer.lastHeartbeatAt = observationNow()
        } catch {
          // 接收已完成但无法记录可信时刻时保持未知，观测失败不引入新的业务动作。
          peer.lastHeartbeatAt = undefined
        }
        return
      }
      if (decoded.type !== 'accepted' && decoded.type !== 'response') {
        fail('transport_feature_unavailable')
      }
      const binding = { ...peer.connection, ...decoded.payload.attempt }
      if (decoded.type === 'accepted') {
        // 取消先提交后，原 accepted 仍可能在途；完整绑定已核验，不能借迟到确认复活状态或关闭其它调用。
        if (options.store.responseAnchor(binding).state !== 'outcome_unknown') {
          options.store.accepted(binding)
        }
      } else {
        commitLuvusResponse(options.store, peer.session.adapter, decoded)
        inflight.delete(binding.call_id)
        pruneOriginalReads()
        if (!reads.has(binding.call_id)) {
          peer.session.adapter.release(binding)
        }
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
    observations,
    url: `${options.tls ? 'wss' : 'ws'}://${options.hostname.includes(':') ? '[' + options.hostname + ']' : options.hostname}:${listener.port}/connector`,
    /** 返回有界连接和 provider 健康状态；失效认证会触发关闭且不输出内容或 secret。 */
    status() {
      pruneOriginalReads()
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
        read_contexts: reads.size,
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
    /** 受保护宿主按当前 caller 解析仍存活的原请求 Wire，任何缺上下文、失效或读取拒绝均返回 undefined。 */
    resolveOriginalRead(callId: string): OriginalRead | undefined {
      try {
        pruneOriginalReads()
        options.router.get(options.principal(), callId)
        let original: (OriginalRead & { peer: Peer }) | undefined = reads.get(callId)
        if (!original) {
          const frame = inflight.get(callId)
          const peer = frame ? machines.get(frame.machine_id) : undefined
          if (frame && peer?.session) {
            original = {
              binding: {
                machine_id: frame.machine_id,
                recovery_generation: frame.recovery_generation,
                connection_epoch: frame.connection_epoch,
                ...frame.payload.attempt
              },
              wire: peer.session.adapter,
              peer
            }
          }
        }
        if (!original) {
          return undefined
        }
        assertPeer(original.peer)
        original.wire.checkResult(original.binding)
        return { binding: structuredClone(original.binding), wire: original.wire }
      } catch {
        return undefined
      }
    },
    /** 先按当前主体持久取消，再尽力通知原活 attempt；无取消 ack，不宣称桥接或原生已停止。 */
    cancel(callId: string): Call {
      const call = options.router.cancel(options.principal(), callId)
      const original = inflight.get(callId)
      if (!original || call.state !== 'outcome_unknown') {
        return call
      }
      // 移除本地等待并消费唯一发送机会；重入、写出失败和重复取消均不自动重发。
      inflight.delete(callId)
      const peer = machines.get(original.machine_id)
      try {
        if (
          !peer ||
          call.epoch !== original.connection_epoch ||
          call.attempt_id !== original.payload.attempt.attempt_id
        ) {
          return call
        }
        assertPeer(peer)
        if (
          peer.connection.machine_id !== original.machine_id ||
          peer.connection.recovery_generation !== original.recovery_generation ||
          peer.connection.connection_epoch !== original.connection_epoch
        ) {
          return call
        }
        options.store.assertConnection(peer.connection)
        write(
          peer,
          envelope(peer.connection, 'cancel', {
            attempt: structuredClone(original.payload.attempt),
            reason: 'caller_cancelled'
          })
        )
      } catch {
        /* 持久取消已提交；缺原上下文、撤权、关闭或发送失败只保留 unknown，不恢复队列或泄漏异常。 */
      }
      return call
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
      pruneOriginalReads()
      if (inflight.size >= limits.inflight || reads.size >= limits.read_contexts) {
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
        if (peer.connection.negotiated.capabilities.includes('admission_receipt')) {
          const anchor = options.store.responseAnchor(binding)
          assertBinding(anchor.binding, binding)
          write(
            peer,
            envelope(peer.connection, 'admission_receipt', {
              attempt,
              request_sha256: admissionRequestDigest({
                binding,
                native_request: row.native_request,
                validation: row.mode
              }),
              dedup_expires_at: anchor.dedup_expires_at
            })
          )
        }
        write(peer, frame)
        if (options.retainOriginalRead === true) {
          reads.set(callId, {
            binding: structuredClone(binding),
            wire: peer.session.adapter,
            peer,
            expires: options.store.responseAnchor(binding).content_expires_at
          })
        }
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
