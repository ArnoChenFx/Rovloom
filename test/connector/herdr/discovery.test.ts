/** 用固定官方 schema 验证 MCP 方法描述的参数引用闭包，描述不替代执行门禁。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { describeHerdrContract, describeHerdrParams } from '../../../src/connector/herdr/discovery.js'
import type { JsonObject } from '../../../src/wire/types.js'
import { schemas, source } from './helpers.js'

test(
  'Herdr discovery exposes native frame limits and distinguishes line windows from pagination',
  /** 固定 schema 没有分页参数；描述只声明现存限制，不新增 cursor 或将行数当作字节保证。 */ () => {
    const description = describeHerdrContract({
      target: { machine_id: 'owned', provider_id: 'herdr', profile: 'session', session: 'owned' },
      binding_revision: 1,
      source,
      document,
      source_basis: 'configured_connector_contract'
    })
    assert.equal(description.methods.length, 65)
    for (const method of description.methods) {
      assert.equal(method.limits.request_frame_bytes, 65_536)
      assert.equal(method.limits.response_frame_bytes, 65_536)
      assert.equal(method.limits.frame_size_basis, 'utf8_json_including_lf')
      assert.equal(method.limits.response_pagination, 'unavailable')
      assert.equal(method.limits.response_objects, false)
      if (method.method === 'pane.read' || method.method === 'agent.read') {
        assert.deepEqual(method.limits.line_window, {
          parameter: 'lines',
          selection: 'last_lines',
          native_max_lines: 1000,
          guarantees_frame_fit: false
        })
      }
    }
  }
)

const document = JSON.parse(
  readFileSync(new URL('../../fixtures/herdr/0.9.5/schema.json', import.meta.url), 'utf8')
) as JsonObject

test(
  'Herdr discovery isolates unresolved and constrained reference branches without changing the document',
  /** 展示提取不读取外部引用、不递归循环，也不丢弃引用旁的额外断言。 */ () => {
    for (const replacement of [
      { $ref: 'https://synthetic.invalid/request.json' },
      { $ref: '#/schemas/request/$defs/missing' },
      { $ref: '#/schemas/request/$defs/cycle' },
      { $ref: '#/schemas/request/$defs/original', not: {} }
    ]) {
      const changed: any = structuredClone(document)
      const request = changed.schemas.request
      const index = request.oneOf.findIndex(
        /** 只替换可选等待方法。 */ (branch: any) => branch.properties.method.const === 'agent.wait'
      )
      request.$defs.original = request.oneOf[index]
      request.$defs.cycle = { $ref: '#/schemas/request/$defs/cycle' }
      request.oneOf[index] = replacement
      const before = JSON.stringify(changed)
      const catalog = describeHerdrContract({
        target: { machine_id: 'synthetic', provider_id: 'synthetic', profile: 'session', session: 'synthetic' },
        binding_revision: 1,
        source,
        document: changed,
        source_basis: 'configured_connector_contract'
      })
      assert(catalog.methods.some(/** 健康方法不受不可解析分支影响。 */ (method) => method.method === 'ping'))
      assert(!catalog.methods.some(/** 无法准确描述的方法不进入目录。 */ (method) => method.method === 'agent.wait'))
      assert.equal(JSON.stringify(changed), before)
    }
  }
)

for (const [method, valid, invalid] of [
  [
    'agent.prompt',
    { target: 'reviewer', text: 'hello', wait: { until: ['idle'], timeout_ms: 60000 } },
    { text: 'hello' }
  ],
  ['agent.start', { name: 'reviewer', kind: 'opencode', pane_id: 'w1:p1' }, { name: 'reviewer', kind: 'opencode' }],
  ['pane.send_input', { pane_id: 'w1:p1', text: 'hello', keys: ['enter'] }, { pane_id: 42 }],
  [
    'layout.apply',
    { root: { type: 'pane', cwd: '/synthetic' } },
    { root: { type: 'split', direction: 'right', ratio: 0.5 } }
  ]
] as const) {
  test(
    `installed ${method} parameters remain self-contained and agree with the complete native request root`,
    /** 实际执行仍核完整 request 根；方法描述须准确保留必填项、嵌套结构与递归引用。 */ () => {
      const before = JSON.stringify(document)
      const description = describeHerdrParams(document, method)
      const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(description)
      assert.equal(validate(valid), true, JSON.stringify(validate.errors))
      assert.equal(schemas.request({ id: 'discovery', method, params: valid }), true)
      assert.equal(validate(invalid), false)
      assert.equal(schemas.request({ id: 'discovery', method, params: invalid }), false)
      assert.equal(JSON.stringify(document), before)
      assert(!JSON.stringify(description).includes('#/schemas/request/'))
    }
  )
}
