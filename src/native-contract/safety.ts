import { authorize } from '../contracts.js';
import { candidates, permits, SCOPES, views } from './internal.js';
import { attempt, ContractFault, equal, fail, object, pointer, snapshot } from './json.js';
import { verifySource } from './validator.js';
import type {
  Check,
  DispatchAuthorization,
  DispatchCandidate,
  DispatchPermit,
  JsonObject,
  NativeRequestGate,
  ResultAuthorization,
  SafetyClassification,
} from './types.js';

function reject(code: string, reason?: string): never {
  return fail(code, 'authorization', reason, 'authorization');
}
const TOKENS = new Set(['uhp.token.create', 'uhp.token.list', 'uhp.token.revoke']);

function classification(
  candidate: DispatchCandidate,
  context: DispatchAuthorization,
): SafetyClassification {
  if (context.classification_source_verified !== true) reject('safety_classification_untrusted');
  if (!Array.isArray(context.classifications)) reject('safety_classification_missing');
  const rows = snapshot(context.classifications) as readonly JsonObject[];
  const selected = rows.filter(
    (row) =>
      row &&
      typeof row === 'object' &&
      row.method === candidate.method &&
      (candidate.kind === 'control' ? row.action === candidate.action : row.action === undefined),
  );
  if (!selected.length) reject('safety_classification_missing');
  const matching = selected.filter((row) => {
    if (row.sub_action === undefined) return true;
    try {
      const selector = object(row.sub_action);
      return (
        typeof selector.pointer === 'string' &&
        equal(
          pointer(
            candidate.kind === 'control' ? candidate.frame : candidate.request,
            selector.pointer,
          ),
          selector.value,
        )
      );
    } catch {
      return false;
    }
  });
  if (!matching.length) reject('safety_classification_missing', 'sub_action');
  if (matching.length !== 1) reject('safety_classification_invalid', 'conflict');
  const row = matching[0]!;
  const required = [
    'method',
    'revision',
    'contract',
    'native',
    'transport',
    'effect',
    'requires_owner',
    'management_permission',
    'confirmation_required',
    'result',
  ];
  if (
    required.some((key) => !Object.hasOwn(row, key)) ||
    Object.keys(row).some((key) => ![...required, 'action', 'sub_action'].includes(key))
  ) {
    reject('safety_classification_invalid', 'incomplete_or_unknown_field');
  }
  const native = object(row.native, 'safety_classification_invalid');
  const result = object(row.result, 'safety_classification_invalid');
  if (
    !equal(Object.keys(result).sort(), [
      'boundary',
      'delivery',
      'read_authorization',
      'retention',
      'sensitivity',
    ])
  ) {
    reject('safety_classification_invalid', 'incomplete_or_unknown_result_field');
  }
  if (
    !['read', 'write', 'execute', 'external'].includes(row.effect as string) ||
    !['single_request_rpc', 'host_stdio_proxy', 'persistent_local_stream'].includes(
      row.transport as string,
    ) ||
    !SCOPES.has(native.scope as string) ||
    !['read', 'write'].includes(native.access as string) ||
    !['ordinary', 'protected_secret'].includes(result.boundary as string) ||
    !['public', 'potentially_sensitive', 'credential'].includes(result.sensitivity as string) ||
    !['caller_policy', 'none'].includes(result.retention as string) ||
    !['ordinary', 'custody'].includes(result.delivery as string)
  )
    reject('safety_classification_unknown');
  const stored = candidates.get(candidate)!;
  if (
    row.revision !== candidate.binding.classification_revision ||
    !equal(row.contract, candidate.binding.contract) ||
    !equal(native, stored.descriptor.native_contract) ||
    (stored.descriptor.transport !== 'unclassified' &&
      row.transport !== stored.descriptor.transport) ||
    typeof row.requires_owner !== 'boolean' ||
    typeof row.confirmation_required !== 'boolean' ||
    !(
      row.management_permission === null ||
      (typeof row.management_permission === 'string' && row.management_permission.length > 0)
    ) ||
    result.read_authorization !== 'required' ||
    typeof native.idempotent !== 'boolean' ||
    (native.access === 'write' && row.effect === 'read') ||
    (native.access === 'read' && row.effect !== 'read') ||
    (native.scope === 'admin' && row.management_permission === null) ||
    (candidate.method === 'module.action.invoke' && row.sub_action === undefined)
  )
    reject('safety_classification_invalid', 'incomplete_or_conflicting');
  if (
    (result.boundary === 'protected_secret') !== (result.delivery === 'custody') ||
    (result.sensitivity === 'credential' && result.boundary !== 'protected_secret') ||
    (TOKENS.has(candidate.method) &&
      (result.boundary !== 'protected_secret' || row.management_permission === null))
  ) {
    reject('safety_classification_invalid', 'secret_boundary');
  }
  return row as unknown as SafetyClassification;
}

