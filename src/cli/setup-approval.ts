// 把本地所有者的明确确认绑定到既有注册、身份安装和provider管理接口，普通请求不能构造批准。
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { PairingAdmin } from '../transport/pairing.js'
import type { ManagementRequest } from '../storage/model.js'
import type { openGatewayState } from '../runtime/state.js'
import { boundedJson, fields, id, object, sha } from '../wire/index.js'
import { CliError, type NativeProviderKind } from './config.js'
import { setupProviderKinds } from './setup-policy.js'
import { runtimeReference } from './runtime-files.js'
import { readSetupJson, writeSetupJson } from './setup-files.js'
import { SetupTerminal } from './setup-terminal.js'

type State = ReturnType<typeof openGatewayState>
export type PairingPlan = Readonly<{
  schema_version: 1
  attempt_id: string
  actor: string
  uid: number
  generation: string
  name: string
  created_at: number
  expires_at: number
  phase:
    | 'registering'
    | 'reserved'
    | 'issued'
    | 'redeeming'
    | 'paired'
    | 'native_approved'
    | 'configured'
    | 'ready'
    | 'unknown'
  machine_id?: string
  enrollment_sha256?: string
  native_fingerprint?: string
  providers?: readonly NativeProviderKind[]
}>
const phases = new Set([
  'registering',
  'reserved',
  'issued',
  'redeeming',
  'paired',
  'native_approved',
  'configured',
  'ready',
  'unknown'
])

// 内部计划也严格校验；它只记录同一操作的恢复位置，不以JSON字段自证身份或权限。
function plan(value: unknown): PairingPlan {
  try {
    const row = object(value)
    fields(
      row,
      ['schema_version', 'attempt_id', 'actor', 'uid', 'generation', 'name', 'created_at', 'expires_at', 'phase'],
      ['machine_id', 'enrollment_sha256', 'native_fingerprint', 'providers']
    )
    for (const key of ['attempt_id', 'actor', 'generation', 'name', ...(row.machine_id ? ['machine_id'] : [])]) {
      id(row[key])
    }
    if (
      row.schema_version !== 1 ||
      !Number.isSafeInteger(row.uid) ||
      Number(row.uid) < 0 ||
      !Number.isSafeInteger(row.created_at) ||
      !Number.isSafeInteger(row.expires_at) ||
      Number(row.expires_at) <= Number(row.created_at) ||
      !phases.has(String(row.phase))
    ) {
      throw new CliError('invalid_config')
    }
    if (row.enrollment_sha256 !== undefined) {
      sha(row.enrollment_sha256)
    }
    if (row.native_fingerprint !== undefined) {
      sha(row.native_fingerprint)
    }
    if (row.providers !== undefined) {
      setupProviderKinds(row.providers)
    }
    if (!['registering', 'reserved'].includes(String(row.phase)) && (!row.machine_id || !row.enrollment_sha256)) {
      throw new CliError('invalid_config')
    }
    return Object.freeze({
      ...row,
      ...(row.providers ? { providers: setupProviderKinds(row.providers) } : {})
    }) as PairingPlan
  } catch {
    throw new CliError('invalid_config')
  }
}

export class SetupApproval {
  readonly #providers = new Map<string, { confirmation: string; expires: number; generation: string }>()
  #state: State | undefined

  // 只接收真实终端实例；本模块没有默认管理员、默认允许或来自配置的authorize回调。
  constructor(
    readonly terminal: SetupTerminal,
    readonly directory: string
  ) {}

  // 绑定唯一产品双库；reload只换真实后端，不生成第二个writer或迁移旧epoch。
  attach(state: State): void {
    this.terminal.assertOwner()
    this.#state = state
  }

  // 旧后端关闭前撤下引用，异步请求不能继续借用已经释放的Store。
  detach(state: State): void {
    if (this.#state === state) {
      this.#state = undefined
    }
  }

  // 每个管理动作都要求当前OS所有者和实际已打开后端，不接受客户端的verified字段。
  private state(): State {
    this.terminal.assertOwner()
    if (!this.#state) {
      throw new CliError('backend_unavailable', 3)
    }
    return this.#state
  }

