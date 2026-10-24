// 一次明确配对管理意图的有限状态机；与设备流程同构，只准备/显式确认/提交/查原回执，不接DOM或自动重放。
import { managementRequestId } from './request-id.js'
import type {
  ConfirmationDraft,
  ConfirmationView,
  ManagementArguments,
  ManagementIntent,
  ManagementWrite
} from '../mcp/management.js'
import {
  checkManagementWriteReply,
  checkPairingIntent,
  managementConfirmationKey,
  managementWriteBody,
  ManagementClientError,
  type BrowserReceipt,
  type ManagementClientOperation,
  type ManagementClientProblem,
  type ManagementWriteTransport,
  type PairingManagementIntent,
  type PairingWriteOperation
} from './write-contract.js'
import type { ManagementOperationKey } from './write-flow.js'

export type PairingManagementState =
  | { phase: 'idle' }
  | { phase: 'preparing'; intent: PairingManagementIntent }
  | { phase: 'awaiting_confirmation' | 'confirming' | 'submitting'; review: ConfirmationView }
  | { phase: 'checking' | 'unconfirmed'; operation: ManagementOperationKey; problem?: ManagementClientProblem }
  | { phase: 'committed'; receipt: BrowserReceipt }
  | { phase: 'not_committed'; receipt: BrowserReceipt }
  | { phase: 'failed'; problem: ManagementClientProblem }
  | { phase: 'cancelled' }

/** 返回独立冻结快照，UI代码不能改写正在提交的目标、摘要或关联。 */
function snapshot<T>(value: T): T {
  const copy = JSON.parse(JSON.stringify(value)) as T
  /** 仅冻结已验证JSON，不读取外部getter或保留可变服务对象。 */
  function freeze(item: unknown): void {
    if (item && typeof item === 'object') {
      for (const child of Object.values(item)) {
        freeze(child)
      }
      Object.freeze(item)
    }
  }
  freeze(copy)
  return copy
}
/** 固定错误分类不保留任意传输异常正文。 */
function failure(error: unknown): ManagementClientProblem {
  return error instanceof ManagementClientError ? error.problem : 'unavailable'
}

/** 把扁平配对意图组装为共享 ManagementIntent；字段已由 checkPairingIntent 精确校验。 */
function operationOf(intent: PairingManagementIntent): ManagementIntent {
  if (intent.action === 'pairing_claim_approve') {
    return {
      action: 'pairing_claim_approve',
      target: {
        machine_id: intent.machine_id,
        pairing_id: intent.pairing_id,
        claim_id: intent.claim_id,
        user_code: intent.user_code
      }
    }
  }
  return 'name' in intent
    ? { action: 'pairing_create', target: { name: intent.name, policy_ref: intent.policy_ref, labels: intent.labels } }
    : { action: 'pairing_create', target: { machine_id: intent.machine_id, policy_ref: intent.policy_ref } }
}
const operationName: Record<PairingManagementIntent['action'], PairingWriteOperation> = {
  pairing_create: 'pairings_create',
  pairing_claim_approve: 'pairings_claim_approve'
}

