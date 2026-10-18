import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLuvusWireAdapter } from '../../src/integration/luvus-wire.js';
import type { NativeWireBackend, TrustedAttempt } from '../../src/integration/luvus-wire.js';
import { boundedJson, contractRef, hash, LIMITS } from '../../src/wire/index.js';
import type {
  AttemptBinding,
  AuthenticatedEnvelope,
  ContractSource,
  Payloads,
  ProviderPolicies,
} from '../../src/wire/types.js';
import type { NativeBinding, SafetyClassification } from '../../src/native-contract/index.js';
import {
  auth,
  clone,
  compiled,
  G,
  identity,
  json,
  request,
  T,
  view,
} from '../native-contract/helpers.js';

// 全部是隔离 P0 fixture 与明确的测试权限；生产模块不导入本工厂或测试 gate。
function fixture(method = 'task.add', raw = false, stream = false) {
  const params =
    method === 'ping'
      ? {}
      : method === 'task.add'
        ? { title: 'synthetic' }
        : {
            server_generation: G,
            terminal_id: T,
            pane_id: '3',
            ...(method === 'terminal.backend.capture'
              ? { mode: 'visible', lines: 1, ansi: false }
              : {}),
          };
  const candidate = request(view(), { id: 'native_1', method, params });
  const initial = auth(candidate);
  const origin: ContractSource = {
    provider_kind: 'luvus',
    protocol_family: 'uhp',
    binary_version: '0.14.3',
    binary_sha256: identity.binary_sha256,
    schema_sha256: identity.schema_sha256,
    schema_origin: 'installed_cli',
    schema_command: 'luvus uhp schema',
    server_version: '0.14.3',
    native_protocol_version: '1.0',
    runtime_generation: G,
    adapter_revision: 'integration_test',
    classification_revision: 'review1',
    support_basis: 'live_catalog',
  };
  const binding: AttemptBinding = {
    machine_id: 'm1',
    recovery_generation: 'recovery1',
    connection_epoch: 'e1',
    call_id: 'call1',
    attempt_id: 'attempt1',
    native_request_id: 'native_1',
    provider_kind: 'luvus',
    binding_revision: 1,
    contract_ref: contractRef(origin),
    target: { machine_id: 'm1', provider_id: 'p1', profile: 'session', session: 'synthetic' },
    registration: {
      deadline: 1000,
      history: null,
      caller_policy_revision: 'caller1',
      local_policy_revision: 'local1',
    },
  };
  const row: TrustedAttempt = {
    binding,
    principal_id: 'synthetic',
    method,
    mode: raw ? 'raw-contract' : 'strict',
    native_request: { method, params },
    transport: stream ? 'stream' : 'rpc',
    ...(stream ? { feature: 'terminal_control', stream_id: 'stream1' } : {}),
  };
  const rows = new Map([[binding.call_id, row]]);
  const policies: ProviderPolicies = {
    caller: {
      revision: 'caller1',
      grants: [
        {
          target: clone(binding.target),
          methods: [method],
          actions: ['dispatch', 'read', 'stream_input', 'cancel'],
        },
      ],
    },
    local: { revision: 'local1', grants: [] },
  };
  policies.local.grants = clone(policies.caller.grants);
  const state = {
    active: true,
    enabled: true,
    sourceVerified: true,
    reader: 'synthetic',
    content: 'available' as 'available' | 'expired' | 'discarded' | 'unavailable',
    owner: raw,
    grant: raw,
    trustedClassification: true,
    classifications: clone(initial.classifications) as SafetyClassification[],
    revision: 1,
    localConfig: 'config1',
    now: 100,
    custody: false,
    channel: 'ordinary' as 'ordinary' | 'custody',
  };
  const capabilities = json('session-capabilities.json');
  capabilities.result.session = 'synthetic';
  capabilities.result.server_generation = G;
  const nativeBinding = (record: TrustedAttempt): NativeBinding => ({
    ...candidate.binding,
    provider_id: record.binding.target.provider_id,
    binding_revision: record.binding.binding_revision,
    contract_source_ref: record.binding.contract_ref,
  });
  const backend: NativeWireBackend = {
    connection: () => ({
      machine_id: 'm1',
      recovery_generation: 'recovery1',
      connection_epoch: 'e1',
      authenticated: true,
      active: state.active as true,
      negotiated: {
        major: 2,
        minor: 0,
        capabilities: ['rpc', 'objects', 'late_evidence', 'terminal_observe', 'terminal_control'],
      },
    }),
    attempt: (call, attempt) => {
      const found = rows.get(call);
      return found?.binding.attempt_id === attempt ? found : undefined;
    },
    provider: (target) => ({
      machine_id: 'm1',
      provider_id: target.provider_id,
      binding_revision: state.revision,
      kind: 'luvus',
      enabled: state.enabled,
      config_ref: 'config1',
    }),
    localProvider: (target) => ({
      machine_id: 'm1',
      provider_id: target.provider_id,
      binding_revision: state.revision,
      kind: 'luvus',
      enabled: state.enabled,
      config_ref: state.localConfig,
    }),
    contract: (ref) =>
      ref === contractRef(origin)
        ? {
            wire: { source: origin, support_status: 'validated' },
            compiled,
            capabilities,
            capability_revision: 'caps1',
          }
        : undefined,
    nativeSource: (call) => {
      const found = rows.get(call);
      return found
        ? {
            authenticated: true,
            source_verified: state.sourceVerified,
            binding: nativeBinding(found),
          }
        : undefined;
    },
    policies: () => policies,
    authority: (record, native) => {
      const {
        source: _source,
        principal_id: _principal,
        caller_policy: _caller,
        local_policy: _local,
        mode: _mode,
        now: _now,
        ...authority
      } = initial;
      return {
        ...authority,
        classifications: state.classifications,
        classification_source_verified: state.trustedClassification,
        owner: state.owner,
        raw_requested: raw,
        custody_available: state.custody,
        result_channel: state.channel,
        ...(state.grant
          ? {
              raw_grant: {
                id: 'grant1',
                source_verified: true,
                principal_id: record.principal_id,
                binding: native,
                methods: [method],
                expires_at: 200,
              },
            }
          : {}),
      };
    },
    currentPrincipal: () => state.reader,
    contentStatus: () => state.content,
    now: () => state.now,
    responseAnchor: () => ({
      binding,
      method,
      mode: row.mode,
      state: 'outcome_unknown',
      content_status: state.content,
      content_expires_at: 500,
      dedup_expires_at: 2000,
    }),
  };
  const adapter = createLuvusWireAdapter(backend);
  const attempt = ({
    machine_id: _machine,
    recovery_generation: _recovery,
    connection_epoch: _epoch,
    ...rest
  }: AttemptBinding) => rest;
  function frame<K extends keyof Payloads>(
    type: K,
    payload: Payloads[K],
  ): Extract<AuthenticatedEnvelope, { type: K }> {
    return {
      protocol_major: 2,
      protocol_minor: 0,
      type,
      message_id: 'msg1',
      machine_id: 'm1',
      recovery_generation: 'recovery1',
      connection_epoch: 'e1',
      payload,
    } as Extract<AuthenticatedEnvelope, { type: K }>;
  }
  const opening = stream
    ? frame('stream_open', {
        attempt: attempt(binding),
        expected_binding_revision: 1,
        native_request: row.native_request,
        validation: row.mode,
        stream_id: 'stream1',
        feature: 'terminal_control',
      })
    : frame('request', {
        attempt: attempt(binding),
        expected_binding_revision: 1,
        native_request: row.native_request,
        validation: row.mode,
      });
  const response = frame('response', {
    attempt: attempt(binding),
    native_response: {
      id: 'native_1',
      error: {
        code: 'synthetic',
        message: 'preserve',
        data: { deep: ['汉字', { native: true }] },
      },
    },
  });
  const decode = (
    value: unknown,
    direction: 'gateway_to_connector' | 'connector_to_gateway' = 'gateway_to_connector',
  ) => adapter.decode(JSON.stringify(value), direction);
  return {
    adapter,
    backend,
    binding,
    row,
    rows,
    origin,
    policies,
    state,
    opening,
    response,
    decode,
    frame,
    attempt,
    nativeBinding,
  };
}
const rejects = (run: () => unknown, code: string) =>
  assert.throws(run, (e: any) => e.code === code, code);

