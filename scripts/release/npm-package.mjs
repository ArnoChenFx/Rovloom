/** 构建只含运行所需文件的 npm 包 tarball（GitHub Release 资产，不发布到 npm 注册表）；内容与版本在打包后核对。 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { encode, fileMetadata, npmAssetName, releaseContext, root, validateProductVersion } from './metadata.mjs'

/** 从仓库 package.json 取出运行所需字段；脚本、devDependencies 和仓库内部字段不进入发布包。 */
export function npmPackageJson(source) {
  assert.equal(source.name, 'rovloom')
  assert.deepEqual(source.bin, { rovloom: 'dist/src/cli/main.js' })
  assert(source.dependencies && Object.keys(source.dependencies).length > 0, 'Runtime dependencies are required')
  return {
    name: source.name,
    version: source.version,
    description: source.description,
    license: source.license,
    // 仍是私有包：这是 Release 资产，不是 npm 注册表发布（见 #202）。
    private: true,
    type: source.type,
    engines: source.engines,
    bin: source.bin,
    files: ['dist/src', 'LICENSE', 'README.md'],
    dependencies: source.dependencies,
    repository: { type: 'git', url: 'git+https://github.com/ArnoChenFx/rovloom.git' },
    homepage: 'https://github.com/ArnoChenFx/rovloom#readme'
  }
}

/** tarball 条目白名单：只允许 package.json、LICENSE、README 与 dist/src 下的非 sourcemap JS。 */
export function assertTarballEntries(entries) {
  assert(entries.length > 3, 'Empty npm tarball')
  for (const entry of entries) {
    const name = entry.replace(/\/$/u, '')
    const allowed =
      [
        'package',
        'package/package.json',
        'package/LICENSE',
        'package/README.md',
        'package/dist',
        'package/dist/src'
      ].includes(name) ||
      (/^package\/dist\/src\/.+\.js$/u.test(name) && !name.includes('..'))
    assert(allowed, `Unexpected file in npm tarball: ${name}`)
  }
  assert(entries.includes('package/dist/src/cli/main.js'), 'CLI entry missing from npm tarball')
}

/** 重新构建 dist，暂存干净目录后用 bun pm pack 生成确定性 tarball。 */
export async function packNpm(destination) {
  const source = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  await validateProductVersion({ version: source.version })
  const build = spawnSync(process.execPath, ['--no-env-file', 'scripts/bun/build.mjs'], {
    cwd: root,
    stdio: 'inherit',
    timeout: 300_000
  })
  assert.ifError(build.error)
  assert.equal(build.status, 0, 'Product build failed')
  const stage = mkdtempSync(join(tmpdir(), 'rovloom-npm-stage-'))
  try {
    cpSync(resolve(root, 'dist/src'), join(stage, 'dist/src'), {
      recursive: true,
      filter: /** sourcemap 只增大下载体积，不进入运行包。 */ (path) => !path.endsWith('.map')
    })
    for (const file of ['LICENSE', 'README.md']) {
      cpSync(resolve(root, file), join(stage, file))
    }
    writeFileSync(join(stage, 'package.json'), JSON.stringify(npmPackageJson(source), null, 2) + '\n')
    mkdirSync(destination, { recursive: true })
    const pack = spawnSync(process.execPath, ['--no-env-file', 'pm', 'pack', '--destination', destination], {
      cwd: stage,
      encoding: 'utf8',
      timeout: 120_000
    })
    assert.ifError(pack.error)
    assert.equal(pack.status, 0, `bun pm pack failed: ${pack.stderr}`)
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
  const name = npmAssetName(source.version)
  assert.deepEqual(readdirSync(destination), [name], 'Unexpected pack output')
  const path = join(destination, name)
  const listing = spawnSync('tar', ['-tzf', path], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  assert.equal(listing.status, 0, 'Cannot list npm tarball')
  assertTarballEntries(listing.stdout.split('\n').filter(Boolean))
  return { version: source.version, name, path, ...fileMetadata(path) }
}

if (import.meta.main) {
  assert.equal(process.argv.length, 3, 'Usage: bun scripts/release/npm-package.mjs /new-output-directory')
  const result = await packNpm(resolve(process.argv[2]))
  if (process.env.GITHUB_REF_TYPE === 'tag') {
    // tag 构建额外写收据，绑定 tag、提交和 tarball 字节；发布器据此校验。
    const context = releaseContext()
    assert.equal(context.version, result.version)
    const asset = { name: result.name, size: result.size, sha256: result.sha256 }
    writeFileSync(join(resolve(process.argv[2]), 'receipt.json'), encode({ ...context, asset }))
  }
  console.log(encode({ name: result.name, size: result.size, sha256: result.sha256 }))
}
