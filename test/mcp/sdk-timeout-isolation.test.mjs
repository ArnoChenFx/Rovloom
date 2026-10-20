// 故意失败的隔离子进程保留Bun原超时，验证真实SDK和listener在下一用例前已经释放。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'

for (const mode of ['blocked', 'sse_eof']) {
  test(
    `真实SDK故意超时仍失败，after在下一用例前关闭listener：${mode}`,
    { timeout: 10_000 },
    /** 子进程业务明确为阻塞测试探针，不执行native或读用户配置。 */ async () => {
      const root = await mkdtemp(join(tmpdir(), 'rovloom-sdk-isolation-'))
      const path = join(root, 'timeout.test.mjs')
      const lifecycle = new URL('./sdk-lifecycle.ts', import.meta.url).href
      const fixture = new URL('./http-fixture.ts', import.meta.url).href
      const transport = new URL(
        '../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js',
        import.meta.url
      ).href
      const source = `
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sdkTestLifecycle } from ${JSON.stringify(lifecycle)}
import { httpFixture, syntheticHeaders } from ${JSON.stringify(fixture)}
import { StreamableHTTPClientTransport } from ${JSON.stringify(transport)}

const mode = ${JSON.stringify(mode)}
let entered = false
let cleaned = false
let callbackSettled = false
let requestSettled = false
let settledBeforeCleanup
let running
test('intentional_timeout', { timeout: 500 }, async (context) => {
  const scope = sdkTestLifecycle(context, 'http-sessions', 500)
  let release
  const blocked = new Promise((resolve) => { release = resolve })
  let ready
  const started = new Promise((resolve) => { ready = resolve })
  const http = httpFixture(scope.service({
    async execute() {
      if (mode === 'blocked') {
        entered = true
        ready()
        await blocked
      }
      return {}
    }
  }))
  running = http.running
  let request
  await scope.own('http', async () => {
    settledBeforeCleanup = requestSettled
    release()
    await http.close()
    await request
    cleaned = true
  })
  try {
    const transport = mode === 'sse_eof' ? new StreamableHTTPClientTransport(new URL(running.url), {
      requestInit: { headers: syntheticHeaders },
      async fetch(url, init) {
        const response = await fetch(url, init)
        const message = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
        if (message?.method === 'tools/call') {
          await response.body?.cancel()
          entered = true
          ready()
          return new Response(': synthetic_test_eof\\n\\n', {
            status: 200, headers: { 'content-type': 'text/event-stream' }
          })
        }
        return response
      }
    }) : http.transport
    await http.client.connect(transport, scope.options())
    request = scope.call('machines_list', () =>
      http.client.callTool({ name: 'machines_list', arguments: {} }, undefined,
        mode === 'sse_eof' ? { signal: scope.signal } : scope.options())
    ).then(() => { requestSettled = true }, () => { requestSettled = true })
    await scope.wait(started)
    scope.phase('both_running')
    await scope.wait(new Promise(() => {}))
    assert.fail('timeout_must_not_pass')
  } finally {
    await scope.close()
    callbackSettled = true
  }
})
test('next_case_observes_closed_resources', async () => {
  assert.equal(entered, true)
  assert.equal(cleaned, true)
  assert.equal(callbackSettled, true)
  assert.equal(requestSettled, true)
  if (mode === 'sse_eof') assert.equal(settledBeforeCleanup, false)
  await running.closed
  await assert.rejects(fetch(running.url))
  console.log('sdk_timeout_cleanup_before_next_case')
  console.log(mode)
})
`
      let child
      try {
        await writeFile(path, source)
        child = spawn(process.execPath, ['--no-env-file', 'test', path], {
          env: { PATH: process.env.PATH, NO_COLOR: '1' },
          stdio: ['ignore', 'pipe', 'pipe']
        })
        const closed = once(child, 'close')
        let output = ''
        for (const stream of [child.stdout, child.stderr]) {
          stream.on(
            'data',
            /** 子进程只含固定fixture诊断，限制采集量以拒绝异常噪声。 */ (bytes) => {
              output += bytes.toString()
              if (output.length > 32_768) {
                child.kill('SIGKILL')
              }
            }
          )
        }
        const deadline = setTimeout(
          /** 子进程失去清理能力时明确失败并终止自己的进程。 */ () => child.kill('SIGKILL'),
          7000
        )
        try {
          assert.deepEqual(await closed, [1, null], output)
        } finally {
          clearTimeout(deadline)
        }
        assert.match(output, /test timed out after 500ms/)
        assert.match(output, /1 pass/)
        assert.match(output, /1 fail/)
        assert.match(output, /sdk_timeout_cleanup_before_next_case/)
        assert.match(output, /"cleanup":"complete"/)
        assert(output.includes(mode))
        assert.doesNotMatch(output, /Unhandled error/)
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL')
          await once(child, 'close')
        }
        await rm(root, { recursive: true, force: true })
      }
    }
  )
}
