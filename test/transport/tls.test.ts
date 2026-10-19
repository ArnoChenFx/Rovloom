// 用 loopback 和临时自签证书验证严格 CA/hostname 拒绝；不导入系统信任。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
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
  'WSS 默认拒绝未知 CA，显式 fixture CA 仍严格核对 hostname',
  /** 分别验证未知 CA、匹配的受信 CA 及错误 hostname，只允许准确 TLS 身份完成握手。 */
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'rovloom-mock-tls-'))
    try {
      const tls = certificate(root, '127.0.0.1')
      const f = fixture({ tls, developmentLoopback: false })
      try {
        const a = f.pair('mock')
        const untrusted = f.connector(
          /** 提供预先创建的 mock 设备凭据，只供本次隔离连接使用。 */
          () => a.credential
        )
        await until(
          /** 等待失败连接进入退避重连，观察握手或 TLS 的拒绝结果。 */
          () => untrusted.status().reconnects > 1
        )
        assert.equal(f.gateway.status().devices.length, 0)
        assert.equal(f.sessions.opened, 0)
        untrusted.stop()
        const verified = f.connector(
          /** 提供预先创建的 mock 设备凭据，只供本次隔离连接使用。 */
          () => a.credential,
          {
            ca: tls.cert
          }
        )
        await until(
          /** 等待模拟连接完成认证及可信 provider 核对后进入 ready。 */
          () => verified.status().phase === 'ready'
        )
        assert.equal(f.gateway.status().devices[0]!.ready, true)
      } finally {
        f.stop()
      }
      const wrong = certificate(root, '127.0.0.2')
      const mismatch = fixture({ tls: wrong, developmentLoopback: false })
      try {
        const a = mismatch.pair('mock')
        const client = mismatch.connector(
          /** 提供预先创建的 mock 设备凭据，只供本次隔离连接使用。 */
          () => a.credential,
          { ca: wrong.cert }
        )
        await until(
          /** 等待失败连接进入退避重连，观察握手或 TLS 的拒绝结果。 */
          () => client.status().reconnects > 1
        )
        assert.equal(mismatch.gateway.status().devices.length, 0)
        assert.equal(mismatch.sessions.opened, 0)
      } finally {
        mismatch.stop()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)
