/** 单文件中的真实 schema 工厂验收：仅使用版本化离线 fixture，不建立设备或授权。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import schema from '../fixtures/luvus/0.14.3/linux/schema-bundle.json' with { type: 'file' }
import { compileBundle, createNativeValidator } from '../../src/native-contract/index.ts'
import { createHash } from 'node:crypto'
import herdrSchema from '../fixtures/herdr/0.9.5/schema.json' with { type: 'file' }
import { compileHerdrSchemas, isCompiledHerdrSchemas } from '../../src/connector/herdr/compiler-api.ts'

const bytes = readFileSync(schema)
const compiled = await compileBundle(bytes, {
  identity: {
    binary_sha256: '895073022da8edd231c9d4c810d68627b954b61e4e9f9f2d5d19e2c2fcf282a9',
    schema_sha256: createHash('sha256').update(bytes).digest('hex'),
    revision: 'standalone-packaging-probe'
  }
})
assert(compiled.ok, JSON.stringify(compiled))
assert.equal(compiled.value.documents.length, 29)
const error = { id: 'packaging', error: { code: 'synthetic', message: 'synthetic', data: { preserved: true } } }
const checked = createNativeValidator(compiled.value).checkResponseShape(error)
assert(checked.ok, JSON.stringify(checked))
assert.deepEqual(checked.value.response, error)
// 同一个可执行文件同时携带两种固定 Worker；Herdr 不经过 UHP 转写。
const herdr = await compileHerdrSchemas(readFileSync(herdrSchema))
assert(isCompiledHerdrSchemas(herdr))
assert(!isCompiledHerdrSchemas({ ...herdr }))
assert(herdr.request({ id: 'packaging', method: 'ping', params: {} }))
assert(!herdr.request({ id: 'packaging', method: 'unknown', params: {} }))
assert(herdr.response({ id: 'packaging', result: { type: 'pong', version: '0.9.5', protocol: 22 } }))
assert(herdr.response({ id: 'packaging', error: { code: 'synthetic', message: 'synthetic' } }))
assert(!herdr.response({ id: 'packaging', result: {} }))
console.log(
  JSON.stringify({
    scope: 'native-contract-probe',
    documents: 29,
    errorDataPreserved: true,
    herdr: { version: '0.9.5', originalRoots: true, compiledBrand: true }
  })
)
