/** CI 只读元数据入口；固定 GitHub API 来源和资源类型，失败时不输出正文或凭据。 */
import { readNetwork } from './read-network.mjs'

const path = process.argv[2] ?? ''
if (!/^repos\/[\w.-]+\/[\w.-]+\/(?:actions\/runs\/\d+(?:\/jobs\?per_page=100)?|releases\/latest)$/u.test(path)) {
  throw new Error('github_read_path_invalid')
}
try {
  const bytes = await readNetwork('https://api.github.com/' + path, {
    maxBytes: 8_388_608,
    timeoutMs: 30_000,
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'rovloom-ci',
      ...(process.env.GH_TOKEN ? { authorization: 'Bearer ' + process.env.GH_TOKEN } : {})
    }
  })
  JSON.parse(bytes.toString('utf8'))
  process.stdout.write(bytes)
} catch {
  throw new Error('github_read_failed')
}
