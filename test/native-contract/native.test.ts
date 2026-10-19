// 覆盖原生契约主路径、P0 离线重放、参数覆盖状态、流绑定及 JSON 安全边界。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkDispatch, checkResultBoundary, checkSequence, parseNativeJson } from '../../src/native-contract/index.js'
import {
  auth,
  clone,
  G,
  json,
  raw,
  register,
  rejects,
  request,
  sourceFor,
  T,
  unwrap,
  validator,
  view
} from './helpers.js'

test(
  '原生完整 schema 保留 144 generic 与 79 条件分支的独立状态',
  /* 遍历通用参数方法，确认严格派发拒绝缺口且完整 raw 授权仍保留覆盖状态。 */ () => {
    const session = view()
    const host = view('host')
    assert.equal(session.methods.length, 197)
    assert.equal(host.methods.length, 17)
    assert.equal(
      session.methods.filter(
        /* 筛选没有方法专用参数分支的描述，核对总数。 */ (m) => m.schema_status === 'generic_params_only'
      ).length,
      144
    )
    for (const entry of session.methods.filter(
      /* 枚举仅有通用参数约束的方法以逐一验证两种执行模式。 */ (m) => m.schema_status === 'generic_params_only'
    )) {
      const invoke = entry.method === 'module.action.invoke'
      const checked = request(session, {
        id: 'all-generic',
        method: entry.method,
        params: { unannounced: ['synthetic'], ...(invoke ? { action: 'synthetic' } : {}) }
      })
      assert.equal(checked.validation, 'generic')
      let authorization = auth(checked)
      if (invoke) {
        authorization = {
          ...authorization,
          classifications: [
            {
              ...(authorization.classifications[0] as object),
              sub_action: { pointer: '/params/action', value: 'synthetic' }
            }
          ]
        }
      }
      // admin/凭据 gate 独立满足后，严格路径仍仅因参数缺口拒绝。
      const safe = {
        ...authorization,
        permissions: ['admin-test'],
        custody_available: true,
        result_channel: 'custody' as const
      }
      rejects(checkDispatch(checked, safe), 'parameter_schema_incomplete')
      const allowed = unwrap(
        checkDispatch(checked, {
          ...raw(checked),
          classifications: authorization.classifications,
          permissions: ['admin-test'],
          custody_available: true,
          result_channel: 'custody'
        })
      )
      assert.equal(allowed.validation, 'generic')
      assert.equal(allowed.mode, 'raw_contract')
    }
  }
)

