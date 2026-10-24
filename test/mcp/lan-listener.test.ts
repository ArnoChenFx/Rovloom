// 显式 LAN 选择：通配明文监听接纳任意 Host 的固定 /mcp 路径；未选择时其余 Host 仍被拒绝。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHttpFacade } from '../../src/mcp/http.js'
import type { GatewayService } from '../../src/mcp/types.js'

const unused = {
  execute: /* 本例只检查进入服务之前的 Host/Origin 门禁。 */ async () => {
    throw new Error('unused_test_stub')
  }
} as unknown as GatewayService
const init = {
  jsonrpc: '2.0',
  id: 'init',
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'lan', version: '1' } }
}

function facade(lan: boolean) {
  return createHttpFacade({
    origin: 'http://127.0.0.1:1',
    service: unused,
    authentication: { authenticate: /* 合成身份，仅为越过认证。 */ () => ({ principal_id: 'isolated' }) },
    ...(lan ? { lan: true } : {})
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

test('lan facade accepts any LAN Host and same-origin Origin; cross-site Origin stays denied', async () => {
  const plain = facade(false)
  const lan = facade(true)
  try {
    // 未选择 LAN：其它 Host 一律拒绝，回环照常。
    assert.equal((await post(plain, 'http://192.0.2.10:1/mcp', { host: '192.0.2.10:1' })).status, 403)
    // 选择 LAN：局域网 Host 明文访问被接受，回环也仍可用。
    const ok = await post(lan, 'http://192.0.2.10:1/mcp', { host: '192.0.2.10:1' })
    assert.equal(ok.status, 200)
    await ok.body?.cancel()
    const loop = await post(lan, 'http://127.0.0.1:1/mcp', { host: '127.0.0.1:1' })
    assert.equal(loop.status, 200)
    await loop.body?.cancel()
    // 同源浏览器 Origin 被接受；跨站 Origin 仍拒绝。
    const same = await post(lan, 'http://192.0.2.10:1/mcp', { host: '192.0.2.10:1', origin: 'http://192.0.2.10:1' })
    assert.equal(same.status, 200)
    await same.body?.cancel()
    const cross = await post(lan, 'http://192.0.2.10:1/mcp', { host: '192.0.2.10:1', origin: 'http://evil.example' })
    assert.equal(cross.status, 403)
    // 非明文 scheme 请求仍按回环/公开来源判断，LAN 不能为伪造 scheme 放行。
    const wrongPath = await post(lan, 'http://192.0.2.10:1/other', { host: '192.0.2.10:1' })
    assert.equal(wrongPath.status, 403)
  } finally {
    await plain.close()
    await lan.close()
  }
})
