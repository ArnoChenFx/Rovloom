// 为固定 helper 定义封闭事务、单次交接凭据和持久回执；不包含 URL、脚本、PID 或任意目标参数。
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { parseReleaseJson } from '../../release/contract.js'
import { validateDownloadPlan, type UpdatePlan } from '../plan.js'
import { MAX_BINARY_BYTES, UpdateError } from '../contract.js'
import { windowsProcessStamp, type WindowsProcessStamp } from './parent.js'

export const WINDOWS_HELPER_COMMAND = '__rovloom-update-helper-v1'
export type WindowsFileIdentity = Readonly<{
  volume: string
  fileId: string
  size: number
  sha256: string
  security: string
}>
export type WindowsDirectoryIdentity = Readonly<{ volume: string; fileId: string; security: string }>
export type WindowsHelperJob = Readonly<{
  schemaVersion: 1
  transactionId: string
  plan: UpdatePlan
  parent: WindowsProcessStamp
  original: WindowsFileIdentity
  directory: WindowsDirectoryIdentity
}>
export type WindowsHelperTicket = Readonly<{ schemaVersion: 1; transactionId: string; secret: string }>
export type WindowsHelperState =
  | 'awaiting_parent'
  | 'prepared'
  | 'replacing'
  | 'replaced'
  | 'updated'
  | 'rolling_back'
  | 'rolled_back'
  | 'aborted'
  | 'recovery_required'
  | 'cleanup_required'
export type WindowsHelperCode =
  | 'permission_denied'
  | 'parent_timeout'
  | 'target_changed'
  | 'checksum_mismatch'
  | 'candidate_unusable'
  | 'replace_failed'
  | 'verification_failed'
  | 'rollback_failed'
  | 'receipt_failed'
  | 'service_handoff_unavailable'
export type WindowsHelperReceipt = Readonly<{
  schemaVersion: 1
  transactionId: string
  jobSha256: string
  sequence: number
  state: WindowsHelperState
  code: WindowsHelperCode | null
}>
const states: readonly string[] = [
  'awaiting_parent',
  'prepared',
  'replacing',
  'replaced',
  'updated',
  'rolling_back',
  'rolled_back',
  'aborted',
  'recovery_required',
  'cleanup_required'
]
const codes: readonly string[] = [
  'permission_denied',
  'parent_timeout',
  'target_changed',
  'checksum_mismatch',
  'candidate_unusable',
  'replace_failed',
  'verification_failed',
  'rollback_failed',
  'receipt_failed',
  'service_handoff_unavailable'
]

// 准确字段集阻止未来宽松反序列化把数据扩展成路径、进程或脚本能力。
function fields(value: unknown, names: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== [...names].sort().join(',')
  ) {
    throw new UpdateError('invalid_manifest')
  }
  return value as Record<string, unknown>
}

// 只接受无浮点损失的卷/文件身份与有限默认数据流；security 是原生已核验安全描述符的摘要。
function fileIdentity(value: unknown): WindowsFileIdentity {
  const v = fields(value, ['volume', 'fileId', 'size', 'sha256', 'security'])
  if (
    typeof v.volume !== 'string' ||
    !/^[1-9]\d{0,19}$/u.test(v.volume) ||
    BigInt(v.volume) > 0xffffffffffffffffn ||
    typeof v.fileId !== 'string' ||
    !/^[0-9a-f]{32}$/u.test(v.fileId) ||
    !Number.isSafeInteger(v.size) ||
    (v.size as number) < 1 ||
    (v.size as number) > MAX_BINARY_BYTES ||
    typeof v.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(v.sha256) ||
    typeof v.security !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(v.security)
  ) {
    throw new UpdateError('invalid_manifest')
  }
  return Object.freeze({
    volume: v.volume,
    fileId: v.fileId,
    size: v.size as number,
    sha256: v.sha256,
    security: v.security
  })
}

// helper 重开固定事务目录后必须匹配封存对象身份；路径字符串本身不授予目录能力。
export function windowsDirectoryIdentity(value: unknown): WindowsDirectoryIdentity {
  const v = fields(value, ['volume', 'fileId', 'security'])
  if (
    typeof v.volume !== 'string' ||
    !/^[1-9]\d{0,19}$/u.test(v.volume) ||
    BigInt(v.volume) > 0xffffffffffffffffn ||
    typeof v.fileId !== 'string' ||
    !/^[0-9a-f]{32}$/u.test(v.fileId) ||
    typeof v.security !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(v.security)
  ) {
    throw new UpdateError('invalid_manifest')
  }
  return Object.freeze({ volume: v.volume, fileId: v.fileId, security: v.security })
}

// 相同官方更新计划在 producer 和 helper 各自核验；默认稳定与禁止降级规则继续共用。
function job(value: unknown): WindowsHelperJob {
  const v = fields(value, ['schemaVersion', 'transactionId', 'plan', 'parent', 'original', 'directory'])
  if (v.schemaVersion !== 1 || typeof v.transactionId !== 'string' || !/^[0-9a-f]{32}$/u.test(v.transactionId)) {
    throw new UpdateError('invalid_manifest')
  }
  const p = fields(v.plan, [
    'repository',
    'currentVersion',
    'targetVersion',
    'tag',
    'commit',
    'bun',
    'platform',
    'asset',
    'status'
  ])
  fields(p.platform, ['os', 'arch', 'libc'])
  fields(p.asset, ['os', 'arch', 'libc', 'name', 'size', 'sha256'])
  const plan = p as unknown as UpdatePlan
  validateDownloadPlan(plan)
  if (plan.platform.os !== 'windows') {
    throw new UpdateError('unsupported_platform')
  }
  const frozen = Object.freeze({
    ...plan,
    platform: Object.freeze({ ...plan.platform }),
    asset: Object.freeze({ ...plan.asset })
  })
  return Object.freeze({
    schemaVersion: 1,
    transactionId: v.transactionId,
    plan: frozen,
    parent: windowsProcessStamp(v.parent),
    original: fileIdentity(v.original),
    directory: windowsDirectoryIdentity(v.directory)
  })
}

