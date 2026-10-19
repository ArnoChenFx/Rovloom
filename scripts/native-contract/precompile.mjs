// 从已审核原字节在独立 Bun Worker 完整生成固定资产；构建只核对，不下载代码或自动更新信任目录。
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { resolve, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { toolchain } from '../bun/toolchain.mjs'
import { AJV_VERSION, ARTIFACT_VERSION } from '../../src/native-contract/compiler-protocol.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))
const generated = 'src/native-contract/generated'
const compilerFiles = [
  'src/native-contract/compiler-core.ts',
  'src/native-contract/compiler-protocol.ts',
  'src/native-contract/json.ts',
  'scripts/native-contract/precompile-worker.ts',
  'scripts/native-contract/precompile.mjs'
].sort()

// 对来源明确的字节计算摘要，不把 schema 自报 hash 当作证据。
function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

// 仅读取仓库内的普通固定输入；拒绝目录或文件符号链接及越界别名。
function readLocal(base, path) {
  const directory = realpathSync(base)
  const absolute = resolve(directory, path)
  if (
    relative(directory, absolute).split(/[\\/]/u)[0] === '..' ||
    !lstatSync(absolute).isFile() ||
    realpathSync(absolute) !== absolute
  ) {
    throw new Error('Precompiled input must be a regular repository file')
  }
  return readFileSync(absolute)
}

// 在任何 Worker 编译前核对审核目录与原生收集记录，不从外部路径或 URL 生成资产。
export function approvedInput(input, base = root) {
  const keys = ['name', 'binary_version', 'binary_sha256', 'schema_sha256', 'schema', 'environment']
  if (
    !input ||
    Object.keys(input).length !== keys.length ||
    !keys.every(/* 缺失或多余字段不能参与构建来源。 */ (key) => Object.hasOwn(input, key)) ||
    !/^luvus-[0-9]+\.[0-9]+\.[0-9]+-(?:linux|darwin|windows)-(?:x64|arm64)$/u.test(input.name) ||
    !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(input.binary_version) ||
    !input.name.startsWith(`luvus-${input.binary_version}-`) ||
    !/^[a-f0-9]{64}$/u.test(input.binary_sha256) ||
    !/^[a-f0-9]{64}$/u.test(input.schema_sha256) ||
    !/^test\/fixtures\/luvus\/[0-9]+\.[0-9]+\.[0-9]+\/(?:linux|darwin|windows)\/schema-bundle\.json$/u.test(
      input.schema
    ) ||
    input.schema.split('/')[3] !== input.binary_version ||
    input.environment !== input.schema.replace('schema-bundle.json', 'environment.json')
  ) {
    throw new Error('Invalid reviewed precompiled input')
  }
  const bytes = readLocal(base, input.schema)
  const environment = JSON.parse(readLocal(base, input.environment))
  if (
    bytes.length > 2_097_152 ||
    digest(bytes) !== input.schema_sha256 ||
    environment.binary_sha256 !== input.binary_sha256
  ) {
    throw new Error('Precompiled input provenance mismatch')
  }
  return {
    bytes,
    identity: {
      binary_sha256: input.binary_sha256,
      schema_sha256: input.schema_sha256,
      revision: 'precompiled-build'
    }
  }
}

// 固定编译器源码按 LF 计量，避免平台 checkout 换行影响实现摘要；schema 原字节不作规范化。
function compilerFingerprint() {
  const hash = createHash('sha256')
  for (const path of compilerFiles) {
    hash.update(path).update('\0').update(readLocal(root, path).toString('utf8').replace(/\r\n/gu, '\n'))
  }
  return hash.digest('hex')
}

// 同时绑定锁定版本与实际 Ajv 编译/运行时源码，防止同版本不同包内容静默进入构建。
function ajvFingerprint() {
  const directory = resolve(root, 'node_modules/ajv')
  const lock = Bun.JSON5.parse(readLocal(root, 'bun.lock').toString('utf8'))
  const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json')))
  if (manifest.version !== AJV_VERSION || lock.packages.ajv?.[0] !== `ajv@${AJV_VERSION}`) {
    throw new Error('Precompiled Ajv version mismatch')
  }
  const files = ['package.json']
  // Ajv dist 内的 JS 与 JSON 包括生成器、方言和 helper；不依赖平台目录枚举顺序。
  function walk(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const next = resolve(path, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Error('Precompiled Ajv source must be regular')
      }
      if (entry.isDirectory()) {
        walk(next)
      } else if (/\.(?:js|json)$/u.test(entry.name)) {
        files.push(relative(directory, next).split('\\').join('/'))
      }
    }
  }
  walk(resolve(directory, 'dist'))
  const hash = createHash('sha256')
  hash.update(lock.packages.ajv.at(-1)).update('\0')
  for (const path of files.sort()) {
    hash
      .update(path)
      .update('\0')
      .update(readFileSync(resolve(directory, path)))
  }
  return hash.digest('hex')
}

