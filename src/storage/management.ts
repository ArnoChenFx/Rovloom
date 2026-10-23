// 在既有 Store writer 中保存管理范围、一次性确认、配对申请与回执，不持有凭据或建立第二设备账本。
import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { canonical, digest, GatewayError } from '../contracts.js'
import type { Machine } from './model.js'
import type { ProviderBinding } from '../wire/types.js'
import type {
  ConfirmationDraft,
  ConfirmationView,
  ManagementIntent,
  ManagementReply,
  ManagementWrite,
  OperationReceipt,
  ResourceTarget
} from '../mcp/management.js'

export type ManagementActor = { actor: string; session_hash: string; policy_digest: string }
export type ManagementAuthority = () => ManagementActor
export type ManagementPrimitives = {
  transaction<T>(run: (now: number) => T): T
  guard(): void
  generation(): string
  clock(): number
  register(name: string, now: number): Machine
  rename(machine: string, name: string, now: number): Machine
  disconnect(machine: string, epoch: string, now: number): void
  revoke(machine: string, now: number): void
  provider(machine: string, provider: string, revision: number, enabled: boolean, now: number): ProviderBinding
  approveClaim(claimId: string, userCode: string, now: number): { machine_id: string; credential: string }
  claimCustody(event: { machine_id: string; claim_id: string; credential: string }): void
  audit(action: string, actor: string, now: number, details: Record<string, unknown>, event: string): void
}
type ConfirmationRow = {
  confirmation_id: string
  history_epoch: string
  request_id: string
  operation_digest: string
  summary: string
  resource_digest: string
  impact_json: string
  state: ConfirmationView['state']
  expires: number
}
type HistoryRow = ManagementActor & { generation: string; accept_until: number; expires: number }
type Resource = { revision: number; epoch: string | null; binding_revision: number | null; fingerprint: string }

/** 组合可信 Store 原语；所有 mutation 都在原事务、预算和审计门禁内执行。 */
export class ManagementLedger {
  /** 只接收 Store 构造时注入的私有 SQLite 与同库原语，普通输入无法更换后端。 */
  constructor(
    private readonly db: DatabaseSync,
    private readonly host: ManagementPrimitives,
    private readonly retention: number
  ) {}

  /** 认证与当前政策由共享服务重读；相同会话的重复请求不会刷新既有 scope。 */
  open(authority: ManagementAuthority): ManagementReply['history_open'] {
    return this.host.transaction(
      /* writer 持锁后复验管理员并原子登记有限范围。 */ (now) => {
        const actor = authority()
        const generation = this.host.generation()
        const old = this.db
          .prepare(
            'SELECT history_epoch,accept_until FROM admin_history WHERE actor=? AND session_hash=? AND policy_digest=? AND generation=? AND accept_until>? ORDER BY accept_until DESC LIMIT 1'
          )
          .get(actor.actor, actor.session_hash, actor.policy_digest, generation, now)
        if (old) {
          return {
            history_epoch: String(old.history_epoch),
            recovery_generation: generation,
            accept_new_until: Number(old.accept_until)
          }
        }
        const history = 'admin_history_' + randomUUID()
        const until = now + Math.min(300_000, this.retention)
        this.db
          .prepare('INSERT INTO admin_history VALUES(?,?,?,?,?,?,?)')
          .run(history, actor.actor, actor.session_hash, generation, actor.policy_digest, until, until + this.retention)
        return { history_epoch: history, recovery_generation: generation, accept_new_until: until }
      }
    )
  }

  /** 缺失/过期/其它会话/旧代次明确拒绝，不能把没有记录解释为新意图。 */
  private history(
    write: { history_epoch: string; recovery_generation: string },
    actor: ManagementActor,
    now: number,
    fresh: boolean
  ): HistoryRow {
    const row = this.db.prepare('SELECT * FROM admin_history WHERE history_epoch=?').get(write.history_epoch) as
      | HistoryRow
      | undefined
    if (
      !row ||
      row.actor !== actor.actor ||
      row.session_hash !== actor.session_hash ||
      row.generation !== write.recovery_generation ||
      row.generation !== this.host.generation() ||
      now >= row.expires ||
      (fresh && (now >= row.accept_until || row.policy_digest !== actor.policy_digest))
    ) {
      throw new GatewayError('management_history_unavailable')
    }
    return row
  }

