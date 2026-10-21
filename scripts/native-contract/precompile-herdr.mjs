/** 从固定正式 Herdr schema 完整生成并核对资产；同时保留原 Luvus 全量构建检查，每种只编译一次。 */
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { precompile } from './precompile.mjs'
import { HERDR_IDENTITY } from '../../src/connector/herdr/compiler-protocol.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))
const generated = 'src/connector/herdr/generated'
const compilerFiles = [
  'src/connector/herdr/compiler-core.ts',
  'src/connector/herdr/compiler-protocol.ts',
  'src/connector/herdr/review.ts',
  'scripts/native-contract/precompile-herdr-worker.ts',
  'scripts/native-contract/precompile-herdr.mjs'
].sort()

/** 只读取固定仓库内的普通文件，符号链接和别名不能参与来源核对。 */
function readLocal(base, name) {
  const directory = realpathSync(base)
  const path = resolve(directory, name)
  if (
    relative(directory, path).split(/[\\/]/u)[0] === '..' ||
    !lstatSync(path).isFile() ||
    realpathSync(path) !== path
  ) {
    throw new Error('Herdr precompiled input must be a regular repository file')
  }
  return readFileSync(path)
}

/** 正式原字节、独立 provenance 与现行审核身份必须一致，不从资产自报版本选择输入。 */
export function approvedHerdrInput(base = root) {
  const bytes = readLocal(base, 'test/fixtures/herdr/0.9.5/schema.json')
  const provenance = JSON.parse(readLocal(base, 'test/fixtures/herdr/0.9.5/provenance.json'))
  const hash = createHash('sha256').update(bytes).digest('hex')
  if (
    hash !== HERDR_IDENTITY.schema_sha256 ||
    Object.entries(HERDR_IDENTITY).some(
      /** 所有固定 binary/schema/version/protocol/dialect 均需独立匹配。 */ ([key, value]) => provenance[key] !== value
    )
  ) {
    throw new Error('Herdr precompiled input provenance mismatch')
  }
  return bytes
}

/** 构建观察沿用 Luvus 的 30 秒上限，独立于 Herdr 产品的 10 秒接纳期限。 */
async function compileFresh(bytes) {
  const worker = new Worker(new URL('./precompile-herdr-worker.ts', import.meta.url).href, { smol: true })
  let timer
  try {
    return await new Promise(
      /** 每条路径都回收本次构建 Worker，编译失败不能用旧资产掩盖。 */ (resolve, reject) => {
        timer = setTimeout(
          /** 构建超时明确失败，不改变任何运行时预算。 */ () => reject(new Error('Herdr precompiled build timeout')),
          30_000
        )
        worker.onerror = /** 隐藏原生 schema、代码和宿主路径。 */ (event) => {
          event.preventDefault()
          reject(new Error('Herdr precompiled build Worker failed'))
        }
        worker.onmessage = /** 仅返回这次真实完整编译的纯数据产物。 */ ({ data }) => {
          if (!data?.ok) {
            reject(new Error('Herdr precompiled full compilation rejected'))
          } else {
            resolve(data.value)
          }
        }
        worker.postMessage(bytes)
      }
    )
  } finally {
    clearTimeout(timer)
    worker.terminate()
  }
}

/** 检查模式逐字节核对完整目录，缺失、额外或损坏资产均失败，绝不隐式更新。 */
export function checkHerdrGenerated(files, base = root) {
  if (JSON.stringify(readdirSync(resolve(base, generated)).sort()) !== JSON.stringify([...files.keys()].sort())) {
    throw new Error('Herdr precompiled asset set differs')
  }
  for (const [name, contents] of files) {
    if (readLocal(base, `${generated}/${name}`).toString('utf8') !== contents) {
      throw new Error('Herdr precompiled assets are stale or corrupt; review and regenerate explicitly')
    }
  }
}

/** 复用原 Luvus 检查核验真实 Ajv 包摘要，再对 Herdr 完整编译一次；生成器不泛化运行时协议。 */
export async function precompileHerdr({ write = false } = {}) {
  const luvus = await precompile({ write })
  const bytes = approvedHerdrInput()
  const compilerHash = createHash('sha256')
  for (const name of compilerFiles) {
    compilerHash.update(name).update('\0').update(readLocal(root, name).toString('utf8').replace(/\r\n/gu, '\n'))
  }
  const compilerSha = compilerHash.digest('hex')
  const envelope = {
    version: 1,
    compiler_sha256: compilerSha,
    ajv_sha256: luvus.ajv_sha256,
    artifact: await compileFresh(bytes)
  }
  const assetSha = createHash('sha256').update(JSON.stringify(envelope)).digest('hex')
  const files = new Map([
    ['herdr-0.9.5.compiled.json', JSON.stringify(envelope, null, 2) + '\n'],
    [
      'catalog.ts',
      `// 构建生成的固定 Herdr 资产与独立摘要目录；仅用 native:generate 显式更新。\nimport asset from './herdr-0.9.5.compiled.json' with { type: 'json' }\nimport type { HerdrPrecompiledEntry } from '../precompiled.js'\n\nexport const HERDR_PRECOMPILED: HerdrPrecompiledEntry = Object.freeze({\n  compiler_sha256: '${compilerSha}',\n  ajv_sha256: '${luvus.ajv_sha256}',\n  asset_sha256: '${assetSha}',\n  asset\n})\n`
    ]
  ])
  if (write) {
    mkdirSync(resolve(root, generated), { recursive: true })
    for (const [name, contents] of files) {
      writeFileSync(resolve(root, generated, name), contents)
    }
  } else {
    checkHerdrGenerated(files)
  }
  return { luvus, herdr: { assets: 1, compiler_sha256: compilerSha, ajv_sha256: luvus.ajv_sha256 } }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length === 1 && args[0] !== '--write')) {
    throw new Error('Usage: bun scripts/native-contract/precompile-herdr.mjs [--write]')
  }
  console.log(JSON.stringify(await precompileHerdr({ write: args[0] === '--write' })))
}
