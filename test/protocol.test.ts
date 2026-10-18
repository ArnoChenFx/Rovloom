import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as protocol from '../src/protocol.js';
import { context, request, rejects } from './wire/helpers.js';

test('顶层协议导出集合保持稳定，业务帧必须显式提供认证上下文', () => {
  assert.deepEqual(Object.keys(protocol).sort(), ['MAX_FRAME_BYTES', 'PROTOCOL_MAJOR', 'PROTOCOL_MINOR', 'decodeFrame', 'encodeFrame'].sort());
  const ctx = context();
  assert.deepEqual(protocol.decodeFrame(protocol.encodeFrame(request, ctx), ctx), request);
  rejects(() => protocol.decodeFrame(JSON.stringify(request), 'connection_1'), 'authenticated_context_required');
  rejects(() => protocol.encodeFrame(request), 'authenticated_context_required');
});
