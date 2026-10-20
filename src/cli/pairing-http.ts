// 将既有一次性enrollment/custody接到专用HTTP交付；文件持久确认前不报告配对完成，不重发secret。
import { createHash, timingSafeEqual } from 'node:crypto'
import { createPairingDelivery } from '../transport/custody.js'
import type { CredentialDeliveryAck, CredentialDeliveryContext } from '../transport/custody.js'
import type { DeviceCredential } from '../transport/identity.js'
import type { openGatewayState } from '../runtime/state.js'
import { parseNativeJson } from '../native-contract/json.js'
import { fields, id, object } from '../wire/index.js'
import { SetupApproval, type PairingPlan } from './setup-approval.js'
import { setupPolicies, setupTarget } from './setup-policy.js'

type State = ReturnType<typeof openGatewayState>
type Receipt = { machine_id: string; delivery_id: string; state: 'delivered' }
type Exchange = {
  plan: PairingPlan
  context?: CredentialDeliveryContext
  credential_sha256?: Buffer
  acknowledgement?: (value: CredentialDeliveryAck) => void
  task: Promise<Receipt>
  close(): void
}
export type SetupNativeRequest = Readonly<{
  plan: PairingPlan
  credential: DeviceCredential
  input: unknown
  signal: AbortSignal
}>

// 只交付固定公共码与无秘密元数据；配对secret响应同样强制no-store。
export function setupReply(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }
  })
}

// 按实际流累计有界字节，不因缺Content-Length或分块传输而无限读取。
async function requestJson(request: Request, maximum: number, stopped: AbortSignal): Promise<Record<string, unknown>> {
  const signal = AbortSignal.any([request.signal, stopped, AbortSignal.timeout(5000)])
  const reader = request.body?.getReader()
  if (!reader) {
    throw new Error('setup_request_invalid')
  }
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      let abort!: () => void
      const cancelled = new Promise<never>(
        /* 仅结束读取等待，不延长原凭据交付期限。 */ (_resolve, reject) => {
          abort = /* 只拒绝本次body等待，关闭流程继续等待原handler收尾。 */ () =>
            reject(new Error('setup_request_closed'))
          signal.addEventListener('abort', abort, { once: true })
        }
      )
      let result: ReadableStreamReadResult<Uint8Array>
      try {
        if (signal.aborted) {
          throw new Error('setup_request_closed')
        }
        result = await Promise.race([reader.read(), cancelled])
      } finally {
        signal.removeEventListener('abort', abort)
      }
      if (result.done) {
        break
      }
      bytes += result.value.length
      if (bytes > maximum || signal.aborted) {
        throw new Error('setup_request_invalid')
      }
      chunks.push(result.value)
    }
    const parsed = parseNativeJson(Buffer.concat(chunks, bytes), { object_bytes: maximum })
    if (!parsed.ok) {
      throw new Error('setup_request_invalid')
    }
    return object(parsed.value)
  } finally {
    void reader.cancel().catch(/* 只回收请求流，不透传网络错误或等待不受控对端。 */ () => {})
    reader.releaseLock()
  }
}

// 设备认证完全复用现有三轴凭据与IdentityHost；MCP Bearer、cookie或自报authenticated不作为来源。
function device(value: unknown): DeviceCredential {
  const input = object(value)
  fields(input, ['machine_id', 'recovery_generation', 'credential'])
  id(input.machine_id)
  id(input.recovery_generation)
  if (typeof input.credential !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(input.credential)) {
    throw new Error('setup_request_invalid')
  }
  return input as DeviceCredential
}

export class GatewayPairingHttp {
  readonly #exchanges = new Map<string, Exchange>()
  readonly #requests = new Set<Promise<Response>>()
  readonly #stop = new AbortController()
  #closed = false

  // 仅由同一产品Gateway交付实际双库与本地确认；不接受替代认证或测试成功回调。
  constructor(
    readonly state: State,
    readonly approval: SetupApproval,
    readonly native: (request: SetupNativeRequest) => Promise<unknown>
  ) {}

  // 每次短HTTP操作也经真实身份库/Store建立并复验fresh epoch，结束只断开该精确epoch。
  private async authenticated<T>(credential: DeviceCredential, run: () => Promise<T>): Promise<T> {
    const host = this.state.lifecycle.identityHost
    const active = host.authenticate(credential.machine_id, credential.recovery_generation, credential.credential)
    try {
      host.assert(active.identity, active.lease)
      const value = await run()
      host.assert(active.identity, active.lease)
      return value
    } finally {
      host.disconnect(active.identity)
    }
  }

