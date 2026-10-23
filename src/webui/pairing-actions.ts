/** 管理页在线配对区：新建申请、跟踪认领、核对核对码后批准签发；全部写操作复用确认/回执 flow。 */
import type { ManagementReply } from '../mcp/management.js'
import type { Localizer, MessageKey } from './i18n.js'
import { createPairingManagementFlow, type PairingManagementState } from './pairing-flow.js'
import {
  checkManagementWriteReply,
  managementWriteBody,
  ManagementClientError,
  type ManagementClientProblem,
  type ManagementWriteTransport,
  type PairingManagementIntent
} from './write-contract.js'

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

type PairingStatus = ManagementReply['pairings_get']
type Entry = {
  name: string
  machine_id: string
  pairing_id: string
  status: PairingStatus['status']
  claim?: NonNullable<PairingStatus['claim']>
  item: HTMLLIElement
}

/** 创建固定控件；申请编号、核对码与服务回复只通过 textContent 进入页面。 */
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = ''): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  element.className = className
  return element
}

/** 在线配对区：一个挂载同时只允许一个待确认意图；轮询只读 pairings_get，不重放任何写动作。 */
export function createPairingActions(options: {
  transport: ManagementWriteTransport
  authorizationLost(problem: 'unauthenticated' | 'forbidden'): void
  pollMs?: number
}) {
  const region = node('section', 'pairing-section')
  const heading = node('h2')
  const intro = node('p', 'muted')
  const form = node('form', 'pairing-form')
  const nameLabel = node('label')
  const nameCaption = node('span')
  const nameInput = node('input')
  nameInput.name = 'pairing-name'
  nameInput.required = true
  nameInput.maxLength = 63
  nameInput.pattern = '[a-z0-9][a-z0-9._-]{0,62}'
  nameInput.autocomplete = 'off'
  nameLabel.append(nameCaption, nameInput)
  const policyLabel = node('label')
  const policyCaption = node('span')
  const policyInput = node('input')
  policyInput.name = 'pairing-policy'
  policyInput.required = true
  policyInput.maxLength = 128
  policyInput.autocomplete = 'off'
  policyLabel.append(policyCaption, policyInput)
  const create = node('button', 'pairing-confirm')
  create.type = 'submit'
  form.append(nameLabel, policyLabel, create)
  const reviewBox = node('div', 'pairing-review')
  reviewBox.hidden = true
  const reviewText = node('p', 'pairing-status')
  const reviewFacts = node('dl', 'facts pairing-facts')
  const controls = node('div', 'pairing-controls')
  const confirm = node('button', 'pairing-confirm')
  const check = node('button')
  const cancel = node('button')
  for (const button of [confirm, check, cancel]) {
    button.type = 'button'
  }
  controls.append(confirm, check, cancel)
  reviewBox.append(reviewText, reviewFacts, controls)
  const message = node('p', 'pairing-status')
  message.setAttribute('role', 'status')
  message.setAttribute('aria-live', 'polite')
  const list = node('ul', 'pairing-entries')
  region.append(heading, intro, form, reviewBox, message, list)

  let i18n: Localizer | undefined
  let available = false
  let disposed = false
  let flow: ReturnType<typeof createPairingManagementFlow> | undefined
  let flowIntent: PairingManagementIntent | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  const entries = new Map<string, Entry>()
  const pollMs = options.pollMs ?? 4000

  /** 摘要事实只展示动作与目标字段；确认摘要本身来自后台，不由页面拼装。 */
  function fact(term: string, value: string): void {
    const dt = node('dt')
    dt.textContent = term
    const dd = node('dd')
    dd.textContent = value
    reviewFacts.append(dt, dd)
  }
  /** 按 flow 状态重绘确认区；committed 后把结果落到对应申请条目并启动/继续轮询。 */
  function paintFlow(state: PairingManagementState): void {
    if (!i18n) {
      return
    }
    const t = i18n.t.bind(i18n)
    check.hidden = true
    confirm.hidden = true
    if (state.phase === 'idle' || state.phase === 'cancelled') {
      reviewBox.hidden = true
      return
    }
    reviewBox.hidden = false
    if (state.phase === 'preparing' || state.phase === 'confirming' || state.phase === 'submitting') {
      reviewText.textContent = t('pairing.preparing')
      return
    }
    if (state.phase === 'awaiting_confirmation') {
      reviewText.textContent = t('pairing.review')
      reviewFacts.replaceChildren()
      const summary = state.review.summary
      fact(t('manage.action'), t(summary.action === 'pairing_create' ? 'pairing.create' : 'pairing.approve'))
      if (summary.action === 'pairing_create') {
        fact(
          t('pairing.name'),
          'name' in summary.target ? summary.target.name : (summary.target as { machine_id: string }).machine_id
        )
        fact(t('pairing.policy'), summary.target.policy_ref)
      } else if (summary.action === 'pairing_claim_approve') {
        fact(t('pairing.machine'), summary.target.machine_id)
        fact(t('pairing.userCode'), summary.target.user_code)
      }
      fact(t('manage.expires'), new Date(state.review.expires_at).toISOString())
      confirm.hidden = false
      confirm.textContent = t('pairing.confirm')
      return
    }
    if (state.phase === 'committed') {
      reviewBox.hidden = true
      const receipt = state.receipt as typeof state.receipt & {
        machine_id?: string
        pairing_id?: string
        expires_at?: number
      }
      if (state.receipt.action === 'pairing_create' && receipt.pairing_id && receipt.machine_id) {
        const name =
          flowIntent?.action === 'pairing_create' && 'name' in flowIntent
            ? flowIntent.name
            : (entries.get(receipt.pairing_id)?.name ?? receipt.machine_id)
        addEntry({
          name,
          machine_id: receipt.machine_id,
          pairing_id: receipt.pairing_id,
          status: 'pending',
          item: node('li', 'pairing-entry')
        })
        message.textContent = t('pairing.created')
      } else if (state.receipt.action === 'pairing_claim_approve') {
        message.textContent = t('pairing.approved')
      }
      flow = undefined
      flowIntent = undefined
      ensurePolling()
      return
    }
    if (state.phase === 'not_committed') {
      reviewText.textContent = t('manage.notCommitted')
      flow = undefined
      flowIntent = undefined
      return
    }
    if (state.phase === 'unconfirmed') {
      reviewText.textContent = t('manage.unknown')
      check.hidden = false
      check.textContent = t('manage.check')
      return
    }
    if (state.phase === 'failed') {
      reviewText.textContent = t(errors[state.problem])
      if (state.problem === 'unauthenticated' || state.problem === 'forbidden') {
        options.authorizationLost(state.problem)
      }
      flow = undefined
      flowIntent = undefined
      return
    }
    reviewBox.hidden = true
  }
  /** 启动一个意图的准备阶段；已有待确认意图时不覆盖它。 */
  async function start(intent: PairingManagementIntent): Promise<void> {
    if (disposed || !available || flow) {
      return
    }
    flowIntent = intent
    flow = createPairingManagementFlow({ transport: options.transport })
    paintFlow(await flow.prepare(intent))
  }
  /** 条目 DOM 只承载展示；批准按钮每次点击都新建一个明确意图并走完整确认。 */
  function renderEntry(entry: Entry): void {
    if (!i18n) {
      return
    }
    const t = i18n.t.bind(i18n)
    entry.item.replaceChildren()
    const head = node('div', 'pairing-entry-head')
    const title = node('strong')
    title.textContent = entry.name
    const status = node('span', 'muted')
    status.textContent =
      entry.status === 'paired'
        ? t('pairing.paired')
        : entry.status === 'expired' || entry.status === 'cancelled'
          ? t('pairing.expired')
          : entry.claim?.status === 'approved'
            ? t('pairing.approved')
            : entry.claim
              ? t('pairing.claimArrived')
              : t('pairing.waitingClaim')
    head.append(title, status)
    entry.item.append(head)
    const facts = node('dl', 'facts')
    const idTerm = node('dt')
    idTerm.textContent = t('pairing.application')
    const idValue = node('dd')
    const idCode = node('code')
    idCode.textContent = entry.pairing_id
    idValue.append(idCode)
    const machineTerm = node('dt')
    machineTerm.textContent = t('pairing.machine')
    const machineValue = node('dd')
    machineValue.textContent = entry.machine_id
    facts.append(idTerm, idValue, machineTerm, machineValue)
    entry.item.append(facts)
    if (entry.status === 'pending' && entry.claim?.status === 'pending') {
      const codeLabel = node('p', 'muted')
      codeLabel.textContent = t('pairing.userCode')
      const code = node('div', 'pairing-code')
      code.textContent = entry.claim.user_code
      const approve = node('button', 'pairing-confirm')
      approve.type = 'button'
      approve.textContent = t('pairing.approve')
      const claim = entry.claim
      approve.addEventListener('click', () => {
        void start({
          action: 'pairing_claim_approve',
          machine_id: entry.machine_id,
          pairing_id: entry.pairing_id,
          claim_id: claim.claim_id,
          user_code: claim.user_code
        })
      })
      entry.item.append(codeLabel, code, approve)
    }
  }
  /** 新增条目并立即渲染；同 pairing_id 重入时只更新状态。 */
  function addEntry(entry: Entry): void {
    const existing = entries.get(entry.pairing_id)
    if (existing) {
      existing.status = entry.status
      renderEntry(existing)
      return
    }
    entries.set(entry.pairing_id, entry)
    list.append(entry.item)
    renderEntry(entry)
  }
  /** 只读轮询所有未完成申请；会话失效时上交页面统一处理，其它错误保持等待。 */
  async function poll(): Promise<void> {
    for (const entry of entries.values()) {
      if (disposed || entry.status !== 'pending') {
        continue
      }
      try {
        const args = { machine_id: entry.machine_id, pairing_id: entry.pairing_id }
        managementWriteBody('pairings_get', args)
        const reply = await options.transport.execute('pairings_get', args, new AbortController().signal)
        const status = checkManagementWriteReply('pairings_get', reply, args)
        entry.status = status.status
        entry.claim = status.claim
        renderEntry(entry)
      } catch (error) {
        if (
          error instanceof ManagementClientError &&
          (error.problem === 'unauthenticated' || error.problem === 'forbidden')
        ) {
          stopPolling()
          options.authorizationLost(error.problem)
          return
        }
      }
    }
    if (![...entries.values()].some((entry) => entry.status === 'pending')) {
      stopPolling()
    }
  }
  /** 仅在存在未完成申请且页面可见时轮询。 */
  function ensurePolling(): void {
    if (disposed || timer || ![...entries.values()].some((entry) => entry.status === 'pending')) {
      return
    }
    timer = setInterval(() => {
      void poll()
    }, pollMs)
  }
  /** 暂停轮询但不丢弃条目或待确认意图。 */
  function stopPolling(): void {
    if (timer) {
      clearInterval(timer)
      timer = undefined
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const name = nameInput.value.trim()
    const policy = policyInput.value.trim()
    if (!name || !policy) {
      return
    }
    void start({ action: 'pairing_create', name, policy_ref: policy, labels: [] })
  })
  confirm.addEventListener('click', () => {
    if (flow) {
      void flow.confirm().then(paintFlow)
    }
  })
  check.addEventListener('click', () => {
    if (flow) {
      void flow.checkReceipt().then(paintFlow)
    }
  })
  cancel.addEventListener('click', () => {
    flow?.cancel()
    if (flow) {
      paintFlow(flow.state())
    }
    if (flow?.state().phase === 'cancelled') {
      flow = undefined
      flowIntent = undefined
    }
  })

  return {
    region,
    /** 偏好或快照变化只重绘文案与可见性，不替换待确认意图或轮询。 */
    update(localizer: Localizer, isAvailable: boolean): void {
      i18n = localizer
      available = isAvailable
      region.hidden = !isAvailable
      const t = localizer.t.bind(localizer)
      heading.textContent = t('pairing.title')
      intro.textContent = t('pairing.intro')
      nameCaption.textContent = t('pairing.name')
      policyCaption.textContent = t('pairing.policy')
      create.textContent = t('pairing.create')
      cancel.textContent = t('pairing.cancel')
      for (const entry of entries.values()) {
        renderEntry(entry)
      }
      if (flow) {
        paintFlow(flow.state())
      }
      if (isAvailable) {
        ensurePolling()
      }
    },
    /** 页面隐藏时暂停轮询；恢复由下一次 update 重新启动。 */
    suspend(): void {
      stopPolling()
    },
    /** 会话/权限失效时清空条目与意图，旧数据不能继续操作。 */
    clear(): void {
      stopPolling()
      flow?.dispose()
      flow = undefined
      flowIntent = undefined
      entries.clear()
      list.replaceChildren()
      reviewBox.hidden = true
      message.textContent = ''
    },
    /** 卸载后拒绝新动作并忽略迟到轮询。 */
    dispose(): void {
      disposed = true
      stopPolling()
      flow?.dispose()
    }
  }
}
