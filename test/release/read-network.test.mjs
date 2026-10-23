/** 受控 HTTPS 响应覆盖有限只读重试；不运行任何 native 或安装操作。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readNetwork } from '../../scripts/ci/read-network.mjs'

const url = 'https://example.test/immutable'
const options = { maxBytes: 16, wait: async () => {} }

test('read retries connection, transient status and interrupted body, at most three times', async () => {
  for (const failure of [
    () => {
      throw new TypeError('fetch failed')
    },
    () => new Response('', { status: 503 }),
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError('interrupted'))
          }
        })
      )
  ]) {
    let calls = 0
    const fetcher = async (_url, init) => {
      assert.equal(init.method, 'GET')
      assert.equal(init.body, undefined)
      calls++
      return calls === 1 ? failure() : new Response('ok')
    }
    assert.equal((await readNetwork(url, { ...options, fetcher })).toString(), 'ok')
    assert.equal(calls, 2)
  }
  let calls = 0
  await assert.rejects(
    readNetwork(url, {
      ...options,
      fetcher: async () => {
        calls++
        return new Response('', { status: 503 })
      }
    }),
    /read_transient_status/
  )
  assert.equal(calls, 3)
})

test('read never retries permanent rejection, invalid TLS, excess bytes or unsafe redirect', async () => {
  for (const failure of [
    () => new Response('', { status: 403 }),
    () => new Response('', { status: 404 }),
    () => new Response('x'.repeat(17)),
    () => new Response('', { status: 302, headers: { location: 'http://example.test/no' } }),
    () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED' } })
    }
  ]) {
    let calls = 0
    await assert.rejects(
      readNetwork(url, {
        ...options,
        fetcher: async () => {
          calls++
          return failure()
        }
      })
    )
    assert.equal(calls, 1)
  }
})

test('read cancellation during backoff prevents another attempt and total deadline is shared', async () => {
  const controller = new AbortController()
  let calls = 0
  await assert.rejects(
    readNetwork(url, {
      ...options,
      signal: controller.signal,
      fetcher: async () => {
        calls++
        return new Response('', { status: 503 })
      },
      wait: async () => {
        controller.abort()
        throw controller.signal.reason
      }
    }),
    /read_aborted/
  )
  assert.equal(calls, 1)
  await assert.rejects(
    readNetwork(url, {
      maxBytes: 16,
      timeoutMs: 20,
      fetcher: async (_url, { signal }) =>
        new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    }),
    /read_aborted/
  )
})

test('read respects short Retry-After and strips authorization permanently across origins', async () => {
  const waits = []
  let calls = 0
  const bytes = await readNetwork(url, {
    ...options,
    headers: { authorization: 'synthetic', cookie: 'synthetic' },
    wait: async (ms) => {
      waits.push(ms)
    },
    fetcher: async (target, init) => {
      calls++
      if (calls === 1) {
        return new Response('', { status: 429, headers: { 'retry-after': '1' } })
      }
      if (calls === 2) {
        return new Response('', { status: 302, headers: { location: 'https://cdn.test/asset' } })
      }
      assert.equal(target.hostname, 'cdn.test')
      assert.equal(init.headers.has('authorization'), false)
      assert.equal(init.headers.has('cookie'), false)
      return new Response('ok')
    }
  })
  assert.equal(bytes.toString(), 'ok')
  assert.deepEqual(waits, [1000])
})
