// 用真实原生契约校验器验证仅响应句柄的最小保留、身份绑定及不可执行边界。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkDispatch,
  checkResultBoundary,
  compileBundle,
  createNativeValidator
} from '../../src/native-contract/index.js'
import type { DispatchCandidate, DispatchPermit, CheckedResponse } from '../../src/native-contract/index.js'
import { candidates, permits, responses, responseContexts } from '../../src/native-contract/internal.js'
import {
  auth,
  bytes,
  clone,
  G,
  identity,
  json,
  rejects,
  request,
  source,
  sourceFor,
  T,
  unwrap,
  validator,
  view
} from './helpers.js'

// 经过真实能力、请求和派发授权生成 RPC 许可，供密封与释放测试使用。
function dispatched(
  method = 'task.add',
  params: Record<string, unknown> = { title: 'synthetic', prompt: 'synthetic-request-secret' }
) {
  const candidate = request(view(), { id: 'response-context', method, params })
  const authorization = auth(candidate)
  const permit = unwrap(checkDispatch(candidate, authorization))
  return { candidate, permit, authorization, source: sourceFor(candidate.binding) }
}

test(
  '持有已校验 RPC 响应不会反向保留原请求，释放后仅响应密封句柄仍可校验',
  // 保留响应对象并检查真实私有登记，确保释放不依赖该对象恰好已被 GC。
  () => {
    const original = dispatched()
    const checked = unwrap(
      validator.checkResponse(original.permit, { id: 'response-context', result: { id: 'synthetic' } }, original.source)
    )
    const sealed = unwrap(validator.sealResponseContext(original.permit))
    unwrap(validator.releaseRequestContext(original.permit))
    assert.equal(responses.get(checked)!.candidate, null)
    assert.equal(responses.get(checked)!.permit, null)
    assert.equal(checked.response.id, 'response-context')
    assert.equal(unwrap(validator.checkResponseOnly(sealed, checked.response, original.source)), undefined)
    unwrap(validator.releaseResponseContext(sealed))
  }
)

test(
  '同一 RPC 候选的其它真实许可随释放一起撤销，不继续强引原文或保留读取权限',
  // 对一个候选签发两份许可，只释放第一份后核对第二份已无内部正文、响应和读取能力。
  () => {
    const original = dispatched()
    const second = unwrap(checkDispatch(original.candidate, original.authorization))
    unwrap(validator.releaseRequestContext(original.permit))
    assert.equal(permits.get(second), undefined)
    assert.equal(permits.has(second), false)
    rejects(
      validator.checkResponse(second, { id: 'response-context', result: {} }, original.source),
      'invalid_permit_handle'
    )
    rejects(checkResultBoundary(second, {} as never), 'invalid_permit_handle')
    rejects(validator.releaseRequestContext(second), 'invalid_permit_handle')
  }
)

test(
  '真实 permit seal 后只保留最小响应约束，释放请求并验证 metadata-only，不授予执行或读取',
  /* 密封并释放真实请求后核对私有保留字段，分别尝试读取、派发和开流以证明权限没有随元数据保留。 */ () => {
    const original = dispatched()
    const sealed = unwrap(validator.sealResponseContext(original.permit))
    const retained = responseContexts.get(sealed)!
    assert(sealed.retained_bytes > 0)
    assert(!JSON.stringify(retained).includes('synthetic-request-secret'))
    for (const forbidden of ['request', 'params', 'permit', 'candidate', 'capabilities', 'view']) {
      assert(!Object.hasOwn(retained, forbidden))
    }
    unwrap(validator.releaseRequestContext(original.permit))
    assert(!candidates.has(original.candidate))
    assert(!permits.has(original.permit))
    const response = { id: 'response-context', result: { text: 'synthetic-output-secret' } }
    assert.equal(unwrap(validator.checkResponseOnly(sealed, response, original.source)), undefined)
    assert(!JSON.stringify(sealed).includes('synthetic-output-secret'))
    rejects(validator.checkResponse(original.permit, response, original.source), 'invalid_permit_handle')
    rejects(checkDispatch(sealed as unknown as DispatchCandidate, original.authorization), 'invalid_request_handle')
    rejects(checkResultBoundary(sealed as unknown as DispatchPermit, {} as never), 'invalid_permit_handle')
    rejects(validator.openStream(sealed as unknown as DispatchPermit, {} as CheckedResponse), 'invalid_stream_context')
    rejects(validator.checkResponseOnly(clone(sealed), response, original.source), 'invalid_response_context')
    unwrap(validator.releaseResponseContext(sealed))
    rejects(validator.checkResponseOnly(sealed, response, original.source), 'invalid_response_context')
  }
)

