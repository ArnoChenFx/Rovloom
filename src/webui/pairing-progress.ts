// 配对进度仅查询原申请；手动刷新、有界等待和内存引用，不签发秘密、不扩大权限。
import type { ManagementReply } from '../mcp/management.js'
import type { Localizer, MessageKey } from './i18n.js'
import { checkManagementWriteReply, ManagementClientError, type ManagementWriteTransport } from './write-contract.js'

/** 所有公开引用及状态只通过textContent/原生输入框呈现。 */
function node<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {
  return document.createElement(tag)
}

/** 页面退出、导航、改目标都会取消旧等待；迟到回复不能覆盖新目标。 */
export function createPairingProgress(options: {
  transport: ManagementWriteTransport
  cancel(machine: string, pairing: string, trigger: HTMLElement): void
  authorizationLost(): void
}) {
  const region = node('section')
  region.className = 'pairing-progress'
  region.hidden = true
  const heading = node('h2')
  const note = node('p')
  note.className = 'muted'
  const form = node('form')
  form.className = 'pairing-form'
  const machineLabel = node('label')
  const machineCaption = node('span')
  const machine = node('input')
  machine.name = 'pairing-machine'
  const pairingLabel = node('label')
  const pairingCaption = node('span')
  const pairing = node('input')
  pairing.name = 'pairing-id'
  for (const input of [machine, pairing]) {
    input.required = true
    input.pattern = '[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}'
    input.maxLength = 128
    input.autocomplete = 'off'
  }
  machineLabel.append(machineCaption, machine)
  pairingLabel.append(pairingCaption, pairing)
  const refresh = node('button')
  refresh.type = 'submit'
  form.append(machineLabel, pairingLabel, refresh)
  const message = node('p')
  message.setAttribute('role', 'status')
  message.setAttribute('aria-live', 'polite')
  const details = node('dl')
  details.className = 'facts'
  const cancel = node('button')
  cancel.type = 'button'
  const close = node('button')
  close.type = 'button'
  region.append(heading, note, form, message, details, cancel, close)
  let i18n: Localizer
  let live = false
  let disposed = false
  let controller: AbortController | undefined
  let progress: ManagementReply['pairings_get'] | undefined
  let now: number | undefined
  let observed: number | undefined
  let problem: MessageKey = 'pairing.unknown'

  /** 查询快照的期限不因语言或页面刷新续期；旧状态不能允许取消。 */
  function paint(): void {
    if (!i18n || disposed) {
      return
    }
    const fresh = progress && now !== undefined && observed !== undefined && now - observed < 15_000
    region.setAttribute('aria-busy', String(!!controller))
    heading.textContent = i18n.t('pairing.lookup')
    note.textContent = i18n.t('pairing.lookupNote')
    machineCaption.textContent = i18n.t('manage.machine')
    pairingCaption.textContent = i18n.t('pairing.id')
    refresh.textContent = i18n.t('action.refresh')
    refresh.disabled = !live || !!controller
    cancel.textContent = i18n.t('pairing.cancel')
    cancel.disabled = !live || !fresh || progress?.status !== 'pending' || now! >= progress.expires_at || !!controller
    close.textContent = i18n.t('manage.close')
    message.textContent = i18n.t(controller ? 'pairing.reading' : fresh ? `pairing.${progress!.status}` : problem)
    details.replaceChildren()
    if (fresh) {
      for (const [key, value] of [
        ['manage.machine', progress!.machine_id],
        ['pairing.id', progress!.pairing_id],
        ['pairing.status', i18n.t(`pairing.${progress!.status}`)],
        ['pairing.issuance', i18n.t('value.unverified')],
        ['manage.expires', i18n.timestamp(progress!.expires_at)]
      ] as [MessageKey, string][]) {
        const row = node('div')
        const dt = node('dt')
        dt.textContent = i18n.t(key)
        const dd = node('dd')
        dd.textContent = value
        row.append(dt, dd)
        details.append(row)
      }
    }
  }

  /** 取消等待仅丢弃此处只读快照；不会取消服务器上的配对申请。 */
  function invalidate(): void {
    controller?.abort()
    controller = undefined
    progress = undefined
    observed = undefined
    problem = 'pairing.unknown'
    paint()
  }

  /** 独立鉴权的精确进度查询；403只说明缺少读取授权，不推断注册未提交。 */
  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    if (!live || controller || disposed) {
      return
    }
    const pending = new AbortController()
    controller = pending
    const args = { machine_id: machine.value, pairing_id: pairing.value }
    progress = undefined
    paint()
    try {
      const reply = checkManagementWriteReply(
        'pairings_get',
        await options.transport.execute('pairings_get', args, pending.signal),
        args
      )
      if (disposed || controller !== pending || pending.signal.aborted) {
        return
      }
      progress = reply
      observed = now
    } catch (error) {
      if (disposed || controller !== pending || pending.signal.aborted) {
        return
      }
      problem =
        error instanceof ManagementClientError && error.problem === 'forbidden'
          ? 'pairing.forbidden'
          : 'manage.unavailable'
      if (error instanceof ManagementClientError && error.problem === 'unauthenticated') {
        options.authorizationLost()
      }
    } finally {
      if (controller === pending) {
        controller = undefined
        paint()
      }
    }
  }

  /** 输入变化即撤销旧引用对应的展示及取消入口。 */
  function input(): void {
    invalidate()
  }
  /** 明确取消仍进入共享二次确认与持久回执状态机。 */
  function cancelPairing(): void {
    if (!cancel.disabled && progress) {
      options.cancel(progress.machine_id, progress.pairing_id, cancel)
    }
  }
  /** 收起并停止当前等待，不把隐藏当成后端取消。 */
  function suspend(): void {
    invalidate()
    region.hidden = true
  }
  form.addEventListener('submit', submit)
  form.addEventListener('input', input)
  cancel.addEventListener('click', cancelPairing)
  close.addEventListener('click', suspend)
  return {
    region,
    /** 仅保留非秘密原回执引用，不自动查询缺少devices_read的新设备。 */
    open(machineId = '', pairingId = ''): void {
      if (disposed || !live) {
        return
      }
      invalidate()
      machine.value = machineId
      pairing.value = pairingId
      region.hidden = false
      paint()
      machine.focus()
    },
    /** 语言重绘保留输入；模式/快照失效时停止等待并撤销旧进度。 */
    update(localizer: Localizer, available: boolean, trustedNow?: number): void {
      i18n = localizer
      live = available
      now = trustedNow
      if (!live) {
        invalidate()
      }
      paint()
    },
    suspend,
    /** 会话失效时清空所有旧引用。 */
    clear(): void {
      suspend()
      machine.value = ''
      pairing.value = ''
    },
    /** 永久卸载不留下网络、计时器或事件监听。 */
    dispose(): void {
      invalidate()
      disposed = true
      form.removeEventListener('submit', submit)
      form.removeEventListener('input', input)
      cancel.removeEventListener('click', cancelPairing)
      close.removeEventListener('click', suspend)
      region.remove()
    }
  }
}
