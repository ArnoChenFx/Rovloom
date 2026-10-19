/** 回放自有真实 MCP 工作流的脱敏原生交换；离线回放不替代再次运行真实宿主或模型对话。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createHerdrCodec } from '../../../src/connector/herdr/readonly.js'
import { fixedHerdrSource } from '../../../src/connector/herdr/review.js'
import { object } from '../../../src/wire/index.js'
import { schemas } from './helpers.js'

test(
  'owned OpenCode launch and readiness remain native state without a conversation or reply receipt',
  /** 第二个独立实例的真实脱敏样本不能与管理实例拼接共同序号。 */ () => {
    const fixture = JSON.parse(
      readFileSync(new URL('../../fixtures/herdr/0.9.5/agent-startup.json', import.meta.url), 'utf8')
    )
    const source = fixedHerdrSource()
    assert.equal(fixture.provenance.binary_sha256, source.binary_sha256)
    assert.equal(fixture.provenance.schema_sha256, source.schema_sha256)
    const codec = createHerdrCodec(source, schemas)
    for (const { request, response } of fixture.exchanges) {
      assert.equal(schemas.request(request), true)
      assert.deepEqual(codec.decode(Buffer.from(JSON.stringify(response) + '\n'), request), response)
    }
    const started = fixture.exchanges[0].response.result.agent
    const ready = fixture.exchanges[1].response.result.agent
    assert.equal(started.launch_pending, true)
    assert.equal(started.agent, undefined)
    assert.equal(ready.interactive_ready, true)
    assert.equal(ready.agent, 'opencode')
    assert.equal(ready.terminal_id, started.terminal_id)
    assert.equal(ready.agent_session, undefined)
  }
)

test(
  'owned native management exchanges preserve original request roots, response variants and IDs',
  /** 仅回放必要原生数据，不从 fixture 建立本机安装或权限。 */ () => {
    const fixture = JSON.parse(
      readFileSync(new URL('../../fixtures/herdr/0.9.5/workflow.json', import.meta.url), 'utf8')
    )
    const source = fixedHerdrSource()
    assert.equal(fixture.provenance.binary_sha256, source.binary_sha256)
    assert.equal(fixture.provenance.schema_sha256, source.schema_sha256)
    const codec = createHerdrCodec(source, schemas)
    for (const { request, response } of fixture.exchanges) {
      assert.equal(schemas.request(request), true)
      assert.equal(schemas.response(response), true)
      assert.deepEqual(JSON.parse(Buffer.from(codec.encode(request)).toString('utf8')), request)
      assert.deepEqual(codec.decode(Buffer.from(JSON.stringify(response) + '\n'), request), response)
    }
    const input = fixture.exchanges.find(
      /** 输入方法只认官方精确名称。 */ (entry: { request: { method: string } }) =>
        entry.request.method === 'pane.send_text'
    )
    const output = fixture.exchanges.find(
      /** 可见输出使用不主动滚动的原生 source。 */ (entry: { request: { method: string } }) =>
        entry.request.method === 'pane.read'
    )
    const expected = 'owned-0123456789abcdef'
    assert.equal(input.request.params.text.includes(expected), false)
    assert.equal(object(object(output.response.result).read).source, 'visible')
    assert.equal(String(object(object(output.response.result).read).text).includes(expected), true)
  }
)