  // 计划名由程序生成的有界ID选择，不允许路径或URL进入内部状态解析。
  private path(attempt: string): string {
    id(attempt)
    return runtimeReference(this.directory, 'setup_' + attempt)
  }

  // 重读同一计划并复验实际所有者及恢复代次；文件不是绕过终端确认的授权令牌。
  read(attempt: string): PairingPlan {
    const state = this.state()
    const result = plan(readSetupJson(this.path(attempt)))
    if (
      result.attempt_id !== attempt ||
      result.actor !== this.terminal.actor ||
      result.uid !== this.terminal.uid ||
      result.generation !== state.store.generation()
    ) {
      throw new CliError('configuration_required')
    }
    return result
  }

  // 已有未完成操作必须保留其machine/attempt，不因重启或丢响应另注册一个设备。
  active(): PairingPlan | undefined {
    const raw = readSetupJson(runtimeReference(this.directory, 'setup-active'))
    if (raw === undefined) {
      return undefined
    }
    const value = object(raw)
    fields(value, ['attempt_id'])
    id(value.attempt_id)
    return this.read(value.attempt_id)
  }

  // 只更新当前程序计划；首次排他创建和后续原子更新共享同一固定内部路径。
  private save(value: PairingPlan, replace: boolean): PairingPlan {
    const checked = plan(value)
    writeSetupJson(this.path(checked.attempt_id), checked, replace)
    return checked
  }

  // 明确本地确认后才调用原PairingAdmin；register与enroll批准各消费一次并绑定同一machine。
  async issue(): Promise<{ plan: PairingPlan; code?: string }> {
    const state = this.state()
    const previous = this.active()
    if (previous && previous.phase !== 'ready') {
      if (
        !['issued', 'paired', 'native_approved'].includes(previous.phase) ||
        (previous.phase === 'issued' && Date.now() >= previous.expires_at)
      ) {
        throw new CliError('configuration_required')
      }
      if (!(await this.terminal.confirm('Resume the existing device setup? / 继续原设备设置？'))) {
        throw new CliError('configuration_required')
      }
      return { plan: previous }
    }
    if (!(await this.terminal.confirm('Pair one Connector with this Gateway? / 允许配对一个 Connector？'))) {
      throw new CliError('configuration_required')
    }
    const now = Date.now()
    const attempt = randomUUID()
    let current = this.save(
      {
        schema_version: 1,
        attempt_id: attempt,
        actor: this.terminal.actor,
        uid: this.terminal.uid,
        generation: state.store.generation(),
        name: 'connector-' + attempt.slice(0, 8),
        created_at: now,
        expires_at: now + 300_000,
        phase: 'registering'
      },
      false
    )
    writeSetupJson(runtimeReference(this.directory, 'setup-active'), { attempt_id: attempt }, previous !== undefined)
    let registration = false
    let issuance = false
    const admin = new PairingAdmin(state.store, {
      // 此闭包只持有刚确认的一次注册/签发范围；其它动作、目标、过期或后端替换全部拒绝。
      authorize: (action, machine) => {
        this.state()
        if (this.#state !== state || Date.now() >= current.expires_at) {
          throw new CliError('configuration_required')
        }
        if (action === 'register' && machine === undefined && !registration && current.phase === 'registering') {
          registration = true
          return
        }
        if (action === 'enroll' && machine === current.machine_id && !issuance && current.phase === 'reserved') {
          issuance = true
          return
        }
        throw new CliError('configuration_required')
      }
    })
    const machine = admin.register(current.name)
    current = this.save({ ...current, phase: 'reserved', machine_id: machine.machine_id }, true)
    const enrollment = admin.issue(machine.machine_id, Math.max(1, current.expires_at - Date.now()))
    current = this.save(
      { ...current, phase: 'issued', enrollment_sha256: createHash('sha256').update(enrollment).digest('hex') },
      true
    )
    return { plan: current, code: machine.machine_id + '.' + current.attempt_id + '.' + enrollment }
  }

