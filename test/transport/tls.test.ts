// 用 loopback 和临时自签证书验证严格 CA/hostname 拒绝；不导入系统信任。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:https'
import { once } from 'node:events'
import { fixture, until } from './helpers.js'

/** 在测试私有目录生成一日自签 mock 证书，不修改系统信任或真实设备证书。 */
function certificate(root: string, ip: string) {
  const cert = join(root, ip + '.crt')
  const key = join(root, ip + '.key')
  const result = spawnSync(
    '/usr/bin/openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=mock-fixture.invalid',
      '-addext',
      'subjectAltName=IP:' + ip
    ],
    { stdio: 'ignore' }
  )
  assert.equal(result.status, 0)
  return { cert: readFileSync(cert, 'utf8'), key: readFileSync(key, 'utf8') }
}
test(
  'WSS使用系统信任拒绝自签证书，旧CA或关闭校验输入不能改变结果',
  /** 外部HTTPS监听器模拟反向代理；证书仅存在本例目录，不导入系统信任。 */
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'rovloom-mock-tls-'))
    const tls = certificate(root, '127.0.0.1')
    let upgraded = 0
    const proxy = createServer(tls)
    proxy.on(
      'upgrade',
      /** 任何成功升级都说明不可信TLS边界被绕过。 */ (_request, socket) => {
        upgraded++
        socket.destroy()
      }
    )
    proxy.listen(0, '127.0.0.1')
    await once(proxy, 'listening')
    const address = proxy.address()
    assert(address && typeof address === 'object')
    const f = fixture()
    try {
      const device = f.pair('mock')
      for (const legacy of [{}, { ca: tls.cert, rejectUnauthorized: false }]) {
        const client = f.connector(/** 合成凭据不得在TLS拒绝前进入Wire认证。 */ () => device.credential, {
          url: `wss://127.0.0.1:${address.port}/connector`,
          ...legacy
        })
        await until(/** 等待真实TLS失败后进入至少一次重试。 */ () => client.status().reconnects > 1)
        client.stop()
        assert.equal(upgraded, 0)
        assert.equal(f.sessions.opened, 0)
      }
    } finally {
      f.stop()
      const closed = once(proxy, 'close')
      proxy.closeAllConnections()
      proxy.close()
      await closed
      rmSync(root, { recursive: true, force: true })
    }
  }
)