function checkedAuthorization(
  candidate: DispatchCandidate,
  input: DispatchAuthorization,
): DispatchAuthorization {
  const stored = candidates.get(candidate);
  if (!stored || !views.has(stored.view)) reject('invalid_request_handle');
  const context = snapshot(input) as unknown as DispatchAuthorization;
  if (!context.source?.authenticated) reject('unauthenticated');
  const current = verifySource(context.source);
  if (!equal(current, candidate.binding)) reject('capability_stale');
  if (
    typeof context.principal_id !== 'string' ||
    !context.principal_id.trim() ||
    !Number.isSafeInteger(context.now) ||
    context.now < 0
  )
    reject('invalid_authorization_context');
  return context;
}
function checkTransport(
  candidate: DispatchCandidate,
  context: DispatchAuthorization,
  row?: SafetyClassification,
): void {
  const stored = candidates.get(candidate)!;
  const transport =
    stored.descriptor.transport === 'unclassified' ? row?.transport : stored.descriptor.transport;
  if (
    !transport ||
    !Array.isArray(context.supported_transports) ||
    !context.supported_transports.includes(transport) ||
    (stored.descriptor.transport === 'unclassified' &&
      transport !==
        (candidate.binding.target.profile === 'host' ? 'host_stdio_proxy' : 'single_request_rpc'))
  )
    reject('unsupported_transport');
  if (
    candidate.kind === 'control' &&
    (!stored.stream ||
      !Array.isArray(context.supported_control_actions) ||
      !context.supported_control_actions.includes(candidate.action))
  )
    reject('unsupported_stream_feature');
}
function checkPolicies(
  candidate: DispatchCandidate,
  context: DispatchAuthorization,
  row: SafetyClassification,
): void {
  const stored = candidates.get(candidate)!;
  const capabilities = views.get(stored.view)!.capabilities;
  if (capabilities.access !== undefined) {
    const access = object(capabilities.access);
    if (
      !Array.isArray(access.allowed_methods) ||
      !access.allowed_methods.includes(candidate.method)
    )
      reject('forbidden', 'native_access');
  }
  for (const policy of [context.caller_policy, context.local_policy]) {
    if (
      !policy ||
      typeof policy.host !== 'boolean' ||
      ['machines', 'sessions', 'methods'].some((key) => {
        const items = (policy as unknown as Record<string, unknown>)[key];
        return (
          !Array.isArray(items) ||
          !items.every((item) => typeof item === 'string' && item.length > 0) ||
          new Set(items).size !== items.length
        );
      })
    )
      reject('invalid_authorization_context');
  }
  if (
    context.supported_control_actions !== undefined &&
    (!Array.isArray(context.supported_control_actions) ||
      !context.supported_control_actions.every((action) => typeof action === 'string'))
  )
    reject('invalid_authorization_context');
  try {
    authorize(
      candidate.binding.target,
      candidate.method,
      context.caller_policy,
      context.local_policy,
    );
  } catch {
    reject('forbidden', 'policy');
  }
  if (row.requires_owner && context.owner !== true) reject('forbidden', 'owner_required');
  if (!Array.isArray(context.permissions)) reject('invalid_authorization_context');
  if (row.management_permission && !context.permissions.includes(row.management_permission))
    reject('management_forbidden');
  if (row.confirmation_required && context.confirmation_verified !== true)
    reject('confirmation_required');
}
function checkSecret(context: DispatchAuthorization, row: SafetyClassification): void {
  if (
    (row.result.boundary === 'protected_secret' && context.result_channel !== 'custody') ||
    (context.result_channel === 'custody' && context.custody_available !== true)
  )
    reject('secret_boundary_required');
  if (!['ordinary', 'custody'].includes(context.result_channel))
    reject('invalid_authorization_context');
}
function checkRaw(candidate: DispatchCandidate, context: DispatchAuthorization): void {
  const grant = context.raw_grant;
  if (
    context.owner !== true ||
    context.raw_requested !== true ||
    !grant ||
    grant.source_verified !== true ||
    typeof grant.id !== 'string' ||
    !grant.id.length ||
    Object.keys(grant).some(
      (key) =>
        ![
          'id',
          'source_verified',
          'principal_id',
          'binding',
          'methods',
          'actions',
          'expires_at',
        ].includes(key),
    )
  )
    reject('raw_contract_not_authorized');
  if (
    grant.principal_id !== context.principal_id ||
    !Array.isArray(grant.methods) ||
    !grant.methods.includes(candidate.method) ||
    (candidate.kind === 'control' &&
      (!Array.isArray(grant.actions) || !grant.actions.includes(candidate.action))) ||
    !equal(grant.binding?.target, candidate.binding.target)
  ) {
    reject('raw_contract_scope_mismatch');
  }
  if (!Number.isSafeInteger(grant.expires_at) || grant.expires_at <= context.now)
    reject('raw_contract_grant_expired');
  if (!equal(grant.binding, candidate.binding)) reject('raw_contract_grant_stale');
}

