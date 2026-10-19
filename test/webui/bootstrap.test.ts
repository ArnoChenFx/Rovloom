/** 验证 CLI 单 meta 交付只进入内存，重复/无效/过期交付不能驱动已有管理客户端。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createManagementPageCsrf } from '../../src/webui/bootstrap.js'
import { createManagementWriteClient } from '../../src/webui/write-client.js'
import { ManagementClientError } from '../../src/webui/write-contract.js'

const token = 'c'.repeat(43)

/** 模拟 Document 的查询/移除边界；真实 DOM 与生产入口另由 Chromium 验证。 */
function fixture(values: { content: string; expiry?: string }[]) {
  let queries = 0
  const elements = values.map(
    /** 记录每个交付节点是否已被消费。 */ (value) => ({
      content: value.content,
      dataset: { expiresAt: value.expiry },
      removed: false,
      /** 模拟移除后节点不再参与后续 DOM 查询。 */
      remove() {
        this.removed = true
      }
    })
  )
  const page = {
    /** 只允许契约指定的 marker，不访问 cookie 或其它页面字段。 */
    querySelectorAll(selector: string) {
      assert.equal(selector, 'meta[name="rovloom-management-bootstrap"]')
      queries++
      return elements.filter(/** 已移除节点不会被第二个消费者读到。 */ (element) => !element.removed)
    }
  } as unknown as Document
  return { page, elements, /** 观察 provider 是否重新读取 DOM。 */ queries: () => queries }
}

test(
  '有效交付同步移出 DOM，回调复用内存且第二个消费者得不到原值',
  /** DOM 一次消费不等于每次请求轮换 token，也不把 token 写回 DOM。 */ async () => {
    const f = fixture([{ content: token, expiry: String(Date.now() + 60_000) }])
    const csrf = createManagementPageCsrf(f.page)
    assert(f.elements.every(/** 无论后续是否取值，原节点已移除。 */ (element) => element.removed))
    const signal = new AbortController().signal
    assert.equal(await csrf(signal), token)
    assert.equal(await csrf(signal), token)
    assert.equal(f.queries(), 1)
    assert.equal(await createManagementPageCsrf(f.page)(signal), null)
  }
)

test(
  '缺失或重复 meta 一律拒绝并移除全部重复节点',
  /** 相同或不同 token 的重复交付都不能任取一个成为生产凭据。 */ async () => {
    const value = { content: token, expiry: String(Date.now() + 60_000) }
    for (const entries of [[], [value, value], [value, { ...value, content: 'd'.repeat(43) }]]) {
      const f = fixture(entries)
      assert.equal(await createManagementPageCsrf(f.page)(new AbortController().signal), null)
      assert(f.elements.every(/** 拒绝的交付同样不留在 DOM。 */ (element) => element.removed))
    }
  }
)

test(
  'token 必须是43字符 base64url，截止必须是有效安全整数且未到期',
  /** 不把空值、坏长度、非整数或不精确时间当成有效会话。 */ async () => {
    const future = String(Date.now() + 60_000)
    const entries = [
      { content: '', expiry: future },
      { content: 'c'.repeat(42), expiry: future },
      { content: 'c'.repeat(44), expiry: future },
      { content: 'c'.repeat(42) + '+', expiry: future },
      { content: token },
      { content: token, expiry: '' },
      { content: token, expiry: 'NaN' },
      { content: token, expiry: 'Infinity' },
      { content: token, expiry: '1.5' },
      { content: token, expiry: String(Number.MAX_SAFE_INTEGER + 1) },
      { content: token, expiry: String(Date.now()) },
      { content: token, expiry: '-1' }
    ]
    for (const entry of entries) {
      const f = fixture([entry])
      assert.equal(await createManagementPageCsrf(f.page)(new AbortController().signal), null)
      assert.equal(f.elements[0]!.removed, true)
    }
  }
)

test(
  '取消只拒绝本次取值，到期后墙钟回退也不能恢复已清除的 token',
  /** 精确检查原截止，不因反复取值、取消或时钟回退续期。 */ async () => {
    const original = Date.now
    let at = 1000
    Date.now = /** 只控制本测试的墙钟，finally 恢复。 */ () => at
    try {
      const f = fixture([{ content: token, expiry: '1001' }])
      const csrf = createManagementPageCsrf(f.page)
      const cancelled = new AbortController()
      cancelled.abort()
      assert.equal(await csrf(cancelled.signal), null)
      assert.equal(await csrf(new AbortController().signal), token)
      at = 1001
      assert.equal(await csrf(new AbortController().signal), null)
      at = 1000
      assert.equal(await csrf(new AbortController().signal), null)
      assert.equal(f.queries(), 1)
    } finally {
      Date.now = original
    }
  }
)

test(
  '正式写客户端使用消费后的内存 CSRF，仅发送固定同源请求',
  /** 交付原值只进入指定 header，不能变成 JSON 身份或 Authorization。 */ async () => {
    const f = fixture([{ content: token, expiry: String(Date.now() + 60_000) }])
    let calls = 0
    const client = createManagementWriteClient({
      csrf: createManagementPageCsrf(f.page),
      /** 检查真正交给浏览器 fetch 的边界，不启动管理后端。 */
      async fetcher(path, init) {
        calls++
        assert.equal(path, '/admin/v1/actions/history_open')
        assert.equal(init.credentials, 'same-origin')
        assert.equal(init.body, '{}')
        const headers = new Headers(init.headers)
        assert.equal(headers.get('x-rovloom-csrf'), token)
        assert.equal(headers.get('authorization'), null)
        assert.equal(headers.get('cookie'), null)
        return Response.json({
          history_epoch: 'fixture_history',
          recovery_generation: 'fixture_generation',
          accept_new_until: 10_000
        })
      }
    })
    try {
      await client.execute('history_open', {}, new AbortController().signal)
      assert.equal(calls, 1)
      assert.equal(f.elements[0]!.removed, true)
    } finally {
      client.close()
    }
  }
)

test(
  '无效 DOM 交付在网络发送前失败，客户端不能用 cookie 或身份字段补齐 CSRF',
  /** 即使后端读取可用，也不发送准备或设备变更请求。 */ async () => {
    const entry = { content: token, expiry: String(Date.now() + 60_000) }
    const client = createManagementWriteClient({
      csrf: createManagementPageCsrf(fixture([entry, entry]).page),
      /** 任何网络发送都说明失败关闭边界失效。 */
      async fetcher() {
        assert.fail('unexpected request')
      }
    })
    try {
      await assert.rejects(
        client.execute('history_open', {}, new AbortController().signal),
        /** 只观察公开问题与未开始发送的事实，不记录 token。 */ (error: unknown) =>
          error instanceof ManagementClientError && error.problem === 'unauthenticated' && !error.request_started
      )
    } finally {
      client.close()
    }
  }
)
