import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeFoundationV1History, MAX_FRAME_BYTES } from '../src/wire/foundation-v1-history.js'
import type { Envelope } from '../src/wire/foundation-v1-history.js'

// 原基线断言保留，显式限定为历史记录；执行入口的 v2 拒绝另有测试。
const decodeFrame = (input: string, epoch: string): Envelope => decodeFoundationV1History(input, epoch).frame
const encodeFrame = (frame: Envelope): string => {
  const input = JSON.stringify(frame)
  decodeFrame(input, frame.connection_epoch)
  return input
}

const request: Envelope = {
  protocol_major: 1,
  protocol_minor: 0,
  type: 'request',
  message_id: 'msg_1',
  connection_epoch: 'epoch_1',
  payload: {
    call_id: 'call_1',
    attempt_id: 'attempt_1',
    deadline: 12345,
    target: { machine_id: 'm_1', profile: 'session', session: 'explicit' },
    request: { method: 'pane.read', params: { pane: 3 }, if_revision: 42 }
  }
}

test('versioned business frames round-trip native fields and both profiles', () => {
  assert.deepEqual(decodeFrame(encodeFrame(request), 'epoch_1'), request)
  const host: Envelope = {
    ...request,
    payload: { ...request.payload, target: { machine_id: 'm_1', profile: 'host' } }
  }
  assert.deepEqual(decodeFrame(encodeFrame(host), 'epoch_1'), host)
  for (const type of ['accepted', 'cancel'] as const) {
    const frame: Envelope = {
      ...request,
      type,
      payload: { call_id: 'call_1', attempt_id: 'attempt_1' }
    }
    assert.deepEqual(decodeFrame(encodeFrame(frame), 'epoch_1'), frame)
  }
  const response: Envelope = {
    ...request,
    type: 'response',
    payload: {
      call_id: 'call_1',
      attempt_id: 'attempt_1',
      uhp_response: {
        id: 'native',
        error: { code: 'revision_conflict', data: { revision: 3 } },
        extension: true
      }
    }
  }
  assert.deepEqual(decodeFrame(encodeFrame(response), 'epoch_1'), response)
})

test('frames reject stale epochs, unsupported versions, fields, targets and reserved credentials', () => {
  const raw = JSON.parse(JSON.stringify(request))
  const reject = (value: unknown, code: RegExp) =>
    assert.throws(() => decodeFrame(JSON.stringify(value), 'epoch_1'), code)
  reject({ ...raw, protocol_major: 2 }, /protocol_version_unsupported/)
  reject({ ...raw, protocol_minor: 1 }, /protocol_version_unsupported/)
  reject({ ...raw, connection_epoch: 'epoch_old' }, /stale_epoch/)
  reject({ ...raw, auth: 'never-accepted' }, /invalid_frame_fields/)
  reject({ ...raw, type: 'stream_open' }, /unsupported_frame_type/)
  reject(
    { ...raw, payload: { ...raw.payload, request: { method: 'pane.read', auth: 'secret' } } },
    /reserved_request_field/
  )
  reject(
    { ...raw, payload: { ...raw.payload, target: { machine_id: 'm', profile: 'session' } } },
    /invalid_frame_fields/
  )
  reject({ ...raw, payload: { ...raw.payload, deadline: 0 } }, /invalid_deadline/)
  assert.throws(() => decodeFrame('{', 'epoch_1'), /invalid_frame_json/)
  assert.throws(() => decodeFrame('x'.repeat(MAX_FRAME_BYTES + 1), 'epoch_1'), /frame_limit/)
})

test('response union and heartbeat bounds fail closed', () => {
  const heartbeat: Envelope = { ...request, type: 'heartbeat', payload: { sequence: 0 } }
  assert.deepEqual(decodeFrame(encodeFrame(heartbeat), 'epoch_1'), heartbeat)
  assert.throws(() => encodeFrame({ ...heartbeat, payload: { sequence: -1 } }), /invalid_sequence/)
  const response: Envelope = {
    ...request,
    type: 'response',
    payload: {
      call_id: 'c',
      attempt_id: 'a',
      uhp_response: { result: {}, error: {} }
    }
  }
  assert.throws(() => encodeFrame(response), /invalid_native_response/)
})
