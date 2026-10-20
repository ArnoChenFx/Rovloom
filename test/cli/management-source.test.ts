// 独立管理来源使用真实私有文件/摘要/authority；principal和既有批准均为明确合成fixture。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, statSync, unlinkSync } from 'node:fs'
import { createManagementSessionAuthority } from '../../src/runtime/management-session.js'
import { openCallerSource } from '../../src/cli/caller-source.js'
import { openProtectedManagementSource } from '../../src/cli/management-source.js'
import { managementSourceFixture, mcpProof, managementProof } from './management-source-fixture.js'

test(
  '受保护管理来源只接受独立证明和固定租期，MCP凭据、URL及伪造来源均不升级为管理员',
  /** 页面资源为显式fixture；身份解析、文件保护、摘要与会话authority全部走正式实现。 */ async () => {
    if (process.platform !== 'linux') {
      return
    }
    const f = await managementSourceFixture()
    const source = openProtectedManagementSource(f.config, 'management', {
      now: /** 共用受控测试时钟。 */ () => f.clock.now,
      assets: f.assets
    })
    try {
      const signal = new AbortController().signal
      assert.deepEqual(await source.management.resolveLease(f.request(), signal), f.lease)
      for (const request of [
        f.request('Bearer ' + mcpProof),
        f.request('Basic ' + Buffer.from(f.lease.caller.principal_id + ':' + mcpProof).toString('base64')),
        f.request('Basic malformed'),
        f.request(
          'Basic ' +
            Buffer.from(f.lease.caller.principal_id + ':SYNTHETIC_WRONG_PROOF_'.padEnd(64, 'w')).toString('base64')
        ),
        f.request(undefined, { headers: { origin: 'http://untrusted.invalid' } }),
        f.request(undefined, { headers: { host: 'untrusted.invalid' } }),
        f.request(undefined, { headers: { 'sec-fetch-site': 'cross-site' } }),
        new Request(f.origin + '/?proof=SYNTHETIC_PRIVATE', { headers: { host: new URL(f.origin).host } })
      ]) {
        assert.equal(await source.management.resolveLease(request, signal), null)
      }
      assert.equal(source.administrator({ principal_id: 'other' }, f.lease.management_session_ref), null)
      assert.deepEqual(source.administrator(f.lease.caller, f.lease.management_session_ref), f.admin)
      const cancelled = new AbortController()
      cancelled.abort()
      assert.equal(await source.management.resolveLease(f.request(), cancelled.signal), null)
      f.clock.now = f.lease.expires_at
      assert.equal(await source.management.resolveLease(f.request(), signal), null)
      assert.equal(source.administrator(f.lease.caller, f.lease.management_session_ref), null)
      f.clock.now--
      assert.equal(await source.management.resolveLease(f.request(), signal), null)
    } finally {
      source.close()
      f.close()
    }
  }
)

test(
  '管理来源字段与凭据摘要独立，普通权限不撤销cookie，内容变更或删除仍永久拒绝',
  /** 使用正式caller和authority读取同一文件后端；不注入管理员成功回调。 */ async () => {
    if (process.platform !== 'linux') {
      return
    }
    for (const mutation of ['changed', 'missing'] as const) {
      const f = await managementSourceFixture()
      const source = openProtectedManagementSource(f.config, 'management', { assets: f.assets })
      const caller = openCallerSource(f.callerPath, f.callers.resource, source.administrator)
      const authority = createManagementSessionAuthority(caller.identities)
      source.bindAuthority(authority)
      try {
        const lease = await source.management.resolveLease(f.request(), new AbortController().signal)
        assert(lease)
        const cookie = authority.bootstrap(lease).cookie
        assert(await authority.sessions.resolveCookie(cookie, new AbortController().signal))
        chmodSync(f.sourcePath, 0o644)
        assert(await authority.sessions.resolveCookie(cookie, new AbortController().signal))
        assert.equal(statSync(f.sourcePath).mode & 0o777, 0o644)
        if (mutation === 'changed') {
          f.save(f.sourcePath, { ...f.source, pairing_policy_refs: ['changed'] })
        }
        if (mutation === 'missing') {
          unlinkSync(f.sourcePath)
        }
        assert.equal(await authority.sessions.resolveCookie(cookie, new AbortController().signal), null)
        f.save(f.sourcePath, f.source)
        chmodSync(f.sourcePath, 0o600)
        assert.equal(await authority.sessions.resolveCookie(cookie, new AbortController().signal), null)
        assert.equal(await source.management.resolveLease(f.request(), new AbortController().signal), null)
      } finally {
        source.close()
        authority.close()
        caller.close()
        f.close()
      }
    }
    const f = await managementSourceFixture()
    try {
      f.source.sessions[0]!.credential_sha256 = f.callers.callers[0]!.token_sha256
      f.save(f.sourcePath, f.source)
      assert.throws(
        /** 同一MCP凭据摘要不得兼任独立管理员证明。 */ () =>
          openProtectedManagementSource(f.config, 'management', { assets: f.assets }),
        { code: 'invalid_config' }
      )
    } finally {
      f.close()
    }
  }
)

