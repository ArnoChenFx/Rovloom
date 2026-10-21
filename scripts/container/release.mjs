/** 只接受官方成功的tag发行工作流；下载原发布资产，不从PR或第三方URL取得发布字节。 */
import assert from 'node:assert/strict'
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import {
  RELEASE_REPOSITORY,
  RELEASE_MANIFEST,
  assetName,
  parseReleaseJson,
  parseReleaseVersion,
  validateReleaseManifest,
  versionFromTag
} from '../../src/release/contract.ts'
import { githubClient, verifyRemoteTag } from '../release/github.mjs'

export const image = 'ghcr.io/arnochenfx/rovloom'
const prefix = `/repos/${RELEASE_REPOSITORY}`

/** 事件与实时Run API双重核验；一个同名PR工作流不能取得发布资格。 */
export async function releaseContext(event, api) {
  assert.equal(event.repository?.full_name, RELEASE_REPOSITORY)
  const trigger = event.workflow_run
  assert.equal(trigger?.head_repository?.full_name, RELEASE_REPOSITORY)
  assert.equal(trigger?.name, 'Tagged product release')
  assert.equal(trigger?.event, 'push')
  assert.equal(trigger?.conclusion, 'success')
  assert(Number.isSafeInteger(trigger.id) && trigger.id > 0)
  const run = await api(`${prefix}/actions/runs/${trigger.id}`)
  for (const field of ['id', 'name', 'event', 'conclusion', 'head_sha', 'head_branch']) {
    assert.equal(run[field], trigger[field], 'Workflow run changed or differs from event')
  }
  assert.equal(run.path, '.github/workflows/release.yml')
  assert.equal(run.repository?.full_name, RELEASE_REPOSITORY)
  assert.equal(run.head_repository?.full_name, RELEASE_REPOSITORY)
  assert.equal(run.status, 'completed')
  assert(/^[0-9a-f]{40}$/u.test(run.head_sha))
  const context = { tag: run.head_branch, version: versionFromTag(run.head_branch), commit: run.head_sha }
  await verifyRemoteTag(api, context)
  const release = await api(`${prefix}/releases/tags/${encodeURIComponent(context.tag)}`)
  assert.equal(release.draft, false)
  assert.equal(release.tag_name, context.tag)
  // target_commitish 只是创建 tag 的提示；已解析的远端 tag 与发行说明才绑定工作流提交。
  assert.equal(release.prerelease, parseReleaseVersion(context.version).prerelease.length > 0)
  assert.equal(typeof release.body, 'string')
  assert(release.body.includes(`<!-- rovloom-release:1 ${context.tag} ${context.commit} -->`))
  assert(Array.isArray(release.assets) && release.assets.length === 8, 'Expected complete six-binary release')
  const names = new Set(release.assets.map(/** 重复或额外资产不能混入镜像来源。 */ (asset) => asset.name))
  const expected = [RELEASE_MANIFEST, 'SHA256SUMS']
  for (const os of ['linux', 'darwin', 'windows']) {
    for (const arch of ['x64', 'arm64']) {
      expected.push(assetName(context.version, { os, arch, libc: os === 'linux' ? 'glibc' : null }))
    }
  }
  assert.equal(names.size, 8)
  assert(expected.every(/** 资产名必须精确属于该tag的合同。 */ (name) => names.has(name)))
  for (const asset of release.assets) {
    assert.equal(asset.state, 'uploaded')
    assert.equal(asset.browser_download_url, downloadUrl(context.tag, asset.name))
  }
  return context
}

/** 原始资产固定在官方不可替换版本路径；不接受latest下载或环境提供的镜像站。 */
function downloadUrl(tag, name) {
  return `https://github.com/${RELEASE_REPOSITORY}/releases/download/${tag}/${name}`
}

/** 公开下载不附带GITHUB_TOKEN；有界读取，最终跳转只接纳GitHub官方资产域。 */
export async function download(tag, name, limit, request = fetch) {
  const response = await request(downloadUrl(tag, name), { signal: AbortSignal.timeout(120_000) })
  assert(response.ok, `Official release asset download failed (${response.status})`)
  assert(
    ['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(
      new URL(response.url).hostname
    )
  )
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    assert(size <= limit, 'Release asset exceeded byte limit')
    chunks.push(Buffer.from(chunk))
  }
  assert(size > 0, 'Empty release asset')
  return Buffer.concat(chunks)
}