  /** 管理 revision 和完整持久状态共同形成确认 fence；provider 配置只进入内部摘要。 */
  private resource(intent: ManagementIntent): Resource {
    if (intent.action === 'pairing_create' && 'name' in intent.target) {
      return { revision: 0, epoch: null, binding_revision: null, fingerprint: digest(canonical(intent.target)) }
    }
    const target = intent.target as ResourceTarget
    const machine = this.db
      .prepare('SELECT machine_id,name,status,epoch,resource_revision,labels_json FROM machines WHERE machine_id=?')
      .get(target.machine_id)
    if (!machine) {
      throw new GatewayError('machine_not_found')
    }
    if (!['pending', 'offline', 'online', 'revoked'].includes(String(machine.status))) {
      throw new GatewayError('invalid_machine_state')
    }
    if (
      !Number.isSafeInteger(machine.resource_revision) ||
      Number(machine.resource_revision) < 1 ||
      Number(machine.resource_revision) >= Number.MAX_SAFE_INTEGER - 1
    ) {
      throw new GatewayError('revision_conflict')
    }
    if (intent.action === 'provider_disable' || intent.action === 'provider_enable') {
      const provider = this.db
        .prepare('SELECT * FROM providers WHERE machine_id=? AND provider_id=?')
        .get(target.machine_id, target.provider_id!)
      if (
        !provider ||
        provider.kind !== intent.target.kind ||
        provider.binding_revision !== intent.expected_binding_revision ||
        Number(provider.binding_revision) >= Number.MAX_SAFE_INTEGER - 1
      ) {
        throw new GatewayError('provider_binding_mismatch')
      }
      if (
        (intent.action === 'provider_enable' && provider.enabled === 1) ||
        (intent.action === 'provider_disable' && provider.enabled === 0)
      ) {
        throw new GatewayError('invalid_machine_state')
      }
      if (machine.status === 'revoked') {
        throw new GatewayError('invalid_machine_state')
      }
      return {
        revision: Number(provider.binding_revision),
        epoch: null,
        binding_revision: Number(provider.binding_revision),
        fingerprint: digest(canonical({ machine: { ...machine }, provider: { ...provider } }))
      }
    }
    if (
      intent.action === 'device_disconnect' &&
      (machine.status !== 'online' || machine.epoch !== intent.expected_connection_epoch)
    ) {
      throw new GatewayError('connection_epoch_conflict')
    }
    if (intent.action === 'pairing_create' && machine.status !== 'pending') {
      throw new GatewayError('invalid_machine_state')
    }
    if (intent.action === 'device_revoke' && machine.status === 'revoked') {
      throw new GatewayError('invalid_machine_state')
    }
    return {
      revision: Number(machine.resource_revision),
      epoch: machine.epoch as string | null,
      binding_revision: null,
      fingerprint: digest(
        canonical({
          machine: { ...machine },
          providers:
            intent.action === 'device_revoke'
              ? this.db
                  .prepare(
                    'SELECT provider_id,kind,binding_revision,enabled FROM providers WHERE machine_id=? ORDER BY provider_id'
                  )
                  .all(target.machine_id)
                  .map(/* 撤销确认绑定所有当前实例，新增或变更provider后必须重新确认。 */ (row) => ({ ...row }))
              : []
        })
      )
    }
  }

  /** 返回只供已授权管理写入使用的精确 fence，不把展示用 epoch 引用当能力。 */
  state(target: ResourceTarget, authority: ManagementAuthority): ManagementReply['write_state_get'] {
    this.host.guard()
    authority()
    const row = this.db
      .prepare('SELECT resource_revision,epoch FROM machines WHERE machine_id=?')
      .get(target.machine_id)
    if (!row) {
      throw new GatewayError('machine_not_found')
    }
    let revision = Number(row.resource_revision)
    let binding: number | null = null
    if (target.provider_id) {
      const provider = this.db
        .prepare('SELECT binding_revision FROM providers WHERE machine_id=? AND provider_id=?')
        .get(target.machine_id, target.provider_id)
      if (!provider) {
        throw new GatewayError('provider_binding_mismatch')
      }
      revision = binding = Number(provider.binding_revision)
    }
    return {
      target,
      resource_revision: revision,
      recovery_generation: this.host.generation(),
      connection_epoch: target.provider_id ? null : (row.epoch as string | null),
      binding_revision: binding
    }
  }

