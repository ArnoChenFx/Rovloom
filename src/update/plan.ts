// 从官方稳定 Release 与清单建立不可变计划；检查阶段只读网络，不读取或修改安装和用户数据。
import {
  MAX_BINARY_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_RELEASE_BYTES,
  UPDATE_MANIFEST,
  UPDATE_REPOSITORY,
  UpdateError,
  updatePlatform,
  type UpdateAsset,
  type UpdateManifest,
  type UpdatePlatform
} from './contract.js'
import { validateReleaseManifest } from '../release/contract.js'
import { officialAssetUrl, readOfficialJson, type UpdateNetwork } from './network.js'
import { compareVersions, stableVersion } from './version.js'

export type UpdatePlan = Readonly<{
  repository: typeof UPDATE_REPOSITORY
  currentVersion: string
  targetVersion: string
  tag: string
  commit: string
  bun: '1.4.3'
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

// 复用发布端共享的封闭清单规则；默认更新额外要求稳定版本。
export function parseUpdateManifest(input: unknown, tag: string): UpdateManifest {
  try {
    return validateReleaseManifest(input, tag, true)
  } catch {
    throw new UpdateError('invalid_manifest')
  }
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

// 有界解引用官方轻量或附注 tag，清单 commit 必须仍绑定当前远端 tag。
async function verifyManifestTag(network: UpdateNetwork, manifest: UpdateManifest): Promise<void> {
  let value = record(
    await readOfficialJson(network, { kind: 'tag-ref', tag: manifest.tag }, MAX_RELEASE_BYTES),
    'invalid_release'
  )
  for (let depth = 0; depth <= 4; depth++) {
    const object = record(value.object, 'invalid_release')
    if (typeof object.sha !== 'string' || !/^[0-9a-f]{40}$/u.test(object.sha)) {
      throw new UpdateError('invalid_release')
    }
    if (object.type === 'commit') {
      if (object.sha !== manifest.commit) {
        throw new UpdateError('invalid_manifest')
      }
      return
    }
    if (object.type !== 'tag' || depth === 4) {
      throw new UpdateError('invalid_release')
    }
    value = record(
      await readOfficialJson(network, { kind: 'tag-object', sha: object.sha }, MAX_RELEASE_BYTES),
      'invalid_release'
    )
  }
}

// 检查 GitHub 标记的最新稳定发行；较旧或相同版本只报告状态，绝不自动降级。
export async function checkForUpdate(
  network: UpdateNetwork,
  currentVersion: string,
  platform: UpdatePlatform
): Promise<UpdatePlan> {
  compareVersions(currentVersion, currentVersion)
  const local = updatePlatform(platform.os, platform.arch, platform.libc)
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
  await verifyManifestTag(network, manifest)
  const asset = manifest.assets.find(
    /* 精确匹配当前 OS 和架构，不回退其它平台。 */ (item) =>
      item.os === local.os && item.arch === local.arch && item.libc === local.libc
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
    commit: manifest.commit,
    bun: manifest.bun,
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
      commit: plan.commit,
      bun: plan.bun,
      assets: [plan.asset]
    },
    plan.tag
  )
  const local = updatePlatform(plan.platform.os, plan.platform.arch, plan.platform.libc)
  const asset = manifest.assets[0]!
  if (
    plan.status !== 'available' ||
    compareVersions(plan.targetVersion, plan.currentVersion) <= 0 ||
    asset.os !== local.os ||
    asset.arch !== local.arch ||
    asset.libc !== local.libc
  ) {
    throw new UpdateError('invalid_manifest')
  }
  return asset
}
