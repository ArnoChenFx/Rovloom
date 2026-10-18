import { validateTarget } from '../contracts.js';
import {
  candidates,
  contracts,
  permits,
  responses,
  SCOPES,
  STREAM_METHODS,
  streams,
  UHP,
  views,
} from './internal.js';
import { attempt, equal, fail, object, snapshot, text } from './json.js';
import type {
  CapabilityView,
  Check,
  CheckedControl,
  CheckedRequest,
  CheckedResponse,
  CheckedStream,
  CompiledContract,
  DispatchCandidate,
  DispatchPermit,
  JsonObject,
  MethodDescriptor,
  NativeBinding,
  NativeMethodContract,
  NativeValidator,
  ParameterValidation,
  RawRequestCandidate,
  TrustedNativeContext,
} from './types.js';

function data(contract: CompiledContract) {
  const value = contracts.get(contract);
  if (!value) fail('invalid_contract_handle');
  return value;
}

export function verifySource(
  source: TrustedNativeContext,
  expected?: NativeBinding,
): NativeBinding {
  if (!source || source.authenticated !== true || source.source_verified !== true)
    fail('native_source_untrusted', 'source');
  const binding = snapshot(source.binding) as unknown as NativeBinding;
  if (binding.kind !== 'luvus') fail('native_source_untrusted', 'source', 'runtime_kind');
  if (
    !(
      typeof binding.binding_revision === 'string' &&
      binding.binding_revision.length > 0 &&
      binding.binding_revision.length <= 128
    ) &&
    !(Number.isSafeInteger(binding.binding_revision) && (binding.binding_revision as number) >= 0)
  )
    fail('invalid_context');
  if ((binding.target as unknown as JsonObject)?.profile === 'access_machines')
    fail('profile_not_exposed', 'binding');
  validateTarget(binding.target);
  for (const field of [
    'provider_id',
    'contract_source_ref',
    'connection_epoch',
    'recovery_generation',
    'capability_revision',
    'caller_policy_revision',
    'local_policy_revision',
    'classification_revision',
  ] as const) {
    if (typeof binding[field] !== 'string' || !binding[field].length || binding[field].length > 512)
      fail('invalid_context');
  }
  if (
    !binding.contract ||
    !/^[a-f0-9]{64}$/.test(binding.contract.binary_sha256) ||
    !/^[a-f0-9]{64}$/.test(binding.contract.schema_sha256) ||
    !binding.contract.revision
  )
    fail('invalid_context');
  if (
    binding.target.profile === 'session'
      ? typeof binding.server_generation !== 'string' || !binding.server_generation.length
      : binding.server_generation !== null
  )
    fail('invalid_context');
  if (expected && !equal(binding, expected)) fail('native_identity_mismatch', 'binding');
  return binding;
}

function validate(contract: CompiledContract, uri: string, value: unknown, code: string): void {
  const check = data(contract).validators.get(uri);
  if (!check) fail('schema_unavailable', 'validation', 'missing_document');
  if (!check(value)) fail(code, 'schema', check.errors?.[0]?.keyword);
}

function copy(contract: CompiledContract, value: unknown): JsonObject {
  return object(snapshot(value, data(contract).limits));
}

function viewData(contract: CompiledContract, view: CapabilityView) {
  const stored = views.get(view);
  if (!stored || stored.contract !== contract) fail('invalid_capability_handle');
  return stored;
}

function method(contract: CompiledContract, view: CapabilityView, name: string): MethodDescriptor {
  const descriptor = viewData(contract, view).methods.get(name);
  if (!descriptor)
    fail(
      name.startsWith('machine.') ? 'profile_not_exposed' : 'method_not_advertised',
      'discovery',
    );
  return descriptor;
}

function validateTerminalCapabilities(value: JsonObject): void {
  const terminal = object(value.terminal, 'capability_invalid');
  for (const key of ['capabilities', 'features']) {
    const items = terminal[key];
    if (
      !Array.isArray(items) ||
      !items.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 128) ||
      new Set(items).size !== items.length
    )
      fail('capability_invalid', 'discovery', 'terminal');
  }
  for (const source of [value.limits, terminal.limits]) {
    for (const limit of Object.values(object(source, 'capability_invalid'))) {
      if (!Number.isSafeInteger(limit) || (limit as number) < 0)
        fail('capability_invalid', 'discovery', 'limits');
    }
  }
}

