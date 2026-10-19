// 组合持久凭据 hash 与业务账本，实施轮换、撤销、同 ID 重配及接管的拒绝优先顺序。
import { randomBytes } from 'node:crypto'
import { hash, fail, id } from '../wire/index.js'
import type { ConnectionIdentity } from '../wire/types.js'
import type { DeviceCredential, IdentityHost } from './identity.js'
import { IdentityStore } from './identity-store.js'
import type { IdentityAuthorizer, IdentityRecord } from './identity-store.js'

export interface DeviceLedger {
  /** 读取受信账本当前恢复代次，禁止从消息字段建立当前来源。 */
  generation(): string
  /** 当前业务存储不处于 active 或已隔离时拒绝身份操作，不提供默认放行。 */
  guard(): void
  /** 独立 hash 校验后由 Store 原子要求 offline/当前代次；fresh epoch 与审计提交后才返回。 */
  connectVerifiedDevice(machine: string, generation: string): string
  /** 复验当前凭据或连接 fence，撤销、旧代次及旧 epoch 必须拒绝。 */
  assert(identity: ConnectionIdentity): void
  /** 只断开精确匹配的连接 epoch，不把临时离线当作持久撤销。 */
  disconnect(identity: ConnectionIdentity): void
  /** 先核对独立确认与精确 epoch，再恰好一次同步 prepare，让同 ID 安全进入 pending。 */
  resetDeviceEnrollment(machine: string, generation: string, expectedEpoch: string | null, prepare: () => void): void
  /** 事务性撤销设备及其全部 provider 业务路径，必要审计成功前不能报告已生效。 */
  revoke(machine: string): void
}
export type PersistentIdentityOptions = {
  ledger: DeviceLedger
  authorize: IdentityAuthorizer
  /** 重配 prepare 内同步拒绝通道并清资源；不得重入主 Store 断连或写入。 */
  block(machine: string): void
  /** 身份/业务提交后关闭失效连接，可正常断开旧 Store epoch，失败不能恢复拒绝。 */
  changed(machine: string): void
}

