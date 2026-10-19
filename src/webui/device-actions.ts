/** 三项设备操作的持久页面控件；复用既有确认/回执 flow，不创建身份或重放未确认动作。 */
import type { Localizer, MessageKey } from './i18n.js'
import { createDeviceManagementFlow, type DeviceManagementState } from './write-flow.js'
import type { DeviceManagementIntent, ManagementClientProblem, ManagementWriteTransport } from './write-contract.js'

const actionKeys: Record<DeviceManagementIntent['action'], MessageKey> = {
  device_rename: 'actions.rename',
  device_disconnect: 'actions.disconnect',
  device_revoke: 'actions.revoke'
}
const effectKeys = {
  unchanged: 'manage.unchanged',
  revoked: 'manage.revoked',
  disconnected: 'manage.disconnected',
  unconfirmed: 'manage.unconfirmed'
} as const
const errors: Record<ManagementClientProblem, MessageKey> = {
  invalid_request: 'manage.invalid',
  invalid_response: 'manage.invalid',
  unauthenticated: 'manage.unauthenticated',
  forbidden: 'manage.forbidden',
  conflict: 'manage.conflict',
  busy: 'manage.busy',
  unavailable: 'manage.unavailable',
  outcome_unconfirmed: 'manage.unknown',
  aborted: 'manage.cancelled'
}

/** 创建固定控件；服务名称、摘要与回执只通过 textContent 进入页面。 */
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = ''): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  element.className = className
  return element
}