test(
  '原生 P0 全量 LF 请求/响应/事件离线重放，不制造认证或原生新运行',
  /* 离线重放 P0 请求、响应与事件，核对接受数量和预期拒绝边界。 */ () => {
    const transcript = json('transcript.json') as any[]
    const requests = new Map<string, any>()
    const sources = new Map<string, any>()
    const channels = new Map<string, any>()
    let accepted = 0
    let responses = 0
    let events = 0
    let invalid = 0
    let stale = 0
    const generation = json('session-capabilities.json').result.server_generation
    const sessionCaps = json('session-capabilities.json')
    const sessionSource = sourceFor({
      ...view().binding,
      target: { machine_id: 'm1', profile: 'session', session: 'p0-issue3' },
      server_generation: generation
    })
    const actualView = unwrap(validator.bindCapabilities(sessionCaps, sessionSource))
    const host = view('host')
    // 将发送记录校验为请求或控制候选，并保存响应关联及可信来源。
    function sent(input: any, channel?: string) {
      if (input.action) {
        const stream = channels.get(channel!)
        assert(stream)
        const checked = validator.checkControl(stream, input)
        if (input.id === 'input-invalid') {
          rejects(checked, 'native_control_invalid')
          invalid++
        } else {
          const frame = register(unwrap(checked), actualView)
          requests.set(input.id, unwrap(checkDispatch(frame, auth(frame))))
          sources.set(input.id, sourceFor(stream.binding))
          accepted++
          return
        }
        requests.set(input.id, input)
        return
      }
      const from = actualView.methods.some(
        /* 判断 session 能力是否广告了当前发送的方法。 */ (m) => m.method === input.method
      )
        ? actualView
        : host.methods.some(/* 判断 host 能力是否广告了当前发送的方法。 */ (m) => m.method === input.method)
          ? host
          : actualView
      const checked = validator.checkRequest(from, input)
      if (input.id === 'proxy-unknown-method') {
        rejects(checked, 'native_request_invalid')
        requests.set(input.id, input)
        invalid++
      } else if (input.id === 'control-stale-generation') {
        rejects(checked, 'native_identity_mismatch')
        requests.set(input.id, input)
        stale++
      } else {
        requests.set(input.id, register(unwrap(checked), from))
        sources.set(input.id, sourceFor(from.binding))
        accepted++
      }
    }
    // 按原请求校验响应或按流校验事件，并在开流 ack 成功后登记通道。
    function received(input: any, channel?: string) {
      if (input.event) {
        const stream = channels.get(channel!)
        assert(stream)
        assert.deepEqual(unwrap(validator.checkEvent(stream, input, sourceFor(stream.binding))).event, input)
        events++
        return
      }
      const original = requests.get(input.id)
      assert(original, '每个原生 response 必须有原始请求证据')
      if (original?.kind === 'request' || original?.kind === 'permit') {
        const opening = input.result && ['subscription_started', 'terminal_backend_stream'].includes(input.result.type)
        const permit = opening ? unwrap(checkDispatch(original, auth(original))) : null
        const checked = unwrap(validator.checkResponse(permit ?? original, input, sources.get(input.id)))
        assert.deepEqual(checked.response, input)
        if (permit) {
          channels.set(channel!, unwrap(validator.openStream(permit, checked)))
        }
      } else {
        assert.deepEqual(
          unwrap(validator.checkResponseShape(input, original?.action ? 'terminal' : 'general')).response,
          input
        )
      }
      responses++
    }
    for (const row of transcript) {
      if (row.kind === 'send') {
        sent(JSON.parse(row.wire), row.channel)
      }
      if (row.kind === 'receive') {
        received(JSON.parse(row.wire), row.channel)
      }
      if (row.kind === 'process' && row.argv.slice(-2).join(' ') === 'uhp proxy') {
        if (row.label !== 'proxy-malformed-json') {
          sent(JSON.parse(row.stdin.split('\n')[0]))
        }
        if (row.stdout) {
          received(JSON.parse(row.stdout))
        }
      }
    }
    assert.equal(accepted, 29)
    assert.equal(responses, 29)
    assert.equal(events, 23)
    assert.equal(invalid, 2)
    assert.equal(stale, 1)
  }
)

test(
  '绑定的 terminal 流接受真实 frame 与 resync，拒绝 shape-only/错来源/错身份',
  /* 验证终端流接收真实帧和重新同步通知，并拒绝未绑定证明及错误来源或身份。 */ () => {
    const v = view()
    const open = request(v, {
      id: 'open',
      method: 'terminal.backend.control',
      params: { server_generation: G, terminal_id: T, pane_id: '3' }
    })
    const permit = unwrap(checkDispatch(open, auth(open)))
    const ack = {
      id: 'open',
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
        loss_behavior: 'resync_required_then_close'
      }
    }
    rejects(
      validator.openStream(permit, unwrap(validator.checkResponseShape(ack, 'terminal'))),
      'invalid_stream_context'
    )
    const checked = unwrap(validator.checkResponse(permit, ack, sourceFor(open.binding)))
    const stream = unwrap(validator.openStream(permit, checked))
    const frame = {
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
        truncated: false
      }
    }
    assert.equal(unwrap(validator.checkEvent(stream, frame, sourceFor(open.binding))).event.sequence, 0)
    const resync = {
      event: 'terminal.resync_required',
      sequence: 1,
      data: { reason: 'subscriber_overflow' }
    }
    assert.equal(unwrap(validator.checkEvent(stream, resync, sourceFor(open.binding))).requires_resync, true)
    const stale = clone(frame)
    stale.data.terminal_id = '9'.repeat(32)
    rejects(validator.checkEvent(stream, stale, sourceFor(open.binding)), 'native_identity_mismatch')
    rejects(
      validator.checkEvent(stream, frame, { ...sourceFor(open.binding), source_verified: false }),
      'native_source_untrusted'
    )
    const input = unwrap(
      validator.checkControl(stream, {
        id: 'in1',
        action: 'type_literal',
        params: { text: 'synthetic' }
      })
    )
    // open 的分类不自动给子动作许可。
    const contextual = { ...auth(open), source: sourceFor(input.binding) }
    rejects(checkDispatch(input, contextual), 'safety_classification_missing')
  }
)

