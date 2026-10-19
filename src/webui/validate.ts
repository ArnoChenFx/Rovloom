/** 页面消费共享 DTO 的有界校验：未知字段/秘密正文不能留入页面快照或错误。 */
import type {
  DeviceSnapshot,
  ManagementStatus,
  Observed,
  PermissionSnapshot,
  ProviderSnapshot,
  ManagementArguments,
  ManagementReply
} from '../mcp/management.js'
import { ReadError, type TimedSnapshot } from './reader.js'
import type { PageRoute, PageView } from './view.js'
import type { ManagementReadOperation } from './read.js'

/** 只抛出固定分类，避免把非法响应正文变成页面错误。 */
function invalid(): never {
  throw new ReadError('invalid_response')
}

/** 只接收普通数据对象、明确字段与无 getter 的属性。 */
function record(value: unknown, allowed: string[], required = allowed): void {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    invalid()
  }
  if (Object.getOwnPropertySymbols(value).length) {
    invalid()
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!allowed.includes(key) || !descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      invalid()
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      invalid()
    }
  }
}

/** 所有显示文本均有长度上限；允许 XSS 字面文本，由 DOM 转义。 */
function text(value: unknown, limit = 1024): void {
  if (typeof value !== 'string' || value.length > limit || value.includes('\u0000')) {
    invalid()
  }
}

/** 校验可空文本，不用默认引用补造未知身份。 */
function nullableText(value: unknown): void {
  if (value !== null) {
    text(value)
  }
}

/** 时间必须可由 Date 安全显示，不能是 NaN、负数或不可表示的远期。 */
function time(value: unknown): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 8_640_000_000_000_000) {
    invalid()
  }
}

/** 枚举按共享契约精确检查，不把新未知状态默认为 ready。 */
function choice(value: unknown, choices: readonly unknown[]): void {
  if (!choices.includes(value)) {
    invalid()
  }
}

/** 修订号不接受分数、负数或精度已丢失的数值。 */
function revision(value: number | null): void {
  if (value !== null && (!Number.isSafeInteger(value) || value < 1)) {
    invalid()
  }
}

/** 数组有界，拒绝稀疏槽与非数组。 */
function bounded(value: unknown, limit: number): asserts value is unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > limit ||
    Object.keys(value).length !== value.length ||
    Object.getOwnPropertySymbols(value).length
  ) {
    invalid()
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (key === 'length') {
      continue
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      !/^(0|[1-9][0-9]*)$/u.test(key) ||
      Number(key) >= value.length ||
      !descriptor ||
      !descriptor.enumerable ||
      !('value' in descriptor)
    ) {
      invalid()
    }
  }
}

/** 验证可信观测与未核实原因两个分支，禁止 unverified 携带伪造 value。 */
function observed<T>(value: Observed<T>, inspect: (item: T) => void): void {
  if (value.verification === 'verified') {
    record(value, ['verification', 'observed_at', 'source', 'value'])
    time(value.observed_at)
    choice(value.source, ['store', 'gateway_transport', 'native_adapter'])
    inspect(value.value)
  } else {
    record(value, ['verification', 'reason_code'])
    choice(value.verification, ['unverified'])
    choice(value.reason_code, ['backend_unavailable', 'not_recorded', 'stale'])
  }
}