// 构建观察最多 30 秒，独立于产品的 2 秒接纳预算；原始完整编译不查询已有资产。
async function compileFresh(bytes, identity) {
  const worker = new Worker(new URL('./precompile-worker.ts', import.meta.url).href, { smol: true })
  let timer
  try {
    return await new Promise(
      /* 只返回纯数据，不登记契约、不输出源码异常，并在每条路径清理自有 Worker。 */ (resolve, reject) => {
        timer = setTimeout(
          /* 构建超时只使本次构建失败，不扩展运行时期限。 */ () => reject(new Error('Precompiled build timeout')),
          30_000
        )
        worker.onerror = /* 不输出 Ajv 或 Worker 异常原文。 */ (event) => {
          event.preventDefault()
          reject(new Error('Precompiled build Worker failed'))
        }
        worker.onmessage = /* 固定 Worker 必须完成全量编译；拒绝不能用已有资产掩盖。 */ ({ data }) => {
          if (!data?.ok) {
            reject(new Error('Precompiled full compilation rejected'))
          } else {
            resolve(data.value)
          }
        }
        worker.postMessage({ version: ARTIFACT_VERSION, job_id: randomUUID(), bytes, options: { identity } })
      }
    )
  } finally {
    clearTimeout(timer)
    worker.terminate()
  }
}

// 逐字节核对构建输出；检查模式绝不写目录，过期/缺失/额外资产均明确失败。
export function checkGenerated(files, base = root) {
  const directory = resolve(base, generated)
  const actual = readdirSync(directory).sort()
  const expected = [...files.keys()].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('Precompiled asset set differs')
  }
  for (const [name, contents] of files) {
    if (readLocal(base, `${generated}/${name}`).toString('utf8').replace(/\r\n/gu, '\n') !== contents) {
      throw new Error('Precompiled assets are stale or corrupt; review and regenerate explicitly')
    }
  }
}

// 生成目录只含维护资产及其独立摘要目录；每次构建重新完整生成并核对，禁止缓存绕过检查。
export async function precompile({ write = false } = {}) {
  toolchain()
  const inputs = JSON.parse(readLocal(root, 'scripts/native-contract/precompiled-inputs.json'))
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > 64) {
    throw new Error('Invalid precompiled input catalog')
  }
  const names = new Set()
  const identities = new Set()
  const files = new Map()
  const entries = []
  const imports = []
  const compilerSha = compilerFingerprint()
  const ajvSha = ajvFingerprint()
  for (const input of inputs) {
    const { bytes, identity } = approvedInput(input)
    if (names.has(input.name)) {
      throw new Error('Duplicate precompiled input')
    }
    const key = `${identity.binary_sha256}:${identity.schema_sha256}`
    if (identities.has(key)) {
      throw new Error('Duplicate precompiled identity')
    }
    names.add(input.name)
    identities.add(key)
    const artifact = await compileFresh(bytes, identity)
    const envelope = {
      version: 1,
      binary_version: input.binary_version,
      compiler_sha256: compilerSha,
      ajv_sha256: ajvSha,
      artifact
    }
    const name = `${input.name}.compiled.json`
    files.set(name, JSON.stringify(envelope, null, 2) + '\n')
    imports.push(`import asset${entries.length} from './${name}' with { type: 'json' }`)
    entries.push(`  Object.freeze({
    binary_version: '${input.binary_version}',
    binary_sha256: '${identity.binary_sha256}',
    schema_sha256: '${identity.schema_sha256}',
    compiler_sha256: '${compilerSha}',
    ajv_sha256: '${ajvSha}',
    asset_sha256: '${digest(JSON.stringify(envelope))}',
    asset: asset${entries.length}
  })`)
  }
  files.set(
    'catalog.ts',
    `// 构建生成的固定资产目录；用 native:generate 显式更新，独立摘要不能由运行时输入替换。\n${imports.join('\n')}
import type { PrecompiledEntry } from '../precompiled.js'

export const PRECOMPILED_ASSETS: readonly PrecompiledEntry[] = Object.freeze([
${entries.join(',\n')}
])
`
  )
  if (write) {
    mkdirSync(resolve(root, generated), { recursive: true })
    for (const [name, contents] of files) {
      writeFileSync(resolve(root, generated, name), contents)
    }
  } else {
    checkGenerated(files)
  }
  return { assets: entries.length, compiler_sha256: compilerSha, ajv_sha256: ajvSha }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length === 1 && args[0] !== '--write')) {
    throw new Error('Usage: bun scripts/native-contract/precompile.mjs [--write]')
  }
  console.log(JSON.stringify(await precompile({ write: args[0] === '--write' })))
}