test(
  '身份批准必须来自当前管理cookie作用域及精确预批准tuple，返回原确认而不自动续期或消费',
  /** 只读取合成批准；持久一次性消费仍由现有IdentityStore负责，本例不签发设备凭据。 */ async () => {
    if (process.platform !== 'linux') {
      return
    }
    const f = await managementSourceFixture()
    const source = openProtectedManagementSource(f.config, 'management', {
      now: /** 与authority一致的测试时钟。 */ () => f.clock.now,
      assets: f.assets
    })
    const caller = openCallerSource(f.callerPath, f.callers.resource, source.administrator)
    const authority = createManagementSessionAuthority(caller.identities, {
      now: /** 不使用客户端时间。 */ () => f.clock.now
    })
    source.bindAuthority(authority)
    const signal = new AbortController().signal
    const intent = {
      action: 'revoke' as const,
      machine_id: f.target.machine_id,
      recovery_generation: 'fixture_generation',
      revision: 2,
      connection_epoch: 'fixture_epoch'
    }
    const approval = {
      actor: f.lease.caller.principal_id,
      confirmation_id: 'fixture_existing_confirmation',
      expires_at: f.clock.now + 30_000
    }
    try {
      f.save(f.approvalPath, {
        schema_version: 1,
        kind: 'identity-approval-source',
        approvals: [
          {
            principal_id: f.lease.caller.principal_id,
            management_session_ref: f.lease.management_session_ref,
            intent,
            approval
          }
        ]
      })
      assert.throws(/** 普通HTTP/MCP调用没有管理cookie作用域。 */ () => source.authorizeIdentity(intent))
      const lease = await source.management.resolveLease(f.request(), signal)
      assert(lease)
      const cookie = authority.bootstrap(lease).cookie
      const approved = await authority.runAuthenticated(
        cookie,
        signal,
        /** 实际作用域直接委托配置中的原批准。 */ () => source.authorizeIdentity(intent)
      )
      assert.deepEqual(approved, approval)
      assert.deepEqual(
        await authority.runAuthenticated(
          cookie,
          signal,
          /** 重读仍返回原确认，不生成新的消费ID。 */ () => source.authorizeIdentity(intent)
        ),
        approval
      )
      for (const patch of [
        { action: 'install' as const },
        { revision: 3 },
        { connection_epoch: 'other_epoch' },
        { recovery_generation: 'other_generation' },
        { machine_id: 'other_machine' }
      ]) {
        await assert.rejects(
          authority.runAuthenticated(
            cookie,
            signal,
            /** 原tuple任何字段变化都不得借用批准。 */ () => source.authorizeIdentity({ ...intent, ...patch })
          )
        )
      }
      f.clock.now = approval.expires_at
      await assert.rejects(
        authority.runAuthenticated(
          cookie,
          signal,
          /** 原批准到期后不依赖会话剩余期限复活。 */ () => source.authorizeIdentity(intent)
        )
      )
      assert.equal(f.source.sessions[0]!.credential_sha256.includes(managementProof), false)
    } finally {
      source.close()
      authority.close()
      caller.close()
      f.close()
    }
  }
)
