// Gateway 启动状态行：宿主上报管理页地址时公布 dashboard_listening，未上报时不输出该行；MCP 门面仍由 runCli 真实装配。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { configDocument, configTemplate } from '../../src/cli/config.js'
import { runCli, type CliRuntime, type GatewayRuntime } from '../../src/cli/run.js'
import type { GatewayService } from '../../src/mcp/types.js'

// 仅向内核申请并释放动态回环端口，测试不探测用户服务。
async function port(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address === 'object')
  server.close()
  await once(server, 'close')
  return address.port
}

// 只覆盖启动状态行的最小Gateway宿主；真实HTTP门面与诊断仍走runCli原路径。
function stubGateway(managementUrl?: string): GatewayRuntime {
  return {
    // execute 仅满足门面启动校验；本测试不发起任何已认证请求，不得被调用。
    service: {
      execute: async () => {
        throw new Error('fixture_service_must_not_run')
      }
    } as unknown as GatewayService,
    authentication: { authenticate: async () => null },
    setupRequired: true,
    ...(managementUrl ? { managementUrl } : {}),
    close: async () => {}
  }
}

/** 运行一次未配对Gateway并收集到 pairing_required 为止的stderr；关闭后返回退出码与输出。 */
async function launch(managementUrl?: string): Promise<{ code: number; output: string }> {
  const directory = mkdtempSync(join(tmpdir(), 'rovloom-gateway-dashboard-'))
  try {
    const [mcp, devices] = [await port(), await port()]
    const config = {
      ...configTemplate('gateway'),
      state_dir: join(directory, 'gateway'),
      mcp_port: mcp,
      device_port: devices
    }
    const path = join(directory, 'gateway.json')
    writeFileSync(path, JSON.stringify(configDocument(config)), { mode: 0o600 })
    const signal = new AbortController()
    const stderr = new PassThrough()
    let output = ''
    let ready!: () => void
    const listening = new Promise<void>(
      /* 收到固定未配对提示即代表启动输出已全部写出。 */ (resolve) => {
        ready = resolve
      }
    )
    stderr.on(
      'data',
      /* 只观察固定状态行，不输出状态内容。 */ (chunk) => {
        output += chunk
        if (output.includes('pairing_required\n')) {
          ready()
        }
      }
    )
    const runtime: CliRuntime = { gateway: async () => stubGateway(managementUrl) }
    const running = runCli(
      ['gateway', '--config', path],
      { stdin: new PassThrough(), stdout: new PassThrough(), stderr, signal: signal.signal },
      runtime
    )
    await Promise.race([
      listening,
      running.then(
        /* 启动提前失败应立即结束测试。 */ (code) => {
          throw new Error('gateway_early_exit_' + code)
        }
      )
    ])
    signal.abort()
    return { code: await running, output }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('宿主上报管理页地址时启动输出公布 dashboard 地址，未上报时不出现该行', async () => {
  // 宿主上报的是 listener origin（无尾斜杠）；输出按规范 URL 展示。
  const shown = await launch('http://127.0.0.1:9445')
  assert.equal(shown.code, 0)
  const line = 'dashboard_listening http://127.0.0.1:9445/\n'
  assert.ok(shown.output.includes(line), shown.output)
  assert.ok(shown.output.indexOf(line) < shown.output.indexOf('pairing_required\n'))
  assert.match(shown.output, /gateway_listening http:\/\/127\.0\.0\.1:\d+\/mcp\n/)
  const hidden = await launch(undefined)
  assert.equal(hidden.code, 0)
  assert.doesNotMatch(hidden.output, /dashboard_listening/)
  assert.match(hidden.output, /gateway_listening/)
})