  /** 确认摘要无凭据、无会话引用，重读也不会延长期限。 */
  private view(row: ConfirmationRow, now: number): ConfirmationView {
    return {
      affected_providers: JSON.parse(row.impact_json),
      confirmation_id: row.confirmation_id,
      state: row.state === 'consumed' ? 'consumed' : now >= row.expires ? 'expired' : row.state,
      operation_digest: row.operation_digest,
      summary: JSON.parse(row.summary),
      expires_at: row.expires
    }
  }

  /** 同一 request_id 只能绑定一个意图，首次申请在服务器保存目标与当前 fence。 */
  create(draft: ConfirmationDraft, authority: ManagementAuthority): ConfirmationView {
    return this.host.transaction(
      /* 当前管理员、history 与资源 fence 均在原 writer 事务内核对。 */ (now) => {
        const actor = authority()
        this.history(draft, actor, now, true)
        const { request_id, history_epoch, ...summary } = draft
        const operation = digest(canonical({ summary, request_id, history_epoch, actor }))
        const old = this.db
          .prepare('SELECT * FROM admin_confirmations WHERE history_epoch=? AND request_id=?')
          .get(history_epoch, request_id) as ConfirmationRow | undefined
        if (old) {
          if (old.operation_digest !== operation) {
            throw new GatewayError('idempotency_conflict')
          }
          return this.view(old, now)
        }
        const resource = this.resource(draft)
        if (resource.revision !== draft.expected_revision) {
          throw new GatewayError('revision_conflict')
        }
        const row: ConfirmationRow = {
          confirmation_id: 'confirmation_' + randomUUID(),
          history_epoch,
          request_id,
          operation_digest: operation,
          summary: canonical(summary),
          resource_digest: resource.fingerprint,
          impact_json: canonical(
            draft.action === 'device_revoke'
              ? this.db
                  .prepare(
                    'SELECT provider_id,kind,binding_revision,enabled FROM providers WHERE machine_id=? ORDER BY provider_id'
                  )
                  .all(draft.target.machine_id)
                  .map(
                    /* 显示完整撤销影响，保留原确认时点的实例集合。 */ (provider) => ({
                      provider_id: String(provider.provider_id),
                      kind: String(provider.kind),
                      binding_revision: Number(provider.binding_revision),
                      enabled: provider.enabled === 1
                    })
                  )
              : []
          ),
          state: 'pending',
          expires: now + 120_000
        }
        this.db
          .prepare('INSERT INTO admin_confirmations VALUES(?,?,?,?,?,?,?,?,?)')
          .run(
            row.confirmation_id,
            history_epoch,
            request_id,
            operation,
            row.summary,
            row.resource_digest,
            row.impact_json,
            row.state,
            row.expires
          )
        return this.view(row, now)
      }
    )
  }

  /** 从指定 history/request 读取确认，拒绝换会话、换摘要和一份确认用于不同操作。 */
  private confirmation(write: ManagementWrite, now: number): ConfirmationRow {
    const row = this.db
      .prepare('SELECT * FROM admin_confirmations WHERE confirmation_id=? AND history_epoch=? AND request_id=?')
      .get(write.confirmation_id, write.history_epoch, write.request_id) as ConfirmationRow | undefined
    if (!row) {
      throw new GatewayError('confirmation_required')
    }
    const summary = JSON.parse(row.summary) as ConfirmationDraft
    if (
      summary.recovery_generation !== write.recovery_generation ||
      summary.expected_revision !== write.expected_revision ||
      summary.reason !== write.reason
    ) {
      throw new GatewayError('confirmation_mismatch')
    }
    if (now >= row.expires && row.state !== 'consumed') {
      throw new GatewayError('confirmation_expired')
    }
    return row
  }

  /** 此端口只供受信管理会话交互调用；不接收 approved 布尔值或 MCP 自报身份。 */
  confirm(write: ManagementWrite & { operation_digest: string }, authority: ManagementAuthority): ConfirmationView {
    return this.host.transaction(
      /* 同一管理员的确认不执行设备动作，也不续期或修改摘要。 */ (now) => {
        this.history(write, authority(), now, true)
        const row = this.confirmation(write, now)
        if (row.operation_digest !== write.operation_digest) {
          throw new GatewayError('confirmation_mismatch')
        }
        const summary = JSON.parse(row.summary) as ConfirmationDraft
        if (row.state !== 'consumed' && this.resource(summary).fingerprint !== row.resource_digest) {
          throw new GatewayError('revision_conflict')
        }
        if (row.state === 'pending') {
          row.state = 'confirmed'
          this.db
            .prepare("UPDATE admin_confirmations SET state='confirmed' WHERE confirmation_id=?")
            .run(row.confirmation_id)
        }
        return this.view(row, now)
      }
    )
  }

