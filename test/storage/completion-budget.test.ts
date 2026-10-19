// 验证实际原生校验链路下的完成阶段配额预留、竞争派发及失败提交回滚。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/store.js'
import type { StoreOptions } from '../../src/store.js'
import { nativeBackend } from './native-backend.js'
import { management } from './helpers.js'

/* 创建私有 SQLite 测试库、原生适配器和只读检查连接，并提供统一清理入口。 */ function fixture(
  overrides: StoreOptions = {}
) {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-completion-budget-'))
  const path = join(root, 'db')
  const store = new Store(path, /* 提供固定测试时钟，避免配额和事务断言受真实时间影响。 */ () => 100, {
    management,
    ...overrides
  })
  const native = nativeBackend(store)
  const inspect = new DatabaseSync(path, { readOnly: true })
  return {
    store,
    native,
    inspect,
    // 先关闭检查连接和存储写者，再删除本次测试的临时目录。
    close() {
      inspect.close()
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}
/* 汇总审计行序列化后的字节数，供配额上限断言使用。 */ function auditBytes(db: DatabaseSync) {
  return db
    .prepare('SELECT * FROM audit')
    .all()
    .reduce(
      /* 累计每条审计行的 UTF-8 JSON 字节数。 */ (total, row) => total + Buffer.byteLength(JSON.stringify(row)),
      0
    )
}

for (const retention of [{ audit_bytes: 4500 }, { call_metadata_bytes: 2044 }]) {
  test(
    `real native dispatch protects completion subquota ${JSON.stringify(retention)}`,
    /* 验证审计或调用元数据子配额不足时，派发在发送前失败且不留下预留或尝试锚点。 */ () => {
      const f = fixture({ retention })
      try {
        const call = f.native.create()
        assert.throws(
          /* 尝试在完成子配额不足时派发，检查其返回存储降级错误。 */ () => f.native.dispatch(call.call_id),
          /storage_degraded/
        )
        assert.equal(f.native.state.sends, 0)
        const stored = f.inspect
          .prepare('SELECT state,reserved,attempt_id FROM calls WHERE call_id=?')
          .get(call.call_id)!
        assert.equal(stored.state, 'created')
        assert.equal(stored.reserved, 0)
        assert.equal(stored.attempt_id, null)
      } finally {
        f.close()
      }
    }
  )
}

for (const retention of [{ audit_bytes: 14_000 }, { call_metadata_bytes: 4100 }]) {
  test(
    `serialized competing dispatches cannot reuse subquota ${JSON.stringify(retention)}`,
    /* 验证串行提交的竞争派发只能有一次占用完成配额，另一调用保持未派发。 */ async () => {
      const f = fixture({ retention })
      try {
        const first = f.native.create()
        const second = f.native.create()
        const results = await Promise.allSettled(
          [first, second].map(
            /* 把每个调用排入微任务竞争，收集各自的派发成功或拒绝结果。 */ (call) =>
              Promise.resolve().then(
                /* 在微任务中尝试派发当前调用，以竞争同一完成子配额。 */ () => f.native.dispatch(call.call_id)
              )
          )
        )
        assert.equal(
          results.filter(
            /* 筛选成功派发的结果，断言竞争者中只有一个获准执行。 */ (result) => result.status === 'fulfilled'
          ).length,
          1
        )
        assert.equal(f.native.state.sends, 1)
        assert.equal(
          f.inspect.prepare('SELECT SUM(reserved) n FROM calls').get()!.n,
          f.store.limits.attempt_reserve_bytes
        )
        assert.equal(f.inspect.prepare("SELECT COUNT(*) n FROM calls WHERE state='created'").get()!.n, 1)
        assert(auditBytes(f.inspect) <= f.store.limits.audit_bytes)
      } finally {
        f.close()
      }
    }
  )
}
for (const retention of [{ audit_bytes: 18_000 }, { call_metadata_bytes: 4500 }]) {
  test(
    `accepted and terminal commits release only their own subquota ${JSON.stringify(retention)}`,
    /* 验证接收和终结提交只释放所属调用的预留，随后另一调用仍能正常完成。 */ () => {
      const f = fixture({ retention })
      try {
        const first = f.native.create()
        const second = f.native.create()
        const binding = f.native.dispatch(first.call_id)
        f.store.accepted(binding)
        f.store.stop('synthetic', first.call_id)
        assert.equal(f.native.respond(binding).state, 'responded')
        assert.equal(f.inspect.prepare('SELECT reserved FROM calls WHERE call_id=?').get(first.call_id)!.reserved, 0)
        const next = f.native.dispatch(second.call_id)
        assert.equal(f.native.respond(next).state, 'responded')
        assert.equal(f.native.state.sends, 2)
        assert.equal(f.inspect.prepare('SELECT SUM(reserved) n FROM calls').get()!.n, 0)
        assert(auditBytes(f.inspect) <= f.store.limits.audit_bytes)
      } finally {
        f.close()
      }
    }
  )
}

test(
  'failed evidence commit preserves both outstanding obligations and cannot free another dispatch slot',
  /* 验证证据提交失败会回滚状态和审计，同时保留两个在途尝试各自的完成义务。 */ () => {
    let fail = false
    const f = fixture({
      fault: /* 按开关注入证据提交故障，模拟存储写入失败并测试事务回滚。 */ (point) => {
        if (fail && point === 'evidence_commit') {
          throw Error('synthetic write failure')
        }
      }
    })
    try {
      const first = f.native.create()
      const second = f.native.create()
      const a = f.native.dispatch(first.call_id)
      const b = f.native.dispatch(second.call_id)
      const before = f.inspect.prepare('SELECT call_id,state,reserved FROM calls ORDER BY call_id').all()
      const auditBefore = f.inspect.prepare('SELECT COUNT(*) n FROM audit').get()!.n
      fail = true
      assert.throws(
        /* 在故障开启时提交首个响应，检查错误不会释放任何未完成尝试的预留。 */ () => f.native.respond(a),
        /storage_degraded/
      )
      assert.deepEqual(f.inspect.prepare('SELECT call_id,state,reserved FROM calls ORDER BY call_id').all(), before)
      assert.equal(f.inspect.prepare('SELECT COUNT(*) n FROM audit').get()!.n, auditBefore)
      fail = false
      f.store.resumeStorage()
      f.native.respond(a)
      assert.equal(
        f.inspect.prepare('SELECT reserved FROM calls WHERE call_id=?').get(second.call_id)!.reserved,
        f.store.limits.attempt_reserve_bytes
      )
      f.native.respond(b)
      assert.equal(f.inspect.prepare('SELECT SUM(reserved) n FROM calls').get()!.n, 0)
    } finally {
      f.close()
    }
  }
)
