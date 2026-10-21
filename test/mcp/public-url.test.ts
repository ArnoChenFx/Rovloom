// 受信 public_url：反向代理 / TLS 终止后的 Host 与 CORS 来源被接受，其余 Host 仍被拒绝。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHttpFacade } from '../../src/mcp/http.js'
import { configDocument, configTemplate, parseConfig, publicMcpUrl } from '../../src/cli/config.js'
import type { GatewayConfig } from '../../src/cli/config.js'

const unused = {
  execute: /* 本例只检查进入服务之前的 Host/Origin 门禁。 */ async () => {
    throw new Error('unused_test_stub')
  }
}
const init = {
  jsonrpc: '2.0',
  id: 'init',
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'public-url', version: '1' } }
}

function facade(publicUrl?: string) {
  return createHttpFacade({
    origin: 'http://127.0.0.1:1',
    service: unused,
    ...(publicUrl ? { publicUrl } : {}),
    authentication: { authenticate: /* 合成身份，仅为越过认证。 */ () => ({ principal_id: 'isolated' }) }
  })
}
async function post(target: ReturnType<typeof facade>, url: string, headers: Record<string, string>) {
  return target.handleRequest(
    new Request(url, {
      method: 'POST',
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...headers },
      body: JSON.stringify(init)
    })
  )
}

test('public host is accepted only when configured; loopback keeps working; other hosts and paths are denied', async () => {
  const plain = facade()
  const proxied = facade('https://rovloom.example.com/mcp')
  try {
    // 未配置 public_url：公开 Host 被拒绝。
    assert.equal((await post(plain, 'http://rovloom.example.com/mcp', { host: 'rovloom.example.com' })).status, 403)
    // 配置后：反代转发的 Host（scheme 是 http）被接受。
    const ok = await post(proxied, 'http://rovloom.example.com/mcp', { host: 'rovloom.example.com' })
    assert.equal(ok.status, 200)
    await ok.body?.cancel()
    // 回环地址仍可用。
    const loop = await post(proxied, 'http://127.0.0.1:1/mcp', { host: '127.0.0.1:1' })
    assert.equal(loop.status, 200)
    await loop.body?.cancel()
    // 其它 Host、错误路径、查询、Host 与 URL 不一致均拒绝。
    assert.equal((await post(proxied, 'http://evil.example.com/mcp', { host: 'evil.example.com' })).status, 403)
    assert.equal((await post(proxied, 'http://rovloom.example.com/other', { host: 'rovloom.example.com' })).status, 403)
    assert.equal(
      (await post(proxied, 'http://rovloom.example.com/mcp?x=1', { host: 'rovloom.example.com' })).status,
      403
    )
    assert.equal((await post(proxied, 'http://rovloom.example.com/mcp', { host: 'evil.example.com' })).status, 403)
    // 转发头不能改变 Host 判定。
    assert.equal(
      (
        await post(plain, 'http://evil.example.com/mcp', {
          host: 'evil.example.com',
          'x-forwarded-host': 'rovloom.example.com'
        })
      ).status,
      403
    )
    // 浏览器 Origin：public origin 自动在白名单内，其它来源仍被拒绝。
    const cors = await post(proxied, 'http://rovloom.example.com/mcp', {
      host: 'rovloom.example.com',
      origin: 'https://rovloom.example.com'
    })
    assert.equal(cors.status, 200)
    await cors.body?.cancel()
    assert.equal(
      (
        await post(proxied, 'http://rovloom.example.com/mcp', {
          host: 'rovloom.example.com',
          origin: 'https://evil.example.com'
        })
      ).status,
      403
    )
  } finally {
    await plain.close()
    await proxied.close()
  }
})

test('public_url must be an https origin with the fixed /mcp path', () => {
  for (const bad of [
    'http://rovloom.example.com/mcp',
    'https://rovloom.example.com',
    'https://rovloom.example.com/',
    'https://rovloom.example.com/mcp/',
    'https://rovloom.example.com/other',
    'https://rovloom.example.com/mcp?x=1',
    'https://rovloom.example.com/mcp#x',
    'https://user:pw@rovloom.example.com/mcp',
    'https://rovloom.example.com/ mcp',
    'ftp://rovloom.example.com/mcp',
    ''
  ]) {
    assert.equal(publicMcpUrl(bad), false, bad)
    assert.throws(() => facade(bad || 'x'))
  }
  assert.equal(publicMcpUrl('https://rovloom.example.com/mcp'), true)
  assert.equal(publicMcpUrl('https://rovloom.example.com:8443/mcp'), true)
})

test('gateway config accepts and round-trips mcp.public_url, and rejects unknown mcp fields', () => {
  const base = configTemplate('gateway') as GatewayConfig
  assert.equal(base.mcp_public_url, undefined)
  const document = configDocument(base) as { mcp: Record<string, unknown> }
  assert.equal(Object.hasOwn(document.mcp, 'public_url'), false)
  const withUrl = {
    ...document,
    mcp: { ...document.mcp, public_url: 'https://rovloom.example.com/mcp' }
  }
  const parsed = parseConfig(withUrl) as GatewayConfig
  assert.equal(parsed.mcp_public_url, 'https://rovloom.example.com/mcp')
  assert.deepEqual(configDocument(parsed), withUrl)
  assert.throws(() => parseConfig({ ...withUrl, mcp: { ...withUrl.mcp, public_url: 'http://x/mcp' } }))
  assert.throws(() => parseConfig({ ...withUrl, mcp: { ...withUrl.mcp, other: 1 } }))
})
