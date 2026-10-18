import type {
  AttemptBinding,
  AuthenticatedContext,
  ContractSource,
  NativePayloadValidator,
  ProviderAction,
  ProviderBinding,
  ProviderPolicies,
  V2Target,
} from './types.js';
import {
  boundedJson,
  fail,
  fields,
  hash,
  id,
  object,
  oneOf,
  sha,
  text,
  uint,
} from './validation.js';

export function validateTarget(value: unknown): asserts value is V2Target {
  const t = object(value);
  oneOf(t.profile, ['host', 'session']);
  fields(
    t,
    t.profile === 'host'
      ? ['machine_id', 'provider_id', 'profile']
      : ['machine_id', 'provider_id', 'profile', 'session'],
  );
  id(t.machine_id);
  id(t.provider_id);
  if (t.profile === 'session') text(t.session, 256);
}
export function validateProvider(value: unknown): asserts value is ProviderBinding {
  const b = object(value);
  fields(b, ['machine_id', 'provider_id', 'kind', 'config_ref', 'binding_revision', 'enabled']);
  id(b.machine_id);
  id(b.provider_id);
  text(b.config_ref, 256);
  uint(b.binding_revision, true);
  oneOf(b.kind, ['luvus', 'herdr']);
  if (typeof b.enabled !== 'boolean') fail('invalid_provider_binding');
}
export function validateContractSource(value: unknown): asserts value is ContractSource {
  const c = object(value);
  fields(c, [
    'provider_kind',
    'protocol_family',
    'binary_version',
    'binary_sha256',
    'schema_sha256',
    'schema_origin',
    'schema_command',
    'server_version',
    'native_protocol_version',
    'runtime_generation',
    'adapter_revision',
    'classification_revision',
    'support_basis',
  ]);
  oneOf(c.provider_kind, ['luvus', 'herdr']);
  oneOf(c.protocol_family, ['uhp', 'herdr-json']);
  oneOf(c.schema_origin, ['installed_cli']);
  oneOf(c.schema_command, ['luvus uhp schema', 'herdr api schema --json']);
  oneOf(c.support_basis, ['live_catalog', 'schema_and_version']);
  text(c.binary_version, 128);
  sha(c.binary_sha256);
  sha(c.schema_sha256);
  text(c.adapter_revision, 256);
  for (const k of [
    'server_version',
    'native_protocol_version',
    'runtime_generation',
    'classification_revision',
  ]) {
    if (c[k] !== null) text(c[k], 256);
  }
  if (
    (c.provider_kind === 'luvus' &&
      (c.protocol_family !== 'uhp' || c.schema_command !== 'luvus uhp schema')) ||
    (c.provider_kind === 'herdr' &&
      (c.protocol_family !== 'herdr-json' || c.schema_command !== 'herdr api schema --json'))
  )
    fail('contract_provider_mismatch');
}
export function contractRef(source: ContractSource): string {
  validateContractSource(source);
  return hash(boundedJson(source));
}
export function providerFor(binding: AttemptBinding, ctx: AuthenticatedContext): ProviderBinding {
  const b = ctx.resolveProvider?.(binding.target);
  if (!b) fail('provider_binding_unavailable');
  validateProvider(b);
  if (b.machine_id !== binding.machine_id || b.provider_id !== binding.target.provider_id)
    fail('provider_binding_mismatch');
  if (!b.enabled) fail('provider_disabled');
  if (b.kind !== binding.provider_kind || b.binding_revision !== binding.binding_revision)
    fail('provider_binding_mismatch');
  if (b.kind === 'herdr' && binding.target.profile === 'host') fail('unsupported_profile');
  const c = ctx.resolveContract?.(binding.contract_ref);
  if (!c) fail('contract_unavailable');
  fields(object(c), ['source', 'support_status']);
  validateContractSource(c.source);
  oneOf(c.support_status, ['candidate', 'validated']);
  if (contractRef(c.source) !== binding.contract_ref || c.source.provider_kind !== b.kind)
    fail('contract_binding_mismatch');
  // Herdr 还没有本项目 P0；不能由测试/广告/存在 schema 把 candidate 提升为实际支持。
  if (b.kind === 'herdr' || c.support_status !== 'validated') fail('provider_support_candidate');
  if (c.source.classification_revision === null || c.source.support_basis !== 'live_catalog')
    fail('contract_unavailable');
  return b;
}
export function validatorFor(
  binding: AttemptBinding,
  ctx: AuthenticatedContext,
): NativePayloadValidator {
  const provider = providerFor(binding, ctx),
    validator = ctx.validators?.[provider.kind];
  if (!validator) fail('native_validator_unavailable');
  return validator;
}
export function validatePolicies(policies: ProviderPolicies): void {
  const pair = object(policies);
  fields(pair, ['caller', 'local']);
  for (const side of [policies.caller, policies.local]) {
    fields(object(side), ['revision', 'grants']);
    id(side.revision);
    if (!Array.isArray(side.grants) || side.grants.length > 4096) fail('invalid_provider_policy');
    for (const grant of side.grants) {
      fields(object(grant), ['target', 'methods', 'actions']);
      validateTarget(grant.target);
      if (
        !Array.isArray(grant.methods) ||
        grant.methods.length > 256 ||
        !Array.isArray(grant.actions) ||
        grant.actions.length > 4 ||
        new Set(grant.methods).size !== grant.methods.length ||
        new Set(grant.actions).size !== grant.actions.length
      )
        fail('invalid_provider_policy');
      grant.methods.forEach((m) => text(m, 256));
      grant.actions.forEach((a) => oneOf(a, ['dispatch', 'read', 'stream_input', 'cancel']));
    }
  }
}
export function providerScopeAllowed(
  binding: AttemptBinding,
  method: string,
  action: ProviderAction,
  policies?: ProviderPolicies,
): boolean {
  if (!policies) return false;
  validatePolicies(policies);
  const target = boundedJson(binding.target);
  return [policies.caller, policies.local].every((side) =>
    side.grants.some(
      (g) =>
        boundedJson(g.target) === target &&
        g.methods.includes(method) &&
        g.actions.includes(action),
    ),
  );
}
export function assertProviderAccess(
  binding: AttemptBinding,
  method: string,
  action: ProviderAction,
  ctx: AuthenticatedContext,
): void {
  providerFor(binding, ctx);
  if (!providerScopeAllowed(binding, method, action, ctx.policies))
    fail('provider_scope_forbidden');
}
