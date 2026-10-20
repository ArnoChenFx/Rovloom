// 在完整运行时预检后复用仓库构建的固定 standalone 资产，不建立权限或对外代码加载入口。
import { PRECOMPILED_ASSETS } from './generated/catalog.js'
import { AJV_OPTIONS, AJV_VERSION, ARTIFACT_VERSION, CODE_LIMIT, GENERATOR_VERSION } from './compiler-protocol.js'
import type { CompilerArtifact } from './compiler-protocol.js'
import type { ContractIdentity, Limits } from './types.js'
import { DEFAULT_LIMITS, fail, hash, object, snapshot } from './json.js'

export type PrecompiledEntry = Readonly<{
  binary_version: string
  binary_sha256: string
  schema_sha256: string
  compiler_sha256: string
  ajv_sha256: string
  asset_sha256: string
  asset: unknown
}>

// 核对独立构建目录绑定及完整资产摘要；自报 code hash 不能代替受维护目录中的摘要。
export function verifyPrecompiled(entry: PrecompiledEntry): CompilerArtifact {
  const invalid = /* 固定错误不能包含 schema、代码、文件名或底层异常。 */ (): never =>
    fail('schema_unavailable', 'compile', 'precompiled_asset_invalid')
  try {
    const envelope = object(entry.asset)
    if (
      Object.keys(envelope).length !== 5 ||
      envelope.version !== 1 ||
      envelope.binary_version !== entry.binary_version ||
      envelope.compiler_sha256 !== entry.compiler_sha256 ||
      envelope.ajv_sha256 !== entry.ajv_sha256 ||
      !/^[a-f0-9]{64}$/.test(entry.compiler_sha256) ||
      !/^[a-f0-9]{64}$/.test(entry.ajv_sha256)
    ) {
      return invalid()
    }
    const artifact = object(envelope.artifact) as unknown as CompilerArtifact
    if (
      typeof artifact.code !== 'string' ||
      artifact.code.length > CODE_LIMIT ||
      Buffer.byteLength(artifact.code) > CODE_LIMIT ||
      artifact.version !== ARTIFACT_VERSION ||
      artifact.generator !== GENERATOR_VERSION ||
      artifact.ajv !== AJV_VERSION ||
      artifact.identity?.binary_sha256 !== entry.binary_sha256 ||
      artifact.identity?.schema_sha256 !== entry.schema_sha256 ||
      artifact.options_sha256 !== hash(JSON.stringify(AJV_OPTIONS)) ||
      artifact.code_sha256 !== hash(artifact.code)
    ) {
      return invalid()
    }
    // 固定资产亦有结构/字节上限；快照隔离 JSON 模块的可变引用，不执行任何生成函数。
    const frozen = snapshot(envelope, { ...DEFAULT_LIMITS, object_bytes: CODE_LIMIT * 2 })
    if (hash(JSON.stringify(frozen)) !== entry.asset_sha256) {
      return invalid()
    }
    return (frozen as unknown as { artifact: CompilerArtifact }).artifact
  } catch {
    return invalid()
  }
}

const verified = new Map<PrecompiledEntry, CompilerArtifact>()

// 只比较宿主交付的安装身份；bundle 的自报来源、方法目录或版本不能选择旧 validator。
export function precompiledArtifact(identity: ContractIdentity, budget: Limits): CompilerArtifact | undefined {
  const entry = PRECOMPILED_ASSETS.find(
    /* 未知 binary 或不同原字节摘要均交回原完整编译路径。 */ (candidate) =>
      candidate.binary_sha256 === identity.binary_sha256 && candidate.schema_sha256 === identity.schema_sha256
  )
  if (!entry) {
    return undefined
  }
  let artifact = verified.get(entry)
  if (!artifact) {
    artifact = verifyPrecompiled(entry)
    verified.set(entry, artifact)
  }
  // revision 和同步对象预算属于本次宿主；完整预检已按本次收紧预算运行，不能沿用资产预算放行。
  return { ...artifact, identity, limits: budget }
}