function controlFixture() {
  const f = fixture('terminal.backend.control', false, true);
  const data = (frame: Record<string, unknown>, sequence = 0) =>
    f.frame('stream_data', {
      attempt: f.attempt(f.binding),
      stream_id: 'stream1',
      feature: 'terminal_control',
      sequence,
      frame,
    });
  const ack = {
    id: 'native_1',
    result: {
      type: 'terminal_backend_stream',
      mode: 'control',
      server_generation: G,
      terminal_id: T,
      pane_id: '3',
      sequence: 0,
      content_revision: 0,
      ansi: false,
      capture_mode: 'visible',
      lines: 1,
      frame_bytes: 65536,
      queue_capacity: 2,
      loss_behavior: 'resync_required_then_close',
    },
  };
  f.adapter.advanceStream(f.opening, 'gateway_to_connector');
  f.adapter.advanceStream(data(ack), 'connector_to_gateway');
  const input = (id: string) =>
    f.frame('stream_input', {
      attempt: f.attempt(f.binding),
      stream_id: 'stream1',
      feature: 'terminal_control',
      sequence: 0,
      frame: { id, action: 'type_literal', params: { text: 'synthetic' } },
    });
  const inputAck = {
    id: 'input1',
    result: { type: 'terminal_backend_action', state: 'succeeded', dispatch: 'queued' },
  };
  return { ...f, data, input, inputAck, ack };
}

