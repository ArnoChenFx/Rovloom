/** npm 注册表发布：与 Release tarball 同一派生清单，tag 公开后用 npm OIDC trusted publishing 上传。 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { npmAssetName, releaseContext } from './metadata.mjs'

/** 注册表要求 repository.url 与发起 OIDC 发布的 GitHub 仓库完全一致，必须指向官方仓库。 */
export const REPOSITORY_URL = 'git+https://github.com/ArnoChenFx/rovloom.git'

/**
 * 从仓库 package.json 取出运行所需字段；脚本、devDependencies 和仓库内部字段不进入发布包。
 * 不写 private：tarball 同时是 npm 注册表发布的字节，libnpmpublish 会对 tarball 内清单拒绝 private 包。
 */
export function registryNpmPackageJson(source) {
  assert.equal(source.name, 'rovloom')
  assert.deepEqual(source.bin, { rovloom: 'dist/src/cli/main.js' })
  assert(source.dependencies && Object.keys(source.dependencies).length > 0, 'Runtime dependencies are required')
  return {
    name: source.name,
    version: source.version,
    description: source.description,
    license: source.license,
    type: source.type,
    engines: source.engines,
    bin: source.bin,
    files: ['dist/src', 'LICENSE', 'README.md'],
    dependencies: source.dependencies,
    repository: { type: 'git', url: REPOSITORY_URL },
    homepage: 'https://github.com/ArnoChenFx/rovloom#readme'
  }
}

/** Release 资产与注册表发布共用同一份派生清单；旧名保留给既有调用方与测试。 */
export const npmPackageJson = registryNpmPackageJson

/** 本地 npm 只作为发布客户端；版本不够时 OIDC 鉴权会静默回退失败，必须显式拒绝。 */
export function assertTrustedPublishingNpm(version) {
  const [major, minor, patch] = version.split('.').map(Number)
  const supported = major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1)))
  assert(supported, `Trusted publishing requires npm 11.5.1 or newer (found ${version})`)
}

/** 稳定版发布到 latest；预发布用独立 dist-tag，与 GitHub 侧 make_latest 的规则一致。 */
export function npmPublishArgv(path, version) {
  const argv = ['publish', path, '--provenance', '--access', 'public', '--loglevel', 'warn']
  if (version.includes('-')) {
    argv.push('--tag', 'prerelease')
  }
  return argv
}

/**
 * 核对已下载的注册表 manifest 后上传 Release 同款 tarball：
 * 版本未发布过则发布；已存在时只在 tarball 字节（sha512 integrity）完全一致时只读成功，不同字节绝不覆盖。
 * 鉴权由 npm CLI 在 GitHub Actions 中用 OIDC trusted publishing 完成，这里不注入任何长期凭据。
 */
export async function publishNpm(tarball, env = process.env, run = npmClient) {
  const path = resolve(tarball)
  const context = releaseContext(env)
  const name = npmAssetName(context.version)
  assert(path.endsWith(`/${name}`), 'npm tarball does not belong to this release tag')
  const bytes = readFileSync(path)
  const packument = await fetch('https://registry.npmjs.org/rovloom', {
    signal: AbortSignal.timeout(60_000),
    headers: { Accept: 'application/vnd.npm.install-v1+json' }
  })
  assert(
    packument.status !== 404,
    'Package missing from the npm registry; see docs/DISTRIBUTION.md for first-publish setup'
  )
  assert(packument.ok, `npm registry returned ${packument.status}`)
  const version = (await packument.json()).versions?.[context.version]
  if (version === undefined) {
    const listed = run(['--version'], { encoding: 'utf8', timeout: 60_000 })
    assert.equal(listed.status, 0, `npm is not available: ${listed.stderr}`)
    assertTrustedPublishingNpm(listed.stdout.trim())
    const publish = run(npmPublishArgv(path, context.version), {
      // 固定在临时目录调用：绝对 tarball 路径不依赖工作目录，也不让仓库的 bunfig 参与 npm 行为。
      cwd: tmpdir(),
      encoding: 'utf8',
      timeout: 300_000,
      env
    })
    const output = `${publish.stdout}\n${publish.stderr}`
    assert.equal(publish.status, 0, `npm publish failed: ${output}`)
    assert(
      output.includes(`rovloom@${context.version}`),
      `npm publish output does not confirm ${context.version}: ${output}`
    )
    return { status: 'published', version: context.version, name }
  }
  assert.equal(
    version.dist?.integrity,
    `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    `npm registry already has ${name} with different bytes; refusing to overwrite`
  )
  return { status: 'already-published', version: context.version, name }
}

/** npm ≥ 11.5.1 自动检测 Actions 的 OIDC 环境并换取短期发布凭据；显式要求 provenance，注册表来源不接受覆盖。 */
function npmClient(argv, options) {
  return spawnSync('npm', argv, options)
}

if (import.meta.main) {
  assert.equal(process.argv.length, 3, 'Usage: bun scripts/release/registry.mjs /staged-npm-directory')
  const directory = resolve(process.argv[2])
  const tarball = readdirSync(directory).find((entry) => /^rovloom-[0-9]+\.[0-9]+\.[0-9]+.*\.tgz$/u.test(entry))
  assert(tarball, 'Staged npm directory does not contain the release tarball')
  console.log(JSON.stringify(await publishNpm(join(directory, tarball))))
}
