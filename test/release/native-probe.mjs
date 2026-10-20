/** 单文件中的真实 schema 工厂验收：仅使用版本化离线 fixture，不建立设备或授权。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import schema from '../fixtures/luvus/0.14.3/linux/schema-bundle.json' with { type: 'file' }
import { compileBundle, createNativeValidator } from '../../src/native-contract/index.ts'
import { createHash, randomUUID } from 'node:crypto'
import { unknownSchemaBundle } from '../native-contract/unknown-schema-fixture.ts'
import herdrSchema from '../fixtures/herdr/0.9.5/schema.json' with { type: 'file' }
import { compileHerdrSchemas, isCompiledHerdrSchemas } from '../../src/connector/herdr/compiler-api.ts'

const bytes = readFileSync(schema)
const identity = {
  binary_sha256: '895073022da8edd231c9d4c810d68627b954b61e4e9f9f2d5d19e2c2fcf282a9',
  schema_sha256: createHash('sha256').update(bytes).digest('hex'),
  revision: 'standalone-packaging-probe'
}
const compiled = await compileBundle(bytes, { identity })
assert(compiled.ok, JSON.stringify(compiled))
assert.equal(compiled.value.documents.length, 29)
const error = { id: 'packaging', error: { code: 'synthetic', message: 'synthetic', data: { preserved: true } } }
const checked = createNativeValidator(compiled.value).checkResponseShape(error)
assert(checked.ok, JSON.stringify(checked))
assert.deepEqual(checked.value.response, error)
// 这个测试 Worker 导入生产消息处理器，仅封死其 Ajv 方法；缺嵌入资产就不能生成结果。
const worker = new Worker(new URL('./precompiled-worker.ts', import.meta.url).href, { smol: true })
let timer
try {
  const artifact = await new Promise(
    /* 探针也用 2 秒观察上限，不把诊断或构建预算当产品预算。 */ (resolve, reject) => {
      timer = setTimeout(/* 禁止测试悬挂。 */ () => reject(new Error('precompiled probe timeout')), 2000)
      worker.onerror = /* 只返回固定故障，不输出生成源码。 */ (event) => {
        event.preventDefault()
        reject(new Error('precompiled probe failed'))
      }
      worker.onmessage = /* 仅检查生成物是否成功，不把原文写入 stdout。 */ ({ data }) => resolve(data.result)
      worker.postMessage({ version: 1, job_id: randomUUID(), bytes, options: { identity } })
    }
  )
  assert(artifact.ok, JSON.stringify(artifact))
  assert.equal(artifact.value.documents.length, 29)
  assert.equal(artifact.value.schemas.length, 92)
} finally {
  clearTimeout(timer)
  worker.terminate()
}
// 未知原字节必须真实进入完整 Worker；坏输入后仍能接纳合法根，不能只证明固定资产可用。
const malformed = await compileBundle('{}', {
  identity: { ...identity, schema_sha256: createHash('sha256').update('{}').digest('hex') }
})
assert.equal(malformed.ok, false)
assert.equal(malformed.error.reason, 'invalid_schema')
const unknown = unknownSchemaBundle()
const unknownIdentity = { ...identity, schema_sha256: createHash('sha256').update(unknown).digest('hex') }
assert.notEqual(unknownIdentity.schema_sha256, identity.schema_sha256)
const unsupported = JSON.parse(unknown)
unsupported.documents[unsupported.request.$id].synthetic_future_keyword = true
const unsupportedBytes = JSON.stringify(unsupported)
const rejected = await compileBundle(unsupportedBytes, {
  identity: { ...identity, schema_sha256: createHash('sha256').update(unsupportedBytes).digest('hex') }
})
assert.equal(rejected.ok, false)
assert.equal(rejected.error.reason, 'unsupported_keyword')
const full = await compileBundle(unknown, { identity: unknownIdentity })
assert(full.ok, JSON.stringify(full))
assert.equal(full.value.documents.length, 9)
assert.deepEqual(full.value.identity, unknownIdentity)
const validator = createNativeValidator(full.value)
const unknownError = { id: 'unknown', error: { code: 'synthetic', message: '汉😀', data: { preserved: true } } }
const validated = validator.checkResponseShape(unknownError)
assert(validated.ok, JSON.stringify(validated))
assert.deepEqual(validated.value.response, unknownError)
assert.equal(
  validator.checkResponseShape({ ...unknownError, error: { ...unknownError.error, message: '汉😀a' } }).ok,
  false
)
assert.equal(
  validator.checkResponseShape({
    ...unknownError,
    error: { ...unknownError.error, data: { preserved: false } }
  }).ok,
  false
)
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
    precompiledEmbedded: true,
    unknownSchemaWorker: {
      documents: 9,
      malformedRejected: true,
      unknownKeywordRejected: true,
      helpersValidated: true
    },
    herdr: { version: '0.9.5', originalRoots: true, compiledBrand: true }
  })
)