test('retention:none 可读取但证据计划只保留元数据，普通/秘密 result 与 error 均不复活原文', () => {
  for (const secret of [false, true])
    for (const error of [false, true]) {
      const f = fixture();
      const row = f.state.classifications[0]!;
      f.state.classifications = [
        {
          ...row,
          result: {
            ...row.result,
            retention: 'none',
            ...(secret
              ? ({
                  boundary: 'protected_secret',
                  sensitivity: 'credential',
                  delivery: 'custody',
                } as const)
              : {}),
          },
        },
      ];
      f.state.custody = secret;
      f.state.channel = secret ? 'custody' : 'ordinary';
      f.decode(f.opening);
      const response = error
        ? f.response
        : {
            ...f.response,
            payload: {
              ...f.response.payload,
              native_response: {
                id: 'native_1',
                result: { synthetic: 'SYNTHETIC_PRIVATE_CONTENT' },
              },
            },
          };
      f.decode(response, 'connector_to_gateway');
      assert.doesNotThrow(() => f.adapter.checkResult(f.binding));
      const anchor = clone(f.backend.responseAnchor!(f.binding));
      const plan = f.adapter.planEvidence(response);
      assert.equal(plan.content.delivery, 'metadata_only');
      assert.equal(plan.content.native_response, undefined);
      assert.equal(Object.hasOwn(plan.content, 'native_response'), false);
      assert.equal(Object.hasOwn(plan.content, 'result_id'), false);
      assert.equal(
        plan.evidence.response_hash,
        hash(boundedJson(response.payload.native_response)),
      );
      assert.equal(
        plan.evidence.response_bytes,
        Buffer.byteLength(boundedJson(response.payload.native_response)),
      );
      assert.equal(plan.evidence.category, error ? 'error' : 'result');
      assert.equal(plan.content.expires_at, anchor!.content_expires_at);
      assert.equal(plan.dispatch, false);
      assert.deepEqual(f.backend.responseAnchor!(f.binding), anchor);
    }
});