/** 每个挂载只允许一个明确意图；未确认结果只能查询原回执，导航后仍可重新打开核对。 */
export function createDeviceActions(options: {
  transport: ManagementWriteTransport
  committed(machineId: string): void
  authorizationLost(problem: 'unauthenticated' | 'forbidden'): void
}) {
  const region = node('div', 'operation-region')
  const resume = node('button', 'operation-resume')
  resume.type = 'button'
  resume.hidden = true
  const dialog = node('dialog', 'operation-dialog')
  const heading = node('h2')
  heading.id = 'management-operation-heading'
  dialog.setAttribute('aria-labelledby', heading.id)
  const target = node('code')
  const form = node('form', 'operation-form')
  const label = node('label')
  const caption = node('span')
  const name = node('input')
  name.name = 'device-name'
  name.required = true
  name.maxLength = 63
  name.pattern = '[a-z0-9][a-z0-9._-]{0,62}'
  name.autocomplete = 'off'
  const hint = node('p', 'muted')
  hint.id = 'management-name-hint'
  name.setAttribute('aria-describedby', hint.id)
  label.append(caption, name)
  const prepare = node('button')
  prepare.type = 'submit'
  form.append(label, hint, prepare)
  const message = node('p', 'operation-status')
  message.setAttribute('role', 'status')
  message.setAttribute('aria-live', 'polite')
  const details = node('dl', 'facts operation-facts')
  const effect = node('p', 'context-note')
  const controls = node('div', 'operation-controls')
  const confirm = node('button', 'operation-confirm')
  const check = node('button')
  const retry = node('button')
  const cancel = node('button')
  const close = node('button')
  for (const button of [confirm, check, retry, cancel, close]) {
    button.type = 'button'
  }
  controls.append(confirm, check, retry, cancel, close)
  dialog.append(heading, target, form, message, details, effect, controls)
  region.append(resume, dialog)
  let i18n: Localizer
  let flow: ReturnType<typeof createDeviceManagementFlow> | undefined
  let intent: DeviceManagementIntent | undefined
  let editing = false
  let disposed = false
  let live = false
  let serverNow: number | undefined
  let notified = false
  let returnFocus: HTMLElement | undefined

  /** 只允许已知未提交的终态或尚未提交且过期的确认重新准备，绝不丢弃在途/未知关联。 */
  function canPrepareAgain(state: Readonly<DeviceManagementState>): boolean {
    return (
      ['failed', 'cancelled', 'not_committed'].includes(state.phase) ||
      (state.phase === 'awaiting_confirmation' && serverNow !== undefined && serverNow >= state.review.expires_at)
    )
  }

  /** 已验证的数据仍按字段构造定义列表，不能把确认摘要当 HTML。 */
  function fact(key: MessageKey, value: string): void {
    const row = node('div', 'fact')
    const title = node('dt')
    title.textContent = i18n.t(key)
    const content = node('dd')
    content.textContent = value
    row.append(title, content)
    details.append(row)
  }

  /** 仅同步固定按钮和非交互摘要，年龄/语言重绘不替换输入或当前焦点。 */
  function paint(): void {
    if (!i18n || disposed) {
      return
    }
    const state: DeviceManagementState = flow?.state() ?? { phase: 'idle' }
    const phase = editing ? 'editing' : state.phase
    const pending = ['preparing', 'confirming', 'submitting', 'checking'].includes(phase)
    dialog.setAttribute('aria-busy', String(pending))
    const uncertain = ['unconfirmed', 'checking'].includes(phase)
    const review = 'review' in state ? state.review : undefined
    const retryable = canPrepareAgain(state)
    const expired = state.phase === 'awaiting_confirmation' && retryable
    dialog.dataset.phase = phase
    heading.textContent = intent ? i18n.t(actionKeys[intent.action]) : i18n.t('manage.heading')
    target.textContent = intent?.machine_id ?? ''
    caption.textContent = i18n.t('manage.name')
    hint.textContent = i18n.t('manage.nameHint')
    prepare.textContent = i18n.t('manage.prepare')
    confirm.textContent = i18n.t('manage.confirm')
    check.textContent = i18n.t('manage.check')
    retry.textContent = i18n.t('manage.retry')
    cancel.textContent = i18n.t('manage.cancel')
    close.textContent = i18n.t('manage.close')
    resume.textContent = i18n.t('manage.resume')
    resume.hidden = !uncertain || dialog.open
    form.hidden = !editing
    prepare.disabled = !live
    name.disabled = !live
    confirm.hidden = phase !== 'awaiting_confirmation'
    confirm.disabled = !live || expired
    check.hidden = phase !== 'unconfirmed'
    check.disabled = !live
    retry.hidden = !retryable
    retry.disabled = !live || !retryable
    cancel.hidden = !pending && phase !== 'awaiting_confirmation'
    close.hidden = pending
    details.replaceChildren()
    let key: MessageKey =
      phase === 'editing'
        ? 'manage.editing'
        : pending
          ? 'manage.pending'
          : phase === 'awaiting_confirmation'
            ? 'manage.review'
            : phase === 'committed'
              ? 'manage.committed'
              : phase === 'not_committed'
                ? 'manage.notCommitted'
                : uncertain
                  ? 'manage.unknown'
                  : phase === 'cancelled'
                    ? 'manage.cancelled'
                    : 'manage.unavailable'
    if ('problem' in state && state.problem) {
      key = errors[state.problem]
      if (phase === 'failed' && state.problem === 'outcome_unconfirmed') {
        key = 'manage.unavailable'
      }
    }
    if (uncertain) {
      key = 'manage.unknown'
    }
    if (expired) {
      key = 'manage.expired'
    }
    message.textContent = i18n.t(key)
    effect.textContent = i18n.t(
      intent?.action === 'device_disconnect'
        ? 'manage.disconnectEffect'
        : intent?.action === 'device_revoke'
          ? 'manage.revokeEffect'
          : 'manage.nativeEffect'
    )
    if (review) {
      fact('manage.action', i18n.t(actionKeys[intent!.action]))
      fact('manage.machine', 'machine_id' in review.summary.target ? review.summary.target.machine_id : '')
      if (review.summary.action === 'device_rename') {
        fact('manage.name', review.summary.name)
      }
      if (review.summary.action === 'device_disconnect') {
        fact('manage.epoch', review.summary.expected_connection_epoch)
      }
      fact('manage.revision', String(review.summary.expected_revision))
      fact('manage.reason', review.summary.reason)
      fact('manage.expires', i18n.timestamp(review.expires_at))
      fact(
        'manage.providers',
        review.affected_providers
          ?.map(
            /** 展示后台提供的完整受影响实例集合。 */ (p) =>
              `${p.kind} / ${p.provider_id} / ${p.binding_revision} / ${i18n.t(p.enabled ? 'manage.enabled' : 'manage.disabled')}`
          )
          .join('\n') || '—'
      )
    }
    if ('receipt' in state) {
      fact('manage.request', state.receipt.request_id)
      fact('manage.revision', String(state.receipt.new_revision ?? '—'))
      fact('manage.authorization', i18n.t(effectKeys[state.receipt.effects.persistent_authorization]))
      fact('manage.channel', i18n.t(effectKeys[state.receipt.effects.channel]))
      fact('manage.observed', i18n.timestamp(state.receipt.observed_at))
      fact('manage.audit', state.receipt.audit_event_ids.join(', '))
    }
  }

  /** 等待状态机完成一次操作；不从 pending 或未知状态推导成功，不自动重试。 */
  async function run(operation: () => Promise<Readonly<DeviceManagementState>>): Promise<void> {
    const current = flow
    const currentIntent = intent
    let result: Readonly<DeviceManagementState>
    try {
      const work = operation()
      paint()
      result = await work
    } catch {
      if (!disposed) {
        paint()
      }
      return
    }
    if (disposed || flow !== current) {
      return
    }
    if ('problem' in result && (result.problem === 'unauthenticated' || result.problem === 'forbidden')) {
      options.authorizationLost(result.problem)
      return
    }
    if (result.phase === 'committed' && !notified && currentIntent) {
      notified = true
      options.committed(currentIntent.machine_id)
    }
    paint()
  }

  /** 新准备只来自明确用户动作；未确认流程禁止分配新 request_id 或改目标。 */
  function start(): void {
    const state = flow?.state() ?? { phase: 'idle' }
    if (!live || !intent || (state.phase !== 'idle' && !canPrepareAgain(state))) {
      return
    }
    flow?.dispose()
    flow = createDeviceManagementFlow({ transport: options.transport })
    notified = false
    if (intent.action === 'device_rename') {
      intent = { ...intent, name: name.value }
    }
    editing = false
    void run(/** 仅准备当前明确意图，不执行业务提交。 */ () => flow!.prepare(intent!))
  }

  /** 原生表单校验通过后才准备改名，不调用真正的设备提交。 */
  function submit(event: SubmitEvent): void {
    event.preventDefault()
    if (editing) {
      start()
    }
  }

  /** 本次人工确认至多消费一次既有 flow；重复事件由阶段和状态机共同拒绝。 */
  function confirmAction(): void {
    if (live && flow?.state().phase === 'awaiting_confirmation' && !confirm.disabled) {
      void run(/** 由本次人工确认驱动既有状态机。 */ () => flow!.confirm())
    }
  }

  /** 未确认结果只查询原回执，不自动准备、确认或提交其它请求。 */
  function checkReceipt(): void {
    if (live && flow?.state().phase === 'unconfirmed') {
      void run(/** 只查原关联，不重发设备动作。 */ () => flow!.checkReceipt())
    }
  }

  /** 事件处理独立复验同一白名单；改名回输入前也不能销毁在途或未确认 flow。 */
  function retryAction(): void {
    if (!live || !intent || !flow || !canPrepareAgain(flow.state())) {
      return
    }
    if (intent.action === 'device_rename') {
      flow?.dispose()
      flow = undefined
      editing = true
      paint()
      name.focus()
    } else {
      start()
    }
  }

  /** 取消停止等待；提交后保持未确认并允许用户仅查询原回执。 */
  function cancelAction(): void {
    flow?.cancel()
    editing = false
    paint()
  }

  /** 关闭不会重放动作，未确认流程的入口保留在页面壳中。 */
  function closeDialog(): void {
    if (
      ['preparing', 'confirming', 'submitting', 'checking', 'awaiting_confirmation'].includes(flow?.state().phase ?? '')
    ) {
      cancelAction()
    }
    dialog.close()
    if (returnFocus?.isConnected && returnFocus.getClientRects().length) {
      returnFocus.focus()
    } else {
      document.getElementById('management-content')?.focus()
    }
    paint()
  }

  /** Esc 同样遵守取消语义，提交中取消后保留可核对的未知结果。 */
  function escape(event: Event): void {
    event.preventDefault()
    cancelAction()
    if (flow?.state().phase !== 'unconfirmed') {
      closeDialog()
    }
  }

  /** 用户显式重新打开保留的原操作；不会启动新的管理意图。 */
  function resumeAction(): void {
    returnFocus = resume
    dialog.showModal()
    paint()
  }

  form.addEventListener('submit', submit)
  confirm.addEventListener('click', confirmAction)
  check.addEventListener('click', checkReceipt)
  retry.addEventListener('click', retryAction)
  cancel.addEventListener('click', cancelAction)
  close.addEventListener('click', closeDialog)
  dialog.addEventListener('cancel', escape)
  resume.addEventListener('click', resumeAction)
  return {
    region,
    /** 入口只消费页面当前目标；未确认流程优先显示原关联，不能被其它按钮覆盖。 */
    open(action: DeviceManagementIntent['action'], machineId: string, currentName: string, trigger: HTMLElement): void {
      if (disposed || !live || dialog.open) {
        return
      }
      returnFocus = trigger
      if (flow?.state().phase !== 'unconfirmed') {
        flow?.dispose()
        flow = undefined
        intent =
          action === 'device_rename'
            ? { action, machine_id: machineId, name: currentName }
            : { action, machine_id: machineId }
        name.value = currentName
        editing = action === 'device_rename'
      }
      dialog.showModal()
      paint()
      if (editing) {
        name.focus()
      } else if (!flow) {
        start()
      }
    },
    /** 可信年龄仅用于禁用过期确认；后端仍独立检查期限与权限。 */
    update(localizer: Localizer, available: boolean, trustedNow?: number): void {
      i18n = localizer
      live = available
      serverNow = trustedNow
      paint()
    },
    /** 导航/隐藏取消旧意图等待，迟到回复仍由原 flow 拒绝；未确认关联保留在内存。 */
    suspend(): void {
      cancelAction()
      if (dialog.open) {
        dialog.close()
      }
      paint()
    },
    /** 会话丢失立即清除旧摘要/输入，不保留可见设备资料或执行能力。 */
    clear(): void {
      flow?.dispose()
      flow = undefined
      intent = undefined
      name.value = ''
      editing = false
      live = false
      if (dialog.open) {
        dialog.close()
      }
      paint()
    },
    /** 只释放本页监听与 flow；共享客户端由注入它的宿主负责关闭。 */
    dispose(): void {
      flow?.dispose()
      disposed = true
      if (dialog.open) {
        dialog.close()
      }
      form.removeEventListener('submit', submit)
      confirm.removeEventListener('click', confirmAction)
      check.removeEventListener('click', checkReceipt)
      retry.removeEventListener('click', retryAction)
      cancel.removeEventListener('click', cancelAction)
      close.removeEventListener('click', closeDialog)
      dialog.removeEventListener('cancel', escape)
      resume.removeEventListener('click', resumeAction)
      region.remove()
    }
  }
}