  /** 获取既有意图用于当前精确权限复验；这里只读无秘密摘要，不消费确认。 */
  intent(
    write: { history_epoch: string; request_id: string; recovery_generation: string },
    authority: ManagementAuthority
  ): ManagementIntent {
    this.host.guard()
    this.history(write, authority(), this.host.clock(), false)
    const row = this.db
      .prepare('SELECT summary FROM admin_confirmations WHERE history_epoch=? AND request_id=?')
      .get(write.history_epoch, write.request_id)
    if (!row) {
      throw new GatewayError('confirmation_required')
    }
    return JSON.parse(String(row.summary)) as ManagementIntent
  }

  /** 先查询原回执再检查旧资源 fence，重送已提交意图不会执行第二次或关闭新连接。 */
  commit(
    intent: ManagementIntent,
    write: ManagementWrite,
    authority: ManagementAuthority,
    beforeMutation: () => void
  ): OperationReceipt {
    return this.host.transaction(
      /* 管理修改、确认消费、真实操作者审计和回执原子提交。 */ (now) => {
        const actor = authority()
        this.history(write, actor, now, false)
        const row = this.confirmation(write, now)
        const saved = JSON.parse(row.summary)
        const expected = {
          ...intent,
          recovery_generation: write.recovery_generation,
          expected_revision: write.expected_revision,
          reason: write.reason
        }
        if (canonical(saved) !== canonical(expected)) {
          throw new GatewayError('confirmation_mismatch')
        }
        const old = this.db
          .prepare('SELECT receipt FROM admin_operations WHERE history_epoch=? AND request_id=?')
          .get(write.history_epoch, write.request_id)
        if (old) {
          return JSON.parse(String(old.receipt)) as OperationReceipt
        }
        this.history(write, actor, now, true)
        if (row.state !== 'confirmed') {
          throw new GatewayError('confirmation_required')
        }
        const resource = this.resource(intent)
        if (resource.revision !== write.expected_revision || resource.fingerprint !== row.resource_digest) {
          throw new GatewayError('revision_conflict')
        }
        beforeMutation()
        // 外部proof可刷新身份或政策；最后一次外部回调之后复验原scope、摘要与资源，才允许业务修改。
        this.history(write, authority(), now, true)
        if (canonical(saved) !== canonical(expected)) {
          throw new GatewayError('confirmation_mismatch')
        }
        const currentResource = this.resource(intent)
        if (
          currentResource.revision !== write.expected_revision ||
          currentResource.fingerprint !== row.resource_digest
        ) {
          throw new GatewayError('revision_conflict')
        }
        let target: ResourceTarget = {
          machine_id: 'machine_id' in intent.target ? intent.target.machine_id : '',
          ...('provider_id' in intent.target ? { provider_id: intent.target.provider_id } : {})
        }
        let binding: number | null = null
        if (intent.action === 'pairing_create') {
          if ('name' in intent.target) {
            target = { machine_id: this.host.register(intent.target.name, now).machine_id }
            this.db
              .prepare('UPDATE machines SET labels_json=? WHERE machine_id=?')
              .run(canonical(intent.target.labels), target.machine_id)
          }
          if (
            this.db
              .prepare("SELECT 1 FROM admin_pairings WHERE machine_id=? AND status='pending' AND expires>?")
              .get(target.machine_id, now)
          ) {
            throw new GatewayError('pairing_conflict')
          }
          this.db
            .prepare('INSERT INTO admin_pairings(pairing_id,machine_id,policy_ref,status,expires) VALUES(?,?,?,?,?)')
            .run('pairing_' + randomUUID(), target.machine_id, intent.target.policy_ref, 'pending', now + 600_000)
          if ('machine_id' in intent.target) {
            this.db
              .prepare('UPDATE machines SET resource_revision=resource_revision+1 WHERE machine_id=?')
              .run(target.machine_id)
          }
        } else if (intent.action === 'device_rename') {
          this.host.rename(target.machine_id, intent.name, now)
        } else if (intent.action === 'device_disconnect') {
          this.host.disconnect(target.machine_id, intent.expected_connection_epoch, now)
        } else if (intent.action === 'device_revoke') {
          this.host.revoke(target.machine_id, now)
        } else if (intent.action === 'pairing_cancel') {
          const changed = this.db
            .prepare(
              "UPDATE admin_pairings SET status='cancelled' WHERE pairing_id=? AND machine_id=? AND status='pending' AND expires>?"
            )
            .run(intent.target.pairing_id, target.machine_id, now)
          if (
            Number(changed.changes) !== 1 ||
            this.db.prepare('SELECT status FROM machines WHERE machine_id=?').get(target.machine_id)?.status !==
              'pending'
          ) {
            throw new GatewayError('pairing_conflict')
          }
          this.db.prepare('DELETE FROM enrollments WHERE machine_id=?').run(target.machine_id)
          // 取消申请时同事务收敛其活动认领，避免已取消申请仍被批准或交付。
          this.db
            .prepare(
              "UPDATE pairing_claims SET status='cancelled' WHERE pairing_id=? AND status IN ('pending','approved')"
            )
            .run(intent.target.pairing_id)
          this.db
            .prepare('UPDATE machines SET resource_revision=resource_revision+1 WHERE machine_id=?')
            .run(target.machine_id)
        } else if (intent.action === 'pairing_claim_approve') {
          // 批准在同一事务内完成签发与兑换；凭据只暂存进在线 custody，回执与审计不含任何秘密。
          if (
            !this.db
              .prepare('SELECT 1 FROM pairing_claims WHERE claim_id=? AND pairing_id=? AND machine_id=?')
              .get(intent.target.claim_id, intent.target.pairing_id, target.machine_id)
          ) {
            throw new GatewayError('pairing_claim_conflict')
          }
          const approved = this.host.approveClaim(intent.target.claim_id, intent.target.user_code, now)
          if (approved.machine_id !== target.machine_id) {
            throw new GatewayError('pairing_claim_conflict')
          }
          this.host.claimCustody({
            machine_id: approved.machine_id,
            claim_id: intent.target.claim_id,
            credential: approved.credential
          })
        } else {
          binding = this.host.provider(
            target.machine_id,
            target.provider_id!,
            intent.expected_binding_revision,
            intent.action === 'provider_enable',
            now
          ).binding_revision
        }
        const event = 'event_' + randomUUID()
        const revision = Number(
          this.db.prepare('SELECT resource_revision FROM machines WHERE machine_id=?').get(target.machine_id)!
            .resource_revision
        )
        const receipt: OperationReceipt = {
          request_id: write.request_id,
          history_epoch: write.history_epoch,
          recovery_generation: write.recovery_generation,
          operation_digest: row.operation_digest,
          action: intent.action,
          target,
          operation_state: 'committed',
          new_revision: binding ?? revision,
          new_binding_revision: binding,
          observed_at: now,
          audit_event_ids: [event],
          evidence: 'current_durable',
          effects: {
            persistent_authorization: intent.action === 'device_revoke' ? 'revoked' : 'unchanged',
            channel:
              intent.action === 'device_disconnect' || intent.action === 'device_revoke' ? 'unconfirmed' : 'unchanged',
            provider:
              intent.action === 'provider_disable'
                ? 'disabled'
                : intent.action === 'provider_enable'
                  ? 'enabled'
                  : 'unchanged',
            native_work: 'may_continue'
          }
        }
        if (intent.action === 'pairing_create') {
          const pairing = this.db
            .prepare(
              "SELECT pairing_id,expires FROM admin_pairings WHERE machine_id=? AND status='pending' ORDER BY expires DESC LIMIT 1"
            )
            .get(target.machine_id)!
          Object.assign(receipt, {
            machine_id: target.machine_id,
            pairing_id: pairing.pairing_id,
            status: 'pending',
            expires_at: pairing.expires,
            requires_local_issuance: false
          })
        }
        if (intent.action === 'pairing_claim_approve') {
          Object.assign(receipt, {
            machine_id: target.machine_id,
            pairing_id: intent.target.pairing_id,
            claim_id: intent.target.claim_id,
            status: 'approved'
          })
        }
        this.host.audit(
          intent.action,
          actor.actor,
          now,
          {
            target,
            request_id: write.request_id,
            history_epoch: write.history_epoch,
            operation_digest: row.operation_digest,
            new_revision: receipt.new_revision,
            outcome: 'committed'
          },
          event
        )
        this.db
          .prepare("UPDATE admin_confirmations SET state='consumed' WHERE confirmation_id=?")
          .run(row.confirmation_id)
        this.db
          .prepare('INSERT INTO admin_operations VALUES(?,?,?,?)')
          .run(write.history_epoch, write.request_id, row.operation_digest, canonical(receipt))
        return receipt
      }
    )
  }

