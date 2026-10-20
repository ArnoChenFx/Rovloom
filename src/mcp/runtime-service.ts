// 将MCP动作投影到既有常驻宿主；准入、取消和原Wire结果门禁均复用同一运行实例。
import { randomUUID } from 'node:crypto'
import { GatewayError } from '../contracts.js'
import { WireError } from '../wire/index.js'
import { LuvusAdapterError } from '../connector/luvus/index.js'
import type { createGatewayRuntime, createProviderGatewayRuntime } from '../runtime/index.js'
import type { Store } from '../store.js'
import { StoreGatewayService, type StoreGatewayOptions } from './store-service.js'
import { isToolName, parseToolArguments } from './schema.js'
import { publicCallView } from './call-view.js'
import {
  FacadeServiceError,
  SERVICE_ERROR_CODES,
  type CallView,
  type GatewayService,
  type ReplyData,
  type ServiceContext,
  type ServiceErrorCode,
  type ServiceReply,
  type ToolArguments,
  type ToolName
} from './types.js'

export type RuntimeGateway =
  | Awaited<ReturnType<typeof createGatewayRuntime>>
  | Awaited<ReturnType<typeof createProviderGatewayRuntime>>
export type RuntimeGatewayPort = Pick<
  RuntimeGateway,
  'router' | 'principal' | 'runAuthenticated' | 'admit' | 'get' | 'cancel' | 'results' | 'originalAttempt'
> & { store: Store }
export type RuntimeGatewayServiceOptions = Omit<StoreGatewayOptions, 'store' | 'router'> & {
  runtime: RuntimeGatewayPort
}
type Request = { [K in ToolName]: { name: K; args: ToolArguments[K] } }[ToolName]
type Cursor = { caller: string; result: string; offset: number; bytes: number; expires: number }
const errors: Record<string, ServiceErrorCode> = {
  runtime_closed: 'unavailable',
  connection_unavailable: 'unavailable',
  provider_binding_mismatch: 'binding_revision_conflict',
  call_not_found: 'not_found',
  result_not_found: 'content_unavailable',
  result_not_ready: 'content_unavailable',
  result_quota: 'storage_exhausted',
  result_context_unavailable: 'content_unavailable',
  result_retention_context_unavailable: 'content_unavailable',
  discard_forbidden: 'forbidden',
  clock_untrusted: 'storage_degraded'
}

// 只映射受信错误类中的固定公共码，未知原生异常及code不进入MCP诊断。
function publicError(error: unknown): FacadeServiceError {
  if (error instanceof FacadeServiceError && SERVICE_ERROR_CODES.includes(error.code)) {
    return error
  }
  if (error instanceof GatewayError || error instanceof WireError || error instanceof LuvusAdapterError) {
    if (SERVICE_ERROR_CODES.includes(error.code as ServiceErrorCode)) {
      return new FacadeServiceError(error.code as ServiceErrorCode)
    }
    if (Object.hasOwn(errors, error.code)) {
      return new FacadeServiceError(errors[error.code]!)
    }
  }
  return new FacadeServiceError('internal_error')
}

export class RuntimeGatewayService implements GatewayService {
  readonly management: StoreGatewayService['management']
  private readonly reads: StoreGatewayService
  private readonly cursors = new Map<string, Cursor>()
  private closed = false

  // 同一宿主已拥有Store/Router，查询服务不再创建第二个writer或transport。
  constructor(private readonly options: RuntimeGatewayServiceOptions) {
    this.reads = new StoreGatewayService({ ...options, store: options.runtime.store, router: options.runtime.router })
    this.management = this.reads.management
  }

  // 显式关闭只回收门面游标，底层资源仍由角色宿主按顺序释放。
  close(): void {
    this.closed = true
    this.cursors.clear()
  }

  // 每次操作核对等待和真实身份；终止等待不能进入runtime.cancel。
  private current(context: ServiceContext): string {
    if (this.closed || context.wait_signal.aborted) {
      throw new FacadeServiceError('unavailable')
    }
    return this.options.runtime.principal().id
  }

  // 短等复用既有查询实现；正文仅打开原Wire许可保护的真实结果句柄，不直接读取call.response。
  private async callView(callId: string, wait: number | undefined, context: ServiceContext): Promise<CallView> {
    await this.reads.execute(
      'runtime_call_get',
      { call_id: callId, ...(wait === undefined ? {} : { wait_ms: wait }) },
      context
    )
    this.current(context)
    const runtime = this.options.runtime
    const call = runtime.get(callId)
    let view = publicCallView(call)
    let original: ReturnType<RuntimeGatewayPort['originalAttempt']>
    try {
      original = call.attempt_id ? runtime.originalAttempt(callId, call.attempt_id) : undefined
    } catch (error) {
      // 原连接/上下文失效不抹掉调用登记；再次授权后只交付最新元数据，绝不恢复旧许可或正文。
      await this.reads.execute('runtime_call_get', { call_id: callId }, context)
      this.current(context)
      view = publicCallView(runtime.get(callId))
      view.content_reason_code = publicError(error).code
      this.current(context)
      return view
    }
    view.contract_ref = original?.binding.contract_ref ?? null
    if (call.state === 'responded' && call.content_status === 'available') {
      try {
        const result = runtime.results.open(callId)
        view.result = {
          result_id: result.result_id,
          bytes: result.bytes,
          sha256: result.hash,
          expires_at: result.expires
        }
        view.content_delivery = 'result_handle'
      } catch (error) {
        // 句柄配额/正文门禁失败不能抹掉已登记call_id；重新授权元数据，不借此交付任何正文。
        await this.reads.execute('runtime_call_get', { call_id: callId }, context)
        this.current(context)
        view = publicCallView(runtime.get(callId))
        view.content_reason_code = publicError(error).code
      }
    }
    this.current(context)
    return view
  }