test(
  'UTF-8/重复键/整数精度/深度及无行为对象边界',
  /* 覆盖解析的编码、重复键、精度与资源边界，并验证校验不会读取行为属性。 */ () => {
    assert.deepEqual(unwrap(parseNativeJson('{"__proto__":{"safe":true}}')), JSON.parse('{"__proto__":{"safe":true}}'))
    rejects(parseNativeJson('{"id":"a","id":"b"}'), 'duplicate_json_key')
    rejects(parseNativeJson(new Uint8Array([0xff])), 'invalid_utf8')
    rejects(parseNativeJson('{"sequence":9007199254740993}'), 'json_number_precision')
    rejects(parseNativeJson('"\\ud800"'), 'invalid_json')
    rejects(parseNativeJson('['.repeat(65) + '0' + ']'.repeat(65)), 'object_limit')
    const input: any = { id: 'no-getter', method: 'ping', params: {} }
    Object.defineProperty(input.params, 'trap', {
      enumerable: true,
      // 一旦访问测试属性即抛错，用于证明快照不会执行 getter。
      get() {
        throw Error('执行了 getter')
      }
    })
    rejects(validator.checkRequest(view(), input), 'invalid_json')
    const array: any[] = []
    Object.defineProperty(array, 'hidden', { value: true })
    rejects(validator.checkRequest(view(), { id: 'hidden', method: 'ping', params: { array } }), 'invalid_json')
    rejects(checkSequence(1, 1), 'duplicate_stream_frame')
    rejects(checkSequence(1, 3), 'resync_required')
    unwrap(checkSequence(1, 2))
  }
)

test(
  '许可/上下文不能通过 JSON 复制，普通 error.data 原样保存且结果重授权',
  /* 验证 JSON 复制无法伪造许可，错误数据保持原样且结果读取须重新授权。 */ () => {
    const v = view()
    const checked = request(v, {
      id: 'prompt',
      method: 'agent.prompt',
      params: { target: '3', text: 'synthetic' }
    })
    rejects(checkDispatch(clone(checked), auth(checked)), 'invalid_request_handle')
    const permit = unwrap(checkDispatch(checked, auth(checked)))
    const error = {
      id: 'prompt',
      error: {
        code: 'synthetic_extension',
        message: 'synthetic',
        data: { a: [{ keep: true }] },
        extension: true
      }
    }
    assert.deepEqual(unwrap(validator.checkResponse(permit, error, sourceFor(checked.binding))).response, error)
    const resultContext = {
      principal_id: 'synthetic',
      caller_policy_allowed: true,
      local_policy_allowed: true,
      classification_source_verified: true,
      classification_revision: checked.binding.classification_revision,
      channel: 'ordinary' as const,
      content_status: 'available' as const
    }
    unwrap(checkResultBoundary(permit, resultContext))
    rejects(checkResultBoundary(permit, { ...resultContext, caller_policy_allowed: false }), 'forbidden')
    rejects(checkResultBoundary(permit, { ...resultContext, content_status: 'discarded' }), 'content_unavailable')
    rejects(checkResultBoundary(permit, { ...resultContext, classification_revision: 'changed' }), 'capability_stale')
    rejects(
      checkResultBoundary(permit, { ...resultContext, classification_source_verified: false }),
      'safety_classification_untrusted'
    )
    rejects(validator.checkResponse(clone(permit), error, sourceFor(checked.binding)), 'invalid_permit_handle')
  }
)
