import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as protocol from '../../src/protocol.js';
import {
  attempt,
  binding,
  context,
  fixtureValidator,
  frame,
  request,
  response,
  rejects,
} from './helpers.js';

test('顶层协议导出集合保持稳定，业务帧必须显式提供认证上下文', () => {
  assert.deepEqual(
    Object.keys(protocol).sort(),
    ['MAX_FRAME_BYTES', 'PROTOCOL_MAJOR', 'PROTOCOL_MINOR', 'decodeFrame', 'encodeFrame'].sort(),
  );
  const ctx = context();
  assert.deepEqual(protocol.decodeFrame(protocol.encodeFrame(request, ctx), ctx), request);
  rejects(
    () => protocol.decodeFrame(JSON.stringify(request), 'connection_1'),
    'authenticated_context_required',
  );
  rejects(() => protocol.encodeFrame(request), 'authenticated_context_required');
});

test('v2 公共入口往返两种 profile、关联帧并保留完整原生错误', () => {
  for (const target of [
    attempt.target,
    {
      machine_id: attempt.target.machine_id,
      provider_id: attempt.target.provider_id,
      profile: 'host' as const,
    },
  ]) {
    const a = { ...attempt, target };
    const ctx = context('gateway_to_connector', fixtureValidator(), { ...binding, ...a });
    const value = frame('request', { ...request.payload, attempt: a });
    assert.deepEqual(protocol.decodeFrame(protocol.encodeFrame(value, ctx), ctx), value);
  }
  const nativeError = frame('response', {
    attempt,
    native_response: {
      id: attempt.native_request_id,
      error: {
        code: 'revision_conflict',
        message: 'synthetic',
        data: { revision: 42, extension: { retained: true } },
      },
    },
  });
  for (const value of [
    frame('accepted', { attempt }),
    nativeError,
    frame('cancel', { attempt, reason: 'caller_cancelled' }),
  ]) {
    const ctx = context(value.type === 'cancel' ? 'gateway_to_connector' : 'connector_to_gateway');
    assert.deepEqual(protocol.decodeFrame(protocol.encodeFrame(value, ctx), ctx), value);
  }
});

test('v2 公共入口拒绝旧 epoch/版本、未知字段、缺失目标、凭据与无效 deadline', () => {
  const decode = (value: unknown) => protocol.decodeFrame(JSON.stringify(value), context());
  rejects(() => decode({ ...request, protocol_major: 1 }), 'protocol_major_unsupported');
  rejects(() => decode({ ...request, protocol_minor: 1 }), 'protocol_version_unsupported');
  rejects(
    () => decode({ ...request, connection_epoch: 'old_epoch' }),
    'connection_binding_mismatch',
  );
  rejects(() => decode({ ...request, auth: 'synthetic' }), 'invalid_frame_fields');
  rejects(() => decode({ ...request, type: 'unknown' }), 'unsupported_frame_type');
  rejects(
    () =>
      decode({
        ...request,
        payload: {
          ...request.payload,
          native_request: { ...request.payload.native_request, auth: 'synthetic' },
        },
      }),
    'reserved_request_field',
  );
  const target = { ...attempt.target } as any;
  delete target.session;
  rejects(
    () => decode({ ...request, payload: { ...request.payload, attempt: { ...attempt, target } } }),
    'invalid_frame_fields',
  );
  rejects(
    () =>
      decode({
        ...request,
        payload: {
          ...request.payload,
          attempt: { ...attempt, registration: { ...attempt.registration, deadline: 0 } },
        },
      }),
    'invalid_integer',
  );
  rejects(() => protocol.decodeFrame('{', context()), 'invalid_frame_json');
  rejects(
    () => protocol.decodeFrame('x'.repeat(protocol.MAX_FRAME_BYTES + 1), context()),
    'frame_limit',
  );
});

test('v2 公共入口拒绝歧义原生响应，heartbeat 仅接受安全非负整数', () => {
  const ctx = context();
  const heartbeat = frame('heartbeat', { sequence: 0 });
  assert.deepEqual(protocol.decodeFrame(protocol.encodeFrame(heartbeat, ctx), ctx), heartbeat);
  for (const sequence of [-1, Number.MAX_SAFE_INTEGER + 1])
    rejects(
      () => protocol.encodeFrame({ ...heartbeat, payload: { sequence } }, ctx),
      'invalid_integer',
    );
  for (const native_response of [
    { id: attempt.native_request_id },
    {
      id: attempt.native_request_id,
      result: {},
      error: { code: 'synthetic', message: 'synthetic' },
    },
  ])
    rejects(
      () =>
        protocol.encodeFrame(
          { ...response, payload: { ...response.payload, native_response } },
          context('connector_to_gateway'),
        ),
      'native_response_invalid',
    );
});
