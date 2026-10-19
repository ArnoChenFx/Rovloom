/** 仅以短期 GITHUB_TOKEN 访问固定官方 GitHub API；不接受镜像、PAT 配置或外部上传地址。 */
import assert from 'node:assert/strict'
import { repository } from './metadata.mjs'

/** 固定 API 源和路径，拒绝自动重定向，失败只暴露状态码而不输出凭据或响应原文。 */
export function githubClient(token, request = fetch) {
  assert(typeof token === 'string' && token.length > 0, 'GITHUB_TOKEN is required')
  /** 仅向固定 GitHub 元数据或上传域发送有界请求，不信任 API 返回的上传 URL。 */
  async function requestOfficial(path, { method = 'GET', json, bytes } = {}) {
    assert(path.startsWith(`/repos/${repository}/`), 'Unexpected GitHub API path')
    const response = await request(`https://${bytes ? 'uploads' : 'api'}.github.com${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(120_000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': bytes ? 'application/octet-stream' : 'application/json'
      },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
      ...(bytes === undefined ? {} : { body: bytes })
    })
    assert(response.ok, `GitHub API ${method} failed (${response.status})`)
    return response.json()
  }
  return requestOfficial
}

/** 重新解析远端 tag，支持有界的 annotated tag 链，拒绝移动 tag 或非 commit 目标。 */
export async function verifyRemoteTag(api, context) {
  let { object } = await api(`/repos/${repository}/git/ref/tags/${encodeURIComponent(context.tag)}`)
  for (let depth = 0; object.type === 'tag' && depth < 8; depth++) {
    assert(/^[0-9a-f]{40}$/u.test(object.sha), 'Invalid tag object')
    ;({ object } = await api(`/repos/${repository}/git/tags/${object.sha}`))
  }
  assert.equal(object.type, 'commit', 'Tag must resolve to a commit')
  assert.equal(object.sha, context.commit, 'Remote tag moved from the event commit')
}

/** 分页包含草稿的 Release 列表，避免公开 tag 查询遗漏旧草稿后重复创建。 */
export async function findRelease(api, tag) {
  const matches = []
  for (let page = 1; page <= 100; page++) {
    const releases = await api(`/repos/${repository}/releases?per_page=100&page=${page}`)
    assert(Array.isArray(releases))
    matches.push(...releases.filter(/** 仅精确匹配本次 tag。 */ (release) => release.tag_name === tag))
    if (releases.length < 100) {
      assert(matches.length <= 1, 'Duplicate releases for tag')
      return matches[0]
    }
  }
  throw new Error('Release listing exceeded the safety bound')
}
