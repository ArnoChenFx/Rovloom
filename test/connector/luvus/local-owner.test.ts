/** 核对显式本机 Owner 的原生帧选择；缺 token 不会触发自动 Owner fallback。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { requestFrame } from '../../../src/connector/luvus/adapter.js'
import type { LuvusNativeAuth } from '../../../src/connector/luvus/types.js'

test(
  'local Owner is an explicit native transport mode and preserves the original request with assigned ID',
  /** 官方本机 Owner 省略 auth 字段，原参数和预算仍由原帧构造器检查。 */ () => {
    const request = {
      method: 'agent.prompt',
      params: { target: 'owned-agent', text: '你好', terminal_id: 'owned-terminal' }
    }
    const bytes = requestFrame(request, 'request_1', { kind: 'local_owner' }, 4096)
    assert.equal(bytes.at(-1), 10)
    assert.deepEqual(JSON.parse(bytes.toString()), { ...request, id: 'request_1' })
    assert.deepEqual(JSON.parse(requestFrame(request, 'request_1', 'existing-token', 4096).toString()), {
      ...request,
      id: 'request_1',
      auth: 'existing-token'
    })
    assert.throws(
      /** 少一字节也必须拒绝，不能只计算不含LF的JSON。 */ () =>
        requestFrame(request, 'request_1', { kind: 'local_owner' }, bytes.length - 1),
      /native_request_limit/
    )
  }
)

test(
  'missing, invalid or caller supplied native authentication never selects local Owner implicitly',
  /** 只允许宿主明确的原生认证模式，调用参数不能提供身份字段。 */ () => {
    const request = { method: 'workspace.list', params: {} }
    for (const auth of [undefined, null, '', {}, { kind: 'local_owner', token: 'unexpected' }]) {
      assert.throws(
        /** 无效宿主值保持原认证错误。 */ () => requestFrame(request, 'request_1', auth as LuvusNativeAuth, 4096),
        /native_auth_required/
      )
    }
    for (const field of ['id', 'auth']) {
      assert.throws(
        /** 原生ID与认证由宿主赋值，不接受调用方覆盖。 */ () =>
          requestFrame({ ...request, [field]: 'caller' }, 'request_1', { kind: 'local_owner' }, 4096),
        /caller_native_identity_forbidden/
      )
    }
  }
)
