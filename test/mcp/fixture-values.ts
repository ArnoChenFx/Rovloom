// 只提供隔离测试的固定值；导入不编译schema、不创建身份或运行任何后端。
import type { V2Target } from '../../src/wire/types.js'

export const syntheticCredential = 'SYNTHETIC_DEVICE_TEST_ONLY_NOT_ISSUED'
export const target: V2Target = { machine_id: 'machine_a', provider_id: 'luvus_a', profile: 'session', session: 'test' }
export const secondTarget: V2Target = {
  machine_id: 'machine_b',
  provider_id: 'luvus_b',
  profile: 'session',
  session: 'test'
}
export const syntheticSecret = 'SYNTHETIC_SECRET_DO_NOT_PRINT'

export const catalogMethods = ['ping', 'workspace.list', 'pane.read', 'agent.list', 'task.list']