test(
  '仅响应上下文逐项复核完整原生来源、原 ID 和原契约，不从同摘要重建',
  /* 逐一篡改原生绑定、请求 ID 与契约对象，确认密封上下文只认可原句柄及独立真实来源。 */ () => {
    const original = dispatched()
    const sealed = unwrap(validator.sealResponseContext(original.permit))
    const response = { id: 'response-context', result: { id: 'task-created' } }
    for (const field of [
      'provider_id',
      'connection_epoch',
      'recovery_generation',
      'contract_source_ref',
      'capability_revision',
      'classification_revision'
    ] as const) {
      const changed = clone(original.source)
      Object.assign(changed.binding, { [field]: 'different' })
      rejects(validator.checkResponseOnly(sealed, response, changed), 'native_identity_mismatch')
    }
    const changedRevision = { ...original.source, binding: { ...original.source.binding, binding_revision: '1' } }
    rejects(validator.checkResponseOnly(sealed, response, changedRevision), 'native_identity_mismatch')
    rejects(
      validator.checkResponseOnly(sealed, { ...response, id: 'different' }, original.source),
      'native_id_mismatch'
    )
    rejects(
      validator.checkResponseOnly(sealed, response, { ...original.source, source_verified: false }),
      'native_source_untrusted'
    )
    const other = createNativeValidator(unwrap(compileBundle(bytes, { identity })))
    rejects(other.sealResponseContext(original.permit), 'invalid_capability_handle')
    rejects(other.checkResponseOnly(sealed, response, original.source), 'invalid_response_context')
    unwrap(validator.releaseRequestContext(original.permit))
    unwrap(validator.releaseResponseContext(sealed))
  }
)

test(
  'seal 固定在线帧预算含 LF，原 capabilities 释放后仍检查精确字节边界',
  /* 在含多字节字符的响应上设置含 LF 的精确帧边界，释放能力视图后仍拒绝越界字节。 */ () => {
    const response = { id: 'frame-context', result: { text: '汉😀'.repeat(80) } }
    const frameBytes = Buffer.byteLength(JSON.stringify(response)) + 1
    for (const maxBytes of [frameBytes, frameBytes - 1]) {
      const caps = json('session-capabilities.json')
      caps.result.session = 'synthetic'
      caps.result.server_generation = G
      caps.result.limits.frame_bytes = maxBytes
      const from = unwrap(validator.bindCapabilities(caps, source()))
      const candidate = request(from, { id: 'frame-context', method: 'task.add', params: { title: 's' } })
      const permit = unwrap(checkDispatch(candidate, auth(candidate)))
      const sealed = unwrap(validator.sealResponseContext(permit))
      unwrap(validator.releaseRequestContext(permit))
      caps.result.limits.frame_bytes = 1_048_576
      const checked = validator.checkResponseOnly(sealed, response, sourceFor(candidate.binding))
      if (maxBytes === frameBytes) {
        unwrap(checked)
      } else {
        rejects(checked, 'native_response_invalid')
      }
      unwrap(validator.releaseResponseContext(sealed))
    }
  }
)

test('终端 RPC 最小 matcher 保留原生 ID 约束与 method-result，不能 seal 流或控制许可', (
  /* 用终端快照 RPC 核验结果类型和 generation，并证明流许可及控制许可不能密封成 RPC 上下文。 */
) => {
  const original = dispatched('terminal.backend.snapshot', {})
  const sealed = unwrap(validator.sealResponseContext(original.permit))
  unwrap(validator.releaseRequestContext(original.permit))
  const response = {
    id: 'response-context',
    result: {
      type: 'terminal_backend_snapshot',
      server_generation: G,
      event_sequence: 0,
      terminals: [],
      truncated: false
    }
  }
  unwrap(validator.checkResponseOnly(sealed, response, original.source))
  rejects(
    validator.checkResponseOnly(
      sealed,
      { ...response, result: { ...response.result, server_generation: '2'.repeat(32) } },
      original.source
    ),
    'native_identity_mismatch'
  )
  rejects(
    validator.checkResponseOnly(
      sealed,
      { ...response, result: { type: 'terminal_backend_validation', state: 'alive' } },
      original.source
    ),
    'native_result_mismatch'
  )
  unwrap(validator.releaseResponseContext(sealed))
  const stream = dispatched('terminal.backend.control', { server_generation: G, terminal_id: T, pane_id: '3' })
  rejects(validator.sealResponseContext(stream.permit), 'response_context_unavailable')
  rejects(validator.releaseRequestContext(stream.permit), 'response_context_unavailable')
})
