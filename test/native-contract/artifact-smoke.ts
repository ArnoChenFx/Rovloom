// 独立导入 Bun 构建的 ESM 产物，验证公开导出、完整契约编译及原生错误数据保真。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

// 单独导入 Bun 构建产物，不以直接导入 TS 冒充产物 smoke。
const artifact = process.argv[2]
assert(artifact, '需要指定本次构建的本地 ESM 产物')
const api = (await import(pathToFileURL(resolve(artifact)).href)) as typeof import('../../src/native-contract/index.js')
assert.deepEqual(Object.keys(api).sort(), [
  'DEFAULT_LIMITS',
  'checkDispatch',
  'checkResultBoundary',
  'checkSequence',
  'compileBundle',
  'compileBundleIsolated',
  'createNativeValidator',
  'inspectRequestGate',
  'parseNativeJson',
  'releaseCompiledContract'
])
const bytes = readFileSync(new URL('../../fixtures/p0/linux-luvus-0.14.3/schema-bundle.json', import.meta.url))
const identity = {
  binary_sha256: '895073022da8edd231c9d4c810d68627b954b61e4e9f9f2d5d19e2c2fcf282a9',
  schema_sha256: createHash('sha256').update(bytes).digest('hex'),
  revision: 'artifact-smoke'
}
const compiled = api.compileBundle(bytes, { identity })
assert(compiled.ok, JSON.stringify(compiled))
assert.equal(compiled.value.documents.length, 29)
const error = {
  id: 'smoke',
  error: { code: 'synthetic', message: 'synthetic', data: { preserve: true } }
}
const checked = api.createNativeValidator(compiled.value).checkResponseShape(error)
assert(checked.ok, JSON.stringify(checked))
assert.deepEqual(checked.value.response, error)
console.log(
  JSON.stringify({
    artifact: 'Bun ESM native-contract',
    exports: Object.keys(api).length,
    documents: compiled.value.documents.length,
    native_error_data_preserved: true
  })
)
