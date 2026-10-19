/** 为实际受控本机 Owner 装配普通 Luvus 窗口与 Agent 操作，复用原 Wire、当前政策、来源与固定派发期限。 */
import { isDeepStrictEqual } from 'node:util'
import { LuvusAdapterError } from '../connector/luvus/types.js'
import type { NativeMethodContract, SafetyClassification } from '../native-contract/index.js'
import { id, object } from '../wire/index.js'
import { FIXED_LUVUS_SCHEMA_SHA256, FIXED_LUVUS_SHA256 } from './native-control.js'
import { assertLocalOwnerLuvus } from './native-source.js'
import type { LocalOwnerLuvusInstance } from './native-source.js'
import {
  LUVUS_OPERATION_METHODS,
  luvusOperationDescriptor,
  luvusOperationValidation,
  validateLuvusOperationParams
} from './luvus-operations.js'
import type { RuntimeProvider } from './types.js'

/** 只有原受控进程交付的真实 Owner 句柄可装配；普通 JSON、缺 token 或 ready 自报不能成为来源。 */
export function createLuvusOperationsProvider(
  owner: LocalOwnerLuvusInstance,
  peerPolicyRevision: string
): RuntimeProvider {
  assertLocalOwnerLuvus(owner)
  id(peerPolicyRevision)
  const config = owner.config
  const contract = owner.contract
  const source = contract.wire.source
  const classificationRevision = source.classification_revision
  const capabilities = object(object(contract.capabilities).result)
  if (
    config.binary_sha256 !== FIXED_LUVUS_SHA256 ||
    source.binary_sha256 !== FIXED_LUVUS_SHA256 ||
    source.schema_sha256 !== FIXED_LUVUS_SCHEMA_SHA256 ||
    source.binary_version !== '0.14.3' ||
    source.server_version !== '0.14.3' ||
    source.provider_kind !== 'luvus' ||
    source.protocol_family !== 'uhp' ||
    typeof classificationRevision !== 'string' ||
    !classificationRevision.length ||
    source.runtime_generation !== capabilities.server_generation ||
    capabilities.session !== config.target.session ||
    contract.compiled.identity.binary_sha256 !== source.binary_sha256 ||
    contract.compiled.identity.schema_sha256 !== source.schema_sha256 ||
    contract.compiled.identity.revision !== source.adapter_revision ||
    !Array.isArray(capabilities.method_contracts)
  ) {
    throw new LuvusAdapterError('luvus_operations_source_mismatch')
  }
  const live = new Map<string, NativeMethodContract>()
  for (const value of capabilities.method_contracts) {
    const item = object(value)
    if (typeof item.method === 'string' && LUVUS_OPERATION_METHODS.includes(item.method)) {
      const reviewed = luvusOperationDescriptor(item.method)!
      if (live.has(item.method) || !isDeepStrictEqual(item, reviewed.native)) {
        throw new LuvusAdapterError('luvus_operations_contract_mismatch')
      }
      live.set(item.method, item as NativeMethodContract)
    }
  }
  if (live.size !== LUVUS_OPERATION_METHODS.length) {
    throw new LuvusAdapterError('luvus_operations_contract_mismatch')
  }
  return Object.freeze({
    binding: Object.freeze({
      machine_id: config.target.machine_id,
      provider_id: config.target.provider_id,
      kind: 'luvus' as const,
      binding_revision: config.binding_revision,
      config_ref: config.config_ref,
      enabled: true
    }),
    target: config.target,
    peer_policy_revision: peerPolicyRevision,
    contract,
    /** 每个调用都复核原真实 child/root/session/generation，不能复用另一实例的许可。 */
    source(binding) {
      assertLocalOwnerLuvus(owner)
      return owner.source(binding)
    },
    /** 目录只使用当前实际认证连接及当前 caller/local 政策，不创建虚构请求。 */
    catalogSource(connection, policies) {
      assertLocalOwnerLuvus(owner)
      return owner.catalogSource(connection, policies)
    },
    /** 普通方法先核实际来源、固定原生契约和参数；generic 仅使用当前真实 Owner 的既有精确 raw 授权。 */
    authority(attempt, native) {
      assertLocalOwnerLuvus(owner)
      const current = owner.source(attempt.binding)
      const descriptor = luvusOperationDescriptor(attempt.method)
      if (
        !descriptor ||
        !live.has(attempt.method) ||
        attempt.native_request.method !== attempt.method ||
        attempt.mode !== luvusOperationValidation(attempt.method) ||
        !isDeepStrictEqual(current.binding, native)
      ) {
        throw new LuvusAdapterError('luvus_operation_unreviewed')
      }
      validateLuvusOperationParams(attempt.method, attempt.native_request.params)
      const classification: SafetyClassification = {
        method: attempt.method,
        revision: classificationRevision,
        contract: contract.compiled.identity,
        native: descriptor.native,
        transport: 'single_request_rpc',
        effect: descriptor.effect,
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
      const raw = attempt.mode === 'raw-contract'
      return {
        classification_source_verified: true,
        classifications: [classification],
        permissions: [],
        owner: raw,
        confirmation_verified: false,
        custody_available: false,
        result_channel: 'ordinary',
        raw_requested: raw,
        ...(raw
          ? {
              raw_grant: {
                id: attempt.binding.call_id,
                source_verified: true,
                principal_id: attempt.principal_id,
                binding: native,
                methods: [attempt.method],
                expires_at: attempt.binding.registration.deadline
              }
            }
          : {}),
        supported_transports: ['single_request_rpc'],
        supported_control_actions: []
      }
    },
    /** 就绪只取真实受控来源，失效后不把旧 Owner 句柄自报为永久可用。 */
    ready() {
      try {
        assertLocalOwnerLuvus(owner)
        return owner.ready()
      } catch {
        return false
      }
    }
  })
}
