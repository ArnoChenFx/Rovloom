// 从官方稳定 Release 与清单建立不可变计划；检查阶段只读网络，不读取或修改安装和用户数据。
import {
  MAX_BINARY_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_RELEASE_BYTES,
  UPDATE_MANIFEST,
  UPDATE_REPOSITORY,
  UpdateError,
  updateAssetName,
  updatePlatform,
  type UpdateAsset,
  type UpdateManifest,
  type UpdatePlatform
} from './contract.js'
import { officialAssetUrl, readOfficialJson, type UpdateNetwork } from './network.js'
import { compareVersions, stableVersion } from './version.js'

export type UpdatePlan = Readonly<{
  repository: typeof UPDATE_REPOSITORY
  currentVersion: string
  targetVersion: string
  tag: string
  platform: UpdatePlatform
  asset: UpdateAsset
  status: 'available' | 'up_to_date' | 'newer_than_release'
}>
type JsonRecord = Record<string, unknown>

// 拒绝数组、空值及非对象元数据，统一使用调用方指定的固定错误。
function record(value: unknown, code: 'invalid_release' | 'invalid_manifest'): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UpdateError(code)
  }
  return value as JsonRecord
}

// 清单字段使用封闭集合，禁止加入可执行命令、动态路径或下载 URL。
function keys(value: JsonRecord, allowed: readonly string[]): void {
  if (
    Object.keys(value).length !== allowed.length ||
    Object.keys(value).some(/* 限定每个字段必须由本地契约识别。 */ (key) => !allowed.includes(key))
  ) {
    throw new UpdateError('invalid_manifest')
  }
}

// 核验稳定 tag、仓库、版本、平台唯一性、固定名称、大小与摘要，并复制冻结远端值。
export function parseUpdateManifest(input: unknown, tag: string): UpdateManifest {
  const value = record(input, 'invalid_manifest')
  keys(value, ['schemaVersion', 'repository', 'tag', 'version', 'assets'])
  if (
    value.schemaVersion !== 1 ||
    value.repository !== UPDATE_REPOSITORY ||
    value.tag !== tag ||
    !stableVersion(value.version) ||
    tag !== `v${value.version}` ||
    !Array.isArray(value.assets) ||
    value.assets.length < 1 ||
    value.assets.length > 6
  ) {
    throw new UpdateError('invalid_manifest')
  }
  const seen = new Set<string>()
  const assets: UpdateAsset[] = []
  for (const item of value.assets) {
    const raw = record(item, 'invalid_manifest')
    keys(raw, ['os', 'arch', 'name', 'size', 'sha256'])
    if (!['linux', 'darwin', 'windows'].includes(String(raw.os)) || !['x64', 'arm64'].includes(String(raw.arch))) {
      throw new UpdateError('invalid_manifest')
    }
    const platform = updatePlatform(String(raw.os), String(raw.arch))
    const name = updateAssetName(platform)
    if (
      raw.name !== name ||
      seen.has(name) ||
      !Number.isSafeInteger(raw.size) ||
      (raw.size as number) < 1 ||
      (raw.size as number) > MAX_BINARY_BYTES ||
      typeof raw.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(raw.sha256)
    ) {
      throw new UpdateError('invalid_manifest')
    }
    seen.add(name)
    assets.push(Object.freeze({ ...platform, name, size: raw.size as number, sha256: raw.sha256 }))
  }
  return Object.freeze({
    schemaVersion: 1,
    repository: UPDATE_REPOSITORY,
    tag,
    version: value.version,
    assets: Object.freeze(assets)
  })
}

// 只接受本次 Release 中唯一、已上传且 URL 与本地构造完全一致的指定资产。
function releaseAsset(assets: unknown[], tag: string, name: string, limit: number): number {
  const matches = assets.filter(
    /* 不从其它发行或外部 URL 补齐资产。 */ (asset) => record(asset, 'invalid_release').name === name
  )
  if (matches.length !== 1) {
    throw new UpdateError('invalid_release')
  }
  const item = record(matches[0], 'invalid_release')
  if (
    item.state !== 'uploaded' ||
    !Number.isSafeInteger(item.size) ||
    (item.size as number) < 1 ||
    (item.size as number) > limit ||
    item.browser_download_url !== officialAssetUrl(tag, name)
  ) {
    throw new UpdateError('invalid_release')
  }
  return item.size as number
}

// 检查 GitHub 标记的最新稳定发行；较旧或相同版本只报告状态，绝不自动降级。
export async function checkForUpdate(
  network: UpdateNetwork,
  currentVersion: string,
  platform: UpdatePlatform
): Promise<UpdatePlan> {
  compareVersions(currentVersion, currentVersion)
  const local = updatePlatform(platform.os, platform.arch)
  const release = record(await readOfficialJson(network, { kind: 'release' }, MAX_RELEASE_BYTES), 'invalid_release')
  if (
    release.draft !== false ||
    release.prerelease !== false ||
    typeof release.tag_name !== 'string' ||
    !release.tag_name.startsWith('v') ||
    !stableVersion(release.tag_name.slice(1)) ||
    !Array.isArray(release.assets)
  ) {
    throw new UpdateError('invalid_release')
  }
  const tag = release.tag_name
  const manifestSize = releaseAsset(release.assets, tag, UPDATE_MANIFEST, MAX_MANIFEST_BYTES)
  const manifest = parseUpdateManifest(
    await readOfficialJson(network, { kind: 'asset', tag, name: UPDATE_MANIFEST }, MAX_MANIFEST_BYTES, manifestSize),
    tag
  )
  const asset = manifest.assets.find(
    /* 精确匹配当前 OS 和架构，不回退其它平台。 */ (item) => item.os === local.os && item.arch === local.arch
  )
  if (!asset) {
    throw new UpdateError('unsupported_platform')
  }
  if (releaseAsset(release.assets, tag, asset.name, MAX_BINARY_BYTES) !== asset.size) {
    throw new UpdateError('invalid_release')
  }
  const comparison = compareVersions(manifest.version, currentVersion)
  return Object.freeze({
    repository: UPDATE_REPOSITORY,
    currentVersion,
    targetVersion: manifest.version,
    tag,
    platform: local,
    asset,
    status: comparison > 0 ? 'available' : comparison === 0 ? 'up_to_date' : 'newer_than_release'
  })
}

// 下载入口重新检查完整计划，不把外部构造或后续变更的对象当作可信计划。
export function validateDownloadPlan(plan: UpdatePlan): UpdateAsset {
  const manifest = parseUpdateManifest(
    {
      schemaVersion: 1,
      repository: plan.repository,
      tag: plan.tag,
      version: plan.targetVersion,
      assets: [plan.asset]
    },
    plan.tag
  )
  const local = updatePlatform(plan.platform.os, plan.platform.arch)
  const asset = manifest.assets[0]!
  if (
    plan.status !== 'available' ||
    compareVersions(plan.targetVersion, plan.currentVersion) <= 0 ||
    asset.os !== local.os ||
    asset.arch !== local.arch
  ) {
    throw new UpdateError('invalid_manifest')
  }
  return asset
}
