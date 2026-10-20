/** 回放自有官方 Herdr 的最小脱敏元数据协议输入；fixture 不建立安装来源或执行许可。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createHerdrCodec, HERDR_READONLY_REVIEW } from '../../../src/connector/herdr/readonly.js'
import { reviewedHerdrRequest } from '../../../src/connector/herdr/methods.js'
import type { JsonObject } from '../../../src/wire/types.js'
import { schemas, source } from './helpers.js'

test(
  'recorded workspace metadata success, native stale-sequence Ok and error preserve original values',
  /** 核对固定来源后用完整 request/success/error 根回放，不从 Ok 或归档布尔值推导应用成功。 */ () => {
    const fixture = JSON.parse(
      readFileSync(new URL('../../fixtures/herdr/0.9.5/metadata.json', import.meta.url), 'utf8')
    )
    assert.equal(fixture.authorizes_dispatch, false)
    assert.equal(fixture.version, HERDR_READONLY_REVIEW.version)
    assert.equal(fixture.source.binary_sha256, HERDR_READONLY_REVIEW.binary_sha256)
    assert.equal(fixture.source.schema_sha256, HERDR_READONLY_REVIEW.schema_sha256)
    const codec = createHerdrCodec(source, schemas)
    for (const item of fixture.exchanges as { request: JsonObject; response: JsonObject }[]) {
      const { id: _id, ...request } = item.request
      assert(reviewedHerdrRequest(request))
      assert.deepEqual(JSON.parse(Buffer.from(codec.encode(item.request)).toString()), item.request)
      assert.deepEqual(codec.decode(Buffer.from(JSON.stringify(item.response) + '\n'), item.request), item.response)
    }
    const first = fixture.exchanges[0]
    const duplicate = fixture.exchanges[1]
    assert.equal(first.request.params.seq, duplicate.request.params.seq)
    assert.notDeepEqual(first.request.params.tokens, duplicate.request.params.tokens)
    assert.deepEqual(first.response.result, duplicate.response.result)
    assert.equal(fixture.exchanges[3].response.error.code, 'workspace_not_found')
  }
)

test(
  'workspace metadata accepts the installed schema without the former token and TTL subset',
  /** 验收输入的固定值不是产品限制；完整安装根仍接纳其它 source、多 token、长文本及可选期限。 */ () => {
    const codec = createHerdrCodec(source, schemas)
    const params = {
      workspace_id: 'owned-workspace',
      source: 'another-namespace',
      tokens: { another_token: ' 长文本 '.repeat(40), second_token: null }
    }
    for (const optional of [{}, { seq: null, ttl_ms: null }, { seq: 0, ttl_ms: 86_400_000 }]) {
      const request = {
        id: 'metadata-schema-regression',
        method: 'workspace.report_metadata',
        params: { ...params, ...optional }
      }
      assert(reviewedHerdrRequest({ method: request.method, params: request.params }))
      assert.deepEqual(JSON.parse(Buffer.from(codec.encode(request)).toString()), request)
    }
  }
)
