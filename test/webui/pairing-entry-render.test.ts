// 配对条目渲染签名：内容未变时跳过重建（保住复制申请编号的选区），展示相关字段变化必须改变签名。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { entryRenderSignature } from '../../src/webui/pairing-actions.js'
import type { UiLanguage } from '../../src/webui/i18n.js'

/** 只填签名消费的展示字段；DOM 节点字段不在签名输入内。 */
type SignatureEntry = Parameters<typeof entryRenderSignature>[1]

function entry(overrides: Partial<SignatureEntry> = {}): SignatureEntry {
  return {
    name: 'workstation',
    machine_id: 'm_1',
    pairing_id: 'pairing_1',
    status: 'pending',
    claim: { claim_id: 'claim_1', user_code: 'ABCD1234', status: 'pending', expires_at: 1 },
    ...overrides
  }
}

test('signature stays identical while displayed pairing state is unchanged', () => {
  const language: UiLanguage = 'zh-CN'
  assert.equal(entryRenderSignature(language, entry()), entryRenderSignature(language, entry()))
  // 缺省认领与显式 undefined 等价，条目创建与轮询间不产生无差别重绘。
  const absent = entry({ claim: undefined })
  assert.equal(entryRenderSignature(language, absent), entryRenderSignature(language, absent))
})

test('signature changes exactly when a displayed field changes', () => {
  const base = entryRenderSignature('zh-CN', entry())
  assert.notEqual(entryRenderSignature('zh-CN', entry({ name: 'other' })), base)
  assert.notEqual(entryRenderSignature('zh-CN', entry({ status: 'paired' })), base)
  assert.notEqual(entryRenderSignature('zh-CN', entry({ pairing_id: 'pairing_2' })), base)
  assert.notEqual(entryRenderSignature('zh-CN', entry({ machine_id: 'm_2' })), base)
  assert.notEqual(
    entryRenderSignature(
      'zh-CN',
      entry({ claim: { claim_id: 'c', user_code: 'ABCD1234', status: 'approved', expires_at: 1 } })
    ),
    base
  )
  assert.notEqual(
    entryRenderSignature(
      'zh-CN',
      entry({ claim: { claim_id: 'c', user_code: 'FFFF0000', status: 'pending', expires_at: 1 } })
    ),
    base
  )
  assert.notEqual(
    entryRenderSignature(
      'zh-CN',
      entry({
        claim: { claim_id: 'c', user_code: 'ABCD1234', status: 'approved', expires_at: 1, activation: 'configured' }
      })
    ),
    base
  )
  assert.notEqual(entryRenderSignature('en', entry()), base)
})
