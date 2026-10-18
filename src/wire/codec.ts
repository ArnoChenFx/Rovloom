import type {
  AttemptBinding,
  AttemptIdentity,
  AuthenticatedEnvelope,
  CodecContext,
  JsonObject,
  NativeValidationContext,
  RequestGate,
  WireEnvelope,
} from './types.js';
import {
  boundedJson,
  fields,
  object,
  id,
  uint,
  sha,
  text,
  oneOf,
  fail,
  parseJson,
  LIMITS,
} from './validation.js';
import { validateNegotiated, validateOffer, WIRE_MAJOR } from './negotiation.js';
import { assertProviderAccess, providerFor, validateTarget, validatorFor } from './provider.js';

const BASE = ['protocol_major', 'protocol_minor', 'type', 'message_id', 'payload'];
const CONNECTION = ['machine_id', 'recovery_generation', 'connection_epoch'];
const ATTEMPT = [
  'call_id',
  'attempt_id',
  'native_request_id',
  'target',
  'provider_kind',
  'binding_revision',
  'contract_ref',
  'registration',
];
const REQUEST = ['attempt', 'expected_binding_revision', 'native_request', 'validation'];
const STREAM = ['events', 'terminal_observe', 'terminal_control'] as const;
const DIRECTIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  enroll: ['connector_to_gateway'],
  authenticate: ['connector_to_gateway'],
  welcome: ['gateway_to_connector'],
  request: ['gateway_to_connector'],
  accepted: ['connector_to_gateway'],
  response: ['connector_to_gateway'],
  cancel: ['gateway_to_connector'],
  heartbeat: ['gateway_to_connector', 'connector_to_gateway'],
  stream_open: ['gateway_to_connector'],
  stream_data: ['connector_to_gateway'],
  stream_input: ['gateway_to_connector'],
  stream_close: ['gateway_to_connector', 'connector_to_gateway'],
  error: ['gateway_to_connector', 'connector_to_gateway'],
  object_chunk: ['gateway_to_connector', 'connector_to_gateway'],
});
function connection(v: JsonObject): void {
  for (const k of CONNECTION) id(v[k]);
}
export function validateAttempt(value: unknown): asserts value is AttemptIdentity {
  const a = object(value);
  fields(a, ATTEMPT);
  for (const k of ['call_id', 'attempt_id']) id(a[k]);
  if (
    typeof a.native_request_id !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(a.native_request_id)
  )
    fail('invalid_native_id');
  sha(a.contract_ref);
  uint(a.binding_revision, true);
  oneOf(a.provider_kind, ['luvus', 'herdr']);
  validateTarget(a.target);
  const r = object(a.registration);
  fields(r, ['deadline', 'history', 'caller_policy_revision', 'local_policy_revision']);
  uint(r.deadline, true);
  id(r.caller_policy_revision);
  id(r.local_policy_revision);
  if (r.history !== null) {
    const h = object(r.history);
    fields(h, ['history_epoch', 'client_request_key']);
    id(h.history_epoch);
    id(h.client_request_key);
  }
}
function pickAttempt(a: AttemptBinding): AttemptIdentity {
  return {
    call_id: a.call_id,
    attempt_id: a.attempt_id,
    native_request_id: a.native_request_id,
    target: a.target,
    provider_kind: a.provider_kind,
    binding_revision: a.binding_revision,
    contract_ref: a.contract_ref,
    registration: a.registration,
  };
}
export function assertBinding(actual: AttemptBinding, expected: AttemptBinding): void {
  connection(object(actual));
  connection(object(expected));
  validateAttempt(pickAttempt(actual));
  validateAttempt(pickAttempt(expected));
  if (
    CONNECTION.some(
      (k) => actual[k as keyof AttemptBinding] !== expected[k as keyof AttemptBinding],
    ) ||
    boundedJson(pickAttempt(actual)) !== boundedJson(pickAttempt(expected))
  )
    fail('attempt_binding_mismatch');
}
function bind(frame: JsonObject, attempt: unknown): AttemptBinding {
  validateAttempt(attempt);
  if (attempt.target.machine_id !== frame.machine_id) fail('target_machine_mismatch');
  return {
    machine_id: frame.machine_id as string,
    recovery_generation: frame.recovery_generation as string,
    connection_epoch: frame.connection_epoch as string,
    ...attempt,
  };
}
function errorPayload(p: JsonObject): void {
  fields(p, ['source', 'code', 'retryable'], ['cause_message_id']);
  oneOf(p.source, ['gateway', 'transport']);
  if (
    typeof p.code !== 'string' ||
    !/^[a-z][a-z0-9_]{0,63}$/.test(p.code) ||
    typeof p.retryable !== 'boolean'
  )
    fail('invalid_error');
  if (Object.hasOwn(p, 'cause_message_id')) id(p.cause_message_id);
}
function gate(g: RequestGate, mode: 'strict' | 'raw-contract'): void {
  if (!g || typeof g !== 'object' || g.classification_status !== 'trusted_complete')
    fail('classification_unavailable');
  const p = object(g);
  if (!['complete', 'generic', 'unavailable'].includes(p.schema_status as string))
    fail('parameter_schema_unavailable');
  fields(p, [
    'classification_status',
    'schema_status',
    'transport_status',
    'authorized',
    'secret_result_authorized',
    'raw_contract_authorized',
  ]);
  oneOf(p.classification_status, [
    'trusted_complete',
    'missing',
    'unknown',
    'invalid',
    'untrusted',
  ]);
  oneOf(p.schema_status, ['complete', 'generic', 'unavailable']);
  oneOf(p.transport_status, ['supported', 'unsupported']);
  for (const k of ['authorized', 'secret_result_authorized', 'raw_contract_authorized'])
    if (typeof p[k] !== 'boolean') fail('invalid_native_gate');
  if (p.transport_status !== 'supported') fail('unsupported_transport');
  if (p.authorized !== true || p.secret_result_authorized !== true) fail('forbidden');
  if (mode === 'raw-contract' && p.raw_contract_authorized !== true) fail('raw_contract_forbidden');
  if (mode === 'strict' && p.schema_status !== 'complete') {
    fail(
      p.schema_status === 'generic'
        ? 'parameter_schema_incomplete'
        : 'parameter_schema_unavailable',
    );
  }
}
type AuthContext = Extract<CodecContext, { phase: 'authenticated' }>;
function nativeCall<T>(fn: () => T, fallback: string): T {
  try {
    return fn();
  } catch (e) {
    const code = e && typeof e === 'object' && 'code' in e ? e.code : undefined;
    fail(typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : fallback);
  }
}
function nativeVoid(fn: () => void, fallback: string): void {
  if (nativeCall(fn, fallback) !== undefined) fail('invalid_native_validator_result');
}
function anchored(frame: JsonObject, p: JsonObject, ctx: AuthContext): NativeValidationContext {
  const binding = bind(frame, p.attempt);
  const anchor = ctx.resolveAttempt?.(p.attempt as AttemptIdentity);
  if (!anchor) fail('attempt_anchor_unavailable');
  assertBinding(binding, anchor.binding);
  providerFor(binding, ctx);
  text(anchor.method, 256);
  oneOf(anchor.mode, ['strict', 'raw-contract']);
  oneOf(anchor.transport, ['rpc', 'stream']);
  if (binding.registration.history !== null) capability(ctx, 'history_scope');
  if (anchor.transport === 'stream') {
    oneOf(anchor.feature, STREAM);
    capability(ctx, anchor.feature);
    id(anchor.stream_id);
  } else {
    if (anchor.feature !== undefined) fail('attempt_transport_mismatch');
    capability(ctx, 'rpc');
  }
  return {
    binding,
    method: anchor.method,
    mode: anchor.mode,
    transport: anchor.transport,
    ...(anchor.feature === undefined ? {} : { feature: anchor.feature }),
    ...(anchor.stream_id === undefined ? {} : { stream_id: anchor.stream_id }),
    native_handle: anchor.native_handle,
  };
}
function nativeContext(n: NativeValidationContext, ctx: AuthContext): NativeValidationContext {
  if (n.native_handle === undefined || n.native_handle === null) fail('native_handle_unavailable');
  const source = ctx.resolveNativeSource?.(n.binding);
  if (source === undefined || source === null) fail('native_source_unavailable');
  return { ...n, trusted_source: source };
}
function request(frame: JsonObject, p: JsonObject, ctx: AuthContext, stream: boolean): void {
  fields(p, stream ? [...REQUEST, 'stream_id', 'feature'] : REQUEST);
  const r = object(p.native_request);
  if (Object.hasOwn(r, 'auth') || Object.hasOwn(r, 'id')) fail('reserved_request_field');
  const n = anchored(frame, p, ctx);
  uint(p.expected_binding_revision, true);
  if (p.expected_binding_revision !== n.binding.binding_revision) fail('provider_binding_mismatch');
  oneOf(p.validation, ['strict', 'raw-contract']);
  text(r.method, 256);
  if (r.method !== n.method || p.validation !== n.mode) fail('attempt_binding_mismatch');
  if (stream) {
    id(p.stream_id);
    streamFeature(p, ctx);
    if (p.stream_id !== n.stream_id) fail('stream_binding_mismatch');
  }
  if (n.transport !== (stream ? 'stream' : 'rpc') || (stream && n.feature !== p.feature))
    fail('attempt_transport_mismatch');
  assertProviderAccess(n.binding, n.method, 'dispatch', ctx);
  if (
    ctx.policies!.caller.revision !== n.binding.registration.caller_policy_revision ||
    ctx.policies!.local.revision !== n.binding.registration.local_policy_revision
  )
    fail('policy_revision_stale');
  const validator = validatorFor(n.binding, ctx),
    full = { ...r, id: n.binding.native_request_id };
  gate(
    nativeCall(() => validator.requestGate(full, n), 'native_gate_failed'),
    p.validation,
  );
  nativeVoid(() => validator.validateRequest(full, n), 'native_request_invalid');
}
function capability(ctx: AuthContext, name: string): void {
  if (!(ctx.connection.negotiated.capabilities as string[]).includes(name))
    fail('unsupported_capability');
}
function streamFeature(p: JsonObject, ctx: AuthContext): void {
  oneOf(p.feature, STREAM);
  capability(ctx, p.feature);
}

