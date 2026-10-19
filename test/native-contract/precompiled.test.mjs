// 验证固定资产完整语义、运行时预检、失配回退及构建来源边界，不读取真实安装或业务状态。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { compileArtifact } from '../../src/native-contract/compiler-core.ts'
import { precompiledArtifact, verifyPrecompiled } from '../../src/native-contract/precompiled.ts'
import { PRECOMPILED_ASSETS } from '../../src/native-contract/generated/catalog.ts'
import { compileBundle, createNativeValidator } from '../../src/native-contract/index.ts'
import { DEFAULT_LIMITS, hash } from '../../src/native-contract/json.ts'
import { approvedInput, checkGenerated, precompile } from '../../scripts/native-contract/precompile.mjs'
import { unknownSchemaBundle } from './unknown-schema-fixture.ts'

const input = JSON.parse(
  readFileSync(new URL('../../scripts/native-contract/precompiled-inputs.json', import.meta.url))
)[0]
const bytes = readFileSync(new URL('../fixtures/luvus/0.14.3/linux/schema-bundle.json', import.meta.url))
const identity = { binary_sha256: input.binary_sha256, schema_sha256: hash(bytes), revision: 'precompiled-regression' }
const entry = PRECOMPILED_ASSETS[0]

// 复制固定纯 JSON，仅用于故障注入，不将副本作为公开可加载资产。
function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

test(
  '构建期完整重新编译与已提交资产逐字节一致',
  { timeout: 40_000 },
  /* 构建 Worker 无资产查询端口，不能用待检查资产证明自己正确。 */ async () => {
    const checked = await precompile()
    assert.equal(checked.assets, 1)
    const artifact = verifyPrecompiled(entry)
    assert.equal(artifact.documents.length, 29)
    assert.equal(artifact.request_methods.length, 223)
    assert.equal(artifact.schemas.length, 92)
  }
)

test(
  '精确资产命中不调用 Ajv，binary/原字节摘要失配仍进入完整编译',
  /* 封死编译入口证明复用路径；失配必须触发真实编译入口，不能套用旧函数。 */ () => {
    const original = Ajv2020.prototype.addSchema
    let calls = 0
    Ajv2020.prototype.addSchema = /* 此异常只属于测试编译探针。 */ () => {
      calls++
      throw new Error('test compiler denied')
    }
    try {
      const hit = compileArtifact(bytes, { identity }, precompiledArtifact)
      assert(hit.ok)
      assert.equal(calls, 0)
      assert.equal(hit.value.code, verifyPrecompiled(entry).code)
      assert.deepEqual(hit.value.identity, identity)
      const missed = compileArtifact(
        bytes,
        { identity: { ...identity, binary_sha256: 'f'.repeat(64) } },
        precompiledArtifact
      )
      assert.equal(missed.ok, false)
      assert(calls > 0)
      const previousCalls = calls
      const differentBytes = Buffer.concat([bytes, Buffer.from('\n')])
      const differentSchema = compileArtifact(
        differentBytes,
        { identity: { ...identity, schema_sha256: hash(differentBytes) } },
        precompiledArtifact
      )
      assert.equal(differentSchema.ok, false)
      assert(calls > previousCalls)
      assert.equal(precompiledArtifact({ ...identity, schema_sha256: 'e'.repeat(64) }, DEFAULT_LIMITS), undefined)
    } finally {
      Ajv2020.prototype.addSchema = original
    }
  }
)