// 凭据只通过自有 child stdin 交付，不写到日志/argv；它不构成 GitHub 发行签名认证。
export function parseWindowsTicket(bytes: Uint8Array): WindowsHelperTicket {
  const v = fields(parseReleaseJson(bytes, 1024), ['schemaVersion', 'transactionId', 'secret'])
  if (
    v.schemaVersion !== 1 ||
    typeof v.transactionId !== 'string' ||
    !/^[0-9a-f]{32}$/u.test(v.transactionId) ||
    typeof v.secret !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(v.secret)
  ) {
    throw new UpdateError('invalid_arguments')
  }
  return Object.freeze({ schemaVersion: 1, transactionId: v.transactionId, secret: v.secret })
}

// 受信 producer 在任何交接前冻结计划和原安装身份；MAC 只绑定本次私有 IPC 与事务字节。
export function sealWindowsJob(
  plan: UpdatePlan,
  parent: WindowsProcessStamp,
  original: WindowsFileIdentity,
  resources: Readonly<{ transactionId: string; directory: WindowsDirectoryIdentity }>
): Readonly<{ job: WindowsHelperJob; bytes: Uint8Array; ticket: WindowsHelperTicket; digest: string }> {
  const value = job({ schemaVersion: 1, ...resources, plan, parent, original })
  const ticket = Object.freeze({
    schemaVersion: 1 as const,
    transactionId: value.transactionId,
    secret: randomBytes(32).toString('hex')
  })
  const bytes = Buffer.from(JSON.stringify(value))
  const mac = createHmac('sha256', Buffer.from(ticket.secret, 'hex')).update(bytes).digest('hex')
  return Object.freeze({
    job: value,
    ticket,
    digest: createHash('sha256').update(bytes).digest('hex'),
    bytes: Buffer.from(JSON.stringify({ schemaVersion: 1, payload: bytes.toString('base64'), mac }))
  })
}

// 对原始 payload 做常量时间 MAC 比较，再解析封闭结构；字节损坏/重复键/未知参数均不授予能力。
export function openWindowsJob(
  bytes: Uint8Array,
  ticket: WindowsHelperTicket
): Readonly<{ job: WindowsHelperJob; digest: string }> {
  const credential = parseWindowsTicket(Buffer.from(JSON.stringify(ticket)))
  const envelope = fields(parseReleaseJson(bytes, 32768), ['schemaVersion', 'payload', 'mac'])
  if (
    envelope.schemaVersion !== 1 ||
    typeof envelope.payload !== 'string' ||
    envelope.payload.length > 22000 ||
    typeof envelope.mac !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(envelope.mac)
  ) {
    throw new UpdateError('invalid_manifest')
  }
  const payload = Buffer.from(envelope.payload, 'base64')
  if (payload.toString('base64') !== envelope.payload) {
    throw new UpdateError('invalid_manifest')
  }
  const mac = createHmac('sha256', Buffer.from(credential.secret, 'hex')).update(payload).digest()
  if (!timingSafeEqual(mac, Buffer.from(envelope.mac, 'hex'))) {
    throw new UpdateError('invalid_manifest')
  }
  const value = job(parseReleaseJson(payload, 16384))
  if (value.transactionId !== credential.transactionId) {
    throw new UpdateError('invalid_manifest')
  }
  return Object.freeze({ job: value, digest: createHash('sha256').update(payload).digest('hex') })
}

// 持久回执只有固定阶段和安全错误码，不接纳底层异常原文、URL 或用户配置内容。
export function parseWindowsReceipt(bytes: Uint8Array): WindowsHelperReceipt {
  const v = fields(parseReleaseJson(bytes, 4096), [
    'schemaVersion',
    'transactionId',
    'jobSha256',
    'sequence',
    'state',
    'code'
  ])
  if (
    v.schemaVersion !== 1 ||
    typeof v.transactionId !== 'string' ||
    !/^[0-9a-f]{32}$/u.test(v.transactionId) ||
    typeof v.jobSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(v.jobSha256) ||
    !Number.isSafeInteger(v.sequence) ||
    (v.sequence as number) < 1 ||
    (v.sequence as number) > 64 ||
    typeof v.state !== 'string' ||
    !states.includes(v.state) ||
    (v.code !== null && (typeof v.code !== 'string' || !codes.includes(v.code))) ||
    (['rolled_back', 'aborted', 'recovery_required', 'cleanup_required'].includes(v.state)
      ? v.code === null
      : v.code !== null)
  ) {
    throw new UpdateError('invalid_manifest')
  }
  return Object.freeze(v) as WindowsHelperReceipt
}

// 只有 helper 已验证提交的成功回执返回零；待交接/中间状态不能冒充更新已完成。
export function windowsReceiptExit(receipt: WindowsHelperReceipt): number {
  const checked = parseWindowsReceipt(Buffer.from(JSON.stringify(receipt)))
  if (checked.state === 'updated') {
    return 0
  }
  if (checked.state === 'rolled_back') {
    return 6
  }
  return ['replacing', 'replaced', 'rolling_back', 'recovery_required'].includes(checked.state) ? 7 : 4
}