  /** 已提交回执按原会话、history、代次读取，缺失不推断未执行。 */
  receipt(
    write: { request_id: string; history_epoch: string; recovery_generation: string },
    authority: ManagementAuthority
  ): OperationReceipt {
    this.host.guard()
    this.history(write, authority(), this.host.clock(), false)
    const row = this.db
      .prepare('SELECT receipt FROM admin_operations WHERE history_epoch=? AND request_id=?')
      .get(write.history_epoch, write.request_id)
    if (!row) {
      throw new GatewayError('operation_unconfirmed')
    }
    return JSON.parse(String(row.receipt)) as OperationReceipt
  }

  /** 配对进度只来自同库申请和设备状态，独立秘密交付尚未接线时明确未核实。 */
  pairing(machine: string, pairing: string, authority: ManagementAuthority): ManagementReply['pairings_get'] {
    this.host.guard()
    authority()
    const now = this.host.clock()
    const row = this.db
      .prepare(
        'SELECT p.*,m.status machine_status FROM admin_pairings p JOIN machines m USING(machine_id) WHERE pairing_id=? AND machine_id=?'
      )
      .get(pairing, machine)
    if (!row) {
      throw new GatewayError('pairing_not_found')
    }
    const claim = this.db
      .prepare(
        'SELECT claim_id,user_code,status,expires FROM pairing_claims WHERE pairing_id=? ORDER BY created DESC,rowid DESC LIMIT 1'
      )
      .get(pairing) as
      | {
          claim_id: string
          user_code: string
          status: 'pending' | 'approved' | 'delivered' | 'failed' | 'cancelled'
          expires: number
        }
      | undefined
    const status =
      row.status === 'cancelled' || row.machine_status === 'revoked'
        ? 'cancelled'
        : row.status === 'failed' || claim?.status === 'failed'
          ? 'failed'
          : row.status === 'paired'
            ? claim?.status === 'approved'
              ? 'pending'
              : 'paired'
            : now >= Number(row.expires)
              ? 'expired'
              : 'pending'
    return {
      machine_id: machine,
      pairing_id: pairing,
      status,
      expires_at: Number(row.expires),
      // 签发状态如实取自申请行的 issued 标记；在线认领接线后不再冒充未核实。
      issuance: row.issued === 1 ? 'issued' : 'unissued',
      requires_local_issuance: false,
      ...(claim
        ? {
            claim: {
              claim_id: claim.claim_id,
              user_code: claim.user_code,
              status: claim.status,
              expires_at: Number(claim.expires)
            }
          }
        : {})
    }
  }

