// 验证顶层公共协议入口的导出稳定性、认证要求和 Wire v2 校验边界。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as protocol from '../../src/protocol.js'
import { attempt, binding, context, fixtureValidator, frame, request, response, rejects } from './helpers.js'

test(
  '顶层协议导出集合保持稳定，业务帧必须显式提供认证上下文',
  /* 验证顶层协议导出集合保持稳定，业务帧必须显式提供认证上下文。 */ () => {
    assert.deepEqual(
      Object.keys(protocol).sort(),
      ['MAX_FRAME_BYTES', 'PROTOCOL_MAJOR', 'PROTOCOL_MINOR', 'decodeFrame', 'encodeFrame'].sort()
    )
    const ctx = context()
    assert.deepEqual(protocol.decodeFrame(protocol.encodeFrame(request, ctx), ctx), request)
    rejects(
      /* 提交该用例输入，确认公共业务入口缺少认证上下文时被拒绝。 */ () =>
        protocol.decodeFrame(JSON.stringify(request), 'connection_1'),
      'authenticated_context_required'
    )
    rejects(
      /* 提交该用例输入，确认公共业务入口缺少认证上下文时被拒绝。 */ () => protocol.encodeFrame(request),
      'authenticated_context_required'
    )
  }
)

test(
  'v2 公共入口往返两种 profile、关联帧并保留完整原生错误',
  /* 验证v2 公共入口往返两种 profile、关联帧并保留完整原生错误。 */ () => {
    for (const target of [
      attempt.target,
      {
        machine_id: attempt.target.machine_id,
        provider_id: attempt.target.provider_id,
        profile: 'host' as const
      }
    ]) {
      const a = { ...attempt, target }
      const ctx = context('gateway_to_connector', fixtureValidator(), { ...binding, ...a })
      const value = frame('request', { ...request.payload, attempt: a })
      assert.deepEqual(protocol.decodeFrame(protocol.encodeFrame(value, ctx), ctx), value)
    }
    const nativeError = frame('response', {
      attempt,
      native_response: {
        id: attempt.native_request_id,
        error: {
          code: 'revision_conflict',
          message: 'synthetic',
          data: { revision: 42, extension: { retained: true } }
        }
      }
    })
    for (const value of [
      frame('accepted', { attempt }),
      nativeError,
      frame('cancel', { attempt, reason: 'caller_cancelled' })
    ]) {
      const ctx = context(value.type === 'cancel' ? 'gateway_to_connector' : 'connector_to_gateway')
      assert.deepEqual(protocol.decodeFrame(protocol.encodeFrame(value, ctx), ctx), value)
    }
  }
)

test(
  'v2 公共入口拒绝旧 epoch/版本、未知字段、缺失目标、凭据与无效 deadline',
  /* 验证v2 公共入口拒绝旧 epoch/版本、未知字段、缺失目标、凭据与无效 deadline。 */ () => {
    // 经顶层公共入口解码序列化对象并提供完整认证上下文。
    const decode = (value: unknown) => protocol.decodeFrame(JSON.stringify(value), context())
    rejects(
      /* 提交该用例输入，确认不支持的协议主版本时被拒绝。 */ () => decode({ ...request, protocol_major: 1 }),
      'protocol_major_unsupported'
    )
    rejects(
      /* 提交该用例输入，确认消息版本不在当前协商范围时被拒绝。 */ () => decode({ ...request, protocol_minor: 1 }),
      'protocol_version_unsupported'
    )
    rejects(
      /* 提交该用例输入，确认消息与当前连接身份不匹配时被拒绝。 */ () =>
        decode({ ...request, connection_epoch: 'old_epoch' }),
      'connection_binding_mismatch'
    )
    rejects(
      /* 提交该用例输入，确认消息字段缺失或包含额外字段时被拒绝。 */ () => decode({ ...request, auth: 'synthetic' }),
      'invalid_frame_fields'
    )
    rejects(
      /* 提交该用例输入，确认使用未知帧类型时被拒绝。 */ () => decode({ ...request, type: 'unknown' }),
      'unsupported_frame_type'
    )
    rejects(
      /* 提交该用例输入，确认请求正文试图注入保留字段时被拒绝。 */ () =>
        decode({
          ...request,
          payload: {
            ...request.payload,
            native_request: { ...request.payload.native_request, auth: 'synthetic' }
          }
        }),
      'reserved_request_field'
    )
    const target = { ...attempt.target } as any
    delete target.session
    rejects(
      /* 提交该用例输入，确认消息字段缺失或包含额外字段时被拒绝。 */ () =>
        decode({ ...request, payload: { ...request.payload, attempt: { ...attempt, target } } }),
      'invalid_frame_fields'
    )
    rejects(
      /* 提交该用例输入，确认整数越界或不满足非负限制时被拒绝。 */ () =>
        decode({
          ...request,
          payload: {
            ...request.payload,
            attempt: { ...attempt, registration: { ...attempt.registration, deadline: 0 } }
          }
        }),
      'invalid_integer'
    )
    rejects(
      /* 提交该用例输入，确认输入不是合法的单个 JSON 帧时被拒绝。 */ () => protocol.decodeFrame('{', context()),
      'invalid_frame_json'
    )
    rejects(
      /* 提交该用例输入，确认输入超过单帧大小上限时被拒绝。 */ () =>
        protocol.decodeFrame('x'.repeat(protocol.MAX_FRAME_BYTES + 1), context()),
      'frame_limit'
    )
  }
)

test(
  'v2 公共入口拒绝歧义原生响应，heartbeat 仅接受安全非负整数',
  /* 验证v2 公共入口拒绝歧义原生响应，heartbeat 仅接受安全非负整数。 */ () => {
    const ctx = context()
    const heartbeat = frame('heartbeat', { sequence: 0 })
    assert.deepEqual(protocol.decodeFrame(protocol.encodeFrame(heartbeat, ctx), ctx), heartbeat)
    for (const sequence of [-1, Number.MAX_SAFE_INTEGER + 1]) {
      rejects(
        /* 提交该用例输入，确认整数越界或不满足非负限制时被拒绝。 */ () =>
          protocol.encodeFrame({ ...heartbeat, payload: { sequence } }, ctx),
        'invalid_integer'
      )
    }
    for (const native_response of [
      { id: attempt.native_request_id },
      {
        id: attempt.native_request_id,
        result: {},
        error: { code: 'synthetic', message: 'synthetic' }
      }
    ]) {
      rejects(
        /* 提交该用例输入，确认原生响应未通过校验时被拒绝。 */ () =>
          protocol.encodeFrame(
            { ...response, payload: { ...response.payload, native_response } },
            context('connector_to_gateway')
          ),
        'native_response_invalid'
      )
    }
  }
)