test('控制 ack 读取选自己的 permit/当前分类，不能借普通开流许可走普通通道', () => {
  const f = controlFixture(),
    row = f.state.classifications[0]!;
  const control = {
    ...clone(row),
    action: 'type_literal',
    result: {
      ...row.result,
      boundary: 'protected_secret',
      sensitivity: 'credential',
      delivery: 'custody',
    },
  } as const;
  f.state.classifications.push(control);
  f.state.custody = true;
  f.state.channel = 'custody';
  f.adapter.advanceStream(f.input('input1'), 'gateway_to_connector');
  f.state.channel = 'ordinary';
  const error = {
    id: 'input1',
    error: { code: 'send_failed', message: 'synthetic', metadata: { marker: 'SYNTHETIC_SECRET' } },
  };
  f.adapter.advanceStream(f.data(error, 1), 'connector_to_gateway');
  rejects(() => f.adapter.checkResult(f.binding, error), 'secret_boundary_required');
  rejects(() => f.adapter.checkResult(f.binding, f.inputAck), 'secret_boundary_required');
  rejects(() => f.adapter.checkResult(f.binding), 'result_selector_required');
  assert.doesNotThrow(() => f.adapter.checkResult(f.binding, f.ack));
  f.state.channel = 'custody';
  assert.doesNotThrow(() => f.adapter.checkResult(f.binding, error));
  assert.doesNotThrow(() => f.adapter.checkResult(f.binding, f.inputAck));
  f.state.custody = false;
  rejects(() => f.adapter.checkResult(f.binding, error), 'secret_boundary_required');
  f.state.custody = true;
  f.state.classifications = [row];
  rejects(() => f.adapter.checkResult(f.binding, error), 'classification_unavailable');
  // 当前分类降为 ordinary 也不能覆盖当初控制 permit 的秘密边界。
  f.state.classifications.push({ ...control, result: row.result });
  f.state.channel = 'ordinary';
  rejects(() => f.adapter.checkResult(f.binding, error), 'secret_boundary_required');
});

test('流结果 frame 精确选择控制 ID/事件，未派发或其它 attempt 的 ID 不回退到开流许可', () => {
  const f = controlFixture(),
    row = f.state.classifications[0]!;
  f.state.classifications.push({ ...clone(row), action: 'type_literal' });
  f.decode(f.input('input1'));
  f.decode(f.data(f.inputAck), 'connector_to_gateway');
  assert.doesNotThrow(() => f.adapter.checkResult(f.binding, f.inputAck));
  for (const id of ['unknown', 'input2']) {
    rejects(() => f.adapter.checkResult(f.binding, { ...f.inputAck, id }), 'control_ack_unbound');
  }
  const second = clone(f.row);
  second.binding.call_id = 'call2';
  f.rows.set('call2', second);
  const otherOpening = {
    ...f.opening,
    payload: { ...f.opening.payload, attempt: f.attempt(second.binding) },
  };
  f.decode(otherOpening);
  rejects(() => f.adapter.checkResult(second.binding, f.inputAck), 'control_ack_unbound');
  rejects(
    () => f.adapter.checkResult({ ...f.binding, native_request_id: 'input1' }, f.inputAck),
    'attempt_binding_mismatch',
  );
  // 不能把开流 native ID 写在控制 ack 上借其普通分类。
  rejects(
    () => f.adapter.checkResult(f.binding, { ...f.inputAck, id: 'native_1' }),
    'native_result_mismatch',
  );
  const event = {
    event: 'terminal.frame',
    sequence: 0,
    data: {
      server_generation: G,
      terminal_id: T,
      pane_id: '3',
      content_revision: 0,
      mode: 'visible',
      ansi: false,
      text: 'synthetic',
      lines: 1,
      bytes: 9,
      truncated: false,
    },
  };
  assert.doesNotThrow(() => f.adapter.checkResult(f.binding, event));
  rejects(
    () =>
      f.adapter.checkResult(f.binding, {
        ...event,
        data: { ...event.data, terminal_id: '9'.repeat(32) },
      }),
    'native_identity_mismatch',
  );
  f.state.reader = 'other';
  rejects(() => f.adapter.checkResult(f.binding, f.inputAck), 'forbidden');
  f.state.reader = 'synthetic';
  f.state.content = 'discarded';
  rejects(() => f.adapter.checkResult(f.binding, f.inputAck), 'content_unavailable');
  f.state.content = 'available';
  f.policies.local.grants[0]!.actions = ['dispatch', 'stream_input'];
  rejects(() => f.adapter.checkResult(f.binding, f.inputAck), 'forbidden');
});