/** 校验共享设备 DTO，原生错误或凭据字段均不属于允许集。 */
function device(value: DeviceSnapshot): void {
  record(value, [
    'machine_id',
    'name',
    'labels',
    'persisted_state',
    'resource_revision',
    'observed_at',
    'connection',
    'authentication'
  ])
  text(value.machine_id)
  text(value.name, 256)
  time(value.observed_at)
  revision(value.resource_revision)
  choice(value.persisted_state, ['pending', 'offline', 'online', 'revoked'])
  if (value.labels !== null) {
    bounded(value.labels, 64)
    for (const label of value.labels) {
      text(label, 128)
    }
  }
  observed(
    value.connection,
    /** 连接时间必须来自共享可信观测，不接收 OS 自报附加身份。 */
    (connection) => {
      record(connection, ['state', 'connection_epoch_ref', 'last_heartbeat_at'])
      choice(connection.state, ['connecting', 'reconnecting', 'online', 'degraded', 'offline'])
      nullableText(connection.connection_epoch_ref)
      if (connection.last_heartbeat_at !== null) {
        time(connection.last_heartbeat_at)
      }
    }
  )
  observed(
    value.authentication,
    /** 认证失败只接收契约定义的脱敏原因枚举与发生时间。 */
    (authentication) => {
      record(authentication, ['state', 'last_failure'])
      choice(authentication.state, ['pending', 'authenticated', 'failed', 'expired', 'revoked'])
      if (authentication.last_failure !== null) {
        record(authentication.last_failure, ['reason_code', 'occurred_at'])
        choice(authentication.last_failure.reason_code, [
          'auth_failed',
          'credential_expired',
          'heartbeat_timeout',
          'protocol_error',
          'connection_closed',
          'binding_mismatch'
        ])
        time(authentication.last_failure.occurred_at)
      }
    }
  )
}

/** 校验共享 provider DTO；运行观测与 readiness 独立保留。 */
function provider(value: ProviderSnapshot): void {
  record(value, [
    'machine_id',
    'provider_id',
    'kind',
    'binding_revision',
    'enabled',
    'readiness',
    'config_ref',
    'observed_at',
    'runtime'
  ])
  text(value.machine_id)
  text(value.provider_id)
  nullableText(value.config_ref)
  time(value.observed_at)
  revision(value.binding_revision)
  if (value.binding_revision === null) {
    invalid()
  }
  choice(value.enabled, [true, false])
  choice(value.kind, ['luvus', 'herdr'])
  choice(value.readiness, ['unavailable', 'unverified', 'ready'])
  observed(
    value.runtime,
    /** 契约摘要只作安全引用展示，不解析成本机路径或执行许可。 */
    (runtime) => {
      record(runtime, [
        'state',
        'contract_ref',
        'binary_sha256',
        'schema_sha256',
        'classification_revision',
        'supported_transports'
      ])
      choice(runtime.state, ['ready', 'unreachable', 'binding_mismatch', 'migration_unresolved'])
      nullableText(runtime.contract_ref)
      nullableText(runtime.binary_sha256)
      nullableText(runtime.schema_sha256)
      nullableText(runtime.classification_revision)
      bounded(runtime.supported_transports, 4)
      for (const transport of runtime.supported_transports) {
        choice(transport, ['rpc', 'events', 'terminal_observe', 'terminal_control'])
      }
    }
  )
}

/** 验证共享 status 的准确模式、固定轮询建议及独立组件状态。 */
function status(value: ManagementStatus): void {
  record(value, [
    'server_time',
    'observed_at',
    'mode',
    'recovery_generation',
    'policy_revision',
    'refresh_after_ms',
    'stale_after_ms',
    'history',
    'components'
  ])
  time(value.server_time)
  time(value.observed_at)
  text(value.recovery_generation)
  text(value.policy_revision)
  if (value.observed_at > value.server_time || value.refresh_after_ms !== 5000 || value.stale_after_ms !== 15000) {
    invalid()
  }
  choice(value.mode, ['active', 'storage_degraded', 'recovery_quarantined'])
  if (value.history !== null) {
    record(value.history, ['history_epoch', 'accept_new_until'])
    text(value.history.history_epoch)
    time(value.history.accept_new_until)
  }
  record(value.components, ['store', 'transport', 'native'])
  choice(value.components.store, ['available', 'degraded', 'quarantined'])
  for (const item of [value.components.transport, value.components.native]) {
    choice(item, ['available', 'degraded', 'unavailable', 'unverified'])
  }
}

