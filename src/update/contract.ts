// 固定官方更新清单契约；发布任务须采用同一字段和命名，不从远端清单读取 URL 或命令。
export const UPDATE_REPOSITORY = 'ArnoChenFx/Rovloom'
export const UPDATE_MANIFEST = 'rovloom-update.json'
export const MAX_BINARY_BYTES = 256 * 1024 * 1024
export const MAX_MANIFEST_BYTES = 128 * 1024
export const MAX_RELEASE_BYTES = 1024 * 1024
export type UpdateOs = 'linux' | 'darwin' | 'windows'
export type UpdateArch = 'x64' | 'arm64'
export type UpdatePlatform = Readonly<{ os: UpdateOs; arch: UpdateArch }>
export type UpdateAsset = Readonly<UpdatePlatform & { name: string; size: number; sha256: string }>
export type UpdateManifest = Readonly<{
  schemaVersion: 1
  repository: typeof UPDATE_REPOSITORY
  tag: string
  version: string
  assets: readonly UpdateAsset[]
}>

// 根据受支持的平台元组生成唯一未压缩单文件名称，不接受路径或可执行脚本名。
export function updateAssetName(platform: UpdatePlatform): string {
  return `rovloom-${platform.os}-${platform.arch}${platform.os === 'windows' ? '.exe' : ''}`
}

// 把运行时平台转换为发行清单用词；其它平台必须在发起网络请求前拒绝。
export function updatePlatform(os: string, arch: string): UpdatePlatform {
  const normalized = os === 'win32' ? 'windows' : os
  if (!['linux', 'darwin', 'windows'].includes(normalized) || !['x64', 'arm64'].includes(arch)) {
    throw new UpdateError('unsupported_platform')
  }
  return Object.freeze({ os: normalized as UpdateOs, arch: arch as UpdateArch })
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
