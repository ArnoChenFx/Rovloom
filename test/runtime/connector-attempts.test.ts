// 使用既有真实 Wire/原生契约 fixture 检查 Connector 独立准入，不把测试来源当生产认证。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLuvusWireAdapter } from '../../src/integration/luvus-wire.js'
import {
  ConnectorAttemptBook,
  connectorAdmissionAdapter,
  createConnectorAdmissionBackend
} from '../../src/runtime/connector-attempts.js'
import { fixture } from '../connector/luvus/helpers.js'

/** 在 fixture 的受保护端口上建立独立内存准入；不使用它预先登记的 attempt 查询。 */
async function admitted() {
  const f = await fixture()
  const book = new ConnectorAttemptBook({
    retention_ms: 60_000,
    now: /** 提供 fixture 独立时间，供固定期限测试控制。 */ () => f.state.now
  })
  const options = {
    connection: f.backend.connection(),
    routes: [{ target: f.binding.target, principal_id: 'synthetic' }],
    source: f.backend,
    book
  }
  const backend = createConnectorAdmissionBackend(options)
  const adapter = connectorAdmissionAdapter(backend, createLuvusWireAdapter(backend))
  return {
    f,
    book,
    options,
    backend,
    adapter,
    /** 先停有维护 timer 的 Wire，再删除本用例自有安装和 listener。 */
    async close() {
      adapter.close()
      await f.close()
    }
  }
}

test(
  'Connector admission starts without a Gateway attempt record and commits only after full Wire validation',
  /** 原始真实 decode 建立许可后才让准入查询看见已提交请求。 */ async () => {
    const a = await admitted()
    try {
      assert.equal(a.backend.attempt('call1', 'attempt1'), undefined)
      assert.equal(a.adapter.decode(a.f.input(), 'gateway_to_connector').type, 'request')
      assert.deepEqual(a.backend.attempt('call1', 'attempt1'), a.f.row)
      const changed = structuredClone(a.f.envelope)
      changed.payload.native_request.params = { title: 'changed' }
      assert.throws(
        /** 相同 attempt 的正文不可替换。 */ () => a.adapter.decode(JSON.stringify(changed), 'gateway_to_connector'),
        new RegExp('attempt_request_mismatch')
      )
      assert.deepEqual(a.backend.attempt('call1', 'attempt1')?.native_request, a.f.row.native_request)
      a.adapter.release(a.f.binding)
      assert.equal(a.backend.attempt('call1', 'attempt1'), undefined)
      assert.equal(a.book.dedupExpires(a.f.binding), 60_100)
    } finally {
      await a.close()
    }
  }
)

test(
  'a failed original native gate removes the staged candidate and does not reserve a dedup deadline',
  /** 即便 preflight 通过，来源拒绝仍由原 Wire 决定且不能留下锚点。 */ async () => {
    const a = await admitted()
    try {
      a.f.state.trusted = false
      assert.throws(
        /** 未认证的原生来源不能通过原生 gate。 */ () => a.adapter.decode(a.f.input(), 'gateway_to_connector'),
        new RegExp('native_source_untrusted')
      )
      assert.equal(a.backend.attempt('call1', 'attempt1'), undefined)
      assert.throws(
        /** 失败请求未提交 book 记录。 */ () => a.book.dedupExpires(a.f.binding),
        new RegExp('attempt_anchor_unavailable')
      )
      a.f.state.trusted = true
      a.f.state.now = 200
      a.adapter.decode(a.f.input(), 'gateway_to_connector')
      assert.equal(a.book.dedupExpires(a.f.binding), 60_200)
    } finally {
      await a.close()
    }
  }
)

test(
  'connection, route, policy revisions and caller self-report cannot establish an admission anchor',
  /** 分别破坏独立门禁，所有失败后均无候选残留。 */ async () => {
    const a = await admitted()
    try {
      const changed = structuredClone(a.f.envelope)
      changed.connection_epoch = 'other'
      assert.throws(
        /** 别的连接不能复用认证外壳。 */ () => a.adapter.decode(JSON.stringify(changed), 'gateway_to_connector'),
        new RegExp('attempt_binding_mismatch')
      )
      changed.connection_epoch = a.f.envelope.connection_epoch
      changed.payload.attempt.target.provider_id = 'other'
      assert.throws(
        /** 完整目标必须命中受保护本机路由。 */ () => a.adapter.decode(JSON.stringify(changed), 'gateway_to_connector'),
        new RegExp('connector_route_unavailable')
      )
      changed.payload.attempt.target.provider_id = 'p1'
      changed.payload.attempt.registration.caller_policy_revision = 'other'
      assert.throws(
        /** Wire 登记 revision 必须匹配当前双端策略。 */ () =>
          a.adapter.decode(JSON.stringify(changed), 'gateway_to_connector'),
        new RegExp('policy_revision_stale')
      )
      const spoof = { ...a.f.envelope, principal_id: 'owner' }
      assert.throws(
        /** 自报主体作为未声明字段由原 codec 拒绝。 */ () =>
          a.adapter.decode(JSON.stringify(spoof), 'gateway_to_connector'),
        new RegExp('invalid_frame_fields')
      )
      assert.equal(a.backend.attempt('call1', 'attempt1'), undefined)
    } finally {
      await a.close()
    }
  }
)