  /** 失败事务回滚后记录固定拒绝原因；不保存名称、自由文本、凭据或普通请求正文。 */
  denied(operation: ManagementIntent, write: ManagementWrite, reason: string, authority: ManagementAuthority): void {
    this.host.transaction(
      /* 拒绝审计属于同一受管writer和预算，绝不提交先前失败事务的部分修改。 */ (now) => {
        const actor = authority()
        this.history(write, actor, now, false)
        const target = operation.target as ResourceTarget
        this.host.audit(
          'management_denied',
          actor.actor,
          now,
          {
            action: operation.action,
            target: {
              ...('machine_id' in operation.target ? { machine_id: target.machine_id } : {}),
              ...(target.provider_id ? { provider_id: target.provider_id } : {})
            },
            request_id: write.request_id,
            history_epoch: write.history_epoch,
            reason_code: reason,
            outcome: 'rejected'
          },
          'event_' + randomUUID()
        )
      }
    )
  }

  /** 有界保留到期后删除去重范围；未知旧 history 仍拒绝，不能重建同一请求。 */
  expire(now: number): void {
    this.db
      .prepare(
        'DELETE FROM admin_operations WHERE history_epoch IN (SELECT history_epoch FROM admin_history WHERE expires<=?)'
      )
      .run(now)
    this.db
      .prepare(
        'DELETE FROM admin_confirmations WHERE history_epoch IN (SELECT history_epoch FROM admin_history WHERE expires<=?)'
      )
      .run(now)
    this.db.prepare('DELETE FROM admin_history WHERE expires<=?').run(now)
    this.db.prepare('DELETE FROM admin_pairings WHERE expires+?<=?').run(this.retention, now)
  }
}
