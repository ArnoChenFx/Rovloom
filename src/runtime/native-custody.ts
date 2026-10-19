/** 为受控 Luvus 的有限委托持久保存一次批准与消费墓碑；本模块不认证管理员、不向普通调用返回 token。 */
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { boundedJson, fields, id, object } from '../wire/index.js'
import { LuvusAdapterError } from '../connector/luvus/types.js'
import { assertManagedControlDirectory, assertManagedRoot, checkedCustodyPolicy } from './native-root.js'
import type { ManagedLuvusRoot } from './native-root.js'
import { ownedPathStamp } from './native-process.js'
import {
  createNativeRecord,
  nativeRecordIdentity,
  nativeRecordStamp,
  readNativeRecord,
  removeNativeRecord,
  updateNativeRecord
} from './native-record-files.js'

const approvalBrand = Symbol('luvus-custody-approval')
export type NativeCustodyIntent = Readonly<{
  root_id: string
  root_revision: number
  config_ref: string
  config_digest: string
  server_generation: string
  scopes: readonly ('read' | 'orchestration')[]
  methods: readonly string[]
  token_ttl_s: number
}>
export type NativeCustodyDecision = Readonly<{ actor: string; confirmation_id: string; expires_at: number }>
export interface NativeCustodyApproval {
  readonly [approvalBrand]: true
  readonly approval_id: string
}
// 仅受信本机宿主实现：实际 session 和独立 native-custody grant 核验通过后才调用批准 writer。
export type NativeCustodyAuthorizer = (intent: NativeCustodyIntent) => NativeCustodyApproval
export interface NativeCustodyApprovalWriter {
  approve(intent: NativeCustodyIntent, decision: NativeCustodyDecision): NativeCustodyApproval
  read(approvalId: string): NativeCustodyApproval
  close(): void
}
type ApprovalRecord = Readonly<{
  format: 'rovloom-luvus-custody-approval-v1'
  approval_id: string
  intent: NativeCustodyIntent
  decision: NativeCustodyDecision
}>
type ApprovalState = Readonly<{
  root: ManagedLuvusRoot
  record: ApprovalRecord
  path: string
  stamp: string
  assert(): number
}>
const approvals = new WeakMap<NativeCustodyApproval, ApprovalState>()

/** 将请求限制到本记录的精确 session/config/policy；scope 和方法不能扩大受保护本机 grant。 */
export function checkedNativeCustodyIntent(root: ManagedLuvusRoot, input: NativeCustodyIntent): NativeCustodyIntent {
  assertManagedRoot(root)
  const value = object(JSON.parse(boundedJson(input, 8192)))
  fields(value, [
    'root_id',
    'root_revision',
    'config_ref',
    'config_digest',
    'server_generation',
    'scopes',
    'methods',
    'token_ttl_s'
  ])
  const policy = checkedCustodyPolicy({
    scopes: value.scopes as ('read' | 'orchestration')[],
    methods: value.methods as string[],
    max_token_ttl_s: value.token_ttl_s as number
  })
  if (
    value.root_id !== root.root_id ||
    value.root_revision !== root.root_revision ||
    value.config_ref !== root.config.config_ref ||
    value.config_digest !== root.config_digest ||
    typeof value.server_generation !== 'string' ||
    !value.server_generation.length ||
    value.server_generation.length > 512 ||
    policy.max_token_ttl_s > root.custody_policy.max_token_ttl_s ||
    policy.scopes.some(
      /* 每项 scope 都必须属于独立受保护 root policy。 */ (scope) => !root.custody_policy.scopes.includes(scope)
    ) ||
    policy.methods.some(
      /* 精确方法逐项收窄，禁止通配符或从 read 标签推导方法。 */ (method) =>
        !root.custody_policy.methods.includes(method)
    )
  ) {
    throw new LuvusAdapterError('native_custody_intent_mismatch')
  }
  return Object.freeze({
    root_id: root.root_id,
    root_revision: root.root_revision,
    config_ref: root.config.config_ref,
    config_digest: root.config_digest,
    server_generation: value.server_generation,
    scopes: policy.scopes,
    methods: policy.methods,
    token_ttl_s: policy.max_token_ttl_s
  })
}

