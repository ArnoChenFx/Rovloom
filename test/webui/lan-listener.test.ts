// 显式 LAN 管理监听：任意局域网 Host 可访问，未选择时其余 Host 仍拒绝；认证与跨站边界不变。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startManagementReadListener } from '../../src/admin/read-http.js'
import type { GatewayManagementService, ManagementArguments } from '../../src/mcp/management.js'
import type { ManagementHttpOptions } from '../../src/admin/read-http.js'
import type { ManagementReadOperation } from '../../src/webui/read.js'
import { fixtureReply } from './fixtures.js'
import { statusWithHost } from '../mcp/wildcard-listener.js'

function options(): ManagementHttpOptions {
  return {
    service: {
      execute: /* 合成 DTO 只验证传输边界。 */ async (name, args) =>
        fixtureReply(name as ManagementReadOperation, args as ManagementArguments[ManagementReadOperation])
    } as GatewayManagementService,
    authenticate: /* 此身份仅限本测试。 */ async () => ({
      caller: { principal_id: 'fixture-principal' },
      management_session_ref: 'fixture-session'
    })
  }
}

test(
  'management LAN listener accepts LAN hosts only with the explicit opt-in',
  /** 明文局域网访问必须显式选择；默认行为与既有回环边界完全一致。 */ async () => {
    const plain = startManagementReadListener({ ...options(), port: 0, hostname: '0.0.0.0' })
    const lan = startManagementReadListener({ ...options(), port: 0, hostname: '0.0.0.0', lan: true })
    try {
      const plainPort = Number(new URL(plain.url).port)
      const lanPort = Number(new URL(lan.url).port)
      assert.match(lan.url, /^http:\/\/127\.0\.0\.1:\d+$/u)
      // 未选择：非回环 Host 仍被拒绝。
      const refused = await statusWithHost(plainPort, `192.0.2.10:${plainPort}`, '/admin/v1/status')
      assert(refused >= 400 && refused !== 401, `plain -> ${refused}`)
      // 选择 LAN：局域网 Host 与回环 Host 都到达认证之后的 200。
      assert.equal(await statusWithHost(lanPort, `192.0.2.10:${lanPort}`, '/admin/v1/status'), 200)
      assert.equal(await statusWithHost(lanPort, `127.0.0.1:${lanPort}`, '/admin/v1/status'), 200)
      // 回环监听没有局域网路径：lan 与非通配绑定组合仍只接受回环 Host。
      const loopback = startManagementReadListener({ ...options(), port: 0, lan: true })
      try {
        const loopPort = Number(new URL(loopback.url).port)
        const denied = await statusWithHost(loopPort, `192.0.2.10:${loopPort}`, '/admin/v1/status')
        assert(denied >= 400 && denied !== 401, `loopback-only -> ${denied}`)
        assert.equal(await statusWithHost(loopPort, `127.0.0.1:${loopPort}`, '/admin/v1/status'), 200)
      } finally {
        loopback.stop()
      }
    } finally {
      plain.stop()
      lan.stop()
    }
  }
)
