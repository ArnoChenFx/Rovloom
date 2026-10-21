// 独立管理来源使用真实私有文件/摘要/authority；principal和既有批准均为明确合成fixture。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, statSync, unlinkSync } from 'node:fs'
import { createManagementSessionAuthority } from '../../src/runtime/management-session.js'
import { openCallerSource } from '../../src/cli/caller-source.js'
import { openProtectedManagementSource } from '../../src/cli/management-source.js'
import { managementSourceFixture, mcpProof } from './management-source-fixture.js'

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