/** 决策只保存已授权宿主提供的审计事实，actor/随机 confirmation_id 本身不作为权限来源。 */
function checkedDecision(input: NativeCustodyDecision, now: number): NativeCustodyDecision {
  const value = object(JSON.parse(boundedJson(input, 4096)))
  fields(value, ['actor', 'confirmation_id', 'expires_at'])
  id(value.actor)
  id(value.confirmation_id)
  if (
    !Number.isSafeInteger(value.expires_at) ||
    (value.expires_at as number) <= now ||
    (value.expires_at as number) > now + 60_000
  ) {
    throw new LuvusAdapterError('native_custody_approval_expired')
  }
  return Object.freeze(value as NativeCustodyDecision)
}

/** 时钟记录绑定同一受保护 root，正常关闭不会删除或把高水位归零。 */
function clockRecord(root: ManagedLuvusRoot, observedAt: number) {
  return {
    format: 'rovloom-luvus-custody-clock-v1',
    root_id: root.root_id,
    root_revision: root.root_revision,
    config_digest: root.config_digest,
    observed_at: observedAt
  }
}

/** 未完成的推进标记永不自动接管，缺失判断也不能跟随 symlink。 */
function assertNoClockPending(path: string): void {
  try {
    lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw new LuvusAdapterError('native_custody_clock_invalid')
  }
  throw new LuvusAdapterError('native_custody_clock_invalid')
}

/** 只有全新空白批准目录才能建账；已有记录缺失账本、损坏或替换 inode 时拒绝重建。 */
function openClock(root: ManagedLuvusRoot, directory: string, path: string, ownerPath: string) {
  try {
    assertNoClockPending(join(directory, '.clock.pending'))
    const entries = readdirSync(directory)
    if (isDeepStrictEqual(entries, ['.writer.lock'])) {
      createNativeRecord(path, clockRecord(root, 0), 4096)
      createNativeRecord(
        ownerPath,
        {
          format: 'rovloom-luvus-custody-clock-owner-v1',
          root_id: root.root_id,
          root_revision: root.root_revision,
          config_digest: root.config_digest,
          clock_identity: nativeRecordIdentity(path, 4096)
        },
        4096
      )
    }
    const owner = readNativeRecord(ownerPath, 4096)
    const anchor = object(owner.value)
    fields(anchor, ['format', 'root_id', 'root_revision', 'config_digest', 'clock_identity'])
    if (
      anchor.format !== 'rovloom-luvus-custody-clock-owner-v1' ||
      anchor.root_id !== root.root_id ||
      anchor.root_revision !== root.root_revision ||
      anchor.config_digest !== root.config_digest ||
      anchor.clock_identity !== nativeRecordIdentity(path, 4096)
    ) {
      throw new LuvusAdapterError('native_custody_clock_invalid')
    }
    const read = readNativeRecord(path, 4096)
    const value = object(read.value)
    fields(value, ['format', 'root_id', 'root_revision', 'config_digest', 'observed_at'])
    if (
      !Number.isSafeInteger(value.observed_at) ||
      (value.observed_at as number) < 0 ||
      !isDeepStrictEqual(value, clockRecord(root, value.observed_at as number)) ||
      nativeRecordStamp(ownerPath, 4096) !== owner.stamp ||
      nativeRecordIdentity(path, 4096) !== anchor.clock_identity ||
      nativeRecordStamp(path, 4096) !== read.stamp
    ) {
      throw new LuvusAdapterError('native_custody_clock_invalid')
    }
    return { clock: value.observed_at as number, clockStamp: read.stamp, ownerStamp: owner.stamp }
  } catch (error) {
    throw error instanceof LuvusAdapterError ? error : new LuvusAdapterError('native_custody_clock_invalid')
  }
}