test(
  'fixed local dedup expiry survives release and disconnect and cannot move to a new epoch',
  /** 第一次固定截止跨重复校验不变，旧 attempt 不因重连成为新意图。 */ async () => {
    const a = await admitted()
    try {
      a.adapter.decode(a.f.input(), 'gateway_to_connector')
      a.f.state.now = 1000
      a.adapter.decode(a.f.input(), 'gateway_to_connector')
      assert.equal(a.book.dedupExpires(a.f.binding), 60_100)
      a.adapter.close()
      assert.equal(a.backend.attempt('call1', 'attempt1'), undefined)
      assert.equal(a.book.dedupExpires(a.f.binding), 60_100)
      const connection = { ...a.options.connection, connection_epoch: 'e2' }
      const nextBackend = createConnectorAdmissionBackend({ ...a.options, connection })
      const next = connectorAdmissionAdapter(nextBackend, createLuvusWireAdapter(nextBackend))
      try {
        const changed = { ...a.f.envelope, connection_epoch: 'e2' }
        assert.throws(
          /** 固定 book 将已登记 attempt 与原 epoch 一并核对。 */ () =>
            next.decode(JSON.stringify(changed), 'gateway_to_connector'),
          new RegExp('attempt_binding_mismatch')
        )
        a.f.state.now = a.f.binding.registration.deadline
        assert.throws(
          /** 原 deadline 到期后不能重新准入。 */ () => next.decode(JSON.stringify(changed), 'gateway_to_connector'),
          new RegExp('deadline_exceeded')
        )
      } finally {
        next.close()
      }
    } finally {
      await a.close()
    }
  }
)

test(
  'independent protected metadata preserves the Gateway dedup expiry and rejects later changes',
  /** 截止来自独立端口，不能因第二次读取 metadata 不同而覆盖首次值。 */ async () => {
    const a = await admitted()
    let expiry = 90_000
    const book = new ConnectorAttemptBook({
      now: /** 返回 fixture 当前可信时间。 */ () => a.f.state.now,
      dedupExpires: /** 模拟独立受保护元数据端口，不从 Wire 消息提取 TTL。 */ () => expiry
    })
    const backend = createConnectorAdmissionBackend({ ...a.options, book })
    const wire = connectorAdmissionAdapter(backend, createLuvusWireAdapter(backend))
    try {
      wire.decode(a.f.input(), 'gateway_to_connector')
      assert.equal(book.dedupExpires(a.f.binding), 90_000)
      expiry++
      assert.throws(
        /** 元数据漂移保持拒绝，不更改已保存截止。 */ () => wire.decode(a.f.input(), 'gateway_to_connector'),
        new RegExp('attempt_request_mismatch')
      )
      assert.equal(book.dedupExpires(a.f.binding), 90_000)
    } finally {
      wire.close()
      await a.close()
    }
  }
)

test(
  'Connector admission rejects insufficient retention, duplicate keys and unprotected principal ambiguity',
  /** 错误配置和预算不能退化成宽松默认授权或覆盖固定记录。 */ async () => {
    const a = await admitted()
    try {
      assert.throws(
        /** 必须显式选择一类受保护截止来源。 */ () => new ConnectorAttemptBook({ now: Date.now }),
        new RegExp('connector_retention_source_required')
      )
      const short = new ConnectorAttemptBook({ retention_ms: 1, now: a.options.source.now })
      const backend = createConnectorAdmissionBackend({ ...a.options, book: short })
      const wire = connectorAdmissionAdapter(backend, createLuvusWireAdapter(backend))
      try {
        assert.throws(
          /** 去重期限不能短于执行 deadline。 */ () => wire.decode(a.f.input(), 'gateway_to_connector'),
          new RegExp('connector_retention_insufficient')
        )
      } finally {
        wire.close()
      }
      assert.throws(
        /** 相同目标不能存在两条路由。 */ () =>
          createConnectorAdmissionBackend({ ...a.options, routes: [...a.options.routes, ...a.options.routes] }),
        new RegExp('connector_route_invalid')
      )
      assert.throws(
        /** 当前后端没有按调用选择结果读取主体的接口，多个主体保持拒绝。 */ () =>
          createConnectorAdmissionBackend({
            ...a.options,
            routes: [
              ...a.options.routes,
              { target: { ...a.f.binding.target, provider_id: 'p2' }, principal_id: 'other' }
            ]
          }),
        new RegExp('connector_principal_ambiguous')
      )
    } finally {
      await a.close()
    }
  }
)
