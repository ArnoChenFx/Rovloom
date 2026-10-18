import { Ajv2020 } from 'ajv/dist/2020.js'
import type { AnySchema, ValidateFunction } from 'ajv'
import { attempt, ContractFault, equal, fail, hash, limits, object, parse, pointer, snapshot, text } from './json.js'
import { contracts, UHP } from './internal.js'
import type { Check, CompiledContract, CompileOptions, ContractIdentity, JsonObject, Limits } from './types.js'

const DIALECT = 'https://json-schema.org/draft/2020-12/schema'
const ANNOTATIONS = new Set([
  '$id',
  '$schema',
  '$ref',
  '$comment',
  'title',
  'description',
  'default',
  'examples',
  'const',
  'enum',
  'type',
  'required',
  'dependentRequired',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties'
])
const MAPS = new Set(['$defs', 'properties', 'patternProperties', 'dependentSchemas'])
const ARRAYS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems'])
const SINGLES = new Set(['if', 'then', 'else', 'not', 'items', 'additionalProperties', 'contains', 'propertyNames'])
const escaped = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1')

type SchemaEdges = Map<string, Array<{ key: string; weight: number }>>

function preflight(documents: Record<string, unknown>, budget: Limits): void {
  const edges: SchemaEdges = new Map()
  let refs = 0
  const visit = (schema: unknown, uri: string, path: string): string => {
    const key = uri + '#' + path
    const next: Array<{ key: string; weight: number }> = []
    edges.set(key, next)
    if (typeof schema === 'boolean') {
      return key
    }
    const value = object(schema, 'schema_unavailable')
    // 安装版保留了未引用的属性字典；它不是可执行参数 schema，禁止 $ref 指向它。
    if (uri === `${UHP}schema/terminal/common.schema.json` && path === '/$defs/locatorProperties') {
      if (!equal(Object.keys(value).sort(), ['expected_root', 'pane_id', 'server_generation', 'terminal_id'])) {
        fail('schema_unavailable', 'compile', 'unsupported_keyword')
      }
      for (const [name, nested] of Object.entries(value)) {
        next.push({ key: visit(nested, uri, `${path}/${name}`), weight: 0 })
      }
      return key
    }
    if (path && Object.hasOwn(value, '$id')) {
      fail('schema_unavailable', 'compile', 'unsupported_reference')
    }
    if (value.$schema !== undefined && value.$schema !== DIALECT) {
      fail('schema_unavailable', 'compile', 'unsupported_dialect')
    }
    for (const [keyword, child] of Object.entries(value)) {
      if (!ANNOTATIONS.has(keyword) && !MAPS.has(keyword) && !ARRAYS.has(keyword) && !SINGLES.has(keyword)) {
        fail(
          'schema_unavailable',
          'compile',
          keyword.includes('Ref') || keyword.includes('Anchor') ? 'unsupported_reference' : 'unsupported_keyword'
        )
      }
      if (MAPS.has(keyword)) {
        for (const [name, nested] of Object.entries(object(child, 'schema_unavailable'))) {
          next.push({
            key: visit(nested, uri, `${path}/${escaped(keyword)}/${escaped(name)}`),
            weight: 0
          })
        }
      } else if (ARRAYS.has(keyword)) {
        if (!Array.isArray(child)) {
          fail('schema_unavailable', 'compile', 'invalid_schema')
        }
        child.forEach((nested, i) => next.push({ key: visit(nested, uri, `${path}/${keyword}/${i}`), weight: 0 }))
      } else if (SINGLES.has(keyword)) {
        next.push({ key: visit(child, uri, `${path}/${keyword}`), weight: 0 })
      }
    }
    if (value.$ref !== undefined) {
      if (++refs > budget.references) {
        fail('schema_unavailable', 'compile', 'reference_limit')
      }
      let resolved: URL
      try {
        resolved = new URL(text(value.$ref, 'schema_unavailable'), uri)
      } catch {
        fail('schema_unavailable', 'compile', 'unsupported_reference')
      }
      const fragment = resolved.hash.slice(1)
      resolved.hash = ''
      const targetUri = resolved.href
      if (!Object.hasOwn(documents, targetUri)) {
        fail('schema_unavailable', 'compile', 'missing_document')
      }
      let fragmentPath: string
      try {
        fragmentPath = decodeURIComponent(fragment)
      } catch {
        fail('schema_unavailable', 'compile', 'missing_fragment')
      }
      if (targetUri === `${UHP}schema/terminal/common.schema.json` && fragmentPath === '/$defs/locatorProperties') {
        fail('schema_unavailable', 'compile', 'unsupported_reference')
      }
      pointer(documents[targetUri], fragmentPath)
      next.push({ key: targetUri + '#' + fragmentPath, weight: 1 })
    }
    return key
  }

  for (const [uri, schema] of Object.entries(documents)) {
    visit(schema, uri, '')
  }
  checkReferenceDepth(edges, budget.reference_depth)
}

