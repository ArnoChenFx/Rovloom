// 扫描隔离子进程、业务帧和普通审计，检查 mock 凭据及 delegated token 不被泄露。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fixture, until } from './helpers.js'

test(
  'mock 凭据不进入 stdout/stderr、普通审计和业务 Wire 输出',
  /** 以随机 mock secret 检查子进程、普通审计及业务帧，不将测试凭据泄露到可见输出。 */
  async () => {
    const secret = 'MOCK_ONLY_' + randomBytes(32).toString('hex')
    const child = spawnSync(
      process.execPath,
      ['--no-env-file', fileURLToPath(new URL('./log-fixture.ts', import.meta.url))],
      { input: secret, encoding: 'utf8', timeout: 10_000 }
    )
    assert.equal(child.status, 0)
    assert.equal((child.stdout + child.stderr).includes(secret), false)
    assert.equal(child.stdout.trim(), 'mock fixture closed')
    const f = fixture()
    try {
      const a = f.pair('mock')
      const client = f.connector(
        /** 提供预先创建的 mock 设备凭据，只供本次隔离连接使用。 */
        () => a.credential
      )
      await until(
        /** 等待模拟连接完成认证及可信 provider 核对后进入 ready。 */
        () => client.status().phase === 'ready'
      )
      const call = f.call(a.target)
      f.gateway.dispatch(call.call_id)
      await until(
        /** 等待真实 Store 的响应事务完成，避免把 accepted 当成业务结果。 */
        () => f.router.get(f.principal, call.call_id).state === 'responded'
      )
      const output = JSON.stringify(f.store.auditRecords()) + f.encoded.join('\n')
      for (const sensitive of [a.credential.credential, a.enrollment, 'MOCK_ONLY_NO_PRODUCTION_EFFECT']) {
        assert.equal(output.includes(sensitive), false)
      }
    } finally {
      f.stop()
    }
  }
)
