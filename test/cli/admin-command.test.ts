// rovloom admin：纯函数签发/撤销与 CLI 对真实文件的端到端行为；口令只在签发时出现一次。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { configDocument, configTemplate } from '../../src/cli/config.js'
import type { GatewayConfig } from '../../src/cli/config.js'
import { handleAdminCommand } from '../../src/cli/admin-command.js'
import { handleTokenCommand } from '../../src/cli/token-command.js'
import { ADMIN_POLICY_REVISION, emptyManagement, issueAdmin, revokeAdmin } from '../../src/cli/admin-registry.js'
import { digestToken, parseRegistry } from '../../src/cli/token-registry.js'
import type { CallerRegistry } from '../../src/cli/token-registry.js'

const DAY = 86_400_000
const policy = { revision: 'p1', grants: [] }
function callers(now = 1_000): CallerRegistry {
  return {
    schema_version: 1,
    kind: 'mcp-caller-source',
    resource: 'http://127.0.0.1:9/mcp',
    local_policy: { revision: 'local1', grants: [] },
    callers: [
      {
        principal: { id: 'owner', policy },
        token_sha256: digestToken('o'.repeat(43)),
        issued_at: now,
        expires_at: now + DAY
      }
    ]
  }
}

test('issue creates a hash-only admin session plus a permissionless MCP placeholder, and reissue replaces it', () => {
  const first = issueAdmin(callers(), emptyManagement(9445), 'admin', 2_000, 7)
  assert.equal(first.expires_at, 2_000 + 7 * DAY)
  assert.match(first.secret, /^[A-Za-z0-9_-]{43}$/)
  const session = first.management.sessions[0]!
  assert.equal(session.credential_sha256, digestToken(first.secret))
  assert.equal(session.scope, 'all_devices')
  assert.deepEqual(session.administrator.grants, [])
  assert(!JSON.stringify({ callers: first.callers, management: first.management }).includes(first.secret))
  const placeholder = first.callers.callers.find((entry) => entry.principal.id === 'admin')!
  assert.equal(placeholder.principal.policy.revision, ADMIN_POLICY_REVISION)
  assert.deepEqual(placeholder.principal.policy.grants, [])
  // 管理员口令摘要与任何 MCP 令牌摘要都不同，注册表仍然合法。
  assert.notEqual(placeholder.token_sha256, session.credential_sha256)
  parseRegistry(JSON.parse(JSON.stringify(first.callers)))
  const second = issueAdmin(first.callers, first.management, 'admin', 3_000)
  assert.notEqual(second.secret, first.secret)
  assert.equal(second.management.sessions.length, 1)
  assert.notEqual(second.management.sessions[0]!.credential_sha256, session.credential_sha256)
  assert.notEqual(
    second.management.sessions[0]!.lease.management_session_ref,
    session.lease.management_session_ref,
    '重新签发换新会话引用，旧 Cookie 随之失效'
  )
  assert.equal(second.callers.callers.filter((entry) => entry.principal.id === 'admin').length, 1)
})

test('issue refuses to attach admin rights to a real MCP principal, revoke never deletes one', () => {
  assert.throws(() => issueAdmin(callers(), emptyManagement(9445), 'owner', 2_000), { code: 'invalid_arguments' })
  assert.throws(() => issueAdmin(callers(), emptyManagement(9445), 'bad id', 2_000), { code: 'invalid_arguments' })
  const made = issueAdmin(callers(), emptyManagement(9445), 'admin', 2_000)
  const revoked = revokeAdmin(made.callers, made.management, 'admin')
  assert.deepEqual(revoked.management.sessions, [])
  assert.deepEqual(
    revoked.callers.callers.map((entry) => entry.principal.id),
    ['owner']
  )
  assert.throws(() => revokeAdmin(made.callers, made.management, 'owner'), { code: 'invalid_arguments' })
})

function sink() {
  const stream = new PassThrough()
  const chunks: Buffer[] = []
  stream.on('data', (chunk: Buffer) => chunks.push(chunk))
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') }
}

test('admin CLI creates, lists and revokes through the real files; the secret goes only to stdout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-admin-cli-'))
  try {
    const state = join(root, 'gateway')
    mkdirSync(join(state, 'managed'), { recursive: true, mode: 0o700 })
    const config = { ...configTemplate('gateway'), state_dir: state } as GatewayConfig
    const configPath = join(root, 'gateway.json')
    writeFileSync(configPath, JSON.stringify(configDocument(config)), { mode: 0o600 })
    const callerPath = join(state, 'managed', 'mcp-callers.json')
    const managementPath = join(state, 'managed', 'management.json')
    writeFileSync(callerPath, JSON.stringify(callers(Date.now() - 1000)), { mode: 0o600 })
    const run = async (...args: string[]) => {
      const out = sink()
      const err = sink()
      const code = await handleAdminCommand(['admin', ...args, '--config', configPath], {
        stdout: out.stream,
        stderr: err.stream
      })
      return { code, out: out.text(), err: err.text() }
    }

    let result = await run('list')
    assert.equal(result.code, 0)
    assert.equal(result.out, '')

    result = await run('create', '--ttl-days', '7')
    assert.equal(result.code, 0)
    const secret = result.out.trim()
    assert.match(secret, /^[A-Za-z0-9_-]{43}$/)
    assert(!result.err.includes(secret), '口令不得出现在 stderr')
    assert(!readFileSync(managementPath, 'utf8').includes(secret))
    assert(!readFileSync(callerPath, 'utf8').includes(secret))
    assert.equal(JSON.parse(readFileSync(managementPath, 'utf8')).port, config.management_port)

    result = await run('list')
    assert.match(result.out, /^admin\tactive\t/)
    // MCP 令牌列表不显示管理员占位主体。
    const tokenOut = sink()
    await handleTokenCommand(['token', 'list', '--config', configPath], {
      stdout: tokenOut.stream,
      stderr: sink().stream
    })
    assert.doesNotMatch(tokenOut.text(), /admin/)
    assert.match(tokenOut.text(), /^owner\t/)

    result = await run('create', '--principal', 'owner')
    assert.notEqual(result.code, 0)
    assert.match(result.err, /invalid_arguments/)

    result = await run('revoke')
    assert.equal(result.code, 0)
    result = await run('list')
    assert.equal(result.out, '')
    result = await run('revoke')
    assert.notEqual(result.code, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
