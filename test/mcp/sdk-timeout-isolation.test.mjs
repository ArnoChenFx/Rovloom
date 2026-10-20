// 故意失败的隔离子进程保留Bun原超时，验证真实SDK和listener在下一用例前已经释放。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { pathToFileURL } from 'node:url'

for (const mode of ['blocked', 'sse_eof', 'fixture_import', 'fixture_open']) {
  test(
    `故意超时仍失败，after排空取得和主体后才进入下一用例：${mode}`,
    { timeout: 10_000 },
    /** 子进程业务明确为阻塞测试探针，不执行native或读用户配置。 */ async () => {
      const root = await mkdtemp(join(tmpdir(), 'rovloom-sdk-isolation-'))
      const path = join(root, 'timeout.test.mjs')
      const fixturePath = join(root, 'acquisition.mjs')
      const acquisition = pathToFileURL(fixturePath).href
      const timeout = mode.startsWith('fixture_') ? 30 : 500
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
const timeout = ${timeout}
let entered = false
let cleaned = false
let callbackSettled = false
let requestSettled = false
let settledBeforeCleanup
let running
test('intentional_timeout', { timeout }, async (context) => {
  const scope = sdkTestLifecycle(context, 'http-sessions', timeout)
  return scope.run(async () => {
  if (mode.startsWith('fixture_')) {
    scope.phase(mode)
    try {
      const fixture = await scope.load(() => import(${JSON.stringify(acquisition)}))
      await scope.acquire('runtime', () => fixture.open(), (resource) => {
        resource.close()
        cleaned = true
      })
      assert.fail('acquisition_timeout_must_not_pass')
    } finally {
      callbackSettled = true
    }
  }
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
})
test('next_case_observes_closed_resources', async () => {
  assert.equal(callbackSettled, true)
  if (mode.startsWith('fixture_')) {
    const fixture = await import(${JSON.stringify(acquisition)})
    assert.equal(fixture.state.opens, mode === 'fixture_open' ? 1 : 0)
    assert.equal(fixture.state.releases, mode === 'fixture_open' ? 1 : 0)
    assert.equal(fixture.state.live, false)
    assert.equal(cleaned, mode === 'fixture_open')
    console.log('sdk_timeout_cleanup_before_next_case')
    console.log(mode)
    return
  }
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
        await writeFile(
          fixturePath,
          `
// 只观察取得/释放的资源stub，不执行native或提供业务成功。
export const state = { opens: 0, releases: 0, live: false }
if (${JSON.stringify(mode)} === 'fixture_import') await new Promise((resolve) => setTimeout(resolve, 80))
export async function open() {
  state.opens++
  if (${JSON.stringify(mode)} === 'fixture_open') await new Promise((resolve) => setTimeout(resolve, 80))
  state.live = true
  return { close() { state.live = false; state.releases++ } }
}
`
        )
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
        assert.match(output, new RegExp('test timed out after ' + timeout + 'ms'))
        assert.match(output, /1 pass/)
        assert.match(output, /1 fail/)
        assert.match(output, /sdk_timeout_cleanup_before_next_case/)
        assert.match(output, /"cleanup":"complete"/)
        assert.match(output, /"callback_finished":true/)
        assert.match(output, /"acquisitions":0/)
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
