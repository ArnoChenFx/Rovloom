// 对真实入口和可选的实际单文件候选验收空 Gateway；仅使用临时 HOME 与回环动态端口。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readOrCreateRoleConfig } from '../../src/cli/first-config.ts'
import { configDocument, readConfig } from '../../src/cli/config.ts'

// 向内核申请并释放测试端口；不扫描或连接用户的既有监听器。
async function port() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  server.close()
  await once(server, 'close')
  return address.port
}

test(
  '实际 Gateway 首次配置、只读检查、双库启动、401 及退出后重开',
  { timeout: 30_000 },
  /* 原生候选由 CI 提供；本地默认运行同一个正式 main，不生成身份或调用模型。 */ async () => {
    if (!['linux', 'darwin'].includes(process.platform)) {
      return
    }
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'rovloom-gateway-native-'))
    const main = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url))
    const executable = process.env.ROVLOOM_GATEWAY_EXECUTABLE ?? process.execPath
    const prefix = process.env.ROVLOOM_GATEWAY_EXECUTABLE ? [] : ['--no-env-file', main]
    const env = { HOME: home, PATH: process.env.PATH ?? '', NO_COLOR: '1' }
    const configPath = join(home, 'gateway.json')
    try {
      const defaults = readOrCreateRoleConfig('gateway', configPath, { home, platform: process.platform })
      const mcp = await port()
      let devices = await port()
      while (devices === mcp) {
        devices = await port()
      }
      const state = join(home, 'state')
      writeFileSync(
        configPath,
        JSON.stringify(
          configDocument({
            ...defaults,
            state_dir: state,
            mcp_port: mcp,
            device_port: devices,
            management_enabled: false
          })
        )
      )
      for (const action of ['check', 'check-runtime']) {
        const checked = spawnSync(executable, [...prefix, 'config', action, '--config', configPath], {
          env,
          input: '',
          encoding: 'utf8',
          timeout: 10_000
        })
        assert.equal(checked.error, undefined)
        assert.equal(checked.status, 0, checked.stderr)
        assert.equal(existsSync(state), false)
      }
      const bytes = readFileSync(configPath)
      for (let attempt = 0; attempt < 2; attempt++) {
        const child = spawn(executable, [...prefix, 'gateway', '--config', configPath], {
          env,
          stdio: ['pipe', 'pipe', 'pipe']
        })
        let diagnostic = ''
        let stdout = ''
        const closed = once(child, 'close')
        let ready
        const listening = new Promise(
          /* 只由正式入口的未配对提示唤醒实际 HTTP 检查。 */ (resolve) => {
            ready = resolve
          }
        )
        child.stdout.on(
          'data',
          /* 保存输出以断言不会混入 MCP 协议内容。 */ (chunk) => {
            stdout += chunk
          }
        )
        child.stderr.on(
          'data',
          /* 仅收集固定诊断，失败消息不包含状态文件正文。 */ (chunk) => {
            diagnostic += chunk
            if (diagnostic.includes('pairing_required\n')) {
              ready()
            }
          }
        )
        let timer
        try {
          await Promise.race([
            listening,
            closed.then(
              /* 提前退出立即失败，保留真实诊断以定位平台差异。 */ () => {
                throw new Error('gateway_early_exit: ' + diagnostic)
              }
            ),
            new Promise(
              /* 使用有界启动期限，不延长产品租期或原生编译预算。 */ (_resolve, reject) => {
                timer = setTimeout(
                  /* 到期结束本例等待，不将超时视为 ready。 */ () => reject(new Error('gateway_start_timeout')),
                  10_000
                )
              }
            )
          ])
          assert.equal((await fetch('http://127.0.0.1:' + mcp + '/mcp')).status, 401)
          assert.equal(existsSync(join(state, 'gateway.db')), true)
          assert.equal(existsSync(join(state, 'identity.db')), true)
          assert.equal(existsSync(join(state, 'managed', 'mcp-callers.json')), false)
          assert.equal(stdout, '')
        } finally {
          clearTimeout(timer)
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM')
          }
          const [code, signal] = await closed
          assert.equal(code, 0, diagnostic)
          assert.equal(signal, null)
        }
        assert.equal(existsSync(join(state, 'gateway.db.lock')), false)
        assert.equal(existsSync(join(state, 'identity.db.lock')), false)
      }
      assert.deepEqual(readFileSync(configPath), bytes)
      assert.equal(readConfig(configPath).state_dir, state)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }
)