/** 每个实例只负责一个意图；新意图必须由调用方在明确用户流程中新建实例。 */
export function createPairingManagementFlow(options: {
  transport: ManagementWriteTransport
  requestId?: () => string
}) {
  let state: PairingManagementState = { phase: 'idle' }
  let intent: PairingManagementIntent | undefined
  let write: ManagementWrite | undefined
  let review: ConfirmationView | undefined
  let original: ManagementOperationKey | undefined
  let active: AbortController | undefined
  let generation = 0
  let disposed = false
  const requestId = options.requestId ?? managementRequestId

  /** 所有回复即使来自注入transport也重新校验，避免测试stub或宿主绕过客户端边界。 */
  async function execute<K extends ManagementClientOperation>(
    operation: K,
    args: ManagementArguments[K],
    signal: AbortSignal
  ) {
    if (signal.aborted) {
      throw new ManagementClientError('aborted')
    }
    managementWriteBody(operation, args)
    const reply = await options.transport.execute(operation, args, signal)
    return checkManagementWriteReply(operation, reply, args)
  }
  /** 建立单次等待与代次；重入、关闭或重复confirm不发出第二次请求。 */
  function begin(phase: PairingManagementState['phase'], signal?: AbortSignal) {
    if (disposed || active || state.phase !== phase || signal?.aborted) {
      throw new ManagementClientError('invalid_request')
    }
    const controller = new AbortController()
    active = controller
    const current = ++generation
    /** 外部取消调用同一状态转换，不能仅中止fetch后让迟到Promise继续提交。 */
    const abort = () => cancel()
    signal?.addEventListener('abort', abort, { once: true })
    return {
      controller,
      /** 任何后续提交前检查本次代次仍然有效。 */ current: () =>
        !disposed && generation === current && !controller.signal.aborted,
      /** 只回收本次等待，旧任务收尾不能删除新代次的控制器。 */ done() {
        signal?.removeEventListener('abort', abort)
        if (active === controller) {
          active = undefined
        }
      }
    }
  }
  /** 当前已知原操作关联保持不变，session/网络失败不得换scope或request_id。 */
  function unconfirmed(problem?: ManagementClientProblem): void {
    if (!original) {
      state = { phase: 'failed', problem: problem ?? 'unavailable' }
      return
    }
    state = { phase: 'unconfirmed', operation: original, ...(problem ? { problem } : {}) }
  }
  /** 仅接受匹配原意图与确认摘要的当前持久回执。 */
  function accept(receipt: BrowserReceipt): void {
    if (
      !original ||
      !intent ||
      !review ||
      receipt.request_id !== original.request_id ||
      receipt.history_epoch !== original.history_epoch ||
      receipt.recovery_generation !== original.recovery_generation ||
      receipt.action !== intent.action ||
      receipt.operation_digest !== review.operation_digest
    ) {
      throw new ManagementClientError('invalid_response', true)
    }
    if (
      intent.action === 'pairing_claim_approve' &&
      (receipt.target as { machine_id?: string }).machine_id !== intent.machine_id
    ) {
      throw new ManagementClientError('invalid_response', true)
    }
    if (receipt.evidence !== 'current_durable' || receipt.operation_state === 'outcome_unknown') {
      unconfirmed('outcome_unconfirmed')
    } else {
      state =
        receipt.operation_state === 'committed' ? { phase: 'committed', receipt } : { phase: 'not_committed', receipt }
    }
  }
  /** 取消只停止等待；已经开始提交或查回执时保留未确认状态。 */
  function cancel(): void {
    if (!active) {
      if (state.phase === 'idle' || state.phase === 'awaiting_confirmation') {
        generation++
        state = { phase: 'cancelled' }
      }
      return
    }
    generation++
    const controller = active
    active = undefined
    const uncertain = state.phase === 'submitting' || state.phase === 'checking'
    controller.abort()
    if (uncertain) {
      unconfirmed('aborted')
    } else {
      state = { phase: 'cancelled' }
    }
  }

  return {
    /** 只返回JSON安全快照，不含cookie、CSRF或管理员session引用。 */
    state(): Readonly<PairingManagementState> {
      return snapshot(state)
    },
    /** 用户开始动作后显式取history/当前fence/待确认摘要，不执行配对变更。 */
    async prepare(value: PairingManagementIntent, signal?: AbortSignal): Promise<Readonly<PairingManagementState>> {
      const pending = begin('idle', signal)
      try {
        intent = checkPairingIntent(value)
        state = { phase: 'preparing', intent }
        const id = requestId()
        const history = await execute('history_open', {}, pending.controller.signal)
        if (!pending.current()) {
          return snapshot(state)
        }
        const resource =
          'machine_id' in intent
            ? await execute('write_state_get', { machine_id: intent.machine_id }, pending.controller.signal)
            : {
                resource_revision: 0,
                recovery_generation: history.recovery_generation,
                connection_epoch: null,
                binding_revision: null
              }
        if (!pending.current()) {
          return snapshot(state)
        }
        if (history.recovery_generation !== resource.recovery_generation) {
          throw new ManagementClientError('conflict')
        }
        const draft: ConfirmationDraft = {
          ...operationOf(intent),
          request_id: id,
          history_epoch: history.history_epoch,
          recovery_generation: history.recovery_generation,
          expected_revision: resource.resource_revision,
          reason: 'administrator_request'
        }
        const confirmation = await execute('confirmations_create', draft, pending.controller.signal)
        if (!pending.current()) {
          return snapshot(state)
        }
        review = snapshot(confirmation)
        write = {
          request_id: id,
          history_epoch: history.history_epoch,
          recovery_generation: history.recovery_generation,
          expected_revision: resource.resource_revision,
          reason: draft.reason,
          confirmation_id: confirmation.confirmation_id
        }
        original = {
          request_id: id,
          history_epoch: history.history_epoch,
          recovery_generation: history.recovery_generation
        }
        if (confirmation.state === 'expired') {
          throw new ManagementClientError('conflict')
        }
        if (confirmation.state === 'consumed') {
          unconfirmed('outcome_unconfirmed')
        } else {
          state = { phase: 'awaiting_confirmation', review }
        }
      } catch (error) {
        if (pending.current()) {
          state = { phase: 'failed', problem: failure(error) }
        }
      } finally {
        pending.done()
      }
      return snapshot(state)
    },
    /** 只由明确用户确认触发；后端确认成功并保持相同摘要后才调用一次配对动作。 */
    async confirm(signal?: AbortSignal): Promise<Readonly<PairingManagementState>> {
      const pending = begin('awaiting_confirmation', signal)
      try {
        if (!write || !review || !intent) {
          throw new ManagementClientError('invalid_request')
        }
        state = { phase: 'confirming', review }
        const confirmed = await execute(
          'confirmations_confirm',
          { ...write, operation_digest: review.operation_digest },
          pending.controller.signal
        )
        if (!pending.current()) {
          return snapshot(state)
        }
        if (managementConfirmationKey(confirmed) !== managementConfirmationKey(review)) {
          throw new ManagementClientError('invalid_response')
        }
        if (confirmed.state === 'consumed') {
          unconfirmed('outcome_unconfirmed')
          return snapshot(state)
        }
        if (confirmed.state !== 'confirmed') {
          throw new ManagementClientError('conflict')
        }
        const operation = operationName[intent.action]
        const target =
          intent.action === 'pairing_claim_approve'
            ? {
                machine_id: intent.machine_id,
                pairing_id: intent.pairing_id,
                claim_id: intent.claim_id,
                user_code: intent.user_code
              }
            : 'name' in intent
              ? { name: intent.name, policy_ref: intent.policy_ref, labels: intent.labels }
              : { machine_id: intent.machine_id, policy_ref: intent.policy_ref }
        state = { phase: 'submitting', review }
        const receipt = await execute(
          operation,
          { ...write, ...target } as ManagementArguments[typeof operation],
          pending.controller.signal
        )
        if (pending.current()) {
          accept(receipt)
        }
      } catch (error) {
        if (pending.current()) {
          if (state.phase === 'submitting') {
            unconfirmed(failure(error))
          } else {
            state = { phase: 'failed', problem: failure(error) }
          }
        }
      } finally {
        pending.done()
      }
      return snapshot(state)
    },
    /** 用户只读对账原请求，未确认/会话失效继续保留原关联，不自动重新提交配对动作。 */
    async checkReceipt(signal?: AbortSignal): Promise<Readonly<PairingManagementState>> {
      const pending = begin('unconfirmed', signal)
      try {
        if (!original) {
          throw new ManagementClientError('invalid_request')
        }
        state = { phase: 'checking', operation: original }
        const receipt = await execute('operations_get', original, pending.controller.signal)
        if (pending.current()) {
          accept(receipt)
        }
      } catch (error) {
        if (pending.current()) {
          unconfirmed(failure(error))
        }
      } finally {
        pending.done()
      }
      return snapshot(state)
    },
    cancel,
    /** 卸载后拒绝新动作并忽略迟到任务；不删除服务器确认或声称回滚已提交动作。 */
    dispose(): void {
      cancel()
      disposed = true
    }
  }
}
