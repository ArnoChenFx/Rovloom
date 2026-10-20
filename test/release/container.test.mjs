/** 隔离验证容器发布的事件、资产来源和不可覆盖边界；不登录或推送真实registry。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import {
  image,
  indexDescriptors,
  inspectTestedImages,
  inspectVersion,
  isLatest,
  matchExistingIndex,
  releaseContext,
  verifyBinary
} from '../../scripts/container/release.mjs'
import { assetName } from '../../src/release/contract.ts'

/** 内存元数据严格对应现行发布合同，fake二进制只测字节验证，不作为产品验收。 */
function fixture() {
  const context = { tag: 'v0.1.0', version: '0.1.0', commit: 'a'.repeat(40) }
  const run = {
    id: 7,
    name: 'Tagged product release',
    event: 'push',
    conclusion: 'success',
    status: 'completed',
    head_sha: context.commit,
    head_branch: context.tag,
    path: '.github/workflows/release.yml',
    repository: { full_name: 'ArnoChenFx/Rovloom' },
    head_repository: { full_name: 'ArnoChenFx/Rovloom' }
  }
  const bytes = Buffer.from('synthetic-container-binary')
  const hash = /** 合成内容仍由真实摘要算法核验。 */ (value) => createHash('sha256').update(value).digest('hex')
  const assets = ['linux', 'darwin', 'windows'].flatMap(
    /** 覆盖全部六个平台的固定资产名。 */ (os) =>
      ['x64', 'arm64'].map(
        /** 不在JSON中引入下载URL。 */ (arch) => {
          const platform = { os, arch, libc: os === 'linux' ? 'glibc' : null }
          return { ...platform, name: assetName(context.version, platform), size: bytes.length, sha256: hash(bytes) }
        }
      )
  )
  const manifest = Buffer.from(
    JSON.stringify({ schemaVersion: 1, repository: 'ArnoChenFx/Rovloom', ...context, bun: '1.4.3', assets }) + '\n'
  )
  const sums = Buffer.from(
    assets.map(/** 摘要只对应相同字节，不复用随意声明。 */ (asset) => `${asset.sha256}  ${asset.name}\n`).join('') +
      `${hash(manifest)}  release-manifest.json\n`
  )
  const release = {
    draft: false,
    prerelease: false,
    tag_name: context.tag,
    target_commitish: context.commit,
    body: `fixture <!-- rovloom-release:1 ${context.tag} ${context.commit} -->`,
    assets: [
      ...assets.map(/** REST字段与正式下载名一一对应。 */ (asset) => asset.name),
      'release-manifest.json',
      'SHA256SUMS'
    ].map(
      /** 公共元数据只能指向固定官方版本路径。 */ (name) => ({
        name,
        state: 'uploaded',
        browser_download_url: `https://github.com/ArnoChenFx/Rovloom/releases/download/${context.tag}/${name}`
      })
    )
  }
  const event = { repository: { full_name: 'ArnoChenFx/Rovloom' }, workflow_run: structuredClone(run) }
  const api = /** 只响应实际验证路径，意外网络路径立即失败。 */ async (path) => {
    if (path.endsWith('/actions/runs/7')) {
      return structuredClone(run)
    }
    if (path.includes('/git/ref/tags/')) {
      return { object: { type: 'commit', sha: run.head_sha } }
    }
    if (path.includes('/releases/')) {
      return structuredClone(release)
    }
    assert.fail('unexpected container metadata path')
  }
  return { context, run, event, api, release, manifest, sums, bytes }
}

test(
  'container publisher only targets GHCR and accepts the exact successful official tag workflow',
  /** 无真实registry请求。 */ async () => {
    const f = fixture()
    assert.equal(image, 'ghcr.io/arnochenfx/rovloom')
    assert.deepEqual(await releaseContext(f.event, f.api), f.context)
    for (const mutation of [
      'fork',
      'pull_request',
      'failed',
      'workflow',
      'branch',
      'moved',
      'draft',
      'foreign-asset'
    ]) {
      const changed = fixture()
      if (mutation === 'fork') {
        changed.event.workflow_run.head_repository.full_name = 'fork/Rovloom'
      }
      if (mutation === 'pull_request') {
        changed.event.workflow_run.event = 'pull_request'
      }
      if (mutation === 'failed') {
        changed.event.workflow_run.conclusion = 'failure'
      }
      if (mutation === 'workflow') {
        changed.run.path = '.github/workflows/fake.yml'
      }
      if (mutation === 'branch') {
        changed.event.workflow_run.head_branch = changed.run.head_branch = 'main'
      }
      if (mutation === 'moved') {
        changed.run.head_sha = 'b'.repeat(40)
      }
      if (mutation === 'draft') {
        changed.release.draft = true
      }
      if (mutation === 'foreign-asset') {
        changed.release.assets[0].browser_download_url = 'https://example.invalid/payload'
      }
      await assert.rejects(releaseContext(changed.event, changed.api), mutation)
    }
  }
)

test(
  'container staging verifies actual binary, complete checksums and manifest commit',
  /** 坏字节不能进入Docker上下文。 */ () => {
    const f = fixture()
    const platform = { os: 'linux', arch: 'x64', libc: 'glibc' }
    assert.equal(verifyBinary(f.context, platform, f.manifest, f.sums, f.bytes).name, 'rovloom-0.1.0-linux-x64')
    for (const mutate of ['binary', 'sums', 'manifest', 'commit', 'platform', 'duplicate']) {
      assert.throws(
        /** 所有反例均在磁盘写入或registry推送前拒绝。 */ () =>
          verifyBinary(
            mutate === 'commit' ? { ...f.context, commit: 'b'.repeat(40) } : f.context,
            mutate === 'platform' ? { ...platform, libc: 'musl' } : platform,
            mutate === 'manifest' ? Buffer.from(f.manifest.toString().replace('0.1.0', '0.1.1')) : f.manifest,
            mutate === 'sums'
              ? Buffer.from('invalid\n')
              : mutate === 'duplicate'
                ? Buffer.concat([f.sums, f.sums])
                : f.sums,
            mutate === 'binary' ? Buffer.from('changed') : f.bytes
          ),
        mutate
      )
    }
  }
)

