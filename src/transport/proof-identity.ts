// 在既有 IdentityStore 上签发进程内一次性证明，独立读取已提交状态，并持久化精确重配封锁。
import { fail, hash, id } from '../wire/index.js'
import type { IdentityAuthorizer } from './identity-store.js'
import { IdentityStore } from './identity-store.js'

export type VerifiedDeviceProof = Readonly<{ handle: object; machine_id: string; recovery_generation: string }>
export interface DeviceProofHost {
  /** 校验固定期限凭据并签发有界短期证明，不能把 JSON 对象当作认证证明。 */
  verifyCredential(machine: string, generation: string, credential: Uint8Array): VerifiedDeviceProof
  /** 同步一次性消费完全相同的证明对象，并再次读取已提交的当前凭据和 revision。 */
  consumeProof(proof: VerifiedDeviceProof, machine: string, generation: string): boolean
  /** 使用独立数据库快照判断该设备当前是否存在有效凭据。 */
  usableCommitted(machine: string, generation: string): boolean
  /** 核对该 socket 认证时绑定的凭据摘要，轮换完成后旧租期不能借新凭据继续使用。 */
  leaseCommitted(machine: string, generation: string, digest: string): boolean
  /** 同步提交旧凭据失效及精确代次/epoch 封锁，不能提前进入可配对状态。 */
  blockCommitted(machine: string, generation: string, epoch: string | null): undefined
  /** 独立连接检查精确封锁已提交，不能用内存标记或当前 writer 暂存状态证明。 */
  blockedCommitted(machine: string, generation: string, epoch: string | null): boolean
  /** 仅在业务 Store 的重配提交成功后收敛已匹配的 blocked revision。 */
  finishReset(machine: string, generation: string, epoch: string | null): void
}
type ProofEntry = { machine: string; generation: string; digest: string; revision: number; expires: number }

export class PersistentProofIdentity implements DeviceProofHost {
  private readonly proofs = new Map<VerifiedDeviceProof, ProofEntry>()
  /** 复用唯一身份库及独立管理确认，不持久化原始凭据或可恢复证明。 */
  constructor(
    private readonly store: IdentityStore,
    private readonly authorize: IdentityAuthorizer
  ) {}
  /** 校验凭据字节、持久租期及当前 revision 后创建 opaque 对象；最多保留 128 个、每个五秒。 */
  verifyCredential(machine: string, generation: string, credential: Uint8Array): VerifiedDeviceProof {
    if (
      !(credential instanceof Uint8Array) ||
      credential.byteLength < 32 ||
      credential.byteLength > 256 ||
      !/^[A-Za-z0-9_-]+$/.test(Buffer.from(credential).toString('ascii')) ||
      credential.some(
        /** 拒绝高位字节，避免 ASCII 解码截断形成不同原文同一凭据。 */
        (byte) => byte > 127
      )
    ) {
      fail('invalid_device_credential')
    }
    const digest = hash(credential)
    const row = this.store.verify(machine, generation, digest)
    const committed = this.store.committed(machine, generation)
    if (!committed || committed.row.revision !== row.revision || committed.row.status !== 'active') {
      fail('invalid_device_credential')
    }
    for (const [proof, entry] of this.proofs) {
      if (entry.expires <= committed.now) {
        this.proofs.delete(proof)
      }
    }
    if (this.proofs.size >= 128) {
      fail('identity_proof_quota')
    }
    const proof = Object.freeze({ handle: Object.freeze({}), machine_id: machine, recovery_generation: generation })
    this.proofs.set(proof, { machine, generation, digest, revision: row.revision, expires: committed.now + 5000 })
    return proof
  }
  /** 先移除真实证明，再核对其全部绑定和独立已提交状态；失败也不可再次消费。 */
  consumeProof(proof: VerifiedDeviceProof, machine: string, generation: string): boolean {
    const entry = this.proofs.get(proof)
    this.proofs.delete(proof)
    if (!entry || entry.machine !== machine || entry.generation !== generation) {
      return false
    }
    const committed = this.store.committed(machine, generation)
    return (
      !!committed &&
      committed.now < entry.expires &&
      committed.row.status === 'active' &&
      committed.row.revision === entry.revision &&
      ((committed.row.current_hash === entry.digest && committed.row.current_expires > committed.now) ||
        (committed.row.previous_hash === entry.digest && committed.row.previous_expires > committed.now))
    )
  }
  /** 独立读取当前 active 凭据的固定到期边界，blocked、撤销、旧代次和降级均拒绝。 */
  usableCommitted(machine: string, generation: string): boolean {
    const committed = this.store.committed(machine, generation)
    return (
      !!committed &&
      committed.row.status === 'active' &&
      ((!!committed.row.current_hash && committed.row.current_expires > committed.now) ||
        (!!committed.row.previous_hash && committed.row.previous_expires > committed.now))
    )
  }
  /** 在独立已提交快照中精确校验 socket 的原摘要与固定到期时间。 */
  leaseCommitted(machine: string, generation: string, digest: string): boolean {
    const committed = this.store.committed(machine, generation)
    return (
      !!committed &&
      committed.row.status === 'active' &&
      ((committed.row.current_hash === digest && committed.row.current_expires > committed.now) ||
        (committed.row.previous_hash === digest && committed.row.previous_expires > committed.now))
    )
  }
  /** 在同一身份事务内消费独立确认、清空全部 hash 并保存精确 fence；业务事务回滚不会撤销此提交。 */
  blockCommitted(machine: string, generation: string, epoch: string | null): undefined {
    if (generation !== this.store.generation()) {
      fail('identity_recovery_required')
    }
    if (epoch !== null) {
      id(epoch)
    }
    this.store.change(
      machine,
      're_pair',
      this.authorize,
      epoch,
      /** 只允许既有未撤销设备进入 blocked，保留 ID 并推进 revision，使所有旧证明失效。 */
      (row) => {
        if (!row || row.status === 'revoked') {
          fail('invalid_machine_state')
        }
        return {
          row: {
            ...row,
            revision: row.revision + 1,
            status: 'blocked',
            current_hash: null,
            current_expires: 0,
            previous_hash: null,
            previous_expires: 0
          },
          result: undefined
        }
      }
    )
    return undefined
  }
  /** 只接受独立快照中状态、空 hash、revision、代次及 nullable epoch 全部匹配的封锁。 */
  blockedCommitted(machine: string, generation: string, epoch: string | null): boolean {
    const committed = this.store.committed(machine, generation)
    return (
      !!committed &&
      committed.row.status === 'blocked' &&
      committed.row.current_hash === null &&
      committed.row.previous_hash === null &&
      committed.row.current_expires === 0 &&
      committed.row.previous_expires === 0 &&
      committed.blocked?.revision === committed.row.revision &&
      committed.blocked.generation === generation &&
      committed.blocked.connection_epoch === epoch
    )
  }
  /** Store 成功返回后精确收敛 blocked；任何未提交、错 fence 或并发管理变更均不能开放新配对。 */
  finishReset(machine: string, generation: string, epoch: string | null): void {
    if (!this.blockedCommitted(machine, generation, epoch)) {
      fail('identity_fence_mismatch')
    }
    const committed = this.store.committed(machine, generation)
    if (!committed) {
      fail('identity_unavailable')
    }
    this.store.settle(machine, committed.row.revision, 'pending')
  }
}