// context 是受信外部输入；逐帧检查 active/epoch 不代替 TLS、认证或撤销查询。
function decode(input: string | Uint8Array, context: CodecContext, limit: number): WireEnvelope {
  const frame = object(parseJson(input, limit));
  id(frame.message_id);
  uint(frame.protocol_major, true);
  uint(frame.protocol_minor);
  if (typeof frame.type !== 'string' || !Object.hasOwn(DIRECTIONS, frame.type))
    fail('unsupported_frame_type');
  if (!DIRECTIONS[frame.type]!.includes(context.direction)) fail('wrong_direction');
  if (frame.protocol_major !== WIRE_MAJOR) fail('protocol_major_unsupported');
  const p = object(frame.payload);
  if (context.phase === 'preauth') {
    fields(frame, BASE);
    if (frame.type === 'enroll' || frame.type === 'authenticate') {
      const enroll = frame.type === 'enroll';
      fields(
        p,
        enroll
          ? ['registration_id', 'connector_instance_id', 'enrollment_credential', 'offer']
          : [
              'machine_id',
              'recovery_generation',
              'connector_instance_id',
              'device_credential',
              'offer',
            ],
      );
      id(p.connector_instance_id);
      if (enroll) id(p.registration_id);
      else {
        id(p.machine_id);
        id(p.recovery_generation);
      }
      text(p[enroll ? 'enrollment_credential' : 'device_credential'], 4096);
      validateOffer(p.offer);
      if (p.offer.major !== frame.protocol_major || p.offer.minor !== frame.protocol_minor)
        fail('invalid_negotiation');
    } else if (frame.type === 'welcome') {
      fields(p, [...CONNECTION, 'in_reply_to', 'selected']);
      connection(p);
      id(p.in_reply_to);
      if (!context.offer || !context.handshake_message_id) fail('handshake_context_required');
      if (p.in_reply_to !== context.handshake_message_id) fail('handshake_mismatch');
      validateNegotiated(p.selected, context.offer);
      if (p.selected.major !== frame.protocol_major || p.selected.minor !== frame.protocol_minor)
        fail('invalid_negotiation');
    } else if (frame.type === 'error') errorPayload(p);
    else fail('authentication_required');
    return frame as PreAuthResult;
  }
  if (
    context.phase !== 'authenticated' ||
    context.connection?.authenticated !== true ||
    context.connection.active !== true
  )
    fail('authentication_required');
  fields(frame, [...BASE, ...CONNECTION]);
  connection(frame);
  connection(object(context.connection));
  validateNegotiated(context.connection.negotiated);
  if (
    frame.protocol_minor !== context.connection.negotiated.minor ||
    frame.protocol_major !== context.connection.negotiated.major
  )
    fail('protocol_version_unsupported');
  if (CONNECTION.some((k) => frame[k] !== context.connection[k as keyof typeof context.connection]))
    fail('connection_binding_mismatch');
  switch (frame.type) {
    case 'request':
      capability(context, 'rpc');
      request(frame, p, context, false);
      break;
    case 'stream_open':
      request(frame, p, context, true);
      break;
    case 'heartbeat':
      fields(p, ['sequence']);
      uint(p.sequence);
      break;
    case 'error':
      errorPayload(p);
      break;
    case 'object_chunk':
      capability(context, 'objects');
      fields(p, ['object_id', 'kind', 'total_bytes', 'sha256', 'chunk_count', 'index', 'data']);
      id(p.object_id);
      oneOf(p.kind, ['envelope', 'schema_bundle']);
      sha(p.sha256);
      uint(p.total_bytes, true);
      uint(p.chunk_count, true);
      uint(p.index);
      if (p.kind === 'schema_bundle' && context.direction !== 'connector_to_gateway')
        fail('wrong_direction');
      if (
        p.total_bytes >
          (p.kind === 'schema_bundle' ? LIMITS.schema_bundle_bytes : LIMITS.object_bytes) ||
        p.chunk_count !== Math.ceil(p.total_bytes / LIMITS.chunk_bytes) ||
        p.index >= p.chunk_count
      )
        fail('object_limit', 'transport');
      if (
        typeof p.data !== 'string' ||
        p.data.length > 4 * Math.ceil(LIMITS.chunk_bytes / 3) ||
        Buffer.from(p.data, 'base64').toString('base64') !== p.data
      )
        fail('invalid_chunk', 'transport');
      if (
        Buffer.from(p.data, 'base64').length !==
        Math.min(LIMITS.chunk_bytes, p.total_bytes - p.index * LIMITS.chunk_bytes)
      )
        fail('invalid_chunk', 'transport');
      break;
    case 'accepted':
      fields(p, ['attempt']);
      anchored(frame, p, context);
      break;
    case 'cancel': {
      fields(p, ['attempt', 'reason']);
      oneOf(p.reason, ['caller_cancelled', 'deadline_exceeded']);
      const n = anchored(frame, p, context);
      assertProviderAccess(n.binding, n.method, 'cancel', context);
      break;
    }
    case 'response': {
      fields(p, ['attempt', 'native_response']);
      const n = nativeContext(anchored(frame, p, context), context),
        r = object(p.native_response);
      if (n.transport !== 'rpc') fail('attempt_transport_mismatch');
      const validator = validatorFor(n.binding, context);
      nativeVoid(() => validator.validateResponse(r, n), 'native_response_invalid');
      break;
    }
    case 'stream_data':
    case 'stream_input': {
      fields(p, ['attempt', 'stream_id', 'feature', 'sequence', 'frame']);
      id(p.stream_id);
      uint(p.sequence);
      streamFeature(p, context);
      if (frame.type === 'stream_input' && p.feature !== 'terminal_control')
        fail('unsupported_stream_input');
      const n = nativeContext(anchored(frame, p, context), context),
        r = object(p.frame);
      if (n.transport !== 'stream' || n.feature !== p.feature) fail('attempt_transport_mismatch');
      if (p.stream_id !== n.stream_id) fail('stream_binding_mismatch');
      const validator = validatorFor(n.binding, context);
      if (!validator.validateStreamFrame) fail('stream_validator_unavailable');
      if (frame.type === 'stream_input')
        assertProviderAccess(n.binding, n.method, 'stream_input', context);
      nativeVoid(
        () =>
          validator.validateStreamFrame!(r, {
            ...n,
            feature: p.feature as 'events' | 'terminal_observe' | 'terminal_control',
            direction: frame.type === 'stream_input' ? 'input' : 'data',
          }),
        'native_stream_frame_invalid',
      );
      if (frame.type === 'stream_input') {
        if (!validator.checkDispatch) fail('dispatch_validator_unavailable');
        nativeVoid(() => validator.checkDispatch!(r, n), 'native_dispatch_forbidden');
      }
      break;
    }
    case 'stream_close':
      fields(p, ['attempt', 'stream_id', 'reason']);
      id(p.stream_id);
      oneOf(p.reason, ['normal', 'cancelled', 'overflow', 'resync_required', 'transport_error']);
      {
        const n = anchored(frame, p, context);
        if (n.transport !== 'stream') fail('attempt_transport_mismatch');
        if (p.stream_id !== n.stream_id) fail('stream_binding_mismatch');
      }
      break;
    default:
      fail('handshake_after_authentication');
  }
  return frame as AuthenticatedEnvelope;
}
type PreAuthResult = Extract<
  WireEnvelope,
  { type: 'enroll' | 'authenticate' | 'welcome' | 'error' }
>;
export function encodeWireFrame(frame: WireEnvelope, context: CodecContext): string {
  const raw = boundedJson(frame);
  decodeWireFrame(raw, context);
  return raw;
}
export function decodeWireFrame(input: string | Uint8Array, context: CodecContext): WireEnvelope {
  return decode(input, context, LIMITS.frame_bytes);
}
// 仅供有界重组使用；逻辑对象仍须完整执行所有 envelope/原生/授权检查。
export function decodeWireObject(input: Uint8Array, context: CodecContext): AuthenticatedEnvelope {
  if (context.phase !== 'authenticated') fail('authentication_required');
  const result = decode(input, context, LIMITS.object_bytes);
  if (result.type === 'object_chunk') fail('nested_object', 'transport');
  return result as AuthenticatedEnvelope;
}