function shapeCapabilities(
  value: JsonObject,
  binding: NativeBinding,
): Map<string, NativeMethodContract> {
  if (!equal(value.protocol, { name: 'luvus-uhp', major: 1, minor: 0 }))
    fail('capability_invalid', 'discovery', 'protocol');
  if (
    !Array.isArray(value.methods) ||
    !value.methods.length ||
    value.methods.length > 1024 ||
    !value.methods.every((m) => typeof m === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(m)) ||
    new Set(value.methods).size !== value.methods.length ||
    !Array.isArray(value.method_contracts) ||
    value.method_contracts.length !== value.methods.length
  )
    fail('capability_invalid', 'discovery', 'method_catalog');
  if (binding.target.profile === 'session') {
    if (
      value.type !== 'uhp_capabilities' ||
      value.session !== binding.target.session ||
      value.server_generation !== binding.server_generation
    )
      fail('capability_invalid', 'discovery', 'identity');
  } else if (
    value.type !== 'uhp_host_capabilities' ||
    value.profile !== 'host' ||
    value.transport !== 'stdio_proxy'
  ) {
    fail('capability_invalid', 'discovery', 'profile');
  }
  const result = new Map<string, NativeMethodContract>();
  for (const raw of value.method_contracts) {
    const row = object(raw, 'capability_invalid');
    if (!equal(Object.keys(row).sort(), ['access', 'idempotent', 'method', 'scope']))
      fail('capability_invalid', 'discovery', 'unknown_method_contract_field');
    if (
      typeof row.method !== 'string' ||
      !value.methods.includes(row.method) ||
      result.has(row.method) ||
      !SCOPES.has(row.scope as string) ||
      !['read', 'write'].includes(row.access as string) ||
      typeof row.idempotent !== 'boolean'
    )
      fail('capability_invalid', 'discovery', 'method_contract');
    result.set(row.method, row as unknown as NativeMethodContract);
  }
  if (value.access !== undefined) {
    const access = object(value.access, 'capability_invalid');
    const methodList = value.methods as readonly unknown[];
    if (
      !['read_only', 'control'].includes(access.mode as string) ||
      !Array.isArray(access.allowed_methods) ||
      new Set(access.allowed_methods).size !== access.allowed_methods.length ||
      !access.allowed_methods.every((m) => methodList.includes(m))
    )
      fail('capability_invalid', 'discovery', 'access');
  }
  if (binding.target.profile === 'session') validateTerminalCapabilities(value);
  return result;
}

function requestSemantics(request: JsonObject, view: CapabilityView): void {
  const params = object(request.params, 'native_request_invalid');
  for (const [methodName, field, max] of [
    ['task.add', 'title', 256],
    ['task.add', 'prompt', 32768],
    ['task.update', 'prompt', 32768],
  ] as const) {
    if (
      request.method === methodName &&
      typeof params[field] === 'string' &&
      Buffer.byteLength(params[field]) > max
    ) {
      fail('native_request_invalid', 'request', 'utf8_limit');
    }
  }
  if (
    params.server_generation !== undefined &&
    params.server_generation !== view.binding.server_generation
  ) {
    fail('native_identity_mismatch', 'request');
  }
}
const TERMINAL_RESULTS: Record<string, string> = {
  inventory: 'terminal_backend_inventory',
  snapshot: 'terminal_backend_snapshot',
  validate: 'terminal_backend_validation',
  processes: 'terminal_backend_processes',
  capture: 'terminal_backend_capture',
  observe: 'terminal_backend_stream',
  control: 'terminal_backend_stream',
  create: 'terminal_backend_created',
  wait_change: 'terminal_backend_change',
  wait_output: 'terminal_backend_output',
  'events.subscribe': 'subscription_started',
  type_literal: 'terminal_backend_action',
  paste_text: 'terminal_backend_action',
  submit_text: 'terminal_backend_action',
  send_key: 'terminal_backend_action',
  set_title: 'terminal_backend_action',
  notify: 'terminal_backend_action',
  close: 'terminal_backend_action',
};

