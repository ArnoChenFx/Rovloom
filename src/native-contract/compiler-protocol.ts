// 定义宿主与私有编译 Worker 的准确协议、固定生成选项和有界产物，不承载执行许可。
import type { Options } from 'ajv'
import type { CompileOptions, ContractIdentity, Limits } from './types.js'

export const ARTIFACT_VERSION = 1
export const GENERATOR_VERSION = 'luvus-standalone-1'
export const AJV_VERSION = '8.20.0'
export const CODE_LIMIT = 8 * 1024 * 1024
export const COMPILE_TIMEOUT_MS = 2000
export const AJV_OPTIONS: Options = Object.freeze({
  strict: false,
  allErrors: false,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  ownProperties: true,
  inlineRefs: false,
  code: Object.freeze({ source: true, esm: false })
})

export type CompilerArtifact = {
  version: number
  generator: string
  ajv: string
  identity: ContractIdentity
  limits: Limits
  documents: string[]
  request_methods: string[]
  branches: Array<[string, string[]]>
  schemas: Array<[string, string]>
  code: string
  code_sha256: string
  options_sha256: string
}
// 仅由固定 Worker 模块传入的资产查询；公共编译 API 和私有消息均不接受该端口。
export type PrecompiledLookup = (identity: ContractIdentity, budget: Limits) => CompilerArtifact | undefined
export type CompileJob = {
  version: number
  job_id: string
  bytes: Uint8Array | string
  options: CompileOptions
}

export type CompilerPort = {
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: { message?: string; preventDefault?(): void }) => void) | null
  postMessage(message: CompileJob): void
  terminate(): void
  ref(): void
  unref(): void
  addEventListener(type: 'close', listener: () => void): void
}