test(
  'container latest follows the current official stable Release',
  /** 补发旧版本与预发行不抢latest。 */ async () => {
    const f = fixture()
    assert.equal(await isLatest(f.context, f.api), true)
    f.release.tag_name = 'v0.2.0'
    assert.equal(await isLatest(f.context, f.api), false)
    assert.equal(await isLatest({ ...f.context, version: '0.2.0-rc.1' }, f.api), false)
  }
)

/** 合成registry只交付固定manifest/config摘要；不会构建或推送真实镜像。 */
function registryFixture(mode = 'matching') {
  const context = fixture().context
  const stem = `build-${context.commit}-9-1`
  const configurations = { amd64: 'sha256:' + 'c'.repeat(64), arm64: 'sha256:' + 'd'.repeat(64) }
  const mediaType = 'application/vnd.docker.distribution.manifest.v2+json'
  const bodies = Object.fromEntries(
    ['amd64', 'arm64'].map(
      /** 字节决定descriptor，不手填无关联digest。 */ (arch) => [
        arch,
        JSON.stringify({ schemaVersion: 2, mediaType, config: { digest: configurations[arch] } })
      ]
    )
  )
  const index = {
    schemaVersion: 2,
    mediaType: 'application/vnd.docker.distribution.manifest.list.v2+json',
    manifests: ['amd64', 'arm64'].map(
      /** 两个原生平台各占唯一项。 */ (arch) => ({
        mediaType,
        size: Buffer.byteLength(bodies[arch]),
        digest: 'sha256:' + createHash('sha256').update(bodies[arch]).digest('hex'),
        platform: { os: 'linux', architecture: arch }
      })
    )
  }
  if (mode === 'different') {
    index.manifests[0].digest = 'sha256:' + 'e'.repeat(64)
  }
  if (mode === 'extra') {
    index.manifests.push(structuredClone(index.manifests[0]))
  }
  const requests = []
  const request = /** 认证和manifest读取全部在内存，无外部凭据。 */ async (url, options) => {
    requests.push({ url, options })
    if (url.startsWith('https://ghcr.io/token?')) {
      return Response.json({ token: 'synthetic-registry-token' }, { status: mode === 'auth' ? 403 : 200 })
    }
    if (url.endsWith('/manifests/0.1.0')) {
      if (mode === 'absent') {
        return Response.json({ errors: [{ code: 'MANIFEST_UNKNOWN' }] }, { status: 404 })
      }
      if (mode === 'forbidden' || mode === 'unavailable') {
        return new Response('', { status: mode === 'forbidden' ? 403 : 503 })
      }
      if (mode === 'unknown-error') {
        return Response.json({ errors: [{ code: 'DENIED' }] }, { status: 404 })
      }
      return Response.json(index)
    }
    for (const arch of ['amd64', 'arm64']) {
      if (url.endsWith('/manifests/' + stem + '-' + arch)) {
        return new Response(
          mode === 'config' ? bodies[arch].replace(configurations[arch], 'sha256:' + 'f'.repeat(64)) : bodies[arch]
        )
      }
    }
    assert.fail('unexpected synthetic registry path')
  }
  return { context, stem, configurations, index, requests, request }
}

test(
  'GHCR preflight accepts absence or a valid index; authorization and uncertain lookups fail',
  /** 不把网络失败当作未发布。 */ async () => {
    for (const mode of ['absent', 'matching', 'forbidden', 'unavailable', 'unknown-error', 'auth', 'extra']) {
      const r = registryFixture(mode)
      const work = inspectVersion('0.1.0', 'synthetic-actor', 'synthetic-github-token', r.request)
      if (mode === 'absent') {
        assert.equal(await work, null)
      } else if (mode === 'matching') {
        assert.deepEqual(await work, indexDescriptors(r.index))
      } else {
        await assert.rejects(work)
      }
      assert(
        r.requests.every(
          /** 凭据只发固定GHCR，禁止跳转。 */ ({ url, options }) =>
            url.startsWith('https://ghcr.io/') && options.redirect === 'error'
        )
      )
    }
  }
)

test(
  'a published version resumes latest only for the exact two tested image manifests',
  /** 已公开版本不因恢复latest被重写。 */ async () => {
    for (const mode of ['matching', 'absent', 'different', 'extra', 'config']) {
      const r = registryFixture(mode)
      const work = inspectTestedImages(
        r.context,
        'synthetic-actor',
        'synthetic-github-token',
        r.stem,
        r.configurations,
        r.request
      )
      if (mode === 'matching') {
        assert.equal(await work, true)
      } else if (mode === 'absent') {
        assert.equal(await work, false)
      } else {
        await assert.rejects(work)
      }
    }
    const r = registryFixture()
    const expected = indexDescriptors(r.index)
    assert.equal(matchExistingIndex(null, expected), false)
    assert.equal(matchExistingIndex(expected, expected), true)
    const variant = structuredClone(r.index)
    variant.manifests[1].platform.variant = 'v8'
    assert.deepEqual(indexDescriptors(variant), expected)
    variant.manifests[1].platform.variant = 'v9'
    assert.throws(/** 未验收架构变体不得假装同一平台。 */ () => indexDescriptors(variant))
  }
)