// 结构边权重为 0，$ref 边权重为 1；限制引用链长度，同时拒绝任何递归环。
function checkReferenceDepth(edges: SchemaEdges, maxDepth: number): void {
  const active = new Set<string>()
  const lengths = new Map<string, number>()
  const depth = (key: string): number => {
    if (active.has(key)) {
      fail('schema_unavailable', 'compile', 'reference_cycle')
    }
    const cached = lengths.get(key)
    if (cached !== undefined) {
      return cached
    }
    const next = edges.get(key)
    if (!next) {
      fail('schema_unavailable', 'compile', 'missing_fragment')
    }
    active.add(key)
    let longest = 0
    for (const edge of next) {
      longest = Math.max(longest, edge.weight + depth(edge.key))
    }
    active.delete(key)
    if (longest > maxDepth) {
      fail('schema_unavailable', 'compile', 'reference_limit')
    }
    lengths.set(key, longest)
    return longest
  }
  for (const key of edges.keys()) {
    depth(key)
  }
}

function aliases(bundle: JsonObject, docs: Record<string, unknown>): void {
  const same = (uri: string, value: unknown) => {
    if (!Object.hasOwn(docs, uri) || !equal(value, docs[uri])) {
      fail('schema_unavailable', 'compile', 'alias_mismatch')
    }
  }
  for (const key of ['request', 'response', 'event', 'event_catalog']) {
    const value = object(bundle[key], 'schema_unavailable')
    same(text(value.$id, 'schema_unavailable'), value)
  }
  const terminal = object(bundle.terminal, 'schema_unavailable')
  for (const [uri, value] of Object.entries(object(terminal.documents, 'schema_unavailable'))) {
    same(uri, value)
  }
  for (const key of ['request', 'response', 'event', 'control_frame']) {
    const value = object(terminal[key], 'schema_unavailable')
    same(text(value.$id, 'schema_unavailable'), value)
  }
  for (const [name, value] of Object.entries(object(terminal.methods, 'schema_unavailable'))) {
    same(`${UHP}schema/terminal/methods/${name.replace(/_/g, '-')}.schema.json`, value)
  }
  const access = object(bundle.access, 'schema_unavailable')
  const descriptor = object(access.descriptor, 'schema_unavailable')
  same(text(descriptor.$id, 'schema_unavailable'), descriptor)
  if (
    !equal(bundle.protocol, { name: 'luvus-uhp', major: 1, minor: 0 }) ||
    !equal(terminal.protocol, bundle.protocol)
  ) {
    fail('schema_unavailable', 'compile', 'incompatible_protocol')
  }
}

