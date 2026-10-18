import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { AnySchema } from 'ajv';
import type { AttemptBinding, AttemptIdentity, AuthenticatedEnvelope, CodecContext,
  NativePayloadValidator, RequestGate, VersionOffer, StreamFeature } from '../../src/wire/types.js';
import { WireError } from '../../src/wire/validation.js';

export const bundle = JSON.parse(readFileSync(new URL('../../fixtures/p0/linux-luvus-0.14.3/schema-bundle.json', import.meta.url), 'utf8'));
export const transcript: Record<string, any>[] = JSON.parse(readFileSync(new URL('../../fixtures/p0/linux-luvus-0.14.3/transcript.json', import.meta.url), 'utf8'));
export const ajv = new Ajv2020({ strict: false, allErrors: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
for (const [url, schema] of Object.entries(bundle.documents)) ajv.addSchema(schema as AnySchema, url);
for (const url of Object.keys(bundle.documents)) assert(ajv.getSchema(url));
export const nativeRequest = ajv.getSchema(bundle.request.$id)!;
export const nativeResponse = ajv.getSchema(bundle.response.$id)!;
export const nativeControl = ajv.getSchema(bundle.terminal.control_frame.$id)!;
export const nativeTerminalResponse = ajv.getSchema(bundle.terminal.response.$id)!;
export const nativeEvent = ajv.getSchema(bundle.event.$id)!;
export const terminalEvent = ajv.getSchema(bundle.terminal.event.$id)!;
const catalog = new Map(Object.keys(bundle.event_catalog.properties).map(name => [name,
  ajv.compile({ $ref: `${bundle.event_catalog.$id}#/properties/${name}` })]));
// 这是固定 P0 schema 的测试注入器，不是生产安全分类表或原生模块的替代品。
export const allowedGate: RequestGate = { classification_status: 'trusted_complete', schema_status: 'complete',
  transport_status: 'supported', authorized: true, secret_result_authorized: true, raw_contract_authorized: false };
export function fixtureValidator(gate: RequestGate = allowedGate): NativePayloadValidator {
  return {
    requestGate: () => ({ ...gate }),
    validateRequest(r) { if (!nativeRequest(r)) throw new WireError('native_request_invalid'); },
    validateResponse(r) { if (!nativeResponse(r)) throw new WireError('native_response_invalid'); },
    validateStreamFrame(r, context) {
      const valid = context.direction === 'input' ? nativeControl(r) :
        Object.hasOwn(r, 'id') ? nativeResponse(r) && nativeTerminalResponse(r) :
          r.event === 'terminal.frame' ? terminalEvent(r) : nativeEvent(r) && catalog.get(r.event as string)?.(r.data);
      if (!valid) throw new WireError('native_stream_frame_invalid');
    },
  };
}
export const identity = { machine_id: 'machine_1', recovery_generation: 'recovery_1', connection_epoch: 'connection_1' };
export const attempt: AttemptIdentity = { call_id: 'call_1', attempt_id: 'attempt_1', native_request_id: 'proxy-ping',
  target: { machine_id: identity.machine_id, profile: 'session', session: 'p0-issue3' },
  contract_revision: 'review_1', contract_digest: 'a'.repeat(64) };
export const binding: AttemptBinding = { ...identity, ...attempt };
export const offer: VersionOffer = { major: 1, minor: 0, capabilities: ['rpc', 'history_scope', 'late_evidence', 'objects',
  'events', 'terminal_observe', 'terminal_control'], required: ['rpc'] };
export function context(direction: 'gateway_to_connector' | 'connector_to_gateway' = 'gateway_to_connector',
  native = fixtureValidator(), anchor = binding, method = 'ping', transport: 'rpc' | 'stream' = 'rpc',
  feature?: StreamFeature): Extract<CodecContext, { phase: 'authenticated' }> {
  return { phase: 'authenticated', direction, connection: { ...identity, authenticated: true, active: true,
    negotiated: { major: 1, minor: 0, capabilities: [...offer.capabilities] as any } }, native,
    resolveAttempt: () => ({ binding: anchor, method, mode: 'strict', transport, feature }) };
}
export function frame<K extends AuthenticatedEnvelope['type']>(type: K,
  payload: Extract<AuthenticatedEnvelope, { type: K }>['payload']): Extract<AuthenticatedEnvelope, { type: K }> {
  return { protocol_major: 1, protocol_minor: 0, type, message_id: 'message_1', ...identity, payload } as any;
}
export const request = frame('request', { attempt, uhp_request: { id: 'proxy-ping', method: 'ping', params: {} },
  deadline: 1000, validation: 'strict', history: { history_epoch: 'history_1', client_request_key: 'key_1' } });
export const ping = JSON.parse(transcript.find(v => v.label === 'proxy-ping')!.stdout);
export const response = frame('response', { attempt, uhp_response: ping });
export function rejects(action: () => unknown, code: string): void {
  assert.throws(action, (e: unknown) => e instanceof Error && 'code' in e && e.code === code, code);
}
