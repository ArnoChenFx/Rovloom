// 只访问固定 GitHub API 与本仓库下载路径，手动约束 CDN 跳转、总时限和流式字节上界。
import { MAX_BINARY_BYTES, UpdateError, UPDATE_REPOSITORY } from './contract.js'
import { stableVersion } from './version.js'
import { officialReleaseAssetName, parseReleaseJson } from '../release/contract.js'

export type UpdateFetch = (url: string, init: RequestInit) => Promise<Response>
export type UpdateNetwork = { fetch: UpdateFetch; timeoutMs?: number }
export const LATEST_RELEASE_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`
const redirects = new Set([301, 302, 303, 307, 308])
type OfficialSource =
  | { kind: 'release' }
  | { kind: 'asset'; tag: string; name: string }
  | { kind: 'tag-ref'; tag: string }
  | { kind: 'tag-object'; sha: string }

// 只构造稳定 tag 下的受控资产路径；调用者不能提供任意 URL。
export function officialAssetUrl(tag: string, name: string): string {
  if (!tag.startsWith('v') || !stableVersion(tag.slice(1)) || !officialReleaseAssetName(tag.slice(1), name)) {
    throw new UpdateError('invalid_manifest')
  }
  return `https://github.com/${UPDATE_REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${name}`
}

// 固定的 tag 元数据查询也不能通过注入参数改变仓库或 API 路径。
export function officialMetadataUrl(source: Exclude<OfficialSource, { kind: 'asset' }>): string {
  if (source.kind === 'release') {
    return LATEST_RELEASE_URL
  }
  if (source.kind === 'tag-ref' && source.tag.startsWith('v') && stableVersion(source.tag.slice(1))) {
    return `https://api.github.com/repos/${UPDATE_REPOSITORY}/git/ref/tags/${encodeURIComponent(source.tag)}`
  }
  if (source.kind === 'tag-object' && /^[0-9a-f]{40}$/u.test(source.sha)) {
    return `https://api.github.com/repos/${UPDATE_REPOSITORY}/git/tags/${source.sha}`
  }
  throw new UpdateError('invalid_release')
}

// 以 AbortSignal 约束网络 Promise；注入适配器忽略取消时也不会无限阻塞调用方。
export async function waitForUpdateOperation<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let stop!: () => void
  const aborted = new Promise<never>(
    /* 把统一请求时限转换为固定错误。 */ (_resolve, reject) => {
      stop = /* 定时取消只产生固定诊断。 */ () => reject(new UpdateError('request_timeout'))
      if (signal.aborted) {
        stop()
      } else {
        signal.addEventListener('abort', stop, { once: true })
      }
    }
  )
  try {
    return await Promise.race([pending, aborted])
  } finally {
    signal.removeEventListener('abort', stop)
  }
}

// 在固定请求边界内逐块消费响应；不执行脚本，不自动重试或回退其它主机。
export async function readOfficial(
  network: UpdateNetwork,
  source: OfficialSource,
  limit: number,
  consume: (chunk: Uint8Array, signal: AbortSignal) => Promise<void>,
  expected?: number
): Promise<number> {
  const timeout = network.timeoutMs ?? 60_000
  if (
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > 60_000 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_BINARY_BYTES ||
    (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 1 || expected > limit))
  ) {
    throw new UpdateError('invalid_arguments')
  }
  const controller = new AbortController()
  const timer = setTimeout(/* 总时限覆盖请求、跳转和响应体。 */ () => controller.abort(), timeout)
  let response: Response | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    let url = source.kind === 'asset' ? officialAssetUrl(source.tag, source.name) : officialMetadataUrl(source)
    for (let hop = 0; ; hop++) {
      response = await waitForUpdateOperation(
        network.fetch(url, {
          method: 'GET',
          redirect: 'manual',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          headers: { Accept: source.kind === 'asset' ? 'application/octet-stream' : 'application/vnd.github+json' },
          signal: controller.signal
        }),
        controller.signal
      )
      if (response.redirected || (response.url && response.url !== url)) {
        throw new UpdateError('untrusted_redirect')
      }
      if (!redirects.has(response.status)) {
        break
      }
      const location = response.headers.get('location')
      // GitHub 下载只允许一次转往精确 CDN 主机，API 不允许重定向。
      if (source.kind !== 'asset' || hop !== 0 || !location) {
        throw new UpdateError('untrusted_redirect')
      }
      const next = new URL(location, url)
      if (
        next.protocol !== 'https:' ||
        next.hostname !== 'release-assets.githubusercontent.com' ||
        next.port ||
        next.username ||
        next.password ||
        next.hash
      ) {
        throw new UpdateError('untrusted_redirect')
      }
      void response.body?.cancel().catch(/* 回收跳转体失败不放宽后续主机约束。 */ () => {})
      url = next.href
    }
    if (response.status !== 200) {
      throw new UpdateError('release_unavailable')
    }
    const length = response.headers.get('content-length')
    if (
      length !== null &&
      (!/^\d+$/u.test(length) || Number(length) > limit || (expected !== undefined && Number(length) !== expected))
    ) {
      throw new UpdateError('size_mismatch')
    }
    if (!response.body) {
      throw new UpdateError('size_mismatch')
    }
    reader = response.body.getReader()
    let total = 0
    while (true) {
      const item = await waitForUpdateOperation(reader.read(), controller.signal)
      if (item.done) {
        break
      }
      if (item.value.byteLength === 0) {
        throw new UpdateError('size_mismatch')
      }
      total += item.value.byteLength
      if (total > limit || (expected !== undefined && total > expected)) {
        throw new UpdateError('size_mismatch')
      }
      await waitForUpdateOperation(consume(item.value, controller.signal), controller.signal)
      controller.signal.throwIfAborted()
    }
    if (
      total === 0 ||
      (expected !== undefined && total !== expected) ||
      (length !== null && total !== Number(length))
    ) {
      throw new UpdateError('size_mismatch')
    }
    return total
  } catch (error) {
    if (controller.signal.aborted) {
      throw new UpdateError('request_timeout')
    }
    if (error instanceof UpdateError) {
      throw error
    }
    throw new UpdateError('network_failed')
  } finally {
    clearTimeout(timer)
    controller.abort()
    if (reader) {
      void reader.cancel().catch(/* 取消读取后只回收响应流。 */ () => {})
    } else {
      void response?.body?.cancel().catch(/* 不消费被拒绝的响应。 */ () => {})
    }
  }
}

// JSON 读取只缓存严格有界的元数据，UTF-8 损坏也必须拒绝。
export async function readOfficialJson(
  network: UpdateNetwork,
  source: Parameters<typeof readOfficial>[1],
  limit: number,
  expected?: number
): Promise<unknown> {
  const parts: Uint8Array[] = []
  await readOfficial(
    network,
    source,
    limit,
    /* 累积有界元数据片段。 */ async (chunk) => {
      parts.push(chunk.slice())
    },
    expected
  )
  try {
    return parseReleaseJson(Buffer.concat(parts), limit)
  } catch {
    throw new UpdateError(source.kind === 'asset' ? 'invalid_manifest' : 'invalid_release')
  }
}
