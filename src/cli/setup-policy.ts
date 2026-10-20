// 首次本机批准只覆盖该次完整设备/provider/session；两端共享修订和已审核普通方法，不生成笛卡尔权限。
import { LUVUS_OPERATION_METHODS } from '../runtime/luvus-operations.js'
import type { ProviderPolicies, V2Target } from '../wire/types.js'
import type { PairingPlan } from './setup-approval.js'

// 首个Luvus实例的业务选择由程序确定，仍由实际安装、身份和每个原Wire门禁核验。
export function setupTarget(machine: string): V2Target & { profile: 'session' } {
  return { machine_id: machine, provider_id: 'luvus', profile: 'session', session: 'rovloom' }
}

// 权限绑定一次配对的稳定主体和完整Target；terminal执行不属于此普通接口集合。
export function setupPolicies(
  plan: Pick<PairingPlan, 'attempt_id' | 'actor'>,
  target: V2Target
): {
  principal_id: string
  policies: ProviderPolicies
} {
  const grant = {
    target,
    methods: [...LUVUS_OPERATION_METHODS],
    actions: ['dispatch', 'read', 'stream_input', 'cancel'] as const
  }
  return {
    principal_id: plan.actor,
    policies: {
      caller: { revision: 'setup_caller_' + plan.attempt_id, grants: [{ ...grant, actions: [...grant.actions] }] },
      local: { revision: 'setup_local_' + plan.attempt_id, grants: [{ ...grant, actions: [...grant.actions] }] }
    }
  }
}

// 内部引用不会暴露为用户JSON参数，且精确绑定原attempt以避免不同初始化互为别名。
export function setupReference(attempt: string): string {
  return 'luvus_' + attempt
}
