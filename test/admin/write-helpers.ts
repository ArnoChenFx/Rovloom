// 管理写测试使用临时真实 Store 与合成短期管理员；不创建生产账户或长期凭据。
import { randomUUID } from 'node:crypto'
import { Store } from '../../src/store.js'
import type { StoreOptions } from '../../src/store.js'
import { StoreManagementWriteService } from '../../src/admin/write-service.js'
import type {
  AdminContext,
  Administrator,
  ConfirmationDraft,
  GatewayIdentitySource,
  ManagementGrant,
  ManagementIntent,
  ManagementWrite
} from '../../src/mcp/management.js'

/** 每次构造独立测试会话；它没有任何生产身份效力。 */
export function context(): AdminContext {
  return {
    caller: { principal_id: 'fixture_admin' },
    management_session_ref: 'fixture_session',
    wait_signal: new AbortController().signal
  }
}
/** 创建受控身份来源并允许逐请求撤权，服务始终读取同一实际 Store。 */
export function setup(store?: Store, options: StoreOptions = {}) {
  let time = 1000
  const ledger = store ?? new Store(':memory:', /* 合成可控时钟用于精确期限断言。 */ () => time, options)
  let admin: Administrator | null = {
    principal_id: 'fixture_admin',
    session_ref: 'fixture_session',
    assurance: 'administrator',
    policy_revision: 'fixture_policy_1',
    grants: [{ action: 'devices_register' }]
  }
  let authenticated = true
  const identities: GatewayIdentitySource = {
    /** 合成 principal 每次读取均检查测试身份开关，不从请求 JSON 增权。 */
    principal(caller) {
      return authenticated && caller.principal_id === 'fixture_admin'
        ? { id: 'fixture_admin', policy: { revision: 'fixture_caller_1', grants: [] } }
        : null
    },
    /** 只接受本 fixture 独立管理会话，普通 caller 与设备身份保持拒绝。 */
    administrator(caller, session) {
      return authenticated && caller.principal_id === 'fixture_admin' && session === admin?.session_ref ? admin : null
    }
  }
  const transport = { /** 单元测试不连接 socket；真实资源刷新在双Connector集成中另验。 */ refresh() {} }
  const service = new StoreManagementWriteService({
    store: ledger,
    identities,
    transport,
    /** 显式合成策略仅记录测试申请，不授予任何设备权限。 */ pairingPolicy: (ref) => ref === 'fixture_policy'
  })
  return {
    store: ledger,
    service,
    identities,
    /** 在当前合成管理员上追加精确管理授权。 */
    grant(...grants: ManagementGrant[]) {
      if (admin) {
        admin = { ...admin, grants: [...admin.grants, ...grants] }
      }
    },
    /** 直接替换合成会话用于失效、撤权和越目标测试。 */
    set admin(value: Administrator | null) {
      admin = value
    },
    /** 返回合成管理员快照，供测试显式修改政策。 */
    get admin() {
      return admin
    },
    /** 控制 fixture 当前 principal 的存在性，不修改生产身份。 */
    set authenticated(value: boolean) {
      authenticated = value
    },
    /** 精确推进合成 Store 时钟。 */
    advance(delta: number) {
      time += delta
    },
    /** 只关闭本 fixture 拥有的 Store。 */
    close() {
      if (!store) {
        ledger.close()
      }
    }
  }
}
/** 用服务器实际确认记录生成同一次操作范围，不构造 approved 标志。 */
export async function confirmed(service: StoreManagementWriteService, operation: ManagementIntent, revision: number) {
  const history = await service.execute('history_open', {}, context())
  const draft: ConfirmationDraft = {
    ...operation,
    request_id: 'request_' + randomUUID(),
    history_epoch: history.history_epoch,
    recovery_generation: history.recovery_generation,
    expected_revision: revision,
    reason: 'administrator_request'
  }
  const confirmation = await service.execute('confirmations_create', draft, context())
  const write: ManagementWrite = {
    request_id: draft.request_id,
    history_epoch: draft.history_epoch,
    recovery_generation: draft.recovery_generation,
    expected_revision: revision,
    reason: draft.reason,
    confirmation_id: confirmation.confirmation_id
  }
  await service.execute(
    'confirmations_confirm',
    { ...write, operation_digest: confirmation.operation_digest },
    context()
  )
  return { draft, confirmation, write }
}