/** 权限快照只作短期提示，必须绑定当前目标/代次/策略；不授予动作权限。 */
function permissionShape(value: PermissionSnapshot): void {
  record(value, [
    'target',
    'principal_id',
    'policy_revision',
    'caller_policy_revision',
    'local_policy_revision',
    'recovery_generation',
    'observed_at',
    'expires_at',
    'decisions'
  ])
  record(value.target, ['machine_id', 'provider_id'], ['machine_id'])
  text(value.target.machine_id)
  if (value.target.provider_id !== undefined) {
    text(value.target.provider_id)
  }
  text(value.principal_id)
  text(value.policy_revision)
  text(value.caller_policy_revision)
  nullableText(value.local_policy_revision)
  text(value.recovery_generation)
  time(value.observed_at)
  time(value.expires_at)
  bounded(value.decisions, 9)
  for (const decision of value.decisions) {
    record(decision, ['action', 'allowed', 'reason_code'])
    choice(decision.action, [
      'gateway_read',
      'devices_read',
      'devices_register',
      'devices_rename',
      'devices_disconnect',
      'devices_revoke',
      'providers_read',
      'providers_manage',
      'permissions_read'
    ])
    choice(decision.allowed, [true, false])
    choice(decision.reason_code, [
      'allowed',
      'forbidden',
      'backend_unavailable',
      'recovery_quarantined',
      'storage_degraded'
    ])
  }
}

/** 页面权限还必须属于当前设备和全局 fence；HTTP 单操作校验复用相同字段规则。 */
function permissions(value: PermissionSnapshot, page: PageView, route: PageRoute): void {
  permissionShape(value)
  if (
    value.target.machine_id !== route.machineId ||
    value.target.provider_id !== undefined ||
    value.policy_revision !== page.status.policy_revision ||
    value.recovery_generation !== page.status.recovery_generation
  ) {
    invalid()
  }
}

/** 对六项共享读取的传输回复复用展示字段校验；不替代服务的查询和资源授权。 */
export function checkManagementReadReply<K extends ManagementReadOperation>(
  operation: K,
  input: unknown,
  args: ManagementArguments[K]
): ManagementReply[K] {
  try {
    const value = input as ManagementReply[K]
    const target = args as { machine_id?: string; provider_id?: string }
    if (operation === 'status') {
      status(value as ManagementStatus)
    } else if (operation === 'devices_get') {
      const item = value as DeviceSnapshot
      device(item)
      if (item.machine_id !== target.machine_id) {
        invalid()
      }
    } else if (operation === 'providers_get') {
      const item = value as ProviderSnapshot
      provider(item)
      if (item.machine_id !== target.machine_id || item.provider_id !== target.provider_id) {
        invalid()
      }
    } else if (operation === 'permissions_get') {
      const item = value as PermissionSnapshot
      permissionShape(item)
      if (item.target.machine_id !== target.machine_id || item.target.provider_id !== target.provider_id) {
        invalid()
      }
    } else if (operation === 'devices_list' || operation === 'providers_list') {
      const page = value as { items: (DeviceSnapshot | ProviderSnapshot)[]; next_cursor?: string }
      record(page, ['items', 'next_cursor'], ['items'])
      bounded(page.items, 200)
      if (page.next_cursor !== undefined) {
        text(page.next_cursor)
      }
      const seen = new Set<string>()
      for (const item of page.items) {
        if (operation === 'devices_list') {
          device(item as DeviceSnapshot)
        } else {
          provider(item as ProviderSnapshot)
          if (item.machine_id !== target.machine_id) {
            invalid()
          }
        }
        const key = operation === 'devices_list' ? item.machine_id : (item as ProviderSnapshot).provider_id
        if (seen.has(key)) {
          invalid()
        }
        seen.add(key)
      }
    } else {
      invalid()
    }
    const result = structuredClone(value)
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 524_288) {
      invalid()
    }
    return result
  } catch {
    throw new ReadError('invalid_response')
  }
}

