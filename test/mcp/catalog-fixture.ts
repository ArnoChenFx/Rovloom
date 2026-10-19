// 为真实目录/Store接线建立人工在线状态与合成来源；不建立设备或原生会话，不替代生产证明。
import { StoreGatewayService, type GatewayCatalogSource } from '../../src/mcp/index.js'
import { contractRef } from '../../src/wire/index.js'
import { compiled, json, source as nativeSource, G } from '../native-contract/helpers.js'
import { source as wireSource } from '../wire/helpers.js'
import { storeFixture, target, syntheticCredential } from './store-fixture.js'

export const catalogMethods = ['ping', 'workspace.list', 'pane.read', 'agent.list', 'task.list']

// 固定测试凭据只来自人工seed；真实Store建立当前epoch，但不代表#6独立身份桥或socket认证。
export function catalogFixture() {
  const f = storeFixture()
  const epoch = f.store.connect(target.machine_id, syntheticCredential)
  const policy = { revision: 'caller_1', grants: [{ target, methods: catalogMethods, actions: ['read'] as const }] }
  f.setCaller({ id: 'alice', policy: JSON.parse(JSON.stringify(policy)) })
  f.setLocal({ ...JSON.parse(JSON.stringify(policy)), revision: 'local_1' })
  const capabilities = json('session-capabilities.json')
  capabilities.result.session = target.session
  capabilities.result.server_generation = G
  const origin = { ...wireSource, runtime_generation: G, classification_revision: 'review1' }
  const initial = nativeSource()
  let source: GatewayCatalogSource | undefined = {
    local_provider: f.store.provider(target.machine_id, target.provider_id)!,
    record: {
      wire: { source: origin, support_status: 'validated' },
      compiled,
      capabilities,
      capability_revision: 'caps1'
    },
    source: {
      ...initial,
      binding: {
        ...initial.binding,
        provider_id: target.provider_id,
        target: {
          machine_id: target.machine_id,
          profile: 'session',
          session: target.session!
        },
        binding_revision: 1,
        contract_source_ref: contractRef(origin),
        connection_epoch: epoch,
        recovery_generation: f.store.generation(),
        caller_policy_revision: 'caller_1',
        local_policy_revision: 'local_1'
      }
    },
    expires_at: f.store.clock() + 30_000
  }
  let resolutions = 0
  const catalog = {
    resolve: /* 合成能力已显式绑定本例epoch/target；此回调不是生产原生身份提供者。 */ () => {
      resolutions++
      return source
    }
  }
  const service = new StoreGatewayService({
    store: f.store,
    identities: f.identities,
    localPolicies: f.localPolicies,
    catalog
  })
  return {
    ...f,
    service,
    catalog,
    source: /* 只供测试读取合成registry，不允许MCP调用方注入。 */ () => source!,
    setSource: /* 替换当前受测来源以验证每次fresh校验，compiled opaque handle保持真实。 */ (
      next: GatewayCatalogSource | undefined
    ) => {
      source = next
    },
    resolutions: /* 统计是否在授权之前错误触及来源提供者。 */ () => resolutions
  }
}
