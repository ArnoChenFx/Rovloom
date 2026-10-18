import { fields, object, uint, fail, id } from './validation.js';
import type { Capability, Negotiated, VersionOffer } from './types.js';

export const WIRE_MAJOR = 1;
export const WIRE_MINOR = 0;
// 1.0 中的可选能力仍须双方明确广告；较高 minor 不能隐式启用它们。
const CAPABILITIES: Readonly<Record<Capability, number>> = Object.freeze({ rpc: 0, history_scope: 0,
  late_evidence: 0, objects: 0, events: 0, terminal_observe: 0, terminal_control: 0 });
export function validateOffer(value: unknown): asserts value is VersionOffer {
  const v = object(value); fields(v, ['major', 'minor', 'capabilities', 'required']);
  uint(v.major, true); uint(v.minor);
  for (const list of [v.capabilities, v.required]) {
    if (!Array.isArray(list) || list.length > 64 || new Set(list).size !== list.length) fail('invalid_capabilities');
    list.forEach(id);
  }
  if ((v.required as string[]).some(c => !(v.capabilities as string[]).includes(c))) fail('invalid_capabilities');
}
export function negotiate(local: VersionOffer, remote: VersionOffer): Negotiated {
  validateOffer(local); validateOffer(remote);
  if (local.major !== WIRE_MAJOR || remote.major !== local.major) fail('protocol_major_unsupported');
  const minor = Math.min(local.minor, remote.minor, WIRE_MINOR);
  const capabilities = (Object.keys(CAPABILITIES) as Capability[]).filter(c =>
    CAPABILITIES[c] <= minor && local.capabilities.includes(c) && remote.capabilities.includes(c)).sort();
  if ([...local.required, ...remote.required].some(c => !capabilities.includes(c as Capability))) fail('required_capability_unsupported');
  const result = { major: WIRE_MAJOR, minor, capabilities };
  validateNegotiated(result);
  return result;
}
export function validateNegotiated(value: unknown, offer?: VersionOffer): asserts value is Negotiated {
  const v = object(value); fields(v, ['major', 'minor', 'capabilities']);
  uint(v.major, true); uint(v.minor);
  if (v.major !== WIRE_MAJOR || (v.minor as number) > WIRE_MINOR) fail('protocol_version_unsupported');
  if (!Array.isArray(v.capabilities) || v.capabilities.length > 64 || new Set(v.capabilities).size !== v.capabilities.length) fail('invalid_capabilities');
  if (v.capabilities.some(c => !Object.hasOwn(CAPABILITIES, c) || CAPABILITIES[c as Capability] > (v.minor as number))) fail('unsupported_capability');
  if (offer) {
    validateOffer(offer);
    if (offer.major !== v.major || (v.minor as number) > offer.minor ||
      v.capabilities.some(c => !offer.capabilities.includes(c)) || offer.required.some(c => !(v.capabilities as string[]).includes(c))) fail('invalid_negotiation');
  }
  if (v.capabilities.includes('terminal_control') && !v.capabilities.includes('terminal_observe')) fail('invalid_capabilities');
}