  // 先核对原enrollment摘要与目标，再让原Store一次性消费，错误码不能消耗另一设备的token。
  claim(attempt: string, machine: string, enrollment: string): PairingPlan {
    const current = this.read(attempt)
    if (
      current.phase !== 'issued' ||
      current.machine_id !== machine ||
      Date.now() >= current.expires_at ||
      typeof enrollment !== 'string' ||
      !/^[A-Za-z0-9_-]{32,256}$/.test(enrollment) ||
      !timingSafeEqual(createHash('sha256').update(enrollment).digest(), Buffer.from(current.enrollment_sha256!, 'hex'))
    ) {
      throw new CliError('configuration_required')
    }
    return this.save({ ...current, phase: 'redeeming' }, true)
  }

  // 交付只按原结果推进；unknown永不自动重新签发，paired也不能倒退成issued。
  finishDelivery(attempt: string, delivered: boolean): PairingPlan {
    const current = this.read(attempt)
    if (current.phase !== 'redeeming') {
      throw new CliError('configuration_required')
    }
    return this.save({ ...current, phase: delivered ? 'paired' : 'unknown' }, true)
  }

  // 配对不代表原生权限；实际安装信息经本地所有者再次明确批准后才准备provider管理确认。
  async approveNative(
    attempt: string,
    provider: string | readonly NativeProviderKind[],
    fingerprint: string,
    description: string,
    signal = this.terminal.io.signal
  ): Promise<PairingPlan> {
    const state = this.state()
    const current = this.read(attempt)
    const providers = setupProviderKinds(typeof provider === 'string' ? [provider] : provider)
    sha(fingerprint)
    if (!['paired', 'native_approved'].includes(current.phase)) {
      throw new CliError('configuration_required')
    }
    if (current.phase === 'native_approved' && current.native_fingerprint !== fingerprint) {
      throw new CliError('configuration_required')
    }
    if (current.providers && boundedJson(current.providers) !== boundedJson(providers)) {
      throw new CliError('configuration_required')
    }
    if (!(await this.terminal.confirm(description, signal))) {
      throw new CliError('configuration_required')
    }
    const checked = this.read(attempt)
    if (
      checked.phase !== current.phase ||
      checked.native_fingerprint !== current.native_fingerprint ||
      this.#state !== state
    ) {
      throw new CliError('configuration_required')
    }
    for (const kind of providers) {
      this.#providers.set(current.machine_id + '/' + kind, {
        confirmation: randomUUID(),
        expires: Date.now() + 300_000,
        generation: current.generation
      })
    }
    return this.save({ ...current, phase: 'native_approved', native_fingerprint: fingerprint, providers }, true)
  }

  // 交给Store的既有management端口，每份批准仅限一个provider初次定义且严格消费一次。
  authorizeManagement(request: ManagementRequest): { actor: string; confirmation_id: string } {
    const state = this.state()
    const permit = this.#providers.get(request.target)
    if (
      request.action !== 'providers_manage' ||
      request.fence !== 'new' ||
      !permit ||
      permit.generation !== state.store.generation() ||
      Date.now() >= permit.expires
    ) {
      throw new CliError('configuration_required')
    }
    this.#providers.delete(request.target)
    return { actor: this.terminal.actor, confirmation_id: permit.confirmation }
  }

  // 原生配置/绑定持久完成只记录configured，不把静态准备误报为live provider就绪。
  finishNative(attempt: string, fingerprint: string): PairingPlan {
    const current = this.read(attempt)
    if (current.phase !== 'native_approved' || current.native_fingerprint !== fingerprint) {
      throw new CliError('configuration_required')
    }
    return this.save({ ...current, phase: 'configured' }, true)
  }

  // 仅正式Gateway观察到实际认证连接与provider ready后推进；请求中的字段不能触发此方法。
  finishReady(attempt: string): void {
    const current = this.read(attempt)
    if (current.phase !== 'configured') {
      throw new CliError('configuration_required')
    }
    this.save({ ...current, phase: 'ready' }, true)
  }
}
