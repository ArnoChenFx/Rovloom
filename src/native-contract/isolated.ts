// 将受信 registry 的离线 bundle 交给硬预算进程；本地 opaque 句柄不能从 IPC 或 JSON 恢复。
import type { ValidateFunction } from 'ajv'
import { attempt, equal, fail, limits, object, snapshot, utf8Length } from './json.js'
import { contracts } from './internal.js'
import { COMPILER_DEADLINE_MS, SchemaProcess } from './process-host.js'
import type { CompilerMetrics } from './process-host.js'
import type { Check, CompiledContract, CompileOptions, Limits } from './types.js'

export type IsolatedCompilerOptions = Readonly<{ assets_directory: string }>
const hosts = new WeakMap<CompiledContract, SchemaProcess>()

// 元数据只描述已编译的 schema 和分支，不带执行许可、原生来源或请求正文。
type Manifest = {
  identity: CompiledContract['identity']
  documents: string[]
  epoch: string
  limits: Limits
  schemas: string[]
  branches: Array<[string, string[]]>
}

// 对同一内存句柄保留进程实例；调用方不得从消息选择路径、放宽预算或提供来源证明。
export function compileBundleIsolated(
  bytes: Uint8Array | string,
  options: CompileOptions,
  compiler: IsolatedCompilerOptions
): Check<CompiledContract> {
  let host: SchemaProcess | undefined
  const result = attempt(
    'compile',
    /* 建立硬预算上下文并仅登记已核验的编译元数据。 */ () => {
      const until = performance.now() + COMPILER_DEADLINE_MS
      const settings = object(snapshot(options)) as unknown as CompileOptions
      const budget = limits(settings.limits)
      if (typeof compiler?.assets_directory !== 'string' || !compiler.assets_directory.length) {
        fail('schema_unavailable', 'isolation', 'compiler_assets_required')
      }
      let input: string
      if (typeof bytes === 'string') {
        input = bytes
      } else if (bytes instanceof Uint8Array && bytes.byteLength <= budget.bundle_bytes) {
        try {
          input = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
        } catch {
          fail('schema_unavailable', 'compile', 'invalid_utf8')
        }
      } else {
        fail('schema_unavailable', 'compile', 'bundle_limit')
      }
      if (input.length > budget.bundle_bytes || utf8Length(input) > budget.bundle_bytes) {
        fail('schema_unavailable', 'compile', 'bundle_limit')
      }
      host = new SchemaProcess(compiler.assets_directory)
      const metadata = host.request('compile', { bytes: input, options: settings }, until) as Manifest
      if (
        !metadata ||
        Object.keys(metadata).length !== 6 ||
        !equal(metadata.identity, settings.identity) ||
        !equal(metadata.limits, budget) ||
        typeof metadata.epoch !== 'string' ||
        !/^[a-f0-9]{32}$/.test(metadata.epoch) ||
        !Array.isArray(metadata.documents) ||
        metadata.documents.length > budget.documents ||
        metadata.documents.some(/* 文档索引只能包含唯一 URI 字符串。 */ (name) => typeof name !== 'string') ||
        new Set(metadata.documents).size !== metadata.documents.length ||
        !Array.isArray(metadata.schemas) ||
        metadata.schemas.some(/* 拒绝非字符串 schema 索引。 */ (name) => typeof name !== 'string') ||
        new Set(metadata.schemas).size !== metadata.schemas.length ||
        !Array.isArray(metadata.branches) ||
        metadata.branches.some(
          /* 检查跨进程方法/分支元数据的完整形状。 */ (entry) =>
            !Array.isArray(entry) ||
            entry.length !== 2 ||
            typeof entry[0] !== 'string' ||
            !Array.isArray(entry[1]) ||
            entry[1].some(/* 分支路径只能是字符串。 */ (path) => typeof path !== 'string')
        ) ||
        new Set(metadata.branches.map(/* 方法名不得重复。 */ ([name]) => name)).size !== metadata.branches.length
      ) {
        fail('schema_unavailable', 'isolation', 'compiler_protocol_invalid')
      }
      if (performance.now() > until) {
        fail('schema_unavailable', 'isolation', 'compiler_timeout')
      }
      const process = host
      const compiled: CompiledContract = Object.freeze({
        identity: Object.freeze({ ...metadata.identity }),
        documents: Object.freeze([...metadata.documents])
      })
      const validators = new Map<string, ValidateFunction>()
      for (const schema of metadata.schemas) {
        // 每次结构检查都走同一进程及代次；无效结果不能被 false/void 语义误认为成功。
        const validate = ((value: unknown): boolean => {
          const bounded = snapshot(value, budget)
          const result = process.request('validate', {
            identity: compiled.identity,
            epoch: metadata.epoch,
            schema,
            value: bounded
          }) as { valid: boolean; keyword: string | null }
          if (
            !result ||
            Object.keys(result).length !== 2 ||
            typeof result.valid !== 'boolean' ||
            !(result.keyword === null || (typeof result.keyword === 'string' && result.keyword.length <= 128))
          ) {
            process.stop()
            fail('schema_unavailable', 'isolation', 'compiler_protocol_invalid')
          }
          validate.errors = result.valid
            ? null
            : [{ keyword: result.keyword ?? 'schema', instancePath: '', schemaPath: '', params: {} }]
          return result.valid
        }) as ValidateFunction
        validators.set(schema, validate)
      }
      contracts.set(compiled, {
        limits: metadata.limits,
        validators,
        branches: new Map(
          metadata.branches.map(
            /* 冻结每个已编译方法的分支清单。 */ ([name, paths]) => [name, Object.freeze([...paths])]
          )
        ),
        active: /* 每次使用时检查原进程，禁止自动恢复。 */ () => process.active()
      })
      hosts.set(compiled, process)
      return compiled
    }
  )
  if (!result.ok) {
    host?.stop()
  }
  return result
}

// 释放后所有派生候选、许可、stream 和仅响应上下文都失去契约，不允许重建或自动重启。
export function releaseCompiledContract(contract: CompiledContract): Check<CompilerMetrics> {
  return attempt(
    'release_contract',
    /* 只释放 WeakMap 中原始句柄持有的进程。 */ () => {
      const process = hosts.get(contract)
      if (!process) {
        fail('invalid_contract_handle')
      }
      contracts.delete(contract)
      return process.stop()
    }
  )
}