test('证据原文保留同时服从原 permit 和当前分类，当前 custody 与读取授权仍独立生效', () => {
  for (const initialRetention of ['caller_policy', 'none'] as const) {
    const f = fixture(),
      row = f.state.classifications[0]!;
    f.state.classifications = [{ ...row, result: { ...row.result, retention: initialRetention } }];
    f.decode(f.opening);
    const current = initialRetention === 'none' ? 'caller_policy' : 'none';
    f.state.classifications = [{ ...row, result: { ...row.result, retention: current } }];
    assert.equal(f.adapter.planEvidence(f.response).content.delivery, 'metadata_only');
  }
  const f = fixture(),
    row = f.state.classifications[0]!;
  f.state.classifications = [
    {
      ...row,
      result: {
        ...row.result,
        boundary: 'protected_secret',
        sensitivity: 'credential',
        delivery: 'custody',
      },
    },
  ];
  f.state.channel = 'custody';
  f.state.custody = true;
  f.decode(f.opening);
  assert.equal(f.adapter.planEvidence(f.response).content.delivery, 'payload');
  f.state.channel = 'ordinary';
  assert.equal(f.adapter.planEvidence(f.response).content.delivery, 'metadata_only');
  f.state.channel = 'custody';
  f.state.reader = 'other';
  assert.equal(f.adapter.planEvidence(f.response).content.delivery, 'metadata_only');
  f.state.reader = 'synthetic';
  f.state.trustedClassification = false;
  assert.equal(f.adapter.planEvidence(f.response).content.delivery, 'metadata_only');
  f.state.trustedClassification = true;
  f.state.classifications = [];
  assert.equal(f.adapter.planEvidence(f.response).content.delivery, 'metadata_only');
});

test('真实 validator 接入 Wire：完整参数、独立 source 和原生 error.data 保真，结果读取另过当前门禁', () => {
  const f = fixture();
  assert.deepEqual(f.decode(f.opening), f.opening);
  assert.deepEqual(
    f.adapter.decode(f.adapter.encode(f.opening, 'gateway_to_connector'), 'gateway_to_connector'),
    f.opening,
  );
  assert.deepEqual(f.decode(f.response, 'connector_to_gateway'), f.response);
  assert.doesNotThrow(() => f.adapter.checkResult(f.binding));
  rejects(
    () =>
      f.decode(
        {
          ...f.response,
          payload: { ...f.response.payload, native_response: { id: 'other', result: {} } },
        },
        'connector_to_gateway',
      ),
    'native_id_mismatch',
  );
  f.state.reader = 'other';
  rejects(() => f.adapter.checkResult(f.binding), 'forbidden');
  f.state.reader = 'synthetic';
  const classifications = f.state.classifications;
  f.state.classifications = [];
  rejects(() => f.adapter.checkResult(f.binding), 'classification_unavailable');
  f.state.classifications = classifications;
  f.policies.local.grants[0]!.actions = ['dispatch'];
  rejects(() => f.adapter.checkResult(f.binding), 'forbidden');
});

test('真实 generic 只能标 incomplete；raw 仍要求精确 grant、完整分类与当前双方权限', () => {
  const strict = fixture('ping');
  rejects(() => strict.decode(strict.opening), 'parameter_schema_incomplete');
  const raw = fixture('ping', true);
  assert.deepEqual(raw.decode(raw.opening), raw.opening);
  raw.state.grant = false;
  rejects(() => raw.decode(raw.opening), 'raw_contract_forbidden');
  raw.state.grant = true;
  raw.state.classifications = [];
  rejects(() => raw.decode(raw.opening), 'classification_unavailable');
  raw.state.classifications = clone(
    auth(request(view(), { id: 'id', method: 'ping', params: {} })).classifications,
  ) as SafetyClassification[];
  raw.state.trustedClassification = false;
  rejects(() => raw.decode(raw.opening), 'classification_unavailable');
});

