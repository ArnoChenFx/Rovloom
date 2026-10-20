// 为已建立来源的 Luvus 实例复用三项具体普通 RPC 分类，来源证明由各自生产或开发包装器负责。
import { isDeepStrictEqual } from 'node:util'
import type { NativeMethodContract, SafetyClassification } from '../native-contract/index.js'
import { LuvusAdapterError } from '../connector/luvus/index.js'
import type { OwnedLuvusInstance } from './native-instance.js'
import type { RuntimeProvider } from './types.js'
import { id } from '../wire/index.js'

// 此固定清单已按 0.14.3 的具体普通 RPC 审核；其它方法、Host、终端、token 和 raw 均无分类。
const reviewed: Readonly<Record<string, { native: NativeMethodContract; effect: 'read' | 'execute' }>> = Object.freeze({
  'automation.list': {
    native: { method: 'automation.list', access: 'read', scope: 'orchestration', idempotent: true },
    effect: 'read'
  },
  'task.add': {
    native: { method: 'task.add', access: 'write', scope: 'orchestration', idempotent: false },
    effect: 'execute'
  },
  'task.update': {
    native: { method: 'task.update', access: 'write', scope: 'orchestration', idempotent: false },
    effect: 'execute'
  }
})

/** 仅共用已审分类与固定版本检查；provider 注册、来源证明和 caller/local grants 继续独立完成。 */
export function createReviewedLuvusProvider(
  instance: Pick<OwnedLuvusInstance, 'config' | 'contract' | 'issuance' | 'source' | 'ready'>,
  peerPolicyRevision: string,
  expected: Readonly<{ binary: string; revision: string; classification: string; error: string }>
): RuntimeProvider {
  id(peerPolicyRevision)
  const config = instance.config
  const contract = instance.contract
  const origin = contract.wire.source
  if (
    config.binary_sha256 !== expected.binary ||
    origin.binary_sha256 !== expected.binary ||
    origin.classification_revision !== expected.classification ||
    origin.adapter_revision !== expected.revision ||
    contract.compiled.identity.revision !== expected.revision
  ) {
    throw new LuvusAdapterError(expected.error)
  }
  const binding = Object.freeze({
    machine_id: config.target.machine_id,
    provider_id: config.target.provider_id,
    kind: 'luvus' as const,
    config_ref: config.config_ref,
    binding_revision: config.binding_revision,
    enabled: true
  })
  return Object.freeze({
    binding,
    target: config.target,
    peer_policy_revision: peerPolicyRevision,
    contract,
    /** 每次从 opaque 受控实例重新核对来源，不把启动成功缓存为永久授权。 */
    source: (attempt) => instance.source(attempt),
    /** 具体方法须同时属于手工清单和原始签发范围；未知方法无法借原生 scope 获得许可。 */
    authority(attempt, native) {
      const source = instance.source(attempt.binding)
      const entry = Object.hasOwn(reviewed, attempt.method) ? reviewed[attempt.method] : undefined
      if (
        attempt.mode !== 'strict' ||
        !entry ||
        !instance.issuance.methods.includes(attempt.method) ||
        !isDeepStrictEqual(source.binding, native)
      ) {
        throw new LuvusAdapterError(expected.error)
      }
      const classification: SafetyClassification = {
        method: attempt.method,
        revision: expected.classification,
        contract: contract.compiled.identity,
        native: { ...entry.native },
        transport: 'single_request_rpc',
        effect: entry.effect,
        requires_owner: false,
        management_permission: null,
        confirmation_required: false,
        result: {
          boundary: 'ordinary',
          sensitivity: 'potentially_sensitive',
          read_authorization: 'required',
          retention: 'caller_policy',
          delivery: 'ordinary'
        }
      }
      return {
        classification_source_verified: true,
        classifications: [classification],
        permissions: [],
        owner: false,
        confirmation_verified: false,
        custody_available: false,
        result_channel: 'ordinary',
        raw_requested: false,
        supported_transports: ['single_request_rpc'],
        supported_control_actions: []
      }
    },
    /** 原生进程、endpoint 与有限签发均须当前仍有效。 */
    ready: () => instance.ready()
  })
}
