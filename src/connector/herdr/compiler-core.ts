/** 在私有 Worker 内编译 Herdr 完整原始根及原始引用，生成受控 standalone 校验器。 */
import { createHash } from 'node:crypto'
import { Ajv2020 } from 'ajv/dist/2020.js'
import standaloneModule from 'ajv/dist/standalone/index.js'
import { _Code } from 'ajv/dist/compile/codegen/code.js'
import ajvPackage from 'ajv/package.json' with { type: 'json' }
import {
  HERDR_AJV_OPTIONS,
  HERDR_AJV_VERSION,
  HERDR_CODE_LIMIT,
  HERDR_COMPILER_VERSION,
  HERDR_DIALECT,
  HERDR_FORMAT_CODE,
  HERDR_GENERATOR,
  HERDR_INPUT_LIMIT,
  HERDR_ROOTS,
  HERDR_SCHEMA_ID
} from './compiler-protocol.js'
import type { HerdrCompileResult } from './compiler-protocol.js'

/** 只计算公开安装 schema 或本任务生成物的摘要。 */
function hash(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 测量实际原字节和协议元数据，按原路径注册完整 schemas 并编译 RPC 必需根。 */
export function compileHerdrArtifact(bytes: Uint8Array | string): HerdrCompileResult {
  try {
    if (
      !(typeof bytes === 'string' || bytes instanceof Uint8Array) ||
      (typeof bytes === 'string'
        ? bytes.length > HERDR_INPUT_LIMIT || Buffer.byteLength(bytes) > HERDR_INPUT_LIMIT
        : bytes.byteLength > HERDR_INPUT_LIMIT)
    ) {
      return { ok: false, reason: 'schema_input_limit' }
    }
    if (ajvPackage.version !== HERDR_AJV_VERSION) {
      return { ok: false, reason: 'compiler_version_mismatch' }
    }
    const bundle = JSON.parse(
      typeof bytes === 'string' ? bytes : new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    )
    if (
      !bundle ||
      typeof bundle !== 'object' ||
      Array.isArray(bundle) ||
      bundle.$schema !== HERDR_DIALECT ||
      !Number.isSafeInteger(bundle.protocol) ||
      bundle.protocol < 0 ||
      !Number.isSafeInteger(bundle.schema_version) ||
      bundle.schema_version < 1 ||
      !bundle.schemas ||
      HERDR_ROOTS.some(/** 只有 RPC 必需的完整根缺失才拒绝该传输。 */ (root) => !Object.hasOwn(bundle.schemas, root))
    ) {
      return { ok: false, reason: 'schema_identity_mismatch' }
    }
    const ajv = new Ajv2020({
      ...HERDR_AJV_OPTIONS,
      code: { ...HERDR_AJV_OPTIONS.code, formats: new _Code(HERDR_FORMAT_CODE) }
    })
    // schemas 是官方容器关键字；完整原文仍保留，不改写成 UHP 或裁剪 params 分支。
    ajv.addKeyword({ keyword: 'schemas', schemaType: 'object', valid: true })
    ajv.addKeyword({ keyword: 'protocol', schemaType: 'number', valid: true })
    ajv.addKeyword({ keyword: 'schema_version', schemaType: 'number', valid: true })
    for (const [name, minimum, maximum] of [
      ['uint', 0, Number.MAX_SAFE_INTEGER],
      ['uint64', 0, Number.MAX_SAFE_INTEGER],
      ['uint32', 0, 4294967295],
      ['uint16', 0, 65535],
      ['int32', -2147483648, 2147483647]
    ] as const) {
      ajv.addFormat(name, {
        type: 'number',
        validate: /** 保留对应原生整数上下界，同时拒绝精度损失。 */ (value: number) =>
          Number.isSafeInteger(value) && value >= minimum && value <= maximum
      })
    }
    ajv.addFormat('float', { type: 'number', validate: Number.isFinite })
    ajv.addSchema(bundle, HERDR_SCHEMA_ID)
    const exports: Record<string, string> = {}
    for (const [index, root] of HERDR_ROOTS.entries()) {
      const ref = `${HERDR_SCHEMA_ID}#/schemas/${root}`
      if (!ajv.getSchema(ref)) {
        return { ok: false, reason: 'schema_root_unavailable' }
      }
      exports[`v${index}`] = ref
    }
    const standalone = standaloneModule as unknown as (compiler: Ajv2020, refs: Record<string, string>) => string
    const code = standalone(ajv, exports)
    if (code.length > HERDR_CODE_LIMIT || Buffer.byteLength(code) > HERDR_CODE_LIMIT) {
      return { ok: false, reason: 'generated_code_limit' }
    }
    return {
      ok: true,
      value: {
        version: HERDR_COMPILER_VERSION,
        generator: HERDR_GENERATOR,
        ajv: HERDR_AJV_VERSION,
        identity: {
          schema_sha256: hash(bytes),
          protocol: bundle.protocol,
          schema_version: bundle.schema_version,
          dialect: HERDR_DIALECT
        },
        roots: [...HERDR_ROOTS],
        code,
        code_sha256: hash(code),
        options_sha256: hash(JSON.stringify([HERDR_AJV_OPTIONS, HERDR_FORMAT_CODE]))
      }
    }
  } catch {
    return { ok: false, reason: 'schema_compile_failed' }
  }
}