function validateResponseResult(
  candidate: DispatchCandidate,
  terminal: boolean,
  result: JsonObject,
): void {
  const expected =
    candidate.kind === 'control'
      ? 'terminal_backend_action'
      : TERMINAL_RESULTS[candidate.method.slice('terminal.backend.'.length)];
  if (terminal && result.type !== expected) fail('native_result_mismatch', 'response');
  if (candidate.method === 'events.subscribe' && result.type !== 'subscription_started')
    fail('native_result_mismatch', 'response');
  if (
    candidate.kind !== 'control' &&
    (candidate.method === 'terminal.backend.observe' ||
      candidate.method === 'terminal.backend.control')
  ) {
    if (result.mode !== (candidate.method.endsWith('observe') ? 'observe' : 'control'))
      fail('native_result_mismatch', 'response');
  }
  if (terminal && candidate.kind !== 'control') {
    const params = object(candidate.request.params);
    for (const key of ['server_generation', 'terminal_id', 'pane_id']) {
      if (result[key] !== undefined && params[key] !== undefined && result[key] !== params[key])
        fail('native_identity_mismatch', 'response');
    }
    if (
      result.server_generation !== undefined &&
      result.server_generation !== candidate.binding.server_generation
    )
      fail('native_identity_mismatch', 'response');
  }
}

// 实时广告与离线 schema 共同决定描述信息；描述本身不授予执行权限。
function describeCapability(
  binding: NativeBinding,
  name: string,
  hint: NativeMethodContract,
  paths: readonly string[] | undefined,
): MethodDescriptor {
  let transport: MethodDescriptor['transport'] = 'unclassified';
  let schemaStatus: MethodDescriptor['schema_status'] = 'unavailable';
  if (paths) {
    if (binding.target.profile === 'host') transport = 'host_stdio_proxy';
    else transport = STREAM_METHODS.has(name) ? 'persistent_local_stream' : 'single_request_rpc';
    schemaStatus = paths.length ? 'conditional_branch' : 'generic_params_only';
  }
  return Object.freeze({
    method: name,
    profile: binding.target.profile,
    transport,
    schema_status: schemaStatus,
    branch_paths: paths ?? Object.freeze([]),
    classification_status: 'not_evaluated',
    native_contract: hint,
  });
}

function streamModeFor(method: string): CheckedStream['mode'] {
  if (method === 'events.subscribe') return 'general_events';
  if (method === 'terminal.backend.events.subscribe') return 'terminal_events';
  return method.endsWith('observe') ? 'observe' : 'control';
}

function candidateOf(context: CheckedRequest | DispatchPermit): DispatchCandidate {
  if (context.kind === 'permit') {
    const value = permits.get(context);
    if (!value) fail('invalid_permit_handle');
    return value.candidate;
  }
  if (context.kind !== 'request' || !candidates.has(context)) fail('invalid_request_handle');
  return context;
}