/** 打开受保护本机批准 writer；此能力只能交给真实管理员 session 与独立 native-custody policy 的桥。 */
export function openNativeCustodyApprovals(
  root: ManagedLuvusRoot,
  options: Readonly<{
    directory: string
    max_entries?: number
    now?: () => number
  }>
): NativeCustodyApprovalWriter {
  assertManagedRoot(root)
  assertManagedControlDirectory(root.config, options.directory)
  const maximum = options.max_entries ?? 256
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 4096) {
    throw new LuvusAdapterError('native_custody_approval_limit')
  }
  const directoryStamp = ownedPathStamp(options.directory, 'directory')
  const lockPath = join(options.directory, '.writer.lock')
  const lockStamp = createNativeRecord(lockPath, {
    root_id: root.root_id,
    root_revision: root.root_revision,
    config_digest: root.config_digest
  })
  const clockPath = join(options.directory, '.clock.json')
  const clockOwnerPath = join(options.directory, '.clock-owner.json')
  const clockPendingPath = join(options.directory, '.clock.pending')
  let state: ReturnType<typeof openClock>
  try {
    state = openClock(root, options.directory, clockPath, clockOwnerPath)
    assertManagedRoot(root)
    if (
      ownedPathStamp(options.directory, 'directory') !== directoryStamp ||
      nativeRecordStamp(lockPath) !== lockStamp
    ) {
      throw new LuvusAdapterError('native_custody_approval_changed')
    }
  } catch (error) {
    // 只清理刚由本次调用创建且仍匹配的锁，残缺 ledger 保留并使下次打开继续拒绝。
    try {
      removeNativeRecord(lockPath, lockStamp)
    } catch {
      throw new LuvusAdapterError('native_custody_approval_cleanup_failed')
    }
    throw error
  }
  let closed = false
  let degraded = false
  let advancing = false
  /** 用户时钟回调前后及落盘后重验所有来源 fence，关闭或损坏后不能继续创建批准/墓碑。 */
  function fence(pendingStamp?: string): void {
    if (closed || degraded) {
      throw new LuvusAdapterError('native_custody_approval_unavailable')
    }
    assertManagedRoot(root)
    if (
      ownedPathStamp(options.directory, 'directory') !== directoryStamp ||
      nativeRecordStamp(lockPath) !== lockStamp ||
      nativeRecordStamp(clockOwnerPath, 4096) !== state.ownerStamp ||
      nativeRecordStamp(clockPath, 4096) !== state.clockStamp
    ) {
      throw new LuvusAdapterError('native_custody_approval_changed')
    }
    if (pendingStamp === undefined) {
      assertNoClockPending(clockPendingPath)
    } else if (nativeRecordStamp(clockPendingPath, 4096) !== pendingStamp) {
      throw new LuvusAdapterError('native_custody_approval_changed')
    }
  }
  /** 返回时间前先同步持久高水位，回拨或任何提交不确定均锁存失效，显式 close 仍可释放自有锁。 */
  function current(): number {
    if (advancing) {
      degraded = true
      throw new LuvusAdapterError('native_custody_clock_invalid')
    }
    advancing = true
    try {
      fence()
      const now = (options.now ?? Date.now)()
      fence()
      if (!Number.isSafeInteger(now) || now < state.clock || now < 0) {
        throw new LuvusAdapterError('native_custody_clock_invalid')
      }
      if (now > state.clock) {
        const pendingStamp = createNativeRecord(
          clockPendingPath,
          { ...clockRecord(root, now), previous_observed_at: state.clock },
          4096
        )
        state.clockStamp = updateNativeRecord(clockPath, state.clockStamp, clockRecord(root, now), 4096)
        state.clock = now
        fence(pendingStamp)
        removeNativeRecord(clockPendingPath, pendingStamp)
      }
      fence()
      return now
    } catch (error) {
      degraded = true
      throw error instanceof LuvusAdapterError ? error : new LuvusAdapterError('native_custody_clock_invalid')
    } finally {
      advancing = false
    }
  }
  /** 从真实保护文件创建 opaque 引用；同形 JSON 或仅相同摘要不能成为批准。 */
  function reference(approvalId: string): NativeCustodyApproval {
    const now = current()
    id(approvalId)
    const path = join(options.directory, approvalId + '.approval.json')
    const read = readNativeRecord(path, 16_384)
    const value = object(read.value)
    fields(value, ['format', 'approval_id', 'intent', 'decision'])
    if (value.format !== 'rovloom-luvus-custody-approval-v1' || value.approval_id !== approvalId) {
      throw new LuvusAdapterError('native_custody_approval_invalid')
    }
    const record: ApprovalRecord = Object.freeze({
      format: 'rovloom-luvus-custody-approval-v1',
      approval_id: approvalId,
      intent: checkedNativeCustodyIntent(root, value.intent as NativeCustodyIntent),
      decision: checkedDecision(value.decision as NativeCustodyDecision, now)
    })
    const handle = Object.freeze({ [approvalBrand]: true as const, approval_id: approvalId })
    approvals.set(handle, { root, record, path, stamp: read.stamp, assert: current })
    return handle
  }
  return Object.freeze({
    /** 受信本机 API 持久保存准确授权事实；不接受公共 caller 路径，也不把 providers_manage 升级为 token 权限。 */
    approve(input: NativeCustodyIntent, decision: NativeCustodyDecision): NativeCustodyApproval {
      const now = current()
      const intent = checkedNativeCustodyIntent(root, input)
      const checked = checkedDecision(decision, now)
      const files = readdirSync(options.directory)
      if (
        files.length >= maximum * 2 + 3 ||
        files.filter(/* 计数不依赖墓碑是否到期，禁止自动清理后重放。 */ (name) => name.endsWith('.approval.json'))
          .length >= maximum
      ) {
        throw new LuvusAdapterError('native_custody_approval_limit')
      }
      const approvalId = randomUUID()
      createNativeRecord(
        join(options.directory, approvalId + '.approval.json'),
        { format: 'rovloom-luvus-custody-approval-v1', approval_id: approvalId, intent, decision: checked },
        16_384
      )
      return reference(approvalId)
    },
    /** 仅重新读取同一保护文件引用；消费墓碑永久阻止同一批准被再次用于 token 创建。 */
    read: reference,
    /** 正常或失效 writer 只移除自己仍匹配的锁，高水位、批准和墓碑继续持久保留。 */
    close() {
      if (closed) {
        return
      }
      removeNativeRecord(lockPath, lockStamp)
      closed = true
    }
  })
}

