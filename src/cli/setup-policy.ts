// 首次本机批准只覆盖该次完整设备/provider/session；两端共享修订和已审核普通方法，不生成笛卡尔权限。
import { LUVUS_OPERATION_METHODS } from '../runtime/luvus-operations.js'
import { HERDR_WORKFLOW_METHODS } from '../connector/herdr/methods.js'
import { CliError, type NativeProviderKind } from './config.js'
import type { ProviderPolicies, V2Target } from '../wire/types.js'
import type { PairingPlan } from './setup-approval.js'

// 每种首次实例的完整业务Target由程序确定，仍由实际安装、身份和每个原Wire门禁核验。
export function setupTarget(machine: string, kind: NativeProviderKind = 'luvus'): V2Target & { profile: 'session' } {
  return {
    machine_id: machine,
    provider_id: kind,
    profile: 'session',
    session: kind === 'luvus' ? 'rovloom' : 'default'
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
export function selectedSetupPolicies(
  plan: Pick<PairingPlan, 'attempt_id' | 'actor'>,
  machine: string,
  kinds: readonly NativeProviderKind[]
): { principal_id: string; policies: ProviderPolicies } {
  const grants = setupProviderKinds(kinds).map(
    /* 每条授权只覆盖该来源的固定首次session。 */ (kind) => ({
      target: setupTarget(machine, kind),
      methods: [...(kind === 'luvus' ? LUVUS_OPERATION_METHODS : HERDR_WORKFLOW_METHODS)],
      actions: ['dispatch', 'read', 'cancel'] as ('dispatch' | 'read' | 'cancel')[]
    })
  )
  return {
    principal_id: plan.actor,
    policies: {
      caller: { revision: 'setup_caller_' + plan.attempt_id, grants },
      local: { revision: 'setup_local_' + plan.attempt_id, grants: structuredClone(grants) }
    }
  }
}

// 内部引用不会暴露为用户JSON参数，且精确绑定原attempt以避免不同初始化互为别名。
export function setupReference(attempt: string, kind: NativeProviderKind = 'luvus'): string {
  return kind + '_' + attempt
}
