// 固定官方更新清单契约；发布任务须采用同一字段和命名，不从远端清单读取 URL 或命令。
import {
  assetName,
  releasePlatform,
  RELEASE_MAX_BINARY_BYTES,
  RELEASE_MANIFEST,
  RELEASE_REPOSITORY,
  type ReleasePlatform,
  type ReleaseAsset,
  type ReleaseManifest,
  type ReleaseOs,
  type ReleaseArch
} from '../release/contract.js'
export const UPDATE_REPOSITORY = RELEASE_REPOSITORY
export const UPDATE_MANIFEST = RELEASE_MANIFEST
export const MAX_BINARY_BYTES = RELEASE_MAX_BINARY_BYTES
export const MAX_MANIFEST_BYTES = 128 * 1024
export const MAX_RELEASE_BYTES = 1024 * 1024
export type UpdateOs = ReleaseOs
export type UpdateArch = ReleaseArch
export type UpdatePlatform = ReleasePlatform
export type UpdateAsset = ReleaseAsset
export type UpdateManifest = ReleaseManifest

// 根据受支持的平台元组生成唯一未压缩单文件名称，不接受路径或可执行脚本名。
export function updateAssetName(version: string, platform: UpdatePlatform): string {
  return assetName(version, platform)
}

// 把运行时平台转换为发行清单用词；其它平台必须在发起网络请求前拒绝。
export function updatePlatform(os: string, arch: string, libc: unknown = undefined): UpdatePlatform {
  const normalized = os === 'win32' ? 'windows' : os
  try {
    return releasePlatform(normalized, arch, libc === undefined && normalized !== 'linux' ? null : libc)
  } catch {
    throw new UpdateError('unsupported_platform')
  }
}

export type UpdateErrorCode =
  | 'invalid_arguments'
  | 'invalid_current_version'
  | 'unsupported_platform'
  | 'network_failed'
  | 'request_timeout'
  | 'release_unavailable'
  | 'invalid_release'
  | 'invalid_manifest'
  | 'untrusted_redirect'
  | 'size_mismatch'
  | 'checksum_mismatch'
  | 'permission_denied'
  | 'unsafe_staging'
  | 'update_busy'
  | 'staging_failed'
  | 'replacement_unavailable'

export class UpdateError extends Error {
  // 只暴露固定错误码，不回显远端响应、URL 签名、用户路径或底层异常。
  constructor(readonly code: UpdateErrorCode) {
    super(code)
    this.name = 'UpdateError'
  }
}

// 保留可操作的退出类别，缺替换宿主绝不能报成功。
export function updateExitCode(error: unknown): number {
  if (!(error instanceof UpdateError)) {
    return 1
  }
  if (['invalid_arguments', 'invalid_current_version', 'unsupported_platform'].includes(error.code)) {
    return 2
  }
  if (['permission_denied', 'unsafe_staging', 'update_busy', 'staging_failed'].includes(error.code)) {
    return 4
  }
  return error.code === 'replacement_unavailable' ? 5 : 3
}
