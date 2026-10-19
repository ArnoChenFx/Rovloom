/** 复用固定 Luvus 普通方法的契约审核、参数检查和逐次授权；原生来源与 raw 决定仍由受信宿主交付。 */
import { isDeepStrictEqual } from 'node:util'
import { LuvusAdapterError } from '../connector/luvus/types.js'
import type { NativeContractRecord, NativeWireBackend, TrustedAttempt } from '../integration/luvus-wire.js'
import type { SafetyClassification, TrustedNativeContext } from '../native-contract/index.js'
import { object } from '../wire/index.js'
import type { AttemptBinding } from '../wire/types.js'
import { FIXED_LUVUS_SCHEMA_SHA256, FIXED_LUVUS_SHA256 } from './native-control.js'
import { MANAGED_LUVUS_CLASSIFICATION, MANAGED_LUVUS_REVISION } from './native-source.js'
import {
  LUVUS_OPERATION_METHODS,
  luvusOperationDescriptor,
  luvusOperationValidation,
  validateLuvusOperationParams
} from './luvus-operations.js'

/** 只审核固定安装契约与普通方法事实；完整响应 schema、能力绑定和实际来源由外层原校验器复核。 */
export function assertLuvusOperationsContract(contract: NativeContractRecord): void {
  const source = contract.wire.source
  const capabilities = object(object(contract.capabilities).result)
  if (
    contract.wire.support_status !== 'validated' ||
    source.binary_sha256 !== FIXED_LUVUS_SHA256 ||
    source.schema_sha256 !== FIXED_LUVUS_SCHEMA_SHA256 ||
    source.binary_version !== '0.14.3' ||
    source.server_version !== '0.14.3' ||
    source.provider_kind !== 'luvus' ||
    source.protocol_family !== 'uhp' ||
    source.schema_origin !== 'installed_cli' ||
    source.schema_command !== 'luvus uhp schema' ||
    source.native_protocol_version !== '1.0' ||
    source.support_basis !== 'live_catalog' ||
    source.adapter_revision !== MANAGED_LUVUS_REVISION ||
    source.classification_revision !== MANAGED_LUVUS_CLASSIFICATION ||
    typeof source.runtime_generation !== 'string' ||
    !source.runtime_generation.length ||
    source.runtime_generation !== capabilities.server_generation ||
    contract.compiled.identity.binary_sha256 !== source.binary_sha256 ||
    contract.compiled.identity.schema_sha256 !== source.schema_sha256 ||
    contract.compiled.identity.revision !== source.adapter_revision ||
    !Array.isArray(capabilities.method_contracts)
  ) {
    throw new LuvusAdapterError('luvus_operations_source_mismatch')
  }
  const live = new Set<string>()
  for (const value of capabilities.method_contracts) {
    const item = object(value)
    if (typeof item.method === 'string' && LUVUS_OPERATION_METHODS.includes(item.method)) {
      const reviewed = luvusOperationDescriptor(item.method)!
      if (live.has(item.method) || !isDeepStrictEqual(item, reviewed.native)) {
        throw new LuvusAdapterError('luvus_operations_contract_mismatch')
      }
      live.add(item.method)
    }
  }
  if (live.size !== LUVUS_OPERATION_METHODS.length) {
    throw new LuvusAdapterError('luvus_operations_contract_mismatch')
  }
}

/** 固定分类不能授予来源或 raw 权限；每次先取宿主当前来源，再按显式回调决定是否交付原 gate 所需 grant。 */
export function createLuvusOperationsAuthority(
  contract: NativeContractRecord,
  current: (binding: AttemptBinding) => TrustedNativeContext,
  rawAllowed: (attempt: TrustedAttempt) => boolean
): NativeWireBackend['authority'] {
  assertLuvusOperationsContract(contract)
  const classificationRevision = contract.wire.source.classification_revision!
  const identity = contract.compiled.identity
  return /** 每个候选重验当前来源、精确方法与参数，不从快照导入 Owner、permit 或新的期限。 */ (attempt, native) => {
    const proven = current(attempt.binding)
    const descriptor = luvusOperationDescriptor(attempt.method)
    if (
      proven.authenticated !== true ||
      proven.source_verified !== true ||
      !descriptor ||
      attempt.native_request.method !== attempt.method ||
      attempt.mode !== luvusOperationValidation(attempt.method) ||
      !isDeepStrictEqual(proven.binding, native)
    ) {
      throw new LuvusAdapterError('luvus_operation_unreviewed')
    }
    validateLuvusOperationParams(attempt.method, attempt.native_request.params)
    const classification: SafetyClassification = {
      method: attempt.method,
      revision: classificationRevision,
      contract: identity,
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
    const allowed = raw && rawAllowed(attempt) === true
    return {
      classification_source_verified: true,
      classifications: [classification],
      permissions: [],
      owner: allowed,
      confirmation_verified: false,
      custody_available: false,
      result_channel: 'ordinary',
      raw_requested: raw,
      ...(allowed
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
  }
}
