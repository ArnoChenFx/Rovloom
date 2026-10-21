/** 用真实 SQLite、NativeValidator 和原 Wire 上下文验证结果分页、固定期限、当前授权和安全丢弃。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../../../src/store.js'
import type { Principal } from '../../../src/router.js'
import { commitLuvusResponse } from '../../../src/integration/persistence.js'
import { createLuvusResultAccess } from '../../../src/connector/luvus/index.js'
import type { LuvusOriginalRead } from '../../../src/connector/luvus/index.js'
import type { SafetyClassification } from '../../../src/native-contract/index.js'
import { management, responseFrame } from '../../storage/helpers.js'
import { nativeBackend } from '../../storage/native-backend.js'
import { clone } from '../../native-contract/helpers.js'

/** 建立真实隔离账本与原生响应，只读观察连接仅用于核对实际句柄数量。 */
function fixture() {
  const state = { now: 100, available: true }
  const root = mkdtempSync(join(tmpdir(), 'rovloom-luvus-results-'))
  const path = join(root, 'ledger.sqlite')
  const store = new Store(path, /* 返回受控且不可回拨的 Store 时间。 */ () => state.now, {
    management,
    retention: { result_ttl: 10 }
  })
  const inspect = new DatabaseSync(path, { readOnly: true })
  const native = nativeBackend(store)
  const call = native.create()
  const binding = native.dispatch(call.call_id)
  const frame = responseFrame(binding, {
    error: { code: 'synthetic', message: 'preserved', data: { revision: 7, text: '你好🌍'.repeat(8000) } }
  })
  commitLuvusResponse(store, native.adapter, frame)
  const policies = native.backend.policies('synthetic')
  const principal: Principal = {
    id: 'synthetic',
    policy: clone(policies.caller),
    permissions: { discard_response: true }
  }
  const local = clone(policies.local)
  let original: LuvusOriginalRead | undefined = { binding, wire: native.adapter }
  const ports = {
    store,
    localPolicies: /* 返回本用例可撤销的当前本地 ACL，不复用调用者的策略。 */ () => local,
    principal: /* 返回当前测试身份和调用方策略，供每次操作重新快照。 */ () => principal,
    resolveOriginalRead: /* 只返回本次真实登记请求的原 Wire；可模拟已释放的上下文。 */ () =>
      state.available ? original : undefined
  }
  return {
    store,
    native,
    call,
    binding,
    frame,
    principal,
    local,
    state,
    ports,
    access: createLuvusResultAccess(ports),
    /** 在真实保留门禁通过的初始 fixture 阶段预置 Store 句柄，不为 adapter 模拟保留许可。 */
    savedHandle() {
      return store.saveResult('synthetic', call.call_id)
    },
    /** 替换宿主查询结果，仅用于错误或异步 port 的拒绝回归。 */
    context(value: LuvusOriginalRead) {
      original = value
    },
    /** 查询实际 SQLite 句柄数量，检验读取失败不会创建或续期结果。 */
    handles() {
      return Number(inspect.prepare('SELECT COUNT(*) AS n FROM results').get()!.n)
    },
    /** 通过第二个真实连接模拟已提交的句柄维护删除，不改变调用正文或原 Wire。 */
    deleteHandle(resultId: string) {
      const maintenance = new DatabaseSync(path)
      try {
        maintenance.prepare('DELETE FROM results WHERE result_id=?').run(resultId)
      } finally {
        maintenance.close()
      }
    },
    /** 按所有权关闭原 Wire 与测试 Store，避免保留维护计时器或订阅。 */
    close() {
      native.adapter.close()
      inspect.close()
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

test(
  'native error pagination preserves complete bytes, nested data, hash and actual handle expiry',
  /* 把大于一页的多字节原生错误按字节拆开重组，核对每页期限及完整响应字段。 */ (t) => {
    const f = fixture()
    t.after(/* 关闭本用例的原 Wire 和隔离 SQLite。 */ () => f.close())
    const meta = f.savedHandle()
    assert.equal(meta.expires, 110)
    const parts: Buffer[] = []
    let cursor = 0
    while (true) {
      const page = f.access.read(meta.result_id, cursor, 65_535)
      assert.equal(page.expires, meta.expires)
      assert.equal(page.hash, meta.hash)
      assert.equal(page.bytes, meta.bytes)
      parts.push(Buffer.from(page.data, 'base64'))
      cursor = page.next_cursor
      if (page.eof) {
        break
      }
    }
    const all = Buffer.concat(parts)
    assert(parts.length > 1)
    assert.equal(all.length, meta.bytes)
    assert.equal(createHash('sha256').update(all).digest('hex'), meta.hash)
    assert.deepEqual(JSON.parse(all.toString('utf8')), f.frame.payload.native_response)
    assert.equal(f.handles(), 1)
    assert.equal(f.native.state.sends, 1)
  }
)

test(
  'read preserves actual Store expiry and never recreates or extends an expired handle',
  /* 由 fixture 在合法保留阶段预置句柄，证明每页期限固定且 read 不重开到期句柄。 */ (t) => {
    const f = fixture()
    t.after(/* 释放本用例的 Wire 和 SQLite。 */ () => f.close())
    const first = f.savedHandle()
    f.state.now = 105
    assert.equal(f.access.read(first.result_id).expires, first.expires)
    f.state.now = 110
    assert.throws(
      /* 到期句柄必须直接失败，不能转为保存或重发。 */ () => f.access.read(first.result_id),
      /result_not_found/
    )
    assert.equal(f.handles(), 1)
    assert.throws(
      /* 句柄与内容同期限，到期后显式 open 也不能恢复内容或重建句柄。 */ () => f.access.open(f.call.call_id)
    )
    assert.equal(f.native.state.sends, 1)
  }
)

for (const side of ['caller', 'local'] as const) {
  test(
    `result read rechecks current ${side} ACL before every page`,
    /* 在创建句柄后撤销一端权限，证明旧句柄与原派发许可都不能替代当前读取授权。 */ (t) => {
      const f = fixture()
      t.after(/* 释放本用例的 Wire 和 SQLite。 */ () => f.close())
      const meta = f.savedHandle()
      f.access.read(meta.result_id, 0, 7)
      if (side === 'caller') {
        f.principal.policy.grants = []
      } else {
        f.local.grants = []
      }
      assert.throws(
        /* 逐页读取必须拒绝已撤销的精确 provider grant。 */ () => f.access.read(meta.result_id),
        /forbidden/
      )
      assert.throws(/* 已有正文也不能绕过撤权来重新取得句柄。 */ () => f.access.open(f.call.call_id), /forbidden/)
      assert.equal(f.handles(), 1)
    }
  )
}

test(
  'current native source and original Wire context remain mandatory after a handle is issued',
  /* 依次撤销真实原生来源和原上下文，检验 Router ACL 通过仍不足以返回结果页。 */ (t) => {
    const f = fixture()
    t.after(/* 释放本用例的 Wire 和 SQLite。 */ () => f.close())
    const meta = f.savedHandle()
    f.native.state.sourceVerified = false
    assert.throws(/* 来源已撤销时必须拒绝旧句柄的正文读取。 */ () => f.access.read(meta.result_id))
    f.native.state.sourceVerified = true
    f.state.available = false
    assert.throws(
      /* 原上下文缺失时不能从 Store 元数据恢复原生读取许可。 */ () => f.access.read(meta.result_id),
      /result_context_unavailable/
    )
    f.state.available = true
    f.native.adapter.close()
    assert.throws(
      /* 已关闭的原 Wire 必须拒绝读取，不能静默改用新实例。 */ () => f.access.read(meta.result_id),
      /adapter_closed/
    )
  }
)

test(
  'owner and complete original binding cannot be substituted by result parameters or another attempt',
  /* 检查跨主体及被替换的 attempt 均不能借当前句柄取得正文，且不会创建额外结果。 */ (t) => {
    const f = fixture()
    t.after(/* 释放本用例的 Wire 和 SQLite。 */ () => f.close())
    const meta = f.savedHandle()
    f.principal.id = 'other'
    assert.throws(
      /* 相同策略也不授予另一主体读取原调用的权限。 */ () => f.access.read(meta.result_id),
      /call_not_found/
    )
    f.principal.id = 'synthetic'
    f.context({ binding: { ...f.binding, attempt_id: 'wrong_attempt' }, wire: f.native.adapter })
    assert.throws(
      /* 必须用 Store 保存的完整原 binding 复核上下文。 */ () => f.access.read(meta.result_id),
      /attempt_binding_mismatch/
    )
    assert.equal(f.handles(), 1)
  }
)

for (const side of ['caller', 'local'] as const) {
  test(
    `original Wire enforces current native ${side} policy independently of result Router policy`,
    /* 保持结果 Router 的策略可读，仅撤销原 Wire 后端当前策略，证明两个门禁都真实执行。 */ (t) => {
      const f = fixture()
      t.after(/* 释放本用例的 Wire、只读观察连接和 SQLite。 */ () => f.close())
      const meta = f.savedHandle()
      const policies = f.native.backend.policies
      f.native.backend.policies = /* 只撤销真实 NativeWireBackend 的一个当前 grant 集合。 */ (principal) => {
        const current = clone(policies(principal))
        current[side].grants = []
        return current
      }
      assert.throws(
        /* 旧句柄与结果 Router 的 grant 都不能取代原生当前读权限。 */ () => f.access.read(meta.result_id),
        /forbidden/
      )
      assert.equal(f.handles(), 1)
    }
  )
}

test(
  'current native classification is mandatory even when Router policies still allow reading',
  /* 句柄签发后撤销独立分类可信性，不能把存储成功或旧派发许可当作当前秘密边界许可。 */ (t) => {
    const f = fixture()
    t.after(/* 释放本用例的 Wire、只读观察连接和 SQLite。 */ () => f.close())
    const meta = f.savedHandle()
    const authority = f.native.backend.authority
    f.native.backend.authority = /* 返回实际授权上下文并撤销分类来源认证。 */ (...args) => ({
      ...authority(...args),
      classification_source_verified: false
    })
    assert.throws(/* 当前分类不可信时，当前 Router ACL 允许也必须拒绝正文页。 */ () => f.access.read(meta.result_id))
    assert.equal(f.handles(), 1)
  }
)

test(
  'background expiry removes actual handles and content without restoring original read access',
  /* 调用 Store 的真实后台清理，分别核对句柄 TTL 和内容 TTL 到期后的持久状态。 */ (t) => {
    const f = fixture()
    t.after(/* 释放本用例的 Wire、只读观察连接和 SQLite。 */ () => f.close())
    const meta = f.savedHandle()
    f.state.now = 110
    f.store.expire()
    assert.equal(f.handles(), 0)
    assert.throws(/* 后台删除的句柄不能被 read 自动重建。 */ () => f.access.read(meta.result_id), /result_not_found/)
    assert.equal(f.store.call('synthetic', f.call.call_id).response, null)
    assert.throws(/* 内容到期后不能凭仍持有的原 binding 重开结果。 */ () => f.access.open(f.call.call_id))
    assert.equal(f.handles(), 0)
    assert.equal(f.native.state.sends, 1)
  }
)

test(
  'missing original read context fails before creating a durable handle',
  /* 原上下文已释放时，已有 Store 响应也不能产生新的结果访问凭证。 */ (t) => {
    const f = fixture()
    t.after(/* 释放本用例的 Wire、只读观察连接和 SQLite。 */ () => f.close())
    f.state.available = false
    assert.throws(
      /* 缺原生许可时必须先失败，不能先创建再隐藏句柄。 */ () => f.access.open(f.call.call_id),
      /result_context_unavailable/
    )
    assert.equal(f.handles(), 0)
    assert.equal(f.native.state.sends, 1)
  }
)

test(
  'open fails closed without the original Wire retention gate before any handle is created',
  /* 真实 checkResult 不代替独立保留许可；旧宿主缺少该能力时，不创建或模拟句柄。 */ (t) => {
    const f = fixture()
    t.after(/* 释放本用例的 Wire、只读观察连接和 SQLite。 */ () => f.close())
    f.native.adapter.checkResult(f.binding, f.frame.payload.native_response)
    const legacy = { ...f.native.adapter }
    // 仅构造缺 port 的拒绝输入；保留其它真实原 Wire 方法，不模拟保留门禁成功。
    Reflect.deleteProperty(legacy, 'checkResultRetention')
    f.context({ binding: f.binding, wire: legacy })
    assert.throws(
      /* 缺保留能力必须在 Store.saveResult 之前拒绝。 */ () => f.access.open(f.call.call_id),
      /result_retention_context_unavailable/
    )
    assert.equal(f.handles(), 0)
    assert.equal(f.native.state.sends, 1)
  }
)

test(
  'current retention none permits existing-handle read while the actual original retention gate blocks open',
  /* 只撤销当前保留分类，真实读取仍可通过；open 必须由同一原 permit 的真实保留门禁拒绝。 */ (t) => {
    const f = fixture()
    t.after(/* 释放本用例的 Wire、只读观察连接和 SQLite。 */ () => f.close())
    const meta = f.savedHandle()
    const authority = f.native.backend.authority
    f.native.backend.authority = /* 保持身份、读取 grant 和原许可，仅撤销当前继续保留的分类许可。 */ (...args) => {
      const current = clone(authority(...args))
      return {
        ...current,
        classifications: (current.classifications as SafetyClassification[]).map(
          /* 保留同一分类身份和读取边界，仅把当前继续保留条件改为禁止。 */ (classification) => ({
            ...classification,
            result: { ...classification.result, retention: 'none' as const }
          })
        )
      }
    }
    assert.equal(f.access.read(meta.result_id, 0, 7).expires, meta.expires)
    assert.throws(
      /* 独立保留门禁确实运行，不能以 checkResult 成功放行 open。 */ () => f.access.open(f.call.call_id),
      /content_retention_forbidden/
    )
    assert.equal(f.handles(), 1)
    assert.equal(f.native.state.sends, 1)
  }
)

for (const mode of ['promise', 'boolean'] as const) {
  test(
    `invalid ${mode} retention gate cannot create a result handle`,
    /* 仅为负面回归注入无效保留接口，不提供模拟成功的许可或原 permit 替身。 */ async (t) => {
      const f = fixture()
      t.after(/* 释放本用例的 Wire、只读观察连接和 SQLite。 */ () => f.close())
      f.context({
        binding: f.binding,
        wire: {
          ...f.native.adapter,
          checkResultRetention: /* 返回被拒绝的异步值或布尔值，均不是同步完成的独立保留许可。 */ () =>
            mode === 'promise' ? Promise.reject(new Error('synthetic-private-token')) : false
        }
      })
      assert.throws(
        /* 无效保留接口必须在 Store.saveResult 之前终止。 */ () => f.access.open(f.call.call_id),
        /result_port_invalid/
      )
      await Promise.resolve()
      assert.equal(f.handles(), 0)
    }
  )
}

for (const change of ['caller', 'local', 'identity', 'discard'] as const) {
  test(
    `result delivery rechecks ${change} changes made by a synchronous host gate`,
    /* 在原生检查回调内改变可信事实，要求交付前最后一次检查不能使用过时快照。 */ (t) => {
      const f = fixture()
      t.after(/* 释放本用例的 Wire、只读观察连接和 SQLite。 */ () => f.close())
      const meta = f.savedHandle()
      f.context({
        binding: f.binding,
        wire: {
          ...f.native.adapter,
          checkResult: /* 先运行真实原生门禁，再同步撤销一个当前读取条件。 */ (binding, response) => {
            f.native.adapter.checkResult(binding, response)
            if (change === 'caller') {
              f.principal.policy.grants = []
            } else if (change === 'local') {
              f.local.grants = []
            } else if (change === 'identity') {
              f.principal.id = 'other'
            } else {
              f.store.discardResponse('synthetic', f.call.call_id)
            }
          }
        }
      })
      assert.throws(
        /* 已失效的当前事实不能在同步回调返回后继续交付已准备好的正文页。 */ () => f.access.read(meta.result_id)
      )
      assert.equal(f.native.state.sends, 1)
    }
  )
}

for (const change of ['caller', 'identity', 'permission'] as const) {
  test(
    `local policy callback cannot change ${change} during result authorization`,
    /* 在每次本地策略读取的返回边界改变主体事实，检验最后一道 ACL 与专门删除权限。 */ (t) => {
      const f = fixture()
      t.after(/* 释放本用例的 Wire、只读观察连接和 SQLite。 */ () => f.close())
      const meta = f.savedHandle()
      for (const trigger of [1, 2, 3, 4]) {
        f.principal.id = 'synthetic'
        f.principal.policy = clone(f.native.backend.policies('synthetic').caller)
        f.principal.permissions!.discard_response = true
        let reads = 0
        const access = createLuvusResultAccess({
          ...f.ports,
          localPolicies: /* 在指定一次 Router 回调返回前同步撤销主体事实。 */ () => {
            if (++reads === trigger) {
              if (change === 'caller') {
                f.principal.policy.grants = []
              } else if (change === 'identity') {
                f.principal.id = 'other'
              } else {
                f.principal.permissions!.discard_response = false
              }
            }
            return f.local
          }
        })
        if (change === 'permission') {
          if (trigger > 2) {
            continue
          }
          assert.throws(
            /* 两道删除前策略回调均不能使已经撤销的删除权限继续生效。 */ () => access.discard(f.call.call_id)
          )
          assert.notEqual(f.store.call('synthetic', f.call.call_id).response, null)
        } else {
          assert.throws(
            /* 四道读取策略回调任意一次改变身份或 caller grant 都必须拒绝。 */ () => access.read(meta.result_id, 0, 32)
          )
        }
        assert.equal(f.handles(), 1)
      }
      assert.equal(f.native.state.sends, 1)
    }
  )
}

test(
  'discard in final local policy callback blocks the already prepared result page',
  /* 使用真实 Store 在最后一道策略回调中同步丢弃，不能交付回调前准备的正文页。 */ (t) => {
    const f = fixture()
    t.after(/* 释放本用例的原 Wire、只读观察连接和 SQLite。 */ () => f.close())
    const meta = f.savedHandle()
    let reads = 0
    const access = createLuvusResultAccess({
      ...f.ports,
      localPolicies: /* 第四次是最后一道 Router 读取授权，此时主体和 grant 保持不变。 */ () => {
        if (++reads === 4) {
          f.store.discardResponse(f.principal.id, f.call.call_id)
        }
        return f.local
      }
    })
    assert.throws(
      /* 即使策略仍允许，正文及句柄已经丢弃就必须终止交付。 */ () => access.read(meta.result_id, 0, 32),
      /result_not_ready/
    )
    assert.equal(reads, 4)
    assert.equal(f.store.call(f.principal.id, f.call.call_id).response, null)
    assert.equal(f.handles(), 0)
    assert.equal(f.native.state.sends, 1)
  }
)

for (const change of ['handle_delete', 'handle_expiry', 'content_expiry'] as const) {
  test(
    `final local policy ${change} invalidation prevents delivery of a prepared page`,
    /* 在最后一道策略回调中实际删除或到期，要求重新核对正文状态与实际句柄行。 */ (t) => {
      const f = fixture()
      t.after(/* 释放本用例的原 Wire、只读观察连接和 SQLite。 */ () => f.close())
      const meta = f.savedHandle()
      let reads = 0
      const access = createLuvusResultAccess({
        ...f.ports,
        localPolicies: /* 保持当前身份及双方 ACL，仅提交本用例的实际清理或时间变化。 */ () => {
          if (++reads === 4) {
            if (change === 'handle_delete') {
              f.deleteHandle(meta.result_id)
            } else {
              f.state.now = change === 'handle_expiry' ? 110 : 130
              f.store.expire()
            }
          }
          return f.local
        }
      })
      assert.throws(
        /* 旧页不是有效交付证据，实际句柄或内容已失效就必须拒绝。 */ () => access.read(meta.result_id, 0, 32),
        /result_not_found|result_not_ready/
      )
      assert.equal(reads, 4)
      assert.equal(f.handles(), 0)
      assert.equal(f.store.call(f.principal.id, f.call.call_id).response === null, change !== 'handle_delete')
      assert.equal(f.native.state.sends, 1)
    }
  )
}

for (const change of [
  'wire_close',
  'wire_release',
  'source',
  'native_caller',
  'native_local',
  'classification',
  'context'
] as const) {
  test(
    `final local policy ${change} invalidation requires a fresh original Wire gate`,
    /* 保持 Store 正文、句柄和结果 Router ACL 有效，仅在最后策略回调失效原生读取事实。 */ (t) => {
      const f = fixture()
      t.after(/* 释放本用例的原 Wire、只读观察连接和 SQLite。 */ () => f.close())
      const meta = f.savedHandle()
      let reads = 0
      const access = createLuvusResultAccess({
        ...f.ports,
        localPolicies: /* 第四次回调后不能再使用之前已成功的原生读取许可。 */ () => {
          if (++reads === 4) {
            if (change === 'wire_close') {
              f.native.adapter.close()
            } else if (change === 'wire_release') {
              f.native.adapter.release(f.binding)
            } else if (change === 'source') {
              f.native.state.sourceVerified = false
            } else if (change === 'context') {
              f.state.available = false
            } else if (change === 'classification') {
              const authority = f.native.backend.authority
              f.native.backend.authority = /* 仅撤销实际 Native 后端当前分类的来源可信性。 */ (...args) => ({
                ...authority(...args),
                classification_source_verified: false
              })
            } else {
              const policies = f.native.backend.policies
              f.native.backend.policies = /* 仅撤销原生一端的读取权，结果 Router 使用原先独立策略。 */ (...args) => {
                const current = clone(policies(...args))
                current[change === 'native_caller' ? 'caller' : 'local'].grants = []
                return current
              }
            }
          }
          return f.local
        }
      })
      assert.throws(
        /* 实际页仍在也不能取代已经失效的原 Wire、来源、分类或当前 native read grant。 */ () =>
          access.read(meta.result_id, 0, 32)
      )
      assert.equal(reads, 4)
      assert.notEqual(f.store.call(f.principal.id, f.call.call_id).response, null)
      assert.equal(f.handles(), 1)
      assert.equal(f.native.state.sends, 1)
    }
  )
}

for (const change of ['caller', 'local', 'identity', 'discard'] as const) {
  test(
    `late native gate ${change} changes cannot invalidate the final authorization silently`,
    /* 在末次原生门禁返回边界改变当前主体、活本地策略或内容，不能用重排门禁重新引入旧窗口。 */ (t) => {
      const f = fixture()
      t.after(/* 释放本用例的原 Wire、只读观察连接和 SQLite。 */ () => f.close())
      const meta = f.savedHandle()
      let checks = 0
      f.context({
        binding: f.binding,
        wire: {
          ...f.native.adapter,
          checkResult: /* 先执行真实原生检查，仅在第二次调用时注入当前事实变化。 */ (binding, frame) => {
            f.native.adapter.checkResult(binding, frame)
            if (++checks === 2) {
              if (change === 'caller') {
                f.principal.policy.grants = []
              } else if (change === 'local') {
                f.local.grants = []
              } else if (change === 'identity') {
                f.principal.id = 'other'
              } else {
                f.store.discardResponse('synthetic', f.call.call_id)
              }
            }
          }
        }
      })
      assert.throws(
        /* 原生门禁之后同步检查主体、活策略快照和实际正文，禁止交付已撤销的数据。 */ () =>
          f.access.read(meta.result_id, 0, 32)
      )
      assert.equal(checks, 2)
      assert.equal(f.native.state.sends, 1)
    }
  )
}

test(
  'result cursor and page budget stay bounded and never create another handle',
  /* 页大小和游标直接受现有 Store 字节规则约束，不能用无效参数扩大读取或触发重新执行。 */ (t) => {
    const f = fixture()
    t.after(/* 释放本用例的 Wire、只读观察连接和 SQLite。 */ () => f.close())
    const meta = f.savedHandle()
    for (const [cursor, maxBytes] of [
      [-1, 1],
      [0.5, 1],
      [meta.bytes + 1, 1],
      [0, 0],
      [0, 65_537],
      [0, Infinity]
    ]) {
      assert.throws(
        /* 每个越界组合必须按 Store 的既有规则拒绝。 */ () => f.access.read(meta.result_id, cursor, maxBytes),
        /invalid_result_cursor/
      )
    }
    const end = f.access.read(meta.result_id, meta.bytes, 1)
    assert.equal(end.eof, true)
    assert.equal(end.data, '')
    assert.equal(end.next_cursor, meta.bytes)
    assert.equal(f.handles(), 1)
    assert.equal(f.native.state.sends, 1)
  }
)

test(
  'asynchronous native gate is rejected without exposing a page or leaking a late error',
  /* 模拟误接异步授权，要求同步失败并消费晚到拒绝，不能把 Promise 当已完成许可。 */ async (t) => {
    const f = fixture()
    t.after(/* 释放本用例的 Wire 和 SQLite。 */ () => f.close())
    const meta = f.savedHandle()
    f.context({
      binding: f.binding,
      wire: {
        ...f.native.adapter,
        checkResult: /* 返回故意拒绝的异步授权，检验公开错误不回显合成敏感内容。 */ async () => {
          throw new Error('synthetic-private-token')
        }
      }
    })
    assert.throws(
      /* 异步 gate 不是授权成功，必须在结果页交付前拒绝。 */ () => f.access.read(meta.result_id),
      /result_port_invalid/
    )
    await Promise.resolve()
  }
)

for (const port of ['principal', 'localPolicies', 'resolveOriginalRead'] as const) {
  test(
    `asynchronous ${port} port fails closed and consumes its rejected promise`,
    /* 将同步宿主接口故意误接为异步拒绝，检验没有正文交付或未处理的晚到拒绝。 */ async (t) => {
      const f = fixture()
      t.after(/* 释放本用例的 Wire、只读观察连接和 SQLite。 */ () => f.close())
      const meta = f.savedHandle()
      const access = createLuvusResultAccess({
        ...f.ports,
        [port]: /* 仅用于负面测试的异步 port，不返回可用授权或元数据。 */ async () => {
          throw new Error('synthetic-private-token')
        }
      } as unknown as Parameters<typeof createLuvusResultAccess>[0])
      assert.throws(
        /* Promise 不构成完整同步授权，不能向上返回已准备的结果页。 */ () => access.read(meta.result_id),
        /result_port_invalid/
      )
      await Promise.resolve()
      assert.equal(f.handles(), 1)
    }
  )
}

test(
  'discard uses current ACL and independent permission without requiring a live execution context',
  /* 证明显式丢弃不是读取或派发旁路；原上下文回收不妨碍仍获专门授权的安全清理。 */ (t) => {
    const f = fixture()
    t.after(/* 释放本用例的 Wire 和 SQLite。 */ () => f.close())
    const meta = f.savedHandle()
    f.state.available = false
    f.principal.permissions!.discard_response = false
    assert.throws(/* 缺专门删除权限时保留正文和句柄。 */ () => f.access.discard(f.call.call_id), /discard_forbidden/)
    assert.equal(f.handles(), 1)
    f.principal.permissions!.discard_response = true
    f.local.grants = []
    assert.throws(/* 专门权限也不能绕过已撤销的当前本地 ACL。 */ () => f.access.discard(f.call.call_id), /forbidden/)
    f.local.grants = clone(f.native.backend.policies('synthetic').local.grants)
    f.access.discard(f.call.call_id)
    assert.equal(f.handles(), 0)
    assert.equal(f.store.call('synthetic', f.call.call_id).response, null)
    assert.throws(/* 丢弃后旧句柄不能重新暴露正文。 */ () => f.access.read(meta.result_id), /result_not_found/)
    assert.equal(f.native.state.sends, 1)
  }
)