export function checkDispatch(
  candidate: DispatchCandidate,
  input: DispatchAuthorization,
): Check<DispatchPermit> {
  return attempt('authorization', () => {
    const context = checkedAuthorization(candidate, input);
    const row = classification(candidate, context);
    checkTransport(candidate, context, row);
    checkPolicies(candidate, context, row);
    checkSecret(context, row);
    if (context.mode === 'strict') {
      if (candidate.validation === 'generic') reject('parameter_schema_incomplete');
      if (candidate.validation === 'unavailable') reject('schema_unavailable');
    } else if (context.mode === 'raw_contract') {
      checkRaw(candidate, context);
    } else reject('invalid_execution_mode');
    const permit: DispatchPermit = Object.freeze({
      kind: 'permit',
      binding: candidate.binding,
      method: candidate.method,
      mode: context.mode,
      validation: candidate.validation,
      classification_revision: row.revision,
      ...(context.mode === 'raw_contract' ? { raw_grant_id: context.raw_grant!.id } : {}),
    });
    permits.set(permit, {
      candidate,
      principal: context.principal_id,
      classification: row,
      supportedActions: Object.freeze([...(context.supported_control_actions ?? [])]),
    });
    return permit;
  });
}

export function inspectRequestGate(
  candidate: DispatchCandidate,
  input: DispatchAuthorization,
): Check<NativeRequestGate> {
  return attempt('request_gate', () => {
    const context = checkedAuthorization(candidate, input);
    let row: SafetyClassification | undefined;
    let classification_status: NativeRequestGate['classification_status'] = 'trusted_complete';
    try {
      row = classification(candidate, context);
    } catch (error) {
      if (!(error instanceof ContractFault)) throw error;
      const status = error.failure.code.replace('safety_classification_', '');
      if (!['missing', 'unknown', 'invalid', 'untrusted'].includes(status)) throw error;
      classification_status = status as NativeRequestGate['classification_status'];
    }
    return Object.freeze({
      classification_status,
      schema_status:
        candidate.validation === 'schema'
          ? 'complete'
          : candidate.validation === 'generic'
            ? 'incomplete'
            : 'unavailable',
      transport_status: attempt('transport_gate', () => checkTransport(candidate, context, row)).ok
        ? 'supported'
        : 'unsupported',
      authorized: !!row && attempt('policy_gate', () => checkPolicies(candidate, context, row!)).ok,
      secret_result_authorized:
        !!row && attempt('secret_gate', () => checkSecret(context, row!)).ok,
      raw_contract_authorized:
        context.mode === 'raw_contract' &&
        attempt('raw_gate', () => checkRaw(candidate, context)).ok,
    });
  });
}

export function checkResultBoundary(
  permit: DispatchPermit,
  input: ResultAuthorization,
): Check<void> {
  return attempt('result', () => {
    const stored = permits.get(permit);
    if (!stored) reject('invalid_permit_handle');
    const context = snapshot(input) as unknown as ResultAuthorization;
    if (context.classification_source_verified !== true) reject('safety_classification_untrusted');
    if (context.classification_revision !== stored.classification.revision)
      reject('capability_stale');
    if (
      stored.principal !== context.principal_id ||
      context.caller_policy_allowed !== true ||
      context.local_policy_allowed !== true
    )
      reject('forbidden');
    if (
      stored.classification.result.boundary === 'protected_secret' &&
      context.channel !== 'custody'
    )
      reject('secret_boundary_required');
    if (!['ordinary', 'custody'].includes(context.channel)) reject('invalid_authorization_context');
    if (context.content_status !== 'available') reject('content_unavailable');
  });
}

// 保留门禁独立于读取；同时服从派发时和当前可信分类，不能用新分类复活禁存原文。
export function checkResultRetention(
  permit: DispatchPermit,
  input: DispatchAuthorization,
): Check<void> {
  return attempt('result', () => {
    const stored = permits.get(permit);
    if (!stored) reject('invalid_permit_handle');
    const context = checkedAuthorization(stored.candidate, input);
    const current = classification(stored.candidate, context);
    if (stored.principal !== context.principal_id) reject('forbidden');
    if (
      stored.classification.result.retention !== 'caller_policy' ||
      current.result.retention !== 'caller_policy'
    ) {
      reject('content_retention_forbidden');
    }
  });
}
