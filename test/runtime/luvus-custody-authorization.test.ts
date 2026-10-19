// 核对实际管理 session 与独立本机 custody grant 的交集；文件/原生发行由专门隔离回归覆盖。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createManagementSessionAuthority } from '../../src/runtime/management-session.js'
import { createLuvusCustodyAuthorizer } from '../../src/runtime/luvus-custody-authorization.js'
import type { LuvusCustodyGrant } from '../../src/runtime/luvus-custody-authorization.js'
import type {
  NativeCustodyApproval,
  NativeCustodyApprovalWriter,
  NativeCustodyDecision,
  NativeCustodyIntent
} from '../../src/runtime/native-custody.js'
import { setup } from '../admin/write-helpers.js'

/** 只构造自有短期管理员和批准调用计数，不伪装实际 opaque native 或持久消费。 */
function fixture() {
  const management = setup()
  let now = 1000
  const sessions = createManagementSessionAuthority(management.identities, {
    now: /** 会话时钟与审批时钟固定一致。 */ () => now
  })
  const bootstrap = sessions.bootstrap({
    caller: { principal_id: 'fixture_admin' },
    management_session_ref: 'fixture_session',
    issued_at: now,
    expires_at: now + 100_000
  })
  const intent: NativeCustodyIntent = {
    root_id: 'root1',
    root_revision: 1,
    config_ref: 'config1',
    config_digest: 'a'.repeat(64),
    server_generation: 'generation1',
    scopes: ['read', 'orchestration'],
    methods: ['task.add'],
    token_ttl_s: 60
  }
  const grant: LuvusCustodyGrant = {
    action: 'issue_restricted_delegation',
    principal_id: 'fixture_admin',
    ...intent,
    max_token_ttl_s: 60,
    expires_at: now + 5000
  }
  let grants: readonly LuvusCustodyGrant[] = [grant]
  const decisions: NativeCustodyDecision[] = []
  let duringApprove: (() => void) | undefined
  let duringPolicy: (() => void) | undefined
  const proof = Object.freeze({}) as NativeCustodyApproval
  const approvals: NativeCustodyApprovalWriter = {
    /** 本测试仅检查可信桥何时调用 writer；此合成值不能通过生产消费的 WeakMap。 */
    approve(_intent, decision) {
      decisions.push(decision)
      duringApprove?.()
      return proof
    },
    /** 不模拟文件读取或允许从字符串构造生产批准。 */
    read() {
      throw new Error('unused_test_read')
    },
    /** 没有 native 或持久文件需要回收。 */ close() {}
  }
  const authorize = createLuvusCustodyAuthorizer({
    sessions,
    approvals,
    grants: /** 本机政策可独立撤销，与普通管理 grants 分离。 */ () => {
      duringPolicy?.()
      return grants
    },
    now: /** 同一合成时钟只用于严格截止断言。 */ () => now
  })
  return {
    management,
    sessions,
    bootstrap,
    intent,
    grant,
    authorize,
    proof,
    decisions,
    /** 显式更改独立本机政策，不改变管理员或 provider 权限。 */ set grants(value: readonly LuvusCustodyGrant[]) {
      grants = value
    },
    /** 模拟审批文件检查期间的同步撤销。 */ set duringApprove(value: (() => void) | undefined) {
      duringApprove = value
    },
    /** 模拟政策来源回调期间的同步撤销。 */ set duringPolicy(value: (() => void) | undefined) {
      duringPolicy = value
    },
    /** 只推进自有时钟。 */ set now(value: number) {
      now = value
    },
    /** 回收自有管理会话与临时 Store。 */ close() {
      sessions.close()
      management.close()
    }
  }
}

test(
  'native custody approval requires the active real management scope and exact independent grant',
  /** 真实 session 只提供身份，独立 native grant 才允许这个精确有限发行。 */ async () => {
    const f = fixture()
    try {
      assert.throws(/** 请求外没有管理员来源。 */ () => f.authorize(f.intent), /unauthenticated/)
      const result = await f.sessions.runAuthenticated(
        f.bootstrap.cookie,
        new AbortController().signal,
        /** 产品显式动作内才允许创建一次批准。 */ () => f.authorize(f.intent)
      )
      assert.equal(result, f.proof)
      assert.equal(f.decisions.length, 1)
      assert.equal(f.decisions[0]?.actor, 'fixture_admin')
      assert.equal(f.decisions[0]?.expires_at, 6000)
      assert.notEqual(f.decisions[0]?.confirmation_id, '')
    } finally {
      f.close()
    }
  }
)

test(
  'providers_manage and grants with mismatched target, generation, scope or TTL cannot issue custody',
  /** 不把不同 native grants 拼接，也不把普通管理能力转换成发行权限。 */ async () => {
    const f = fixture()
    try {
      f.management.grant({ action: 'providers_manage', machine_id: 'machine1', provider_id: 'provider1' })
      const variants: readonly LuvusCustodyGrant[][] = [
        [],
        [{ ...f.grant, root_revision: 2 }],
        [{ ...f.grant, server_generation: 'generation2' }],
        [{ ...f.grant, config_digest: 'b'.repeat(64) }],
        [{ ...f.grant, max_token_ttl_s: 59 }],
        [{ ...f.grant, expires_at: 1000 }],
        [
          { ...f.grant, scopes: ['read'] },
          { ...f.grant, methods: ['automation.list'] }
        ]
      ]
      for (const grants of variants) {
        f.grants = grants
        await assert.rejects(
          f.sessions.runAuthenticated(
            f.bootstrap.cookie,
            new AbortController().signal,
            /** 每次都在有效管理员请求内，仍须当前独立完整 grant。 */ () => f.authorize(f.intent)
          ),
          /native_custody_forbidden/
        )
      }
      assert.equal(f.decisions.length, 0)
    } finally {
      f.close()
    }
  }
)

test(
  'native custody bridge fences synchronous session revocation before and after approval persistence',
  /** 政策与 writer 回调均不能用先前身份快照越过撤销；已经落盘也不向发行返回批准。 */ async () => {
    const policy = fixture()
    try {
      policy.duringPolicy = /** 政策回调立即使实际管理员来源失效。 */ () => {
        policy.management.admin = null
      }
      await assert.rejects(
        policy.sessions.runAuthenticated(
          policy.bootstrap.cookie,
          new AbortController().signal,
          /** 本次不得创建批准。 */ () => policy.authorize(policy.intent)
        ),
        /unauthenticated/
      )
      assert.equal(policy.decisions.length, 0)
    } finally {
      policy.close()
    }
    const writer = fixture()
    try {
      writer.duringApprove = /** 模拟 writer 时钟/文件检查回调触发撤销。 */ () => {
        writer.management.admin = null
      }
      await assert.rejects(
        writer.sessions.runAuthenticated(
          writer.bootstrap.cookie,
          new AbortController().signal,
          /** 批准已落盘仍须最终会话 fence，不能开始发行。 */ () => writer.authorize(writer.intent)
        ),
        /unauthenticated/
      )
      assert.equal(writer.decisions.length, 1)
    } finally {
      writer.close()
    }
  }
)