/** 子观测和 Gateway 接收心跳不能晚于本次服务时间，避免把未来时间显示为新鲜。 */
function deviceTimes(value: DeviceSnapshot, serverTime: number): void {
  if (value.observed_at > serverTime) {
    invalid()
  }
  if (value.connection.verification === 'verified') {
    if (
      value.connection.observed_at > serverTime ||
      (value.connection.value.last_heartbeat_at !== null && value.connection.value.last_heartbeat_at > serverTime)
    ) {
      invalid()
    }
  }
  if (value.authentication.verification === 'verified') {
    if (
      value.authentication.observed_at > serverTime ||
      (value.authentication.value.last_failure !== null &&
        value.authentication.value.last_failure.occurred_at > serverTime)
    ) {
      invalid()
    }
  }
}

/** 校验一次页面组合，脱离适配层可变引用，拒绝越机器与超出本地展示预算的数据。 */
export function checkPage(snapshot: TimedSnapshot<PageView>, route: PageRoute): TimedSnapshot<PageView> {
  try {
    record(snapshot, ['value', 'serverTime', 'observedAt', 'sessionExpiresAt'])
    const page = snapshot.value
    record(page, ['status', 'devices', 'device', 'providers', 'permissions', 'providersProblem'])
    status(page.status)
    time(snapshot.serverTime)
    time(snapshot.observedAt)
    if (snapshot.sessionExpiresAt !== null) {
      time(snapshot.sessionExpiresAt)
    }
    if (snapshot.serverTime !== page.status.server_time || snapshot.observedAt > snapshot.serverTime) {
      invalid()
    }
    for (const item of [page.devices, page.providers]) {
      record(item, ['items', 'next_cursor'], ['items'])
      bounded(item.items, 200)
      if (item.next_cursor !== undefined) {
        text(item.next_cursor)
      }
    }
    const machines = new Set<string>()
    for (const item of page.devices.items) {
      device(item)
      deviceTimes(item, snapshot.serverTime)
      if (machines.has(item.machine_id)) {
        invalid()
      }
      machines.add(item.machine_id)
    }
    if (page.device !== null) {
      device(page.device)
      deviceTimes(page.device, snapshot.serverTime)
      if (page.device.machine_id !== route.machineId) {
        invalid()
      }
    }
    if (route.machineId === null && (page.device !== null || page.providers.items.length)) {
      invalid()
    }
    if (route.machineId !== null && (page.devices.items.length || page.devices.next_cursor !== undefined)) {
      invalid()
    }
    if (
      page.device === null &&
      (page.providers.items.length || page.providers.next_cursor !== undefined || page.permissions !== null)
    ) {
      invalid()
    }
    const providers = new Set<string>()
    for (const item of page.providers.items) {
      provider(item)
      if (
        item.observed_at > snapshot.serverTime ||
        (item.runtime.verification === 'verified' && item.runtime.observed_at > snapshot.serverTime)
      ) {
        invalid()
      }
      if (item.machine_id !== route.machineId || providers.has(item.provider_id)) {
        invalid()
      }
      providers.add(item.provider_id)
    }
    choice(page.providersProblem, [null, 'forbidden', 'unavailable'])
    if (page.providersProblem !== null && (page.providers.items.length || page.providers.next_cursor !== undefined)) {
      invalid()
    }
    if (page.permissions !== null) {
      permissions(page.permissions, page, route)
      if (page.permissions.observed_at > snapshot.serverTime) {
        invalid()
      }
    }
    if (
      page.status.mode === 'recovery_quarantined' &&
      (page.device ||
        page.devices.items.length ||
        page.devices.next_cursor !== undefined ||
        page.providers.items.length ||
        page.providers.next_cursor !== undefined ||
        page.permissions ||
        page.providersProblem !== null)
    ) {
      invalid()
    }
    if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > 524_288) {
      invalid()
    }
    return structuredClone(snapshot)
  } catch {
    throw new ReadError('invalid_response')
  }
}
