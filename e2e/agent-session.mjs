/** 让真实 LLM Agent（opencode + DeepSeek）通过已部署 Gateway 的 MCP 完成一次对话，并独立核对其回答。
 * 用法：MCP_CONFIG=<quickstart.py 写出的 mcp.json> DEEPSEEK_API_KEY=… bun e2e/agent-session.mjs <opencode可执行文件>
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'

const [opencode, model = 'ds/deepseek-chat'] = process.argv.slice(2)
assert(
  opencode && process.env.MCP_CONFIG && process.env.DEEPSEEK_API_KEY,
  'opencode, MCP_CONFIG and DEEPSEEK_API_KEY are required'
)
const mcp = JSON.parse(readFileSync(process.env.MCP_CONFIG, 'utf8'))
const target = mcp.targets[0]

/** 独立 MCP 客户端读出真实值，Agent 的回答必须与之一致。 */
async function independentVersion() {
  const client = new Client({ name: 'quickstart-check', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcp.url), {
      requestInit: { headers: { authorization: `Bearer ${mcp.token}` } }
    })
  )
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args }, CallToolResultSchema)
    assert.equal(result.isError, undefined, `${name}:${JSON.stringify(result.structuredContent)}`)
    return result.structuredContent.data
  }
  try {
    const discovered = await call('runtime_discover', { target, expected_binding_revision: 1, limit: 100 })
    const submitted = await call('runtime_call', {
      target,
      expected_binding_revision: 1,
      contract_ref: discovered.items[0].contract_ref,
      native_request: { method: 'ping', params: {} },
      deadline: Date.now() + 30_000,
      wait_ms: 2000
    })
    let view = submitted
    for (let i = 0; i < 50 && view.state !== 'responded'; i++) {
      view = await call('runtime_call_get', { call_id: submitted.call_id, wait_ms: 200 })
    }
    const page = await call('runtime_result_read', { result_id: view.result.result_id, max_bytes: 16_384 })
    return JSON.parse(Buffer.from(page.chunk, 'base64').toString('utf8')).result.version
  } finally {
    await client.close()
  }
}

const home = mkdtempSync(join(homedir(), '.rovloom-agent-'))
const config = join(home, 'opencode.json')
writeFileSync(
  config,
  JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    model,
    autoupdate: false,
    share: 'disabled',
    permission: { '*': 'allow' },
    provider: {
      ds: {
        npm: '@ai-sdk/openai-compatible',
        name: 'DeepSeek',
        options: { baseURL: 'https://api.deepseek.com', apiKey: '{env:DEEPSEEK_API_KEY}' },
        models: {
          'deepseek-chat': { name: 'deepseek-chat', tool_call: true, limit: { context: 64_000, output: 8000 } }
        }
      }
    },
    mcp: { rovloom: { type: 'remote', url: mcp.url, enabled: true, headers: { Authorization: `Bearer ${mcp.token}` } } }
  }),
  { mode: 0o600 }
)
const prompt = [
  'Use the rovloom MCP tools only. Do the following and stop:',
  '1. List the machines and providers (rovloom_machines_list, rovloom_providers_list).',
  `2. Discover the methods of target ${JSON.stringify(target)} with expected_binding_revision 1 (rovloom_runtime_discover).`,
  '3. Call "ping" (params {}) through rovloom_runtime_call using the contract_ref from discover and an absolute epoch-millisecond deadline = now+60000; poll rovloom_runtime_call_get until state is responded; read the retained result with rovloom_runtime_result_read (the chunk is base64) and report the Herdr version from the pong.',
  'Finish with one line: RESULT version=<version>.'
].join('\n')
const network =
  /^(https?_proxy|no_proxy|all_proxy|node_extra_ca_certs|ssl_cert_file|ssl_cert_dir|requests_ca_bundle)$/iu
const child = spawn(opencode, ['run', '--model', model, prompt], {
  cwd: home,
  env: {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => network.test(key))),
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CACHE_HOME: join(home, 'cache'),
    XDG_STATE_HOME: join(home, 'state'),
    OPENCODE_CONFIG: config,
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    NO_COLOR: '1'
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
let output = ''
child.stdout.on('data', (bytes) => (output = (output + bytes).slice(-32_768)))
child.stderr.on('data', (bytes) => (output = (output + bytes).slice(-32_768)))
const timer = setTimeout(() => child.kill('SIGKILL'), 240_000)
const code = await new Promise((resolve) => child.on('close', resolve))
clearTimeout(timer)
const real = await independentVersion()
const reported = /RESULT version=(\S+)/u.exec(output)?.[1]
console.log(
  JSON.stringify({ agent_exit: code, reported_version: reported, real_version: real, tail: output.slice(-400) })
)
assert.equal(code, 0, 'agent_exit')
assert.equal(reported, real, 'the agent must report the version the gateway really returned')
