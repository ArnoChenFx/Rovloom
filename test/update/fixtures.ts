// 构造注入 fetch 的合成 Release 与字节样例；它们不是外部已存在或已发布的官方资产。
import { createHash } from 'node:crypto'
import { UPDATE_MANIFEST, UPDATE_REPOSITORY, updateAssetName, type UpdatePlatform } from '../../src/update/contract.js'
import { LATEST_RELEASE_URL, officialAssetUrl, type UpdateNetwork } from '../../src/update/network.js'

// 创建单平台清单与对应 API 元数据，并严格拒绝未声明的请求。
export function fixture(platform: UpdatePlatform = { os: 'linux', arch: 'x64' }, version = '1.2.0') {
  const payload = Buffer.from('isolated fixture bytes; never executed')
  const tag = `v${version}`
  const name = updateAssetName(platform)
  const manifest = {
    schemaVersion: 1,
    repository: UPDATE_REPOSITORY,
    tag,
    version,
    assets: [
      { ...platform, name, size: payload.byteLength, sha256: createHash('sha256').update(payload).digest('hex') }
    ]
  }
  const release = {
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: [
      {
        name: UPDATE_MANIFEST,
        size: 0,
        state: 'uploaded',
        browser_download_url: officialAssetUrl(tag, UPDATE_MANIFEST)
      },
      { name, size: payload.byteLength, state: 'uploaded', browser_download_url: officialAssetUrl(tag, name) }
    ]
  }
  const requests: string[] = []
  const network: UpdateNetwork = {
    // 记录真实请求形状，用新 Response 防止前次消费污染后续请求。
    fetch: async (url, init) => {
      requests.push(url)
      if (init.redirect !== 'manual' || init.credentials !== 'omit' || !init.signal) {
        throw new Error('unsafe request options')
      }
      const metadata = JSON.stringify(manifest)
      release.assets[0]!.size = Buffer.byteLength(metadata)
      if (url === LATEST_RELEASE_URL) {
        return Response.json(release)
      }
      if (url === officialAssetUrl(tag, UPDATE_MANIFEST)) {
        return new Response(metadata)
      }
      if (url === officialAssetUrl(tag, name)) {
        return new Response(payload)
      }
      throw new Error('undeclared request')
    }
  }
  return { network, requests, payload, tag, name, manifest, release }
}