test('消息不能覆盖已登记参数、principal、权限、provider 或原生来源；双端配置必须完全一致', () => {
  const f = fixture();
  const altered = clone(f.opening);
  altered.payload.native_request.params = { server_generation: G, terminal_id: T, pane_id: '4' };
  rejects(() => f.decode(altered), 'attempt_request_mismatch');
  rejects(
    () => f.decode({ ...f.opening, payload: { ...f.opening.payload, owner: true } }),
    'invalid_frame_fields',
  );
  rejects(
    () =>
      f.decode({
        ...f.opening,
        payload: {
          ...f.opening.payload,
          native_request: { ...f.row.native_request, id: 'caller' },
        },
      }),
    'reserved_request_field',
  );
  f.state.sourceVerified = false;
  rejects(() => f.decode(f.opening), 'native_source_untrusted');
  f.state.sourceVerified = true;
  f.state.localConfig = 'other_root';
  rejects(() => f.decode(f.opening), 'provider_binding_mismatch');
  f.state.localConfig = 'config1';
  f.state.enabled = false;
  rejects(() => f.decode(f.opening), 'provider_disabled');
  f.state.enabled = true;
  f.state.revision = 2;
  rejects(() => f.decode(f.opening), 'provider_binding_mismatch');
  f.state.revision = 1;
  f.state.active = false;
  rejects(() => f.decode(f.opening), 'authentication_required');
  f.state.active = true;
  f.backend.nativeSource = () => {
    throw Error('synthetic-private-payload');
  };
  assert.throws(
    () => f.decode(f.opening),
    (e: any) =>
      e.code === 'native_adapter_unavailable' && !e.message.includes('synthetic-private-payload'),
  );
});

test('同设备同名方法/native ID 的多个 provider 独立，错 endpoint 来源和 Herdr 冒充均拒绝', () => {
  const f = fixture();
  f.decode(f.opening);
  const second = clone(f.row);
  second.binding = {
    ...second.binding,
    call_id: 'call2',
    target: { ...second.binding.target, provider_id: 'p2' },
  };
  f.rows.set('call2', second);
  for (const side of [f.policies.caller, f.policies.local])
    side.grants.push({ ...clone(side.grants[0]!), target: second.binding.target });
  const request2 = {
    ...f.opening,
    payload: { ...f.opening.payload, attempt: f.attempt(second.binding) },
  };
  assert.deepEqual(f.decode(request2), request2);
  f.backend.nativeSource = () => ({
    authenticated: true,
    source_verified: true,
    binding: f.nativeBinding(second),
  });
  rejects(() => f.decode(f.response, 'connector_to_gateway'), 'native_identity_mismatch');
  const herdr = clone(f.row);
  herdr.binding = {
    ...herdr.binding,
    call_id: 'call3',
    provider_kind: 'herdr',
    target: { ...herdr.binding.target, provider_id: 'p3' },
  };
  f.rows.set('call3', herdr);
  f.backend.provider = (target) => ({
    machine_id: 'm1',
    provider_id: target.provider_id,
    kind: 'herdr',
    binding_revision: 1,
    config_ref: 'config1',
    enabled: true,
  });
  f.backend.localProvider = f.backend.provider;
  rejects(
    () =>
      f.decode({
        ...f.opening,
        payload: { ...f.opening.payload, attempt: f.attempt(herdr.binding) },
      }),
    'contract_binding_mismatch',
  );
});

