// Controlled elapsed time verifies cold startup, exit and deadline refusal without waiting for wall-clock seconds.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { waitHttpReady } from '../../scripts/release/readiness.mjs'

test('cold readiness can pass beyond the old five-second polling window within one shared deadline', async () => {
  let now = 0
  let calls = 0
  const response = new Response('', { status: 401 })
  const options = {
    now: () => now,
    request: async (_url, { signal }) => {
      assert.equal(signal.aborted, false)
      now += 2000
      if (++calls < 4) {
        throw new Error('synthetic_connection_refused')
      }
      return response
    }
  }
  assert.equal(await waitHttpReady('http://127.0.0.1:9', () => true, 10_000, options), response)
  assert.equal(now, 8000)
  // A second listener consumes only the remainder of the original deadline.
  options.request = async () => {
    now += 3000
    return response
  }
  assert.equal(await waitHttpReady('http://127.0.0.1:9', () => true, 10_000, options), undefined)
})

test('readiness stops after child exit and refuses an exhausted deadline', async () => {
  let calls = 0
  let alive = true
  const options = {
    now: () => 100,
    request: async () => {
      calls++
      alive = false
      throw new Error('synthetic_exit')
    }
  }
  assert.equal(await waitHttpReady('http://127.0.0.1:9', () => alive, 200, options), undefined)
  assert.equal(calls, 1)
  assert.equal(await waitHttpReady('http://127.0.0.1:9', () => true, 100, options), undefined)
  assert.equal(calls, 1)
})
