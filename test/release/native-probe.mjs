/** 单文件中的真实 schema 工厂验收：仅使用版本化离线 fixture，不建立设备或授权。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import schema from '../fixtures/luvus/0.14.3/linux/schema-bundle.json' with { type: 'file' }
import { compileBundle, createNativeValidator } from '../../src/native-contract/index.ts'
import { createHash } from 'node:crypto'

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
console.log(JSON.stringify({ scope: 'native-contract-probe', documents: 29, errorDataPreserved: true }))