test('同一 permit 的原生流 ack 才能开流，逐输入重新分类/授权，控制 ack 绑定输入 ID', () => {
  const f = fixture('terminal.backend.control', false, true);
  const ack = {
    id: 'native_1',
    result: {
      type: 'terminal_backend_stream',
      mode: 'control',
      server_generation: G,
      terminal_id: T,
      pane_id: '3',
      sequence: 0,
      content_revision: 0,
      ansi: false,
      capture_mode: 'visible',
      lines: 1,
      frame_bytes: 65536,
      queue_capacity: 2,
      loss_behavior: 'resync_required_then_close',
    },
  };
  const data = (frame: Record<string, unknown>) =>
    f.frame('stream_data', {
      attempt: f.attempt(f.binding),
      stream_id: 'stream1',
      feature: 'terminal_control',
      sequence: 0,
      frame,
    });
  rejects(() => f.decode(data(ack), 'connector_to_gateway'), 'dispatch_permit_unavailable');
  f.decode(f.opening);
  f.decode(f.opening);
  assert.deepEqual(f.decode(data(ack), 'connector_to_gateway'), data(ack));
  const event = {
    event: 'terminal.frame',
    sequence: 0,
    data: {
      server_generation: G,
      terminal_id: T,
      pane_id: '3',
      content_revision: 0,
      mode: 'visible',
      ansi: false,
      text: 'synthetic',
      lines: 1,
      bytes: 9,
      truncated: false,
    },
  };
  assert.deepEqual(f.decode(data(event), 'connector_to_gateway'), data(event));
  rejects(
    () =>
      f.decode(
        data({ ...event, data: { ...event.data, terminal_id: '9'.repeat(32) } }),
        'connector_to_gateway',
      ),
    'native_identity_mismatch',
  );
  const input = f.frame('stream_input', {
    attempt: f.attempt(f.binding),
    stream_id: 'stream1',
    feature: 'terminal_control',
    sequence: 0,
    frame: { id: 'input1', action: 'type_literal', params: { text: 'synthetic' } },
  });
  rejects(() => f.decode(input), 'safety_classification_missing');
  const row = { ...clone(f.state.classifications[0]!), action: 'type_literal' };
  f.state.classifications.push(row);
  assert.deepEqual(f.decode(input), input);
  assert.equal(f.adapter.advanceStream(f.opening, 'gateway_to_connector').state, 'opening');
  assert.equal(f.adapter.advanceStream(data(ack), 'connector_to_gateway').state, 'open');
  assert.equal(f.adapter.observeMessage(input, 'gateway_to_connector'), 'new');
  assert.equal(f.adapter.observeMessage(input, 'gateway_to_connector'), 'duplicate');
  assert.equal(f.adapter.advanceStream(input, 'gateway_to_connector').next_input_sequence, 1);
  rejects(() => f.adapter.advanceStream(input, 'gateway_to_connector'), 'stream_sequence_mismatch');
  const inputAck = {
    id: 'input1',
    result: { type: 'terminal_backend_action', state: 'succeeded', dispatch: 'queued' },
  };
  assert.deepEqual(f.decode(data(inputAck), 'connector_to_gateway'), data(inputAck));
  rejects(
    () => f.decode(data({ ...inputAck, id: 'unknown' }), 'connector_to_gateway'),
    'control_ack_unbound',
  );
  rejects(
    () => f.decode({ ...input, payload: { ...input.payload, stream_id: 'other' } }),
    'stream_binding_mismatch',
  );
  f.policies.local.grants[0]!.actions = ['dispatch', 'read'];
  rejects(() => f.decode(input), 'provider_scope_forbidden');
  f.policies.local.grants[0]!.actions.push('stream_input');
  f.decode(
    f.frame('stream_close', {
      attempt: f.attempt(f.binding),
      stream_id: 'stream1',
      reason: 'normal',
    }),
  );
  rejects(() => f.decode(input), 'stream_closed');
});

test('结果内容过期/discard 仅补最小可靠证据；原锚点不变、不派发、不续期限', () => {
  const f = fixture();
  f.decode(f.opening);
  const original = clone(f.backend.responseAnchor!(f.binding));
  const available = f.adapter.planEvidence(f.response);
  assert.equal(available.content.delivery, 'payload');
  assert.equal(available.dispatch, false);
  for (const status of ['expired', 'discarded', 'unavailable'] as const) {
    f.state.content = status;
    rejects(() => f.adapter.checkResult(f.binding), 'content_unavailable');
    const plan = f.adapter.planEvidence(f.response);
    assert.equal(plan.content.delivery, 'metadata_only');
    assert.equal(plan.content.native_response, undefined);
    assert.equal(plan.content.expires_at, original!.content_expires_at);
    assert.equal(plan.dispatch, false);
  }
  f.adapter.release(f.binding);
  rejects(() => f.adapter.checkResult(f.binding), 'dispatch_permit_unavailable');
  rejects(() => f.decode(f.response, 'connector_to_gateway'), 'dispatch_permit_unavailable');
});