/** 校验校验和文件精确记录、manifest来源和实际二进制全字节后才写Docker上下文。 */
export function verifyBinary(context, platform, manifestBytes, checksumsBytes, binary) {
  const manifest = validateReleaseManifest(parseReleaseJson(manifestBytes, 65_536), context.tag)
  assert.equal(manifest.commit, context.commit)
  assert.equal(manifest.assets.length, 6)
  const records = new Map()
  const lines = checksumsBytes.toString('utf8').split('\n')
  assert.equal(lines.pop(), '')
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9.-]+)$/u.exec(line)
    assert(match && !records.has(match[2]), 'Invalid or duplicate SHA256SUMS record')
    records.set(match[2], match[1])
  }
  assert.equal(records.size, 7)
  const digest = /** 所有摘要均来自实际收到的字节。 */ (bytes) => createHash('sha256').update(bytes).digest('hex')
  assert.equal(records.get(RELEASE_MANIFEST), digest(manifestBytes))
  for (const asset of manifest.assets) {
    assert.equal(records.get(asset.name), asset.sha256)
  }
  const name = assetName(context.version, platform)
  const selected = manifest.assets.find(
    /** 每个原生runner只接受自己的唯一Linux/glibc产物。 */ (asset) => asset.name === name
  )
  assert(selected, 'Native platform asset missing')
  assert.equal(binary.byteLength, selected.size)
  assert.equal(digest(binary), selected.sha256)
  return selected
}

/** 只在此版本仍为官方稳定latest时移动容器latest，后补旧版本和预发行只得固定标签。 */
export async function isLatest(context, api) {
  if (parseReleaseVersion(context.version).prerelease.length) {
    return false
  }
  const latest = await api(`${prefix}/releases/latest`)
  return latest.tag_name === context.tag && latest.draft === false && latest.prerelease === false
}

/** 临时registry凭据只发往固定GHCR授权端，拒绝重定向和认证故障。 */
async function registryToken(actor, token, request) {
  assert(typeof actor === 'string' && actor.length > 0)
  assert(typeof token === 'string' && token.length > 0)
  const authorization = 'Basic ' + Buffer.from(actor + ':' + token).toString('base64')
  const auth = await request(
    'https://ghcr.io/token?service=ghcr.io&scope=repository%3Aarnochenfx%2Frovloom%3Apull%2Cpush',
    {
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { authorization }
    }
  )
  assert(auth.ok, 'GHCR authorization failed')
  const credentials = await auth.json()
  assert(typeof credentials.token === 'string' && credentials.token.length > 0, 'GHCR token missing')
  return credentials.token
}

/** 只有明确不存在返回null；其它HTTP、认证或格式故障均保留为失败。 */
async function registryManifest(reference, token, request) {
  const response = await request(`https://ghcr.io/v2/arnochenfx/rovloom/manifests/${reference}`, {
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    headers: {
      authorization: 'Bearer ' + token,
      accept:
        'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'
    }
  })
  if (response.status === 404) {
    const failure = await response.json()
    assert(Array.isArray(failure.errors) && failure.errors.length > 0)
    assert(
      failure.errors.every(
        /** 不将权限或服务故障解释为不存在。 */
        (error) => ['MANIFEST_UNKNOWN', 'NAME_UNKNOWN'].includes(error.code)
      )
    )
    return null
  }
  assert.equal(response.status, 200, 'GHCR manifest lookup failed')
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    assert(size <= 1_048_576, 'Registry manifest exceeded byte limit')
    chunks.push(Buffer.from(chunk))
  }
  const bytes = Buffer.concat(chunks)
  const value = parseReleaseJson(bytes, 1_048_576)
  assert.equal(value.schemaVersion, 2)
  return { value, size, digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex') }
}

/** 精确投影两个已接受平台的descriptor；不允许额外平台、重复项或未知架构混入。 */
export function indexDescriptors(value) {
  assert.equal(value.schemaVersion, 2)
  assert(
    ['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json'].includes(
      value.mediaType
    )
  )
  assert(Array.isArray(value.manifests) && value.manifests.length === 2)
  const seen = new Set()
  const descriptors = value.manifests.map(
    /** arm64的v8与省略variant只作为同一原生平台表示。 */ (entry) => {
      assert(entry.platform?.os === 'linux' && ['amd64', 'arm64'].includes(entry.platform.architecture))
      const arch = entry.platform.architecture
      assert(!seen.has(arch))
      seen.add(arch)
      assert(entry.platform.variant === undefined || (arch === 'arm64' && entry.platform.variant === 'v8'))
      assert(
        ['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'].includes(
          entry.mediaType
        )
      )
      assert(/^sha256:[0-9a-f]{64}$/u.test(entry.digest))
      assert(Number.isSafeInteger(entry.size) && entry.size > 0)
      return {
        mediaType: entry.mediaType,
        digest: entry.digest,
        size: entry.size,
        platform: { os: 'linux', architecture: arch }
      }
    }
  )
  return descriptors.sort(
    /** 固定顺序仅用于同值比较，不改变远端index字节。 */
    (left, right) => left.platform.architecture.localeCompare(right.platform.architecture)
  )
}