/** 在原生 token 创建前同步消费精确的一次批准，提交不确定或创建失败后均不撤销墓碑。 */
export function consumeNativeCustodyApproval(
  root: ManagedLuvusRoot,
  input: NativeCustodyIntent,
  approval: NativeCustodyApproval
): Readonly<{ approval_id: string; actor: string; confirmation_id: string }> {
  const state = approvals.get(approval)
  if (!state || state.root !== root) {
    throw new LuvusAdapterError('native_custody_approval_untrusted')
  }
  const now = state.assert()
  const intent = checkedNativeCustodyIntent(root, input)
  if (
    !isDeepStrictEqual(intent, state.record.intent) ||
    now >= state.record.decision.expires_at ||
    nativeRecordStamp(state.path, 16_384) !== state.stamp
  ) {
    throw new LuvusAdapterError('native_custody_approval_mismatch')
  }
  const digest = createHash('sha256').update(boundedJson(state.record, 16_384)).digest('hex')
  createNativeRecord(
    state.path + '.consumed',
    {
      format: 'rovloom-luvus-custody-consumed-v1',
      approval_id: approval.approval_id,
      record_sha256: digest,
      consumed_at: now
    },
    4096
  )
  state.assert()
  if (nativeRecordStamp(state.path, 16_384) !== state.stamp) {
    throw new LuvusAdapterError('native_custody_approval_changed')
  }
  return Object.freeze({
    approval_id: approval.approval_id,
    actor: state.record.decision.actor,
    confirmation_id: state.record.decision.confirmation_id
  })
}