  // 明确拒绝浏览器Origin、URL凭据和非JSON请求；没有公开注册、签发或默认管理员端点。
  handle(request: Request): Promise<Response> | undefined {
    const url = new URL(request.url)
    if (!['/pairing/redeem', '/pairing/ack', '/pairing/status', '/pairing/native'].includes(url.pathname)) {
      return undefined
    }
    if (
      this.#closed ||
      request.method !== 'POST' ||
      request.headers.has('origin') ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json'
    ) {
      return Promise.resolve(setupReply({ error: 'setup_request_refused' }, 403))
    }
    if (this.#requests.size >= 16) {
      return Promise.resolve(setupReply({ error: 'setup_busy' }, 503))
    }
    const task = this.respond(request, url.pathname)
    this.#requests.add(task)
    void task.then(
      /* 同一请求实际收尾后才释放额度。 */ () => this.#requests.delete(task),
      /* 异常收尾也只回收自己的额度，不改变原结果。 */ () => this.#requests.delete(task)
    )
    return task
  }

  // 失败不打印请求、secret、原异常或路径；不把HTTP响应已写入误报为凭据已持久交付。
  private async respond(request: Request, path: string): Promise<Response> {
    try {
      const input = await requestJson(request, path === '/pairing/native' ? 1_048_576 : 16_384, this.#stop.signal)
      if (this.#closed) {
        throw new Error('setup_closed')
      }
      if (path === '/pairing/redeem') {
        return await this.redeem(input)
      }
      const credential = device(input.authentication)
      id(input.attempt_id)
      // 配对完成后关闭专用短认证路径，普通状态查询不能建立新epoch而打断已运行WebSocket。
      if (this.approval.read(input.attempt_id as string).phase === 'ready') {
        throw new Error('setup_closed')
      }
      return await this.authenticated(
        credential,
        /* 认证后仍按当前计划及精确设备选择实际动作。 */ async () => {
          const plan = this.approval.read(input.attempt_id as string)
          if (plan.machine_id !== credential.machine_id || plan.generation !== credential.recovery_generation) {
            throw new Error('setup_target_mismatch')
          }
          if (path === '/pairing/ack') {
            fields(input, ['attempt_id', 'authentication', 'acknowledgement'])
            return await this.acknowledge(input.attempt_id as string, credential, input.acknowledgement)
          }
          if (path === '/pairing/status') {
            fields(input, ['attempt_id', 'authentication'])
            return setupReply({
              attempt_id: plan.attempt_id,
              machine_id: plan.machine_id,
              recovery_generation: plan.generation,
              phase: plan.phase,
              authorization: setupPolicies(plan, setupTarget(credential.machine_id))
            })
          }
          fields(input, ['attempt_id', 'authentication', 'installation'])
          if (!['paired', 'native_approved', 'configured'].includes(plan.phase)) {
            throw new Error('setup_not_paired')
          }
          return setupReply(
            await this.native({
              plan,
              credential,
              input: input.installation,
              signal: AbortSignal.any([request.signal, this.#stop.signal])
            })
          )
        }
      )
    } catch {
      return setupReply({ error: 'setup_not_completed' }, 409)
    }
  }

  // 原code在独立目标/摘要批准后仅消费一次；同attempt的重复POST不重发secret或再次注册。
  private async redeem(input: Record<string, unknown>): Promise<Response> {
    fields(input, ['attempt_id', 'machine_id', 'enrollment'])
    id(input.attempt_id)
    id(input.machine_id)
    if (this.#exchanges.size >= 4 || this.#exchanges.has(input.attempt_id)) {
      throw new Error('setup_exchange_unavailable')
    }
    const plan = this.approval.claim(input.attempt_id, input.machine_id, input.enrollment as string)
    let deliver!: (response: Response) => void
    let refuse!: (reason: Error) => void
    const response = new Promise<Response>(
      /* secret只进入本次请求对应的专用响应。 */ (resolve, reject) => {
        deliver = resolve
        refuse = reject
      }
    )
    let acknowledge!: (value: CredentialDeliveryAck) => void
    let rejectAck!: (reason: Error) => void
    const ack = new Promise<CredentialDeliveryAck>(
      /* 持久文件sink的精确确认从独立后续请求交回。 */ (resolve, reject) => {
        acknowledge = resolve
        rejectAck = reject
      }
    )
    // 尚未开始发送时也消费close产生的晚拒绝，不能把它当成功确认。
    void ack.catch(/* 原transfer仍观察实际失败，这里只防止发送前取消的未处理拒绝。 */ () => {})
    const custody = createPairingDelivery({
      backend: this.state.store,
      identities: this.state.credentials,
      // 只允许本地已批准计划的一次enroll，不能借这个sink轮换或接管其它设备。
      authorizeChannel: (context) => {
        if (this.#closed || context.operation !== 'enroll' || context.machine_id !== plan.machine_id) {
          throw new Error('setup_channel_refused')
        }
        return {
          // 原IdentityStore已完成install后才交付secret；客户端持久确认必须在原5秒范围内返回。
          deliver: async (credential, signal, delivery) => {
            if (
              this.#closed ||
              signal.aborted ||
              credential.machine_id !== plan.machine_id ||
              credential.recovery_generation !== plan.generation
            ) {
              throw new Error('setup_channel_refused')
            }
            exchange.context = delivery
            exchange.credential_sha256 = createHash('sha256').update(credential.credential).digest()
            exchange.acknowledgement = acknowledge
            deliver(
              setupReply({
                attempt_id: plan.attempt_id,
                ...delivery,
                ...credential,
                state: 'persist_and_acknowledge',
                expires_at: plan.expires_at
              })
            )
            return await ack
          },
          // close不重发secret，不假定客户端已保存，也不延长原交付截止。
          close: () => {
            rejectAck(new Error('setup_delivery_closed'))
          }
        }
      }
    })
    const task = custody
      .redeem({ registration_id: plan.machine_id!, enrollment: input.enrollment as string })
      .then(
        /* 精确ack通过后才记录paired，HTTP第一段响应本身不表示成功。 */ (receipt) => {
          this.approval.finishDelivery(plan.attempt_id, true)
          return receipt
        },
        /* 原custody已按精确digest拒绝不确定凭据；计划保留原machine/attempt，不自动签发新token。 */ (
          error: unknown
        ) => {
          try {
            this.approval.finishDelivery(plan.attempt_id, false)
          } catch {
            /* 保留更早的恢复位置，不伪造完成。 */
          }
          refuse(new Error('setup_delivery_unknown'))
          throw error
        }
      )
      .finally(
        /* 仅清除本次secret摘要与发送通道，非秘密计划由受保护文件保存。 */ () => {
          custody.close()
          exchange.credential_sha256?.fill(0)
          exchange.credential_sha256 = undefined
          exchange.acknowledgement = undefined
        }
      )
    const exchange: Exchange = {
      plan,
      task,
      close: /* 原custody负责拒绝与超时，不能绕过其事务。 */ () => custody.close()
    }
    this.#exchanges.set(plan.attempt_id, exchange)
    void task.catch(/* 请求可能已返回第一段响应，最终交付失败仍必须被观察。 */ () => {})
    return await response
  }

  // 设备先经真实IdentityHost认证，再匹配本次原secret摘要和所有交付轴，最后等待原custody结果。
  private async acknowledge(attempt: string, credential: DeviceCredential, value: unknown): Promise<Response> {
    const ack = object(value)
    fields(ack, ['delivery_id', 'revision', 'machine_id', 'recovery_generation'])
    const exchange = this.#exchanges.get(attempt)
    if (
      !exchange?.context ||
      !exchange.acknowledgement ||
      !exchange.credential_sha256 ||
      ack.delivery_id !== exchange.context.delivery_id ||
      ack.revision !== exchange.context.revision ||
      ack.machine_id !== credential.machine_id ||
      ack.recovery_generation !== credential.recovery_generation ||
      !timingSafeEqual(createHash('sha256').update(credential.credential).digest(), exchange.credential_sha256)
    ) {
      throw new Error('setup_ack_refused')
    }
    exchange.acknowledgement(ack as CredentialDeliveryAck)
    const receipt = await exchange.task
    return setupReply({ ...receipt, attempt_id: attempt })
  }

  // 关闭必须等所有原transfer收尾、拒绝不确定凭据后才允许产品关闭IdentityStore。
  async close(): Promise<void> {
    this.#closed = true
    this.#stop.abort()
    for (const exchange of this.#exchanges.values()) {
      exchange.close()
    }
    await Promise.allSettled(
      [...this.#exchanges.values()].map(/* 等待原事务实际结束而非仅取消HTTP等待。 */ (value) => value.task)
    )
    await Promise.allSettled(this.#requests)
    this.#exchanges.clear()
  }
}