export class PersistentIdentity implements IdentityHost {
  /** 组合 hash 身份库与业务账本，首先要求双方恢复代次一致。 */
  constructor(
    private readonly store: IdentityStore,
    private readonly options: PersistentIdentityOptions
  ) {
    if (store.generation() !== options.ledger.generation()) {
      fail('identity_recovery_required')
    }
  }
  /** 复验当前账本门禁及恢复代次，拒绝跨恢复状态继续使用身份记录。 */
  private guard(): void {
    if (this.options.ledger.guard() !== undefined) {
      fail('identity_host_required')
    }
    if (this.generation() !== this.store.generation()) {
      fail('identity_recovery_required')
    }
  }
  /** 读取受信业务账本的当前恢复代次，不从请求输入推导。 */
  generation(): string {
    return this.options.ledger.generation()
  }
  /** 校验显式凭据 TTL 和到期值的整数安全范围，不自动续期。 */
  private ttl(now: number, ttl: number): number {
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 31 * 86_400_000 || !Number.isSafeInteger(now + ttl)) {
      fail('invalid_credential_ttl')
    }
    return now + ttl
  }
  /** 经独立确认提交首份或获准重配后的凭据 hash；既有 active 身份不能被覆盖。 */
  install(device: DeviceCredential, ttl = 24 * 3_600_000): number {
    this.guard()
    id(device.machine_id)
    if (device.recovery_generation !== this.generation() || !/^[A-Za-z0-9_-]{32,256}$/.test(device.credential)) {
      fail('invalid_device_credential')
    }
    return this.store.change(
      device.machine_id,
      'install',
      this.options.authorize,
      null,
      /** 只为新设备或 pending 重配行保存固定到期的单份 hash，并推进 revision。 */
      (previous, now) => {
        if (previous && previous.status !== 'pending') {
          fail('device_already_paired')
        }
        const row: IdentityRecord = {
          machine_id: device.machine_id,
          revision: (previous?.revision ?? 0) + 1,
          status: 'active',
          current_hash: hash(device.credential),
          current_expires: this.ttl(now, ttl),
          previous_hash: null,
          previous_expires: 0
        }
        return { row, result: row.revision }
      }
    )
  }
  /** 验证持久租期后由 Store 创建 fresh epoch，再次复验防止宿主重入撤销时返回许可。 */
  authenticate(machine: string, generation: string, credential: string) {
    this.guard()
    if (typeof credential !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(credential)) {
      fail('invalid_device_credential')
    }
    const lease = hash(credential)
    this.store.verify(machine, generation, lease)
    const epoch = this.options.ledger.connectVerifiedDevice(machine, generation)
    const identity = { machine_id: machine, recovery_generation: generation, connection_epoch: epoch }
    try {
      // 宿主桥可调用管理回调，返回后再次检查，避免重入撤销期间返回认证许可。
      this.store.verify(machine, generation, lease)
      this.options.ledger.assert(identity)
    } catch {
      this.options.ledger.disconnect(identity)
      fail('invalid_device_credential')
    }
    return { identity, lease }
  }
  /** 同时核对持久凭据租期与当前 Store 连接 fence，旧 epoch 或撤销均不能复用。 */
  assert(identity: ConnectionIdentity, lease: string): void {
    this.guard()
    this.store.verify(identity.machine_id, identity.recovery_generation, lease)
    this.options.ledger.assert(identity)
  }
  /** 只断开对应连接 epoch，不将临时离线当作持久撤销。 */
  disconnect(identity: ConnectionIdentity): void {
    this.options.ledger.disconnect(identity)
  }
  /** 经当前授权生成新凭据并提交有界双凭据过渡；同一时间不允许第二个未完成轮换。 */
  rotate(machine: string, overlapMs: number, ttl = 24 * 3_600_000): DeviceCredential {
    this.guard()
    if (!Number.isSafeInteger(overlapMs) || overlapMs < 1 || overlapMs > 600_000) {
      fail('invalid_rotation_overlap')
    }
    const credential = randomBytes(32).toString('base64url')
    const result = this.store.change(
      machine,
      'rotate',
      this.options.authorize,
      null,
      /** 保留旧 hash 至有界重叠期限并保存新 hash，到期或已有过渡时拒绝写入。 */
      (row, now) => {
        if (row?.status !== 'active' || row.current_expires <= now) {
          fail('invalid_device_credential')
        }
        if (row.previous_hash && row.previous_expires > now) {
          fail('rotation_in_progress')
        }
        return {
          row: {
            ...row,
            revision: row.revision + 1,
            current_hash: hash(credential),
            current_expires: this.ttl(now, ttl),
            previous_hash: row.current_hash,
            previous_expires: Math.min(row.current_expires, now + overlapMs)
          },
          result: { machine_id: machine, recovery_generation: this.generation(), credential }
        }
      }
    )
    try {
      this.options.changed(machine)
    } catch {
      // 签发已提交但尚未返回 custody，不能依赖调用者已记录新凭据来收敛。
      this.store.denyDelivery(machine, hash(credential))
      fail('identity_change_incomplete')
    }
    return result
  }
  /** 提交旧过渡凭据失效，并通知宿主同步关闭失效资源。 */
  finishRotation(machine: string): void {
    this.guard()
    this.store.change(
      machine,
      'finish_rotation',
      this.options.authorize,
      null,
      /** 仅对仍有过渡凭据的 active 行清除旧 hash，同时推进 revision。 */
      (row) => {
        if (row?.status !== 'active' || !row.previous_hash) {
          fail('rotation_not_pending')
        }
        return {
          row: { ...row, revision: row.revision + 1, previous_hash: null, previous_expires: 0 },
          result: undefined
        }
      }
    )
    this.options.changed(machine)
  }
  /** 为撤销或重配先提交 blocked 和旧凭据失效，后续跨库失败也不自动恢复权限。 */
  private stage(machine: string, action: 'revoke' | 're_pair', epoch: string | null): number {
    this.guard()
    const revision = this.store.change(
      machine,
      action,
      this.options.authorize,
      epoch,
      /** 构造单调的新 blocked 行并移除全部旧 hash，保留稳定设备历史关联。 */
      (row) => {
        if ((!row && action !== 're_pair') || row?.status === 'revoked') {
          fail('invalid_machine_state')
        }
        const previous = row ?? {
          machine_id: machine,
          revision: 0,
          status: 'blocked' as const,
          current_hash: null,
          current_expires: 0,
          previous_hash: null,
          previous_expires: 0
        }
        const blocked = {
          ...previous,
          revision: previous.revision + 1,
          status: 'blocked' as const,
          current_hash: null,
          current_expires: 0,
          previous_hash: null,
          previous_expires: 0
        }
        return { row: blocked, result: blocked.revision }
      }
    )
    return revision
  }
  /** 完成业务账本动作、资源失效通知和 blocked 收敛；任一步失败都保守报告未完成。 */
  private complete(
    machine: string,
    revision: number,
    status: 'active' | 'pending' | 'revoked',
    operation: () => void
  ): void {
    try {
      operation()
      this.options.changed(machine)
      this.store.settle(machine, revision, status)
    } catch {
      try {
        this.options.changed(machine)
      } catch {
        /* 持久 blocked 不因资源关闭失败而撤销。 */
      }
      fail('identity_change_incomplete')
    }
  }
  /** 先持久拒绝设备凭据，再提交 Store 的独立撤销及资源关闭。 */
  revoke(machine: string): void {
    const revision = this.stage(machine, 'revoke', null)
    this.complete(
      machine,
      revision,
      'revoked',
      /** 调用业务 Store 的持久撤销，保留其独立管理确认和审计门禁。 */
      () => this.options.ledger.revoke(machine)
    )
  }
  /** 在 Store 已核对精确 fence 的事务内提交重配 prepare，成功后同 ID 才进入 pending。 */
  rePair(machine: string, expectedEpoch: string | null): void {
    this.guard()
    let revision: number | undefined
    try {
      // Store 先核对 epoch/管理确认，再在同一 writer 事务内调用 prepare；旧快照不能先破坏新身份。
      this.options.ledger.resetDeviceEnrollment(
        machine,
        this.generation(),
        expectedEpoch,
        /** 恰好一次提交重配的拒绝阶段，不发网络请求、不执行原生动作。 */
        () => {
          if (revision !== undefined) {
            fail('identity_reentrancy')
          }
          revision = this.stage(machine, 're_pair', expectedEpoch)
          let failed = false
          try {
            failed = this.options.block(machine) !== undefined
          } catch {
            failed = true
          }
          if (failed) {
            fail('synchronous_channel_block_required')
          }
        }
      )
      if (revision === undefined) {
        fail('identity_prepare_required')
      }
      this.options.changed(machine)
      this.store.settle(machine, revision, 'pending')
    } catch {
      if (revision !== undefined) {
        try {
          this.options.changed(machine)
        } catch {
          /* prepare 已提交的 blocked 不自动恢复。 */
        }
      }
      fail('identity_change_incomplete')
    }
  }
  /** 绑定旧 epoch 签发只交新 custody 的新凭据，旧凭据失效后才完成连接接管。 */
  takeover(identity: ConnectionIdentity, ttl = 24 * 3_600_000): DeviceCredential {
    this.guard()
    this.options.ledger.assert(identity)
    const credential = randomBytes(32).toString('base64url')
    // 接管凭据只交给明确授权的新 custody；旧 Connector 的自动重连不能再凭复制旧凭据抢回。
    const revision = this.store.change(
      identity.machine_id,
      'takeover',
      this.options.authorize,
      identity.connection_epoch,
      /** 以新 hash 替换全部旧凭据并先进入 blocked，防止原 Connector 自动重连抢回。 */
      (row, now) => {
        if (row?.status !== 'active') {
          fail('invalid_machine_state')
        }
        return {
          row: {
            ...row,
            revision: row.revision + 1,
            status: 'blocked',
            current_hash: hash(credential),
            current_expires: this.ttl(now, ttl),
            previous_hash: null,
            previous_expires: 0
          },
          result: row.revision + 1
        }
      }
    )
    this.complete(
      identity.machine_id,
      revision,
      'active',
      /** 仅断开已获明确接管授权的原连接 epoch。 */
      () => this.options.ledger.disconnect(identity)
    )
    return { machine_id: identity.machine_id, recovery_generation: identity.recovery_generation, credential }
  }
  /** 拒绝仍存在于当前或过渡租期的精确交付 hash，并清理因此失效的连接。 */
  rejectDelivery(machine: string, digest: string): void {
    this.store.denyDelivery(machine, digest)
    this.options.changed(machine)
  }
  /** 读取仍 active 的当前凭据 revision，供专用交付关联；不返回 secret。 */
  credentialRevision(machine: string): number {
    this.guard()
    const row = this.store.read(machine)
    if (row?.status !== 'active') {
      fail('invalid_device_credential')
    }
    return row.revision
  }
}
