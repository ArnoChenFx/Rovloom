// 在独立子进程中经 stdin 接收随机 mock secret，触发认证拒绝并验证完整关闭。
import { readFileSync } from 'node:fs'
import { fixture, until } from './helpers.js'

// mock secret 只经 stdin 进入，避免 URL、环境与 argv 交付。
const secret = readFileSync(0, 'utf8')
const f = fixture()
try {
  const a = f.pair('log-fixture')
  const client = f.connector(
    /** 只通过 stdin 提供的随机 mock secret 替换凭据，触发认证拒绝而不把秘密放入 argv。 */
    () => ({
      ...a.credential,
      credential: secret
    })
  )
  await until(
    /** 等待失败连接进入退避重连，观察握手或 TLS 的拒绝结果。 */
    () => client.status().reconnects > 0
  )
  if (f.gateway.status().devices.length !== 0) {
    throw new Error('fixture_authentication_failed')
  }
} finally {
  f.stop()
}
process.stdout.write('mock fixture closed\n')
