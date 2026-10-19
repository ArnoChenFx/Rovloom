// 验证有界 JSON、provider 路由重新授权、调用状态栅栏及未知 schema 的无损拒绝。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonical } from '../src/contracts.js'
import { Store } from '../src/store.js'
import { Router } from '../src/router.js'
import { connected, management, options, policy } from './storage/helpers.js'

test(
  'bounded canonical JSON rejects cycles, sparse arrays, getters, excessive depth and size',
  /* 验证规范化拒绝循环、稀疏数组、访问器和超限输入，并允许共享子对象。 */ () => {
    const cycle: unknown[] = []
    cycle.push(cycle)
    const sparse = Array.from({ length: 2 })
    delete sparse[0]
    for (const value of [
      cycle,
      sparse,
      {
        // 若规范化读取访问器便抛错，证明校验不执行输入 getter。
        get secret() {
          throw Error('getter executed')
        }
      },
      'x'.repeat(1_048_577)
    ]) {
      assert.throws(
        /* 规范化各类不安全输入，要求抛出 JSON 类型或资源预算错误。 */ () => canonical(value),
        /invalid_json|json_limit/
      )
    }
    let deep: unknown = null
    for (let i = 0; i < 66; i++) {
      deep = { deep }
    }
    assert.throws(/* 规范化超过最大深度的对象，要求触发预算错误。 */ () => canonical(deep), /json_limit/)
    const shared = { a: 1 }
    assert.equal(canonical([shared, shared]), '[{"a":1},{"a":1}]')
  }
)
test(
  'router reauthorizes reads, dispatch and cancellation against both current policies',
  /* 验证读取、派发和取消都按当前完整 provider 目标重新检查双端授权。 */ () => {
    const s = new Store(':memory:', /* 固定存储时钟，排除截止时间对授权测试的干扰。 */ () => 100, { management })
    try {
      const d = connected(s)
      const caller = policy(d.target)
      let local = policy(d.target, true)
      const router = new Router(s, /* 读取可即时替换的本地策略，验证已有调用不会沿用旧许可。 */ () => local)
      const principal = { id: 'alice', policy: caller }
      const c = router.create(principal, d.target, { method: 'pane.read' }, options())
      assert.deepEqual(JSON.parse(c.target_json), d.target)
      assert.equal(c.method, 'pane.read')
      assert.throws(
        /* 请求白名单外的原生方法，要求在登记调用前拒绝。 */ () =>
          router.create(principal, d.target, { method: 'pane.run' }, options()),
        /forbidden/
      )
      local = { ...local, grants: [] }
      assert.throws(/* 撤销本地许可后读取调用，要求拒绝。 */ () => router.get(principal, c.call_id), /forbidden/)
      assert.throws(
        /* 撤销本地许可后派发调用，要求拒绝。 */ () => router.dispatch(principal, c.call_id, d.epoch),
        /forbidden/
      )
      assert.throws(/* 撤销本地许可后取消调用，要求拒绝。 */ () => router.cancel(principal, c.call_id), /forbidden/)
      local = policy(d.target, true)
      assert.equal(router.cancel(principal, c.call_id).state, 'not_dispatched')
      assert.throws(
        /* 其他主体读取调用，要求隐藏原主体的记录。 */ () => router.get({ ...principal, id: 'bob' }, c.call_id),
        /call_not_found/
      )
    } finally {
      s.close()
    }
  }
)
test(
  'acceptance fencing, deadlines and cancellation never report native rollback',
  /* 验证 attempt 确认栅栏和截止时间，并确保取消不声称远端动作已回滚。 */ () => {
    let now = 100
    const s = new Store(':memory:', /* 提供可控时钟，准确触发调用截止时间。 */ () => now, { management })
    try {
      const d = connected(s)
      const pending = s.createCall('alice', d.target, { method: 'ping' }, options({ timeoutMs: 10 }))
      const sent = s.createCall('alice', d.target, { method: 'ping' }, options({ timeoutMs: 10 }))
      const b = s.dispatch('alice', sent.call_id, d.epoch)
      assert.throws(
        /* 提交错误 attempt 的接受消息，要求绑定检查拒绝。 */ () => s.accepted({ ...b, attempt_id: 'wrong' }),
        /binding_mismatch/
      )
      s.accepted(b)
      assert.equal(s.call('alice', sent.call_id).state, 'connector_accepted')
      now = 110
      assert.throws(
        /* 尝试派发已到截止时间的调用，要求拒绝。 */ () => s.dispatch('alice', pending.call_id, d.epoch),
        /dispatch_rejected/
      )
      s.expire()
      assert.equal(s.call('alice', pending.call_id).state, 'not_dispatched')
      assert.equal(s.call('alice', sent.call_id).state, 'outcome_unknown')
      const cancel = s.createCall('alice', d.target, { method: 'ping' }, options())
      s.dispatch('alice', cancel.call_id, d.epoch)
      assert.equal(s.stop('alice', cancel.call_id).state, 'outcome_unknown')
    } finally {
      s.close()
    }
  }
)
test(
  'unknown database version is rejected before schema mutation',
  /* 打开未知版本数据库，验证失败前未新增业务表。 */ () => {
    const dir = mkdtempSync(join(tmpdir(), 'rovloom-version-'))
    const path = join(dir, 'db')
    try {
      const db = new DatabaseSync(path)
      db.exec('CREATE TABLE metadata(version INTEGER); INSERT INTO metadata VALUES(999)')
      db.close()
      chmodSync(path, 0o600)
      assert.throws(
        /* 以未来 schema 版本打开数据库，要求在修改 schema 前拒绝。 */ () => new Store(path),
        /unsupported_database_version/
      )
      const check = new DatabaseSync(path)
      assert.deepEqual(
        check
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all()
          .map(/* 提取表名以确认拒绝未知版本时未创建业务表。 */ (r) => r.name),
        ['metadata']
      )
      check.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