export function createNativeValidator(contract: CompiledContract): NativeValidator {
  data(contract);
  function responseShape(
    input: unknown,
    family: 'general' | 'terminal',
    bound: boolean,
    candidate: DispatchCandidate | null,
    permit: DispatchPermit | null = null,
  ): CheckedResponse {
    const response = copy(contract, input);
    validate(contract, `${UHP}response.schema.json`, response, 'native_response_invalid');
    if (family === 'terminal')
      validate(
        contract,
        `${UHP}schema/terminal/response.schema.json`,
        response,
        'native_response_invalid',
      );
    const result = Object.freeze({ response, identity: contract.identity, bound });
    responses.set(result, { candidate, contract, permit });
    return result;
  }
  function checkedRequest(
    view: CapabilityView,
    input: unknown,
    allowRaw: boolean,
  ): CheckedRequest | RawRequestCandidate {
    viewData(contract, view);
    const request = copy(contract, input);
    const name = text(request.method, 'native_request_invalid');
    const known = data(contract).requestMethods.includes(name);
    if (known || !allowRaw)
      validate(contract, `${UHP}request.schema.json`, request, 'native_request_invalid');
    else {
      if (
        Object.keys(request).some((k) => !['id', 'method', 'params', 'auth'].includes(k)) ||
        typeof request.id !== 'string' ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(request.id) ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(name) ||
        !request.params ||
        typeof request.params !== 'object' ||
        Array.isArray(request.params) ||
        (request.auth !== undefined &&
          (typeof request.auth !== 'string' || !/^[!-~]{1,256}$/.test(request.auth)))
      ) {
        fail('native_request_invalid', 'request', 'minimal_envelope');
      }
    }
    const descriptor = method(contract, view, name);
    requestSemantics(request, view);
    const cap = viewData(contract, view).capabilities;
    const nativeLimit =
      view.binding.target.profile === 'session' ? object(cap.limits).frame_bytes : undefined;
    if (typeof nativeLimit === 'number' && Buffer.byteLength(JSON.stringify(request)) > nativeLimit)
      fail('native_request_invalid', 'request', 'frame_limit');
    let validation: ParameterValidation = 'unavailable';
    if (descriptor.schema_status === 'conditional_branch') validation = 'schema';
    else if (descriptor.schema_status === 'generic_params_only') validation = 'generic';
    const result = Object.freeze({
      kind: validation === 'unavailable' ? 'raw_request' : 'request',
      request,
      binding: view.binding,
      method: name,
      validation,
      schema_status: descriptor.schema_status,
    }) as CheckedRequest | RawRequestCandidate;
    candidates.set(result, { view, descriptor });
    return result;
  }
  const api: NativeValidator = {
    bindCapabilities(input, source) {
      return attempt('capabilities', () => {
        const binding = verifySource(source);
        if (!equal(binding.contract, contract.identity))
          fail('capability_stale', 'discovery', 'contract');
        const response = responseShape(input, 'general', false, null).response;
        const value = object(response.result, 'capability_invalid');
        const hints = shapeCapabilities(value, binding);
        const methods = new Map<string, MethodDescriptor>();
        for (const [name, hint] of hints) {
          const paths = data(contract).branches.get(name);
          const descriptor = describeCapability(binding, name, hint, paths);
          methods.set(name, descriptor);
        }
        const view = Object.freeze({ binding, methods: Object.freeze([...methods.values()]) });
        views.set(view, { contract, capabilities: value, methods });
        return view;
      });
    },
    describe(view, name) {
      return attempt('describe', () => method(contract, view, name));
    },
    checkRequest(view, input) {
      return attempt('request', () => checkedRequest(view, input, false) as CheckedRequest);
    },
    checkRawRequest(view, input) {
      return attempt('request', () => checkedRequest(view, input, true));
    },
    checkResponseShape(input, family = 'general') {
      return attempt('response', () => {
        if (!['general', 'terminal'].includes(family)) fail('invalid_context');
        return responseShape(input, family, false, null);
      });
    },
    checkResponse(context, input, source) {
      return attempt('response', () => {
        const candidate = candidateOf(context);
        const stored = candidates.get(candidate)!;
        viewData(contract, stored.view);
        verifySource(source, candidate.binding);
        const terminal =
          candidate.kind === 'control' || candidate.method.startsWith('terminal.backend.');
        const checked = responseShape(
          input,
          terminal ? 'terminal' : 'general',
          true,
          candidate,
          context.kind === 'permit' ? context : null,
        );
        const request = candidate.kind === 'control' ? candidate.frame : candidate.request;
        // schema 合法之后仍须绑定原请求 ID、结果类型和适用的原生实例标识。
        if (checked.response.id !== request.id) fail('native_id_mismatch', 'response');
        if (checked.response.result !== undefined) {
          validateResponseResult(candidate, terminal, object(checked.response.result));
        }
        return checked;
      });
    },
    openStream(permit, acknowledgement) {
      return attempt('stream', () => {
        const state = permits.get(permit);
        const received = responses.get(acknowledgement);
        // ack 必须由同一 permit 的响应校验产生；同形响应对象不能替代内存句柄。
        if (
          !state ||
          !received ||
          received.contract !== contract ||
          received.candidate !== state.candidate ||
          received.permit !== permit ||
          !acknowledgement.bound ||
          !STREAM_METHODS.has(permit.method) ||
          acknowledgement.response.result === undefined
        )
          fail('invalid_stream_context', 'stream');
        const result = object(acknowledgement.response.result);
        const mode = streamModeFor(permit.method);
        if (!Number.isSafeInteger(result.sequence) || (result.sequence as number) < 0)
          fail('native_response_invalid', 'stream');
        const stream = Object.freeze({
          binding: permit.binding,
          method: permit.method,
          mode,
          sequence: result.sequence as number,
        });
        streams.set(stream, {
          permit,
          identity: mode === 'observe' || mode === 'control' ? result : null,
        });
        return stream;
      });
    },
    checkEvent(stream, input, source) {
      return attempt('event', () => {
        const state = streams.get(stream);
        if (!state) fail('invalid_stream_context', 'event');
        const candidate = permits.get(state.permit)?.candidate;
        if (!candidate) fail('invalid_stream_context');
        viewData(contract, candidates.get(candidate)!.view);
        verifySource(source, stream.binding);
        const event = copy(contract, input);
        const name = text(event.event, 'native_event_invalid');
        const terminal = name.startsWith('terminal.');
        if (name === 'terminal.frame' || name === 'terminal.resync_required') {
          if (
            stream.mode === 'general_events' ||
            (name === 'terminal.frame' && stream.mode === 'terminal_events')
          )
            fail('native_event_invalid', 'event', 'stream_family');
        } else validate(contract, `${UHP}event.schema.json`, event, 'native_event_invalid');
        if (terminal)
          validate(
            contract,
            `${UHP}schema/terminal/event.schema.json`,
            event,
            'native_event_invalid',
          );
        else if (stream.mode !== 'general_events')
          fail('native_event_invalid', 'event', 'stream_family');
        const checker = data(contract).validators.get(`event:${name}`);
        if (
          checker
            ? !checker(event.data)
            : !['terminal.frame', 'terminal.resync_required'].includes(name)
        )
          fail('native_event_invalid', 'event', 'payload');
        const payload = object(event.data, 'native_event_invalid');
        if (
          payload.server_generation !== undefined &&
          payload.server_generation !== stream.binding.server_generation
        )
          fail('native_identity_mismatch', 'event');
        // resync 通知不承诺旧终端标识仍有效；其它终端事件必须匹配开流时的实例。
        if (state.identity && terminal && name !== 'terminal.resync_required') {
          for (const key of ['server_generation', 'terminal_id', 'pane_id'])
            if (payload[key] !== state.identity[key]) fail('native_identity_mismatch', 'event');
        }
        if (name === 'terminal.frame') {
          const bytes = Buffer.byteLength(payload.text as string);
          if (
            bytes > 65536 ||
            payload.bytes !== bytes ||
            payload.lines !== (payload.text as string).split('\n').length ||
            Buffer.byteLength(JSON.stringify(event)) > data(contract).limits.terminal_frame_bytes
          )
            fail('native_event_invalid', 'event', 'utf8_frame_limit');
        }
        return Object.freeze({
          event,
          requires_resync: name === 'terminal.resync_required' || name === 'events.resync_required',
        });
      });
    },
    checkControl(stream, input) {
      return attempt('control', () => {
        const state = streams.get(stream);
        if (!state) fail('invalid_stream_context', 'control');
        const permit = permits.get(state.permit);
        if (!permit) fail('invalid_stream_context', 'control');
        const parent = candidates.get(permit.candidate)!;
        viewData(contract, parent.view);
        const frame = copy(contract, input);
        validate(
          contract,
          `${UHP}schema/terminal/control-frame.schema.json`,
          frame,
          'native_control_invalid',
        );

        // control candidate 只证明帧合法；派发仍须由 safety 模块逐次授权。
        if (stream.mode !== 'control')
          fail('forbidden', 'control', 'read_only_stream', 'authorization');
        const action = text(frame.action);
        const caps = object(viewData(contract, parent.view).capabilities.terminal);
        if (
          !Array.isArray(caps.capabilities) ||
          !caps.capabilities.includes(action) ||
          !permit.supportedActions.includes(action)
        ) {
          fail('unsupported_stream_feature', 'control');
        }
        if (Buffer.byteLength(JSON.stringify(frame)) > data(contract).limits.terminal_frame_bytes)
          fail('native_control_invalid', 'control', 'frame_limit');
        const candidate: CheckedControl = Object.freeze({
          kind: 'control',
          frame,
          binding: stream.binding,
          method: 'terminal.backend.control',
          action,
          validation: 'schema',
        });
        candidates.set(candidate, { ...parent, stream });
        return candidate;
      });
    },
  };
  return Object.freeze(api);
}

export function checkSequence(previous: number, incoming: number): Check<void> {
  return attempt('sequence', () => {
    if (
      !Number.isSafeInteger(previous) ||
      !Number.isSafeInteger(incoming) ||
      previous < 0 ||
      incoming < 0
    )
      fail('invalid_sequence', 'stream');
    if (incoming <= previous) fail('duplicate_stream_frame', 'stream');
    if (incoming !== previous + 1) fail('resync_required', 'stream');
  });
}
