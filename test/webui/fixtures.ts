/** 仅供隔离 UI 测试的共享 DTO fixture；生产构建不能导入此文件。 */
import type {
  DeviceSnapshot,
  ManagementArguments,
  ManagementReply,
  ProviderSnapshot
} from '../../src/mcp/management.js'
import type { ManagementReadOperation } from '../../src/webui/read.js'
import type { PageRoute, PageView } from '../../src/webui/view.js'
import type { TimedSnapshot } from '../../src/webui/reader.js'

export const fixtureTime = Date.UTC(2026, 9, 19, 0, 0, 0)

/** 两台 fixture 的连接和认证互相隔离，持久状态不充当认证证据。 */
export function fixtureDevice(id: string): DeviceSnapshot {
  return {
    machine_id: id,
    name: id === 'fixture-a' ? '研发工作站 <img src=x onerror=alert(1)>' : '隔离测试机 B',
    labels: ['fixture', '隔离测试'],
    resource_revision: 3,
    persisted_state: id === 'fixture-a' ? 'online' : 'revoked',
    observed_at: fixtureTime,
    connection: {
      verification: 'verified',
      observed_at: fixtureTime,
      source: 'gateway_transport',
      value: {
        state: id === 'fixture-a' ? 'online' : 'offline',
        connection_epoch_ref: id === 'fixture-a' ? 'fixture-epoch-a' : null,
        last_heartbeat_at: id === 'fixture-a' ? fixtureTime - 2000 : fixtureTime - 80_000
      }
    },
    authentication: {
      verification: 'verified',
      observed_at: fixtureTime,
      source: 'gateway_transport',
      value: {
        state: id === 'fixture-a' ? 'authenticated' : 'revoked',
        last_failure: null
      }
    }
  }
}

/** 构造同一设备的三条独立 binding，故障与来源未知不会合并到设备状态。 */
function providers(machineId: string): ProviderSnapshot[] {
  return [
    {
      machine_id: machineId,
      provider_id: 'fixture-luvus',
      kind: 'luvus',
      binding_revision: 2,
      config_ref: 'config:fixture-luvus',
      enabled: true,
      readiness: 'ready',
      observed_at: fixtureTime,
      runtime: {
        verification: 'verified',
        source: 'native_adapter',
        observed_at: fixtureTime,
        value: {
          state: 'ready',
          contract_ref: 'fixture-contract',
          binary_sha256: 'a'.repeat(64),
          schema_sha256: 'b'.repeat(64),
          classification_revision: 'fixture-classification',
          supported_transports: ['rpc']
        }
      }
    },
    {
      machine_id: machineId,
      provider_id: 'fixture-herdr',
      kind: 'herdr',
      binding_revision: 4,
      config_ref: 'config:fixture-herdr',
      enabled: true,
      readiness: 'unavailable',
      observed_at: fixtureTime,
      runtime: {
        verification: 'verified',
        source: 'native_adapter',
        observed_at: fixtureTime,
        value: {
          state: 'unreachable',
          contract_ref: null,
          binary_sha256: null,
          schema_sha256: null,
          classification_revision: null,
          supported_transports: []
        }
      }
    },
    {
      machine_id: machineId,
      provider_id: 'fixture-old',
      kind: 'luvus',
      binding_revision: 1,
      config_ref: null,
      enabled: false,
      readiness: 'unverified',
      observed_at: fixtureTime,
      runtime: {
        verification: 'verified',
        source: 'store',
        observed_at: fixtureTime,
        value: {
          state: 'migration_unresolved',
          contract_ref: null,
          binary_sha256: null,
          schema_sha256: null,
          classification_revision: null,
          supported_transports: []
        }
      }
    }
  ]
}

/** 固定共享只读操作的合成返回；没有后台权限、凭据或管理写入实现。 */
export function fixtureReply<K extends ManagementReadOperation>(
  name: K,
  args: ManagementArguments[K]
): ManagementReply[K] {
  const target = 'machine_id' in args ? args.machine_id : 'fixture-a'
  let result: ManagementReply[ManagementReadOperation]
  switch (name) {
    case 'status':
      result = {
        server_time: fixtureTime,
        observed_at: fixtureTime,
        mode: 'active',
        recovery_generation: 'fixture-recovery',
        policy_revision: 'fixture-policy',
        refresh_after_ms: 5000,
        stale_after_ms: 15000,
        history: null,
        components: { store: 'available', transport: 'available', native: 'unverified' }
      }
      break
    case 'devices_list':
      result = { items: [fixtureDevice('fixture-a'), fixtureDevice('fixture-b')] }
      break
    case 'devices_get':
      result = fixtureDevice(target)
      break
    case 'providers_list':
      result = { items: providers(target) }
      break
    case 'providers_get':
      result = providers(target)[0]!
      break
    case 'permissions_get':
      result = {
        target: { machine_id: target },
        principal_id: 'fixture-principal',
        policy_revision: 'fixture-policy',
        caller_policy_revision: 'fixture-caller',
        local_policy_revision: null,
        recovery_generation: 'fixture-recovery',
        observed_at: fixtureTime,
        expires_at: fixtureTime + 30_000,
        decisions: [{ action: 'devices_read', allowed: true, reason_code: 'allowed' }]
      }
      break
  }
  return result! as ManagementReply[K]
}

/** 组合直接页面校验所需 fixture，不作为任何生产默认数据。 */
export function fixtureSnapshot(route: PageRoute): TimedSnapshot<PageView> {
  const status = fixtureReply('status', {})
  return {
    serverTime: fixtureTime,
    observedAt: fixtureTime,
    sessionExpiresAt: null,
    value: {
      status,
      devices: route.machineId === null ? fixtureReply('devices_list', {}) : { items: [] },
      device: route.machineId === null ? null : fixtureReply('devices_get', { machine_id: route.machineId }),
      providers:
        route.machineId === null ? { items: [] } : fixtureReply('providers_list', { machine_id: route.machineId }),
      permissions: route.machineId === null ? null : fixtureReply('permissions_get', { machine_id: route.machineId }),
      providersProblem: null
    }
  }
}
