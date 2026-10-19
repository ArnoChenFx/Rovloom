// 在新建私有目录中于 prepare 后突然退出，用真实 SQLite 验证持久 blocked 与遗留锁。
import { randomUUID, randomBytes } from 'node:crypto'
import { IdentityStore, PersistentIdentity } from '../../src/transport/index.js'
import type { DeviceLedger } from '../../src/transport/index.js'

// 只在测试新建目录中模拟进程突然退出，不读取真实用户身份或凭据。
const path = process.argv.at(-1)!
const repository = new IdentityStore(path, {
  generation: 'mock_crash',
  /** 为独立崩溃 fixture 提供无真实设备的门禁占位，生产入口不使用此回调。 */
  guard() {},
  /** 为仅有少量 mock 行的崩溃 fixture 提供预算占位，不代表生产预算分配。 */
  checkBudget() {},
  /** 固定崩溃 fixture 时间，使确认和到期不依赖墙钟。 */
  now: () => 1000
})
const ledger: DeviceLedger = {
  /** 提供该子进程专用的 mock 恢复代次。 */
  generation: () => 'mock_crash',
  /** 保留假账本门禁接口形状；该子进程不会接触真实业务 Store。 */
  guard() {},
  /** 提供不用于真实连接的 mock epoch，崩溃路径不执行出站认证。 */
  connectVerifiedDevice: () => 'mock_epoch',
  /** 保留无真实连接的 fence 接口，崩溃验证只检查持久 prepare。 */
  assert() {},
  /** 保留无真实 socket 的断开接口，不影响其它任务连接。 */
  disconnect() {},
  /** 保留假账本撤销接口，避免崩溃模拟触达真实设备状态。 */
  revoke() {},
  /** 提交身份 prepare 后立即以指定退出码终止子进程，留下真实 SQLite 状态与 writer 锁。 */
  resetDeviceEnrollment(_machine, _generation, _epoch, prepare) {
    prepare()
    process.exit(77)
  }
}
const identity = new PersistentIdentity(repository, {
  ledger,
  /** 为崩溃 fixture 发出唯一且短期的 mock 管理确认，不构成生产授权。 */
  authorize: () => ({ actor: 'mock_admin', confirmation_id: randomUUID(), expires_at: 2000 }),
  /** 保留无外部资源的失效通知接口，崩溃负例不执行真实清理动作。 */
  changed() {},
  /** 崩溃 fixture 没有网络资源，prepare 的封锁回调保持同步且不重入 mock 主库。 */
  block() {}
})
identity.install({
  machine_id: 'mock_machine',
  recovery_generation: 'mock_crash',
  credential: randomBytes(32).toString('base64url')
})
identity.rePair('mock_machine', null)
throw new Error('mock_crash_not_reached')
