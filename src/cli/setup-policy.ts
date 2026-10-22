// 首次本机批准只覆盖该次完整设备/provider/session；两端共享修订和已审核普通方法，不生成笛卡尔权限。
import { LUVUS_OPERATION_METHODS } from '../runtime/luvus-operations.js'
import { HERDR_WORKFLOW_METHODS } from '../connector/herdr/methods.js'
import { CliError, luvusMode, type ConnectorConfig, type NativeProviderKind } from './config.js'
import type { ProviderPolicies, V2Target } from '../wire/types.js'
import type { PairingPlan } from './setup-approval.js'

// Luvus 会话名随运行方式确定：附着用户真实的 default 会话，或 managed 隔离实例的 rovloom；Herdr 固定 default。
export type SetupSessions = Readonly<{ luvus?: 'default' | 'rovloom' }>

// 只接受程序定义的两个会话名；其它形态一律拒绝，不能借配对请求选择任意会话。
export function setupSessions(input: unknown): SetupSessions {
  if (input === undefined) {
    return Object.freeze({})
  }
  const row = input as Record<string, unknown>
  if (
    row === null ||
    typeof row !== 'object' ||
    Array.isArray(row) ||
    Object.keys(row).some(/* 目前只有 Luvus 可选择会话。 */ (key) => key !== 'luvus') ||
    (row.luvus !== undefined && row.luvus !== 'default' && row.luvus !== 'rovloom')
  ) {
    throw new CliError('configuration_required')
  }
  return Object.freeze(row.luvus === undefined ? {} : { luvus: row.luvus })
}

// 每种首次实例的完整业务Target由程序确定，仍由实际安装、身份和每个原Wire门禁核验。
export function setupTarget(
  machine: string,
  kind: NativeProviderKind = 'luvus',
  sessions: SetupSessions = {}
): V2Target & { profile: 'session' } {
  return {
    machine_id: machine,
    provider_id: kind,
    profile: 'session',
    session: kind === 'luvus' ? (sessions.luvus ?? 'rovloom') : 'default'
  }
}

// 网络选择只接受程序定义的单来源或固定顺序双来源，空值、重复项和未知kind均拒绝。
export function setupProviderKinds(input: unknown): readonly NativeProviderKind[] {
  if (
    !Array.isArray(input) ||
    input.some(/* 不能借对象的字符串转换伪装原生kind。 */ (kind) => kind !== 'luvus' && kind !== 'herdr') ||
    !['luvus', 'herdr', 'luvus,herdr'].includes(input.join(','))
  ) {
    throw new CliError('configuration_required')
  }
  return Object.freeze([...input])
}

// 两个来源各有精确Target和各自已审方法，不把provider、session和方法做笛卡尔授权。
// 修订标签取自 lineage（首台设备那次引导的 attempt）：所有设备的本机策略共用同一修订，Gateway 才能同时就绪；
// 标签只是命名这一代引导，策略内容（授权集合）随加入的设备增长。
export function selectedSetupPolicies(
  plan: Pick<PairingPlan, 'attempt_id' | 'actor' | 'lineage'>,
  machine: string,
  kinds: readonly NativeProviderKind[],
  sessions: SetupSessions = {}
): { principal_id: string; policies: ProviderPolicies } {
  const grants = setupProviderKinds(kinds).map(
    /* 每条授权只覆盖该来源的固定首次session。 */ (kind) => ({
      target: setupTarget(machine, kind, sessions),
      methods: [...(kind === 'luvus' ? LUVUS_OPERATION_METHODS : HERDR_WORKFLOW_METHODS)],
      actions: ['dispatch', 'read', 'cancel'] as ('dispatch' | 'read' | 'cancel')[]
    })
  )
  return {
    principal_id: plan.actor,
    policies: {
      caller: { revision: 'setup_caller_' + (plan.lineage ?? plan.attempt_id), grants },
      local: { revision: 'setup_local_' + (plan.lineage ?? plan.attempt_id), grants: structuredClone(grants) }
    }
  }
}

// 内部引用不会暴露为用户JSON参数，且精确绑定原attempt以避免不同初始化互为别名。
export function setupReference(attempt: string, kind: NativeProviderKind = 'luvus'): string {
  return kind + '_' + attempt
}

// Connector 按自己的运行方式选择 Luvus 会话：附着 default，managed 用 rovloom。
export function setupSessionsFor(config: ConnectorConfig): SetupSessions {
  return Object.freeze({ luvus: luvusMode(config) === 'attach' ? ('default' as const) : ('rovloom' as const) })
}
