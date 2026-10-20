// 用正式离线原字节核对 Herdr 资产、真实构建编译、损坏及来源拒绝；不运行原生实例或授予身份。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { precompiledHerdrArtifact, verifyHerdrPrecompiled } from '../../../src/connector/herdr/precompiled.ts'
import { HERDR_PRECOMPILED } from '../../../src/connector/herdr/generated/catalog.ts'
import {
  approvedHerdrInput,
  checkHerdrGenerated,
  precompileHerdr
} from '../../../scripts/native-contract/precompile-herdr.mjs'

const raw = readFileSync(new URL('../../fixtures/herdr/0.9.5/schema.json', import.meta.url))
const provenance = readFileSync(new URL('../../fixtures/herdr/0.9.5/provenance.json', import.meta.url))

// 仅复制公开构建资产用于故障注入，不建立运行时产物加载入口。
function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

// 只对本测试修改的代码重新计算自报摘要，不能替代独立目录摘要。
function hash(value) {
  return createHash('sha256').update(value).digest('hex')
}

test(
  'Herdr 构建始终从正式原字节完整编译并核对固定资产',
  { timeout: 40_000 },
  /** 此构建 Worker 没有资产查询端口。 */ async () => {
    const result = await precompileHerdr()
    assert.equal(result.herdr.assets, 1)
    assert.equal(result.luvus.assets, 1)
    const artifact = verifyHerdrPrecompiled(HERDR_PRECOMPILED)
    assert.deepEqual(artifact.roots, ['request', 'success_response', 'error_response'])
    assert.equal(artifact.identity.schema_sha256, hash(raw))
  }
)

test(
  '精确 Herdr 资产接纳不调用 Ajv，修改原字节不得选择既有资产',
  /** 封死本测试进程编译入口，保留 Worker 与其他测试的实现。 */ () => {
    const keys = ['compile', 'addSchema', 'getSchema']
    const originals = keys.map(/** 保存原型以便所有路径恢复。 */ (key) => Ajv2020.prototype[key])
    let calls = 0
    try {
      for (const key of keys) {
        Ajv2020.prototype[key] = /** 任意重复编译立即失败。 */ () => {
          calls++
          throw new Error('test compiler forbidden')
        }
      }
      for (let i = 0; i < 3; i++) {
        const result = precompiledHerdrArtifact(raw)
        assert(result.ok)
        assert.equal(result.value.code_sha256, HERDR_PRECOMPILED.asset.artifact.code_sha256)
      }
      assert.deepEqual(precompiledHerdrArtifact(Buffer.concat([raw, Buffer.from(' ')])), {
        ok: false,
        reason: 'schema_digest_mismatch'
      })
      assert.equal(calls, 0)
    } finally {
      keys.forEach(
        /** 精确恢复本测试的原型包装。 */ (key, i) => {
          Ajv2020.prototype[key] = originals[i]
        }
      )
    }
  }
)

const corruptions = [
  /** 编译器实现来源不能用资产自报替换。 */ (entry) => {
    entry.asset.compiler_sha256 = 'a'.repeat(64)
  },
  /** Ajv 实际包来源必须与独立目录一致。 */ (entry) => {
    entry.asset.ajv_sha256 = 'a'.repeat(64)
  },
  /** 改变生成代码并更新自报摘要仍不能绕过独立资产摘要。 */ (entry) => {
    entry.asset.artifact.code += '\n// changed'
    entry.asset.artifact.code_sha256 = hash(entry.asset.artifact.code)
  },
  /** binary 评审身份不能由代码文件替换。 */ (entry) => {
    entry.asset.artifact.identity.binary_sha256 = 'a'.repeat(64)
  },
  /** 原始 schema 摘要必须固定。 */ (entry) => {
    entry.asset.artifact.identity.schema_sha256 = 'a'.repeat(64)
  },
  /** 不能把完整原生根替换为部分参数校验器。 */ (entry) => {
    entry.asset.artifact.roots.pop()
  },
  /** 生成选项及数值格式不可静默改变。 */ (entry) => {
    entry.asset.artifact.options_sha256 = 'a'.repeat(64)
  },
  /** 额外 envelope 字段不能建立兼容来源。 */ (entry) => {
    entry.asset.future = true
  }
]
for (const [index, corrupt] of corruptions.entries()) {
  test(
    'Herdr 损坏资产拒绝 ' + index,
    /** 故障只作用于公开资产副本，原目录保持原样。 */ () => {
      const entry = clone(HERDR_PRECOMPILED)
      corrupt(entry)
      assert.throws(/** 固定错误不包含生成源码或输入正文。 */ () => verifyHerdrPrecompiled(entry), {
        message: 'herdr_schema_precompiled_asset_invalid'
      })
    }
  )
}

test(
  'Herdr 正式输入与 provenance 均独立核对，检查模式不修复损坏生成物',
  /** 仅在新建私有目录复制公开测试输入。 */ () => {
    const root = mkdtempSync(join(tmpdir(), 'rovloom-herdr-precompiled-'))
    const schema = join(root, 'test/fixtures/herdr/0.9.5/schema.json')
    const origin = join(root, 'test/fixtures/herdr/0.9.5/provenance.json')
    const generated = join(root, 'src/connector/herdr/generated')
    try {
      mkdirSync(dirname(schema), { recursive: true })
      writeFileSync(schema, raw)
      writeFileSync(origin, provenance)
      assert.deepEqual(approvedHerdrInput(root), raw)
      const wrong = JSON.parse(provenance)
      wrong.binary_sha256 = 'a'.repeat(64)
      writeFileSync(origin, JSON.stringify(wrong))
      assert.throws(/** 同版本错误 binary 来源仍拒绝。 */ () => approvedHerdrInput(root), /provenance mismatch/)
      writeFileSync(origin, provenance)
      writeFileSync(schema, Buffer.concat([raw, Buffer.from(' ')]))
      assert.throws(/** 连空白变化也按原字节拒绝。 */ () => approvedHerdrInput(root), /provenance mismatch/)
      mkdirSync(generated, { recursive: true })
      const files = new Map([
        ['catalog.ts', 'expected'],
        ['herdr-0.9.5.compiled.json', 'expected']
      ])
      for (const [name, contents] of files) {
        writeFileSync(join(generated, name), contents)
      }
      checkHerdrGenerated(files, root)
      writeFileSync(join(generated, 'catalog.ts'), 'corrupt')
      assert.throws(
        /** 仅检查，禁止把原文件覆盖成期待值。 */ () => checkHerdrGenerated(files, root),
        /stale or corrupt/
      )
      assert.equal(readFileSync(join(generated, 'catalog.ts'), 'utf8'), 'corrupt')
      writeFileSync(join(generated, 'extra.json'), '{}')
      assert.throws(/** 额外文件同样使构建失败。 */ () => checkHerdrGenerated(files, root), /asset set differs/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)
