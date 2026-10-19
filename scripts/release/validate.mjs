/** 在任何发布工作前校验 tag、精确 checkout、包版本和产品版本，输出固定构建矩阵。 */
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { platforms, releaseContext, validateProductVersion } from './metadata.mjs'
import { githubClient, verifyRemoteTag } from './github.mjs'

const context = releaseContext()
const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })
assert.equal(head.status, 0)
assert.equal(head.stdout.trim(), context.commit, 'Checkout differs from tag event commit')
await verifyRemoteTag(githubClient(process.env.GITHUB_TOKEN), context)
await validateProductVersion(context)
assert(/^[1-9]\d*$/u.test(process.env.GITHUB_RUN_ATTEMPT))
appendFileSync(
  process.env.GITHUB_OUTPUT,
  `matrix=${JSON.stringify({ include: platforms })}\nartifactSet=${process.env.GITHUB_RUN_ATTEMPT}\n`
)
console.log(JSON.stringify(context))