test(
  '命中前仍逐次执行预算、原字节和引用闭包检查，不能用 schema 自报摘要放行',
  /* 查询计数必须为零，独立于资产快照是否已在本 Worker 缓存。 */ () => {
    let calls = 0
    const lookup = /* 完整预检通过后才允许触及资产。 */ (id, budget) => {
      calls++
      return precompiledArtifact(id, budget)
    }
    for (const limits of [
      { bundle_bytes: 8 },
      { bundle_nodes: 8 },
      { object_depth: 4 },
      { documents: 1 },
      { document_bytes: 8 },
      { references: 1 },
      { reference_depth: 1 }
    ]) {
      assert.equal(compileArtifact(bytes, { identity, limits }, lookup).ok, false)
    }
    assert.equal(compileArtifact(bytes, { identity: { ...identity, schema_sha256: '0'.repeat(64) } }, lookup).ok, false)
    for (const kind of ['keyword', 'ref', 'version']) {
      const bundle = JSON.parse(bytes)
      if (kind === 'keyword') {
        bundle.documents[bundle.request.$id].unreviewed_keyword = true
      }
      if (kind === 'ref') {
        bundle.documents[bundle.request.$id].$ref = 'https://untrusted.invalid/schema.json'
      }
      if (kind === 'version') {
        bundle.protocol.major = 999
      }
      bundle.schema_sha256 = identity.schema_sha256
      const encoded = JSON.stringify(bundle)
      assert.equal(
        compileArtifact(encoded, { identity: { ...identity, schema_sha256: hash(encoded) } }, lookup).ok,
        false
      )
    }
    assert.equal(calls, 0)
  }
)

test(
  '公共工厂保留调用 revision 与收紧后的同步对象预算，资产不是可复制权限',
  /* 2 秒公共接纳仍由原 SchemaCompiler 执行，运行时验证使用本次预算。 */ async () => {
    const compiled = await compileBundle(bytes, { identity, limits: { object_bytes: 128 } })
    assert(compiled.ok, JSON.stringify(compiled))
    assert.deepEqual(compiled.value.identity, identity)
    const validator = createNativeValidator(compiled.value)
    assert(validator.checkResponseShape({ id: 'small', result: {} }).ok)
    assert.equal(validator.checkResponseShape({ id: 'large', result: { text: 'x'.repeat(256) } }).ok, false)
    assert.throws(/* 复制生成物或公开描述不能恢复 WeakMap 登记。 */ () => createNativeValidator(clone(compiled.value)))
    const independent = await compileBundle(bytes, { identity, limits: { object_bytes: 128 } })
    assert(independent.ok, JSON.stringify(independent))
    assert.notEqual(independent.value, compiled.value)
  }
)

test(
  '未知原字节经真实 Worker 完整生成并保留完整根与两个 runtime helper',
  /* 小型合法未知契约保持两秒产品接纳上限，不用官方资产命中替代回退路径的成功证据。 */ async () => {
    const encoded = unknownSchemaBundle()
    const unknownIdentity = { ...identity, schema_sha256: hash(encoded) }
    assert.notEqual(unknownIdentity.schema_sha256, identity.schema_sha256)
    const compiled = await compileBundle(encoded, { identity: unknownIdentity })
    assert(compiled.ok, JSON.stringify(compiled))
    assert.equal(compiled.value.documents.length, 9)
    const validator = createNativeValidator(compiled.value)
    const error = { id: 'unknown', error: { code: 'synthetic', message: '汉😀', data: { preserved: true } } }
    const checked = validator.checkResponseShape(error)
    assert(checked.ok, JSON.stringify(checked))
    assert.deepEqual(checked.value.response, error)
    assert.equal(validator.checkResponseShape({ ...error, error: { ...error.error, message: '汉😀a' } }).ok, false)
    assert.equal(
      validator.checkResponseShape({ ...error, error: { ...error.error, data: { preserved: false } } }).ok,
      false
    )
  }
)