  // 服务游标绑定主体、原结果、分页大小和不延长的期限；偏移始终交原results.read重新验权。
  private readResult(
    args: ToolArguments['runtime_result_read'],
    context: ServiceContext
  ): ReplyData['runtime_result_read'] {
    const runtime = this.options.runtime
    const caller = this.current(context)
    const now = runtime.store.clock()
    for (const [key, value] of this.cursors) {
      if (now >= value.expires) {
        this.cursors.delete(key)
      }
    }
    const bytes = args.max_bytes ?? 4096
    const cursor = args.cursor ? this.cursors.get(args.cursor) : undefined
    if (
      args.cursor &&
      (!cursor || cursor.caller !== caller || cursor.result !== args.result_id || cursor.bytes !== bytes)
    ) {
      throw new FacadeServiceError('invalid_cursor')
    }
    const page = runtime.results.read(args.result_id, cursor?.offset ?? 0, bytes)
    this.current(context)
    let next: string | undefined
    if (!page.eof) {
      next = [...this.cursors].find(
        /* 重读同一页复用其固定后继引用，避免重试无界创建游标。 */ ([, value]) =>
          value.caller === caller &&
          value.result === args.result_id &&
          value.bytes === bytes &&
          value.offset === page.next_cursor
      )?.[0]
      if (!next) {
        if (this.cursors.size >= 128) {
          throw new FacadeServiceError('busy')
        }
        next = 'result_' + randomUUID()
        this.cursors.set(next, {
          caller,
          result: args.result_id,
          offset: page.next_cursor,
          bytes,
          expires: Math.min(page.expires, now + 30_000)
        })
      }
    }
    return {
      result_id: page.result_id,
      chunk: page.data,
      encoding: page.encoding,
      ...(next ? { next_cursor: next } : {}),
      eof: page.eof,
      total_bytes: page.bytes,
      sha256: page.hash,
      expires_at: page.expires
    }
  }

  // 只做参数投影和受信请求作用域组合，不实现第二份准入、取消、结果存储或管理写事务。
  async execute<K extends ToolName>(
    name: K,
    args: ToolArguments[K],
    context: ServiceContext
  ): Promise<ServiceReply<K>> {
    try {
      if (!isToolName(name)) {
        throw new FacadeServiceError('unsupported')
      }
      let request: Request
      try {
        request = { name, args: parseToolArguments(name, args) } as Request
      } catch {
        throw new FacadeServiceError('invalid_arguments')
      }
      const data = await this.options.runtime.runAuthenticated(
        context.caller,
        /* 身份仅来自HTTP受信上下文。 */ async () => {
          this.current(context)
          const runtime = this.options.runtime
          if (request.name === 'runtime_call') {
            const input = request.args
            if (input.history && input.history.recovery_generation !== runtime.store.generation()) {
              throw new FacadeServiceError('dedup_history_unavailable')
            }
            const admitted = runtime.admit({
              target: input.target,
              native_request: input.native_request,
              options: {
                binding_revision: input.expected_binding_revision,
                contract_ref: input.contract_ref,
                deadline: input.deadline,
                ...(input.validation ? { validation: input.validation } : {}),
                ...(input.history
                  ? {
                      history: {
                        history_epoch: input.history.history_epoch,
                        client_request_key: input.history.client_request_key
                      }
                    }
                  : {})
              }
            })
            return this.callView(admitted.call.call_id, input.wait_ms, context)
          }
          if (request.name === 'runtime_call_get') {
            return this.callView(request.args.call_id, request.args.wait_ms, context)
          }
          if (request.name === 'runtime_call_cancel') {
            const call = runtime.cancel(request.args.call_id)
            this.current(context)
            return {
              call_id: call.call_id,
              // transport没有取消ack，不能把尝试发送通知称为bridge/native已停。
              cancellation:
                call.state === 'not_dispatched'
                  ? 'waiting_stopped'
                  : call.state === 'outcome_unknown'
                    ? 'outcome_unknown'
                    : 'unsupported'
            }
          }
          if (request.name === 'runtime_result_read') {
            return this.readResult(request.args, context)
          }
          if (request.name === 'runtime_response_discard') {
            runtime.results.discard(request.args.call_id)
            this.current(context)
            return { call_id: request.args.call_id, content_status: 'discarded' }
          }
          const reply = await this.reads.execute(name, args, context)
          this.current(context)
          return reply.data
        }
      )
      return { data: data as ReplyData[K] }
    } catch (error) {
      throw publicError(error)
    }
  }
}
