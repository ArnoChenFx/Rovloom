/** 可选收费验收：明确指定模型与执行许可后，经已部署 Gateway 核验同一 OpenCode session 的两轮对话。
 * 用法与预算边界见 e2e/README.md；默认拒绝启动，不读取配置或凭据。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  agentArguments,
  agentTools,
  MAX_AGENT_BYTES,
  readAgentCall,
  verifyConversation
} from './agent-conversation.mjs'

const [permission, opencode, model] = process.argv.slice(2)
assert(
  permission === '--allow-model-requests' && opencode && /^ds\/[a-z0-9][a-z0-9._-]*$/u.test(model ?? ''),
  'Explicit model/budget authorization required: --allow-model-requests <opencode> <ds/model>; no default or fallback'
)
assert(process.env.MCP_CONFIG && process.env.DEEPSEEK_API_KEY, 'MCP_CONFIG and DEEPSEEK_API_KEY are required')
const home = mkdtempSync(join(tmpdir(), 'rovloom-agent-'))
const config = join(home, 'opencode.json')
const client = new Client({ name: 'agent-conversation-check', version: '1' })

/** 出错只返回固定阶段码，不回显配置、提示词、输出或异常中的服务器响应。 */
function requireValue(value, code) {
  if (!value) {
    throw new Error(code)
  }
}

const network =
  /^(https?_proxy|no_proxy|all_proxy|node_extra_ca_certs|ssl_cert_file|ssl_cert_dir|requests_ca_bundle)$/iu

/** stdout 是有界 JSON 事件；stderr 仅排空，不保存或打印。超时/错误绝不自动重试模型请求。 */
function runTurn(prompt, sessionID) {
  return new Promise((resolve, reject) => {
    const child = spawn(opencode, agentArguments(model, prompt, sessionID), {
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
    const chunks = []
    let size = 0
    let failure
    child.stdout.on('data', (bytes) => {
      size += bytes.length
      if (size > MAX_AGENT_BYTES) {
        failure = 'agent_output_limit'
        child.kill('SIGKILL')
      } else {
        chunks.push(bytes)
      }
    })
    child.stderr.resume()
    child.once('error', () => {
      failure = 'agent_spawn_failed'
    })
    const timer = setTimeout(() => {
      failure = 'agent_timeout_outcome_unconfirmed'
      child.kill('SIGKILL')
    }, 240_000)
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (failure || code !== 0 || signal) {
        reject(new Error(failure ?? 'agent_exit_failed'))
      } else {
        resolve(Buffer.concat(chunks).toString('utf8'))
      }
    })
  })
}

let phase = 'prepare'
try {
  const mcp = JSON.parse(readFileSync(process.env.MCP_CONFIG, 'utf8'))
  requireValue(Array.isArray(mcp.targets) && mcp.targets.length === 1, 'single_explicit_target_required')
  const target = mcp.targets[0]
  requireValue(
    target?.machine_id && target.provider_id && target.profile === 'session' && target.session,
    'explicit_target_required'
  )
  const modelID = model.slice('ds/'.length)
  writeFileSync(
    config,
    JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      model,
      small_model: model,
      enabled_providers: ['ds'],
      autoupdate: false,
      share: 'disabled',
      permission: { '*': 'deny', ...Object.fromEntries(agentTools.map((name) => [`rovloom_${name}`, 'allow'])) },
      provider: {
        ds: {
          npm: '@ai-sdk/openai-compatible',
          name: 'DeepSeek',
          whitelist: [modelID],
          options: { baseURL: 'https://api.deepseek.com', apiKey: '{env:DEEPSEEK_API_KEY}' },
          models: { [modelID]: { name: modelID, tool_call: true } }
        }
      },
      mcp: {
        rovloom: { type: 'remote', url: mcp.url, enabled: true, headers: { Authorization: `Bearer ${mcp.token}` } }
      }
    }),
    { mode: 0o600 }
  )
  phase = 'independent_connect'
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcp.url), {
      requestInit: { headers: { authorization: `Bearer ${mcp.token}` } }
    })
  )
  phase = 'two_round_conversation'
  const evidence = await verifyConversation({
    target,
    nonce: randomBytes(16).toString('hex'),
    runTurn,
    readCall: (callID) => readAgentCall(client, callID)
  })
  console.log(JSON.stringify({ ok: true, ...evidence }))
} catch {
  console.error(JSON.stringify({ ok: false, phase, outcome: 'unconfirmed', automatic_retry: false }))
  process.exitCode = 1
} finally {
  try {
    await client.close()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}
