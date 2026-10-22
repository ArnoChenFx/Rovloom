import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { assertTarballEntries, npmPackageJson } from '../../scripts/release/npm-package.mjs'
import {
  assemble,
  assetName,
  encode,
  fileMetadata,
  npmAssetName,
  platforms,
  repository
} from '../../scripts/release/metadata.mjs'
import { publish } from '../../scripts/release/publish.mjs'
import { validateReleaseManifest } from '../../src/release/contract.ts'

const context = { tag: 'v0.1.1', version: '0.1.1', commit: 'a'.repeat(40) }
const source = {
  name: 'rovloom',
  version: '0.1.1',
  description: 'd',
  license: 'Apache-2.0',
  private: true,
  type: 'module',
  engines: { bun: '>=1.4.3' },
  bin: { rovloom: 'dist/src/cli/main.js' },
  files: ['dist/src', 'LICENSE', 'README.md'],
  scripts: { build: 'x' },
  dependencies: { ajv: '^8' },
  devDependencies: { typescript: '^7' }
}

/** 二进制平台目录加 npm 目录，全部是小型测试数据，始终清理。 */
function fixture() {
  const directory = mkdtempSync(resolve(tmpdir(), 'rovloom-npm-release-'))
  const platformsDirectory = resolve(directory, 'platforms')
  const npm = resolve(directory, 'npm')
  mkdirSync(platformsDirectory)
  mkdirSync(npm)
  for (const platform of platforms) {
    const folder = resolve(platformsDirectory, platform.target)
    mkdirSync(folder)
    const name = assetName(context.version, platform)
    writeFileSync(resolve(folder, name), `test-only-${platform.target}`)
    const asset = {
      os: platform.os,
      arch: platform.arch,
      libc: platform.libc,
      name,
      ...fileMetadata(resolve(folder, name))
    }
    writeFileSync(resolve(folder, 'receipt.json'), encode({ ...context, target: platform.target, asset }))
  }
  const name = npmAssetName(context.version)
  writeFileSync(resolve(npm, name), 'test-only-tarball')
  const asset = { name, ...fileMetadata(resolve(npm, name)) }
  writeFileSync(resolve(npm, 'receipt.json'), encode({ ...context, asset }))
  return { platformsDirectory, npm, name, cleanup: () => rmSync(directory, { recursive: true, force: true }) }
}

test('npm 包的 package.json 只含运行所需字段，bin 固定指向构建入口', () => {
  const result = npmPackageJson(source)
  assert.deepEqual(result.bin, { rovloom: 'dist/src/cli/main.js' })
  assert.deepEqual(result.dependencies, source.dependencies)
  assert.equal(result.scripts, undefined)
  assert.equal(result.devDependencies, undefined)
  assert.equal(result.private, true)
  assert.equal(result.version, '0.1.1')
  assert.throws(() => npmPackageJson({ ...source, bin: { rovloom: 'src/cli/main.ts' } }))
  assert.throws(() => npmPackageJson({ ...source, dependencies: {} }))
})

test('tarball 条目白名单拒绝源码、sourcemap、测试和路径逃逸', () => {
  const good = [
    'package/',
    'package/package.json',
    'package/LICENSE',
    'package/README.md',
    'package/dist/src/cli/main.js',
    'package/dist/src/chunk-abc.js'
  ]
  assertTarballEntries(good)
  for (const bad of [
    'package/dist/src/cli/main.js.map',
    'package/src/cli/main.ts',
    'package/test/a.js',
    'package/dist/src/../x.js',
    'package/node_modules/x/index.js',
    'other/package.json'
  ]) {
    assert.throws(() => assertTarballEntries([...good, bad]), bad)
  }
  assert.throws(() => assertTarballEntries(good.filter((entry) => !entry.endsWith('cli/main.js'))))
})

test('发布包含 npm tarball：只进 SHA256SUMS，不进 release-manifest.json', () => {
  const files = fixture()
  try {
    const plain = assemble(context, files.platformsDirectory)
    const bundle = assemble(context, files.platformsDirectory, files.npm)
    assert.equal(bundle.manifestBytes, plain.manifestBytes)
    assert(!bundle.manifestBytes.includes('.tgz'))
    validateReleaseManifest(JSON.parse(bundle.manifestBytes), context.tag)
    const sum = createHash('sha256').update('test-only-tarball').digest('hex')
    assert(bundle.checksumsBytes.includes(`${sum}  ${files.name}\n`))
    assert.equal(bundle.npm.name, files.name)
  } finally {
    files.cleanup()
  }
})

test('npm 收据与 tag、提交或字节不符时在任何写入前失败', () => {
  const files = fixture()
  try {
    writeFileSync(resolve(files.npm, files.name), 'changed-after-receipt')
    assert.throws(() => assemble(context, files.platformsDirectory, files.npm), /receipt/u)
    writeFileSync(resolve(files.npm, 'extra.txt'), 'x')
    assert.throws(() => assemble(context, files.platformsDirectory, files.npm))
  } finally {
    files.cleanup()
  }
})

test('publish 上传 tarball 并在全部资产核对后才公开', async () => {
  const files = fixture()
  try {
    const bundle = assemble(context, files.platformsDirectory, files.npm)
    const uploaded = []
    let release
    const api = async (path, { method = 'GET', json, bytes } = {}) => {
      assert(path.startsWith(`/repos/${repository}/`))
      if (path.includes('/git/ref/tags/')) {
        return { object: { type: 'commit', sha: context.commit } }
      }
      if (method === 'GET' && path.includes('/releases?')) {
        return release ? [structuredClone(release)] : []
      }
      if (method === 'GET' && path.endsWith('/assets?per_page=100')) {
        return structuredClone(uploaded)
      }
      if (method === 'POST' && path.endsWith('/releases')) {
        release = { id: 1, ...json }
        return structuredClone(release)
      }
      if (method === 'POST' && path.includes('/assets?name=')) {
        uploaded.push({
          name: decodeURIComponent(path.split('?name=')[1]),
          size: bytes.length,
          digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          state: 'uploaded'
        })
        return {}
      }
      if (method === 'PATCH') {
        assert.equal(uploaded.length, platforms.length + 3)
        release = { ...release, ...json }
        return structuredClone(release)
      }
      throw new Error(`Unexpected mock API call: ${method} ${path}`)
    }
    assert.equal((await publish(context, bundle, api)).status, 'published')
    assert(uploaded.some((asset) => asset.name === files.name))
    assert(release.body.includes(`rovloom-${context.version}.tgz`))
    assert.equal(release.draft, false)
  } finally {
    files.cleanup()
  }
})
