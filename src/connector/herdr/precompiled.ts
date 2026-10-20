/** 只复用固定正式 Herdr schema 的构建资产；独立摘要目录不由安装输入或私有消息选择。 */
import { createHash } from 'node:crypto'
import { HERDR_PRECOMPILED } from './generated/catalog.js'
import {
  HERDR_AJV_OPTIONS,
  HERDR_AJV_VERSION,
  HERDR_CODE_LIMIT,
  HERDR_COMPILER_VERSION,
  HERDR_FORMAT_CODE,
  HERDR_GENERATOR,
  HERDR_IDENTITY,
  HERDR_INPUT_LIMIT,
  HERDR_ROOTS
} from './compiler-protocol.js'
import type { HerdrCompilerArtifact, HerdrCompileResult } from './compiler-protocol.js'

export type HerdrPrecompiledEntry = Readonly<{
  compiler_sha256: string
  ajv_sha256: string
  asset_sha256: string
  asset: unknown
}>

/** 只计量受限 schema 或固定资产，不把输入自报摘要作为来源证明。 */
function hash(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 独立目录摘要、编译器与 Ajv 来源、完整根、选项及代码摘要全部匹配才返回纯数据产物。 */
export function verifyHerdrPrecompiled(entry: HerdrPrecompiledEntry): HerdrCompilerArtifact {
  try {
    const envelope = entry.asset as {
      version: number
      compiler_sha256: string
      ajv_sha256: string
      artifact: HerdrCompilerArtifact
    }
    const artifact = envelope.artifact
    if (
      !envelope ||
      Object.keys(envelope).sort().join(',') !== 'ajv_sha256,artifact,compiler_sha256,version' ||
      envelope.version !== 1 ||
      !/^[a-f0-9]{64}$/.test(entry.compiler_sha256) ||
      !/^[a-f0-9]{64}$/.test(entry.ajv_sha256) ||
      envelope.compiler_sha256 !== entry.compiler_sha256 ||
      envelope.ajv_sha256 !== entry.ajv_sha256 ||
      !artifact ||
      typeof artifact.code !== 'string' ||
      artifact.code.length > HERDR_CODE_LIMIT ||
      Buffer.byteLength(artifact.code) > HERDR_CODE_LIMIT ||
      artifact.version !== HERDR_COMPILER_VERSION ||
      artifact.generator !== HERDR_GENERATOR ||
      artifact.ajv !== HERDR_AJV_VERSION ||
      JSON.stringify(artifact.identity) !==
        JSON.stringify({
          schema_sha256: HERDR_IDENTITY.schema_sha256,
          protocol: HERDR_IDENTITY.protocol,
          schema_version: HERDR_IDENTITY.schema_version,
          dialect: HERDR_IDENTITY.dialect
        }) ||
      JSON.stringify(artifact.roots) !== JSON.stringify(HERDR_ROOTS) ||
      artifact.options_sha256 !== hash(JSON.stringify([HERDR_AJV_OPTIONS, HERDR_FORMAT_CODE])) ||
      artifact.code_sha256 !== hash(artifact.code) ||
      hash(JSON.stringify(envelope)) !== entry.asset_sha256
    ) {
      throw new Error('invalid')
    }
    return artifact
  } catch {
    throw new Error('herdr_schema_precompiled_asset_invalid')
  }
}

let verified: HerdrCompilerArtifact | undefined

/** 已知摘要只选择缓存；未知摘要交由真实编译，已命中但损坏的资产仍明确拒绝。 */
export function precompiledHerdrArtifact(bytes: Uint8Array | string): HerdrCompileResult | undefined {
  if (
    !(typeof bytes === 'string' || bytes instanceof Uint8Array) ||
    (typeof bytes === 'string'
      ? bytes.length > HERDR_INPUT_LIMIT || Buffer.byteLength(bytes) > HERDR_INPUT_LIMIT
      : bytes.byteLength > HERDR_INPUT_LIMIT)
  ) {
    return { ok: false, reason: 'schema_input_limit' }
  }
  if (hash(bytes) !== HERDR_IDENTITY.schema_sha256) {
    return undefined
  }
  try {
    verified ??= verifyHerdrPrecompiled(HERDR_PRECOMPILED)
    return { ok: true, value: verified }
  } catch {
    return { ok: false, reason: 'precompiled_asset_invalid' }
  }
}