/** 预检允许已有合法index，后续必须核对本次精确tested descriptors才能只读恢复。 */
export async function inspectVersion(version, actor, token, request = fetch) {
  parseReleaseVersion(version)
  const bearer = await registryToken(actor, token, request)
  const existing = await registryManifest(version, bearer, request)
  return existing ? indexDescriptors(existing.value) : null
}

/** 已有固定版本仅在两个完整descriptor与本次验收字节相等时复用，绝不覆盖不同bytes。 */
export function matchExistingIndex(existing, expected) {
  if (existing === null) {
    return false
  }
  assert.deepEqual(existing, expected, 'Existing version index differs from tested images; refusing to overwrite')
  return true
}

/** 用远端原始manifest和本次已load镜像config摘要连接实际测试产物与发布index。 */
export async function inspectTestedImages(context, actor, token, stem, configurations, request = fetch) {
  assert(new RegExp(`^build-${context.commit}-[1-9]\\d*-[1-9]\\d*$`, 'u').test(stem))
  const bearer = await registryToken(actor, token, request)
  const expected = []
  for (const arch of ['amd64', 'arm64']) {
    assert(/^sha256:[0-9a-f]{64}$/u.test(configurations[arch]))
    const manifest = await registryManifest(stem + '-' + arch, bearer, request)
    assert(manifest, 'Tested architecture image missing')
    assert(
      ['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'].includes(
        manifest.value.mediaType
      )
    )
    assert.equal(
      manifest.value.config?.digest,
      configurations[arch],
      'Pushed image differs from loaded tested artifact'
    )
    expected.push({
      mediaType: manifest.value.mediaType,
      digest: manifest.digest,
      size: manifest.size,
      platform: { os: 'linux', architecture: arch }
    })
  }
  const existing = await registryManifest(context.version, bearer, request)
  return matchExistingIndex(existing ? indexDescriptors(existing.value) : null, expected)
}

if (import.meta.main) {
  const [action, directory] = process.argv.slice(2)
  assert(['verify', 'stage', 'latest', 'available', 'version'].includes(action))
  const api = githubClient(process.env.GITHUB_TOKEN)
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  const context = await releaseContext(event, api)
  if (action === 'stage') {
    assert.equal(process.platform, 'linux', 'Container acceptance requires a native Linux runner')
    assert(['x64', 'arm64'].includes(process.arch))
    const platform = { os: 'linux', arch: process.arch, libc: 'glibc' }
    const manifest = await download(context.tag, RELEASE_MANIFEST, 65_536)
    const sums = await download(context.tag, 'SHA256SUMS', 8192)
    const binary = await download(context.tag, assetName(context.version, platform), 256 * 1024 * 1024)
    const asset = verifyBinary(context, platform, manifest, sums, binary)
    const destination = resolve(directory)
    mkdirSync(destination, { recursive: false })
    writeFileSync(resolve(destination, 'rovloom'), binary, { mode: 0o755, flag: 'wx' })
    chmodSync(resolve(destination, 'rovloom'), 0o755)
    appendFileSync(process.env.GITHUB_OUTPUT, `sha256=${asset.sha256}\n`)
  } else if (action === 'available') {
    await inspectVersion(context.version, process.env.GITHUB_ACTOR, process.env.GITHUB_TOKEN)
  } else if (action === 'version') {
    const existing = await inspectTestedImages(
      context,
      process.env.GITHUB_ACTOR,
      process.env.GITHUB_TOKEN,
      process.env.BUILD_STEM,
      { amd64: process.env.AMD64_CONFIG, arm64: process.env.ARM64_CONFIG }
    )
    appendFileSync(process.env.GITHUB_OUTPUT, `existing=${existing}\n`)
  } else if (action === 'latest') {
    appendFileSync(process.env.GITHUB_OUTPUT, `latest=${await isLatest(context, api)}\n`)
  } else {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `tag=${context.tag}\nversion=${context.version}\ncommit=${context.commit}\n`
    )
  }
}