export function compileBundle(bytes: Uint8Array | string, options: CompileOptions): Check<CompiledContract> {
  return attempt('compile', () => {
    const budget = limits(options.limits)
    const identity = object(snapshot(options.identity), 'schema_unavailable') as unknown as ContractIdentity
    if (
      !identity ||
      !/^[a-f0-9]{64}$/.test(identity.binary_sha256) ||
      !/^[a-f0-9]{64}$/.test(identity.schema_sha256) ||
      typeof identity.revision !== 'string' ||
      !identity.revision.length ||
      identity.revision.length > 128
    ) {
      fail('schema_unavailable', 'compile', 'invalid_identity')
    }
    let bundle: JsonObject
    try {
      bundle = object(
        parse(bytes, {
          ...budget,
          object_bytes: budget.bundle_bytes,
          object_nodes: budget.bundle_nodes
        }),
        'schema_unavailable'
      )
    } catch (error) {
      if (error instanceof ContractFault) {
        fail(
          'schema_unavailable',
          'compile',
          error.failure.code === 'object_limit' ? 'bundle_limit' : error.failure.code
        )
      }
      throw error
    }
    if (hash(bytes) !== identity.schema_sha256) {
      fail('schema_unavailable', 'compile', 'digest_mismatch')
    }
    const documents = object(bundle.documents, 'schema_unavailable')
    const entries = Object.entries(documents)
    if (!entries.length || entries.length > budget.documents) {
      fail('schema_unavailable', 'compile', 'document_limit')
    }
    const ids = new Set<string>()
    for (const [uri, value] of entries) {
      if (
        !uri.startsWith(UHP) ||
        new URL(uri).href !== uri ||
        new URL(uri).hash ||
        new URL(uri).search ||
        Buffer.byteLength(JSON.stringify(value)) > budget.document_bytes
      ) {
        fail('schema_unavailable', 'compile', 'invalid_document')
      }
      const doc = object(value, 'schema_unavailable')
      const id = doc.$id ?? uri
      if (typeof id !== 'string' || ids.has(id)) {
        fail('schema_unavailable', 'compile', 'duplicate_id')
      }
      ids.add(id)
      if (id !== uri) {
        fail('schema_unavailable', 'compile', 'duplicate_id')
      }
      if (doc.$schema !== DIALECT) {
        fail('schema_unavailable', 'compile', 'unsupported_dialect')
      }
    }

    // 只在已提供的文档闭包内解析引用；预检和别名核对完成后才交给 Ajv。
    preflight(documents, budget)
    aliases(bundle, documents)
    const validators = new Map<string, ValidateFunction>()
    try {
      const ajv = new Ajv2020({
        strict: false,
        allErrors: false,
        coerceTypes: false,
        useDefaults: false,
        removeAdditional: false,
        ownProperties: true,
        inlineRefs: false
      })
      for (const [uri, doc] of entries) {
        ajv.addSchema(doc as AnySchema, uri)
      }
      for (const [uri] of entries) {
        const validate = ajv.getSchema(uri)
        if (!validate) {
          fail('schema_unavailable', 'compile', 'invalid_schema')
        }
        validators.set(uri, validate)
      }
      const catalog = object(bundle.event_catalog)
      for (const name of Object.keys(object(catalog.properties))) {
        validators.set(`event:${name}`, ajv.compile({ $ref: `${text(catalog.$id)}#/properties/${escaped(name)}` }))
      }
    } catch (error) {
      if (error instanceof ContractFault) {
        throw error
      }
      fail('schema_unavailable', 'compile', 'invalid_schema')
    }
    const request = object(bundle.request)
    const props = object(request.properties)
    const methodEnum = object(props.method).enum
    if (
      !Array.isArray(methodEnum) ||
      methodEnum.some((m) => typeof m !== 'string') ||
      new Set(methodEnum).size !== methodEnum.length
    ) {
      fail('schema_unavailable', 'compile', 'invalid_method_catalog')
    }

    // 空分支表示仅有 generic params，不能因方法在 enum 中就声称参数完整校验。
    const requestMethods = methodEnum as readonly string[]
    const branches = new Map<string, readonly string[]>()
    if (!Array.isArray(request.allOf)) {
      fail('schema_unavailable', 'compile', 'invalid_method_catalog')
    }
    for (const method of requestMethods) {
      const paths: string[] = []
      request.allOf.forEach((raw, i) => {
        const condition = object(object(object(raw).if).properties).method
        const test = object(condition)
        if (test.const === method || (Array.isArray(test.enum) && test.enum.includes(method))) {
          paths.push(`#/allOf/${i}`)
        }
      })
      branches.set(method, Object.freeze(paths))
    }
    const compiled: CompiledContract = Object.freeze({
      identity: Object.freeze({ ...identity }),
      documents: Object.freeze(entries.map(([uri]) => uri))
    })
    contracts.set(compiled, {
      bundle,
      documents,
      limits: budget,
      validators,
      requestMethods,
      branches
    })
    return compiled
  })
}