test('分片重组真实响应仍经过原生许可/完整 schema，传输限额及私有句柄不暴露', () => {
  const f = fixture();
  f.decode(f.opening);
  const raw = Buffer.from(boundedJson(f.response));
  const chunk = f.frame('object_chunk', {
    object_id: 'object1',
    kind: 'envelope',
    total_bytes: raw.length,
    sha256: hash(raw),
    chunk_count: 1,
    index: 0,
    data: raw.toString('base64'),
  });
  assert.deepEqual(f.adapter.acceptChunk(JSON.stringify(chunk), 'connector_to_gateway'), {
    kind: 'envelope',
    envelope: f.response,
  });
  rejects(
    () => f.adapter.decode('x'.repeat(LIMITS.frame_bytes + 1), 'connector_to_gateway'),
    'frame_limit',
  );
  assert.equal('context' in f.adapter, false);
  assert.equal('validators' in f.adapter, false);
  rejects(
    () =>
      f.decode(
        { ...f.response, payload: { ...f.response.payload, native_handle: {} } },
        'connector_to_gateway',
      ),
    'invalid_frame_fields',
  );
});

test('Wire 外壳使用原生有界 JSON parser：重复键/精度损失在解码前拒绝', () => {
  const f = fixture();
  const raw = JSON.stringify(f.opening).replace(
    '"message_id":"msg1"',
    '"message_id":"old","message_id":"msg1"',
  );
  rejects(() => f.adapter.decode(raw, 'gateway_to_connector'), 'duplicate_json_key');
  const heartbeat = f.frame('heartbeat', { sequence: 0 });
  rejects(
    () =>
      f.adapter.decode(
        JSON.stringify(heartbeat).replace('"sequence":0', '"sequence":9007199254740993'),
        'gateway_to_connector',
      ),
    'invalid_integer',
  );
});

test('原生流打开失败保留完整错误并维持未就绪，不制造成功流', () => {
  const f = fixture('terminal.backend.control', false, true);
  f.decode(f.opening);
  const error = f.frame('stream_data', {
    attempt: f.attempt(f.binding),
    stream_id: 'stream1',
    feature: 'terminal_control',
    sequence: 0,
    frame: {
      id: 'native_1',
      error: {
        code: 'control_conflict',
        message: 'synthetic conflict',
        metadata: { retained: true },
      },
    },
  });
  assert.deepEqual(f.decode(error, 'connector_to_gateway'), error);
  rejects(
    () =>
      f.decode(
        f.frame('stream_input', {
          attempt: f.attempt(f.binding),
          stream_id: 'stream1',
          feature: 'terminal_control',
          sequence: 0,
          frame: { id: 'input', action: 'type_literal', params: { text: 'synthetic' } },
        }),
      ),
    'stream_not_ready',
  );
});

test('私有 attempt/快照预算满额拒绝，显式释放后不继承旧 permit', () => {
  const f = fixture();
  const tiny = createLuvusWireAdapter(f.backend, {
    attempts: 1,
    control_ids: 1,
    snapshot_bytes: 1,
  });
  rejects(() => tiny.decode(JSON.stringify(f.opening), 'gateway_to_connector'), 'adapter_limit');
  const limited = createLuvusWireAdapter(f.backend, { attempts: 1, control_ids: 1 });
  limited.decode(JSON.stringify(f.opening), 'gateway_to_connector');
  const second = clone(f.row);
  second.binding.call_id = 'call2';
  f.rows.set('call2', second);
  const next = {
    ...f.opening,
    payload: { ...f.opening.payload, attempt: f.attempt(second.binding) },
  };
  rejects(() => limited.decode(JSON.stringify(next), 'gateway_to_connector'), 'adapter_limit');
  limited.release(f.binding);
  assert.deepEqual(limited.decode(JSON.stringify(next), 'gateway_to_connector'), next);
  rejects(() => limited.checkResult(f.binding), 'dispatch_permit_unavailable');
});