test(
  '损坏资产、未知版本和重算自报摘要不能越过独立构建目录',
  /* 同时覆盖代码和完整元数据，异常不得泄漏生成源码或私人路径。 */ () => {
    const mutations = [
      /* 不能解释未知资产格式。 */ (asset) => {
        asset.version = 999
      },
      /* 编译器实现摘要必须与独立目录一致。 */ (asset) => {
        asset.compiler_sha256 = '0'.repeat(64)
      },
      /* 同版本被替换的 Ajv 内容不能进入资产。 */ (asset) => {
        asset.ajv_sha256 = '0'.repeat(64)
      },
      /* 私有生成物版本不兼容时拒绝。 */ (asset) => {
        asset.artifact.version++
      },
      /* 未知生成器不能通过推断兼容。 */ (asset) => {
        asset.artifact.generator = 'future'
      },
      /* Ajv 版本必须精确匹配。 */ (asset) => {
        asset.artifact.ajv = '999.0.0'
      },
      /* options digest 必须绑定固定生成选项。 */ (asset) => {
        asset.artifact.options_sha256 = '0'.repeat(64)
      },
      /* 不接受另一个安装二进制的产物。 */ (asset) => {
        asset.artifact.identity.binary_sha256 = '0'.repeat(64)
      },
      /* 不接受另一个 schema 的产物。 */ (asset) => {
        asset.artifact.identity.schema_sha256 = '0'.repeat(64)
      },
      /* 代码与其自报 hash 同时更改仍不匹配独立资产摘要。 */ (asset) => {
        asset.artifact.code += '\nthrow Error("synthetic-private-code")'
        asset.artifact.code_sha256 = hash(asset.artifact.code)
      },
      /* 裁剪根文档不能只靠代码 hash 掩盖。 */ (asset) => {
        asset.artifact.documents.pop()
      },
      /* 裁剪事件导出同样改变完整资产摘要。 */ (asset) => {
        asset.artifact.schemas.pop()
      },
      /* 附加字段不作为前向兼容输入。 */ (asset) => {
        asset.future = true
      }
    ]
    for (const mutate of mutations) {
      const asset = clone(entry.asset)
      mutate(asset)
      assert.throws(
        /* 只使用测试内部 verifier；公共 API 没有资产注入端口。 */ () => verifyPrecompiled({ ...entry, asset }),
        /* 返回固定原因，不能把源码带入日志。 */ (error) =>
          error.failure?.reason === 'precompiled_asset_invalid' && !error.message.includes('synthetic-private-code')
      )
    }
  }
)

test(
  '生成器拒绝变更原字节、伪造收集记录和任意路径；检查模式拒绝缺失/额外/过期文件',
  /* 使用自建临时目录，故障不修改仓库或真实安装。 */ () => {
    const base = mkdtempSync(join(tmpdir(), 'rovloom-precompiled-'))
    try {
      const schema = join(base, input.schema)
      const environment = join(base, input.environment)
      mkdirSync(dirname(schema), { recursive: true })
      writeFileSync(schema, bytes)
      writeFileSync(environment, JSON.stringify({ binary_sha256: input.binary_sha256 }))
      assert.equal(approvedInput(input, base).identity.schema_sha256, identity.schema_sha256)
      writeFileSync(schema, Buffer.concat([bytes, Buffer.from('\n')]))
      assert.throws(/* 自报相同 hash 不能接受不同原字节。 */ () => approvedInput(input, base), /provenance mismatch/u)
      writeFileSync(schema, bytes)
      writeFileSync(environment, JSON.stringify({ binary_sha256: '0'.repeat(64) }))
      assert.throws(/* binary 来源必须与已审记录一致。 */ () => approvedInput(input, base), /provenance mismatch/u)
      for (const schema of ['../../private.json', 'https://untrusted.invalid/code.js', '/tmp/private.json']) {
        assert.throws(
          /* 目录外路径在任何读取前拒绝。 */ () => approvedInput({ ...input, schema }, base),
          /Invalid reviewed/u
        )
      }
      const directory = join(base, 'src/native-contract/generated')
      mkdirSync(directory, { recursive: true })
      const expected = new Map([['catalog.ts', '// 固定测试目录\n']])
      assert.throws(/* 缺失资产不能自动重建。 */ () => checkGenerated(expected, base))
      writeFileSync(join(directory, 'catalog.ts'), expected.get('catalog.ts'))
      checkGenerated(expected, base)
      writeFileSync(join(directory, 'extra.json'), '{}')
      assert.throws(/* 额外文件不能静默进入生成目录。 */ () => checkGenerated(expected, base))
      rmSync(join(directory, 'extra.json'))
      writeFileSync(join(directory, 'catalog.ts'), '// 已过期\n')
      assert.throws(/* 检查失败不写入或修复资产。 */ () => checkGenerated(expected, base))
      assert.equal(readFileSync(join(directory, 'catalog.ts'), 'utf8'), '// 已过期\n')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }
)
