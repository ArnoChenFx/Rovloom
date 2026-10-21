/** 真实 LLM Agent（opencode）经 MCP 驱动整条链路；副作用由独立 MCP 客户端读回，不采信 Agent 自述。
 * 用法：DEEPSEEK_API_KEY=… bun e2e/agent.mjs <rovloom二进制> <herdr 0.9.5二进制> <opencode可执行文件> [模型]
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createStack, environment } from './harness.mjs'

const [binary, herdrBinary, opencode, model = 'deepseek/deepseek-chat'] = process.argv.slice(2)
assert(binary && herdrBinary && opencode, 'Usage: bun e2e/agent.mjs <rovloom> <herdr> <opencode> [provider/model]')
assert(process.env.DEEPSEEK_API_KEY, 'DEEPSEEK_API_KEY is required')

/** 运行 Agent；密钥只经环境变量传入，输出落盘前截断，绝不回显配置。 */
function runAgent(prompt, home, config, timeout) {
  return new Promise((resolve) => {
    const child = spawn(opencode, ['run', '--model', model, prompt], {
      cwd: home,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        XDG_CONFIG_HOME: join(home, 'config'),
        XDG_DATA_HOME: join(home, 'data'),
        XDG_CACHE_HOME: join(home, 'cache'),
        XDG_STATE_HOME: join(home, 'state'),
        OPENCODE_CONFIG: config,
        DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
        NO_COLOR: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (bytes) => (stdout = (stdout + bytes).slice(-32_768)))
    child.stderr.on('data', (bytes) => (stderr = (stderr + bytes).slice(-8192)))
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr })
    })
  })
}

const stack = await createStack({
  binary,
  herdrBinary,
  methods: ['ping', 'session.snapshot', 'workspace.create']
})
const report = { environment: environment(binary), model }
let failure
try {
  await stack.startGateway()
  stack.startConnector()
  const client = await stack.connect()
  await stack.waitReady(client)
  const snapshot = async () => {
    const view = await stack.invoke(client, { method: 'session.snapshot', params: {} })
    return (await stack.readResult(client, view)).result.snapshot.workspaces.length
  }
  const before = await snapshot()
  const home = join(stack.f.root, 'agent-home')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const config = join(home, 'opencode.json')
  writeFileSync(
    config,
    JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      model,
      autoupdate: false,
      share: 'disabled',
      permission: { '*': 'allow' },
      mcp: {
        rovloom: {
          type: 'remote',
          url: stack.f.resource,
          enabled: true,
          headers: { Authorization: `Bearer ${stack.f.proof}` }
        }
      }
    }),
    { mode: 0o600 }
  )
  const prompt = [
    'You can use the rovloom MCP tools. Do exactly the following and then stop:',
    '1. List the machines, then the providers of the single machine (rovloom_machines_list, rovloom_providers_list).',
    '2. Discover the methods of that provider (target: that machine_id, the provider_id, profile "session", session "smoke", expected_binding_revision 1) and describe "ping".',
    '3. Call "ping" with params {} through runtime_call (use the contract_ref from discover, a deadline of now+60000 ms as an absolute epoch-millisecond number), wait for it with runtime_call_get until state is "responded", read the result with runtime_result_read (the chunk is base64) and tell me the Herdr version in the pong.',
    '4. Call "workspace.create" with params {} the same way, once only, and tell me the workspace_id it returned.',
    'Finish with one line: RESULT version=<version> workspace=<workspace_id>.'
  ].join('\n')
  const started = Date.now()
  const agent = await runAgent(prompt, home, config, 240_000)
  report.agent = { exit: agent.code, signal: agent.signal, seconds: Math.round((Date.now() - started) / 1000) }
  report.agent_output_tail = agent.stdout.slice(-1500)
  if (agent.code !== 0) {
    report.agent_stderr_tail = agent.stderr.slice(-1500)
  }
  const after = await snapshot()
  report.workspaces = { before, after }
  assert.equal(agent.code, 0, 'agent_exit')
  assert.equal(after, before + 1, 'the agent must have created exactly one workspace through the gateway')
  assert.match(agent.stdout, /0\.9\.5/u, 'the agent must report the real Herdr version')
  report.result = 'passed'
} catch (error) {
  failure = error
  report.result = 'failed'
  report.error = String(error?.message ?? error)
  report.diagnostics = stack.diagnostics()
} finally {
  const problems = await stack.close()
  if (problems.length) {
    report.cleanup = problems
  }
}
console.log(JSON.stringify(report, null, 2))
process.exit(failure ? 1 : 0)
