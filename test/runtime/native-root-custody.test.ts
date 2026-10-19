/** 用合成受保护记录验证 Luvus root 与一次批准文件；不启动 native，不读取真实凭据或发行 token。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boundedJson } from '../../src/wire/index.js'
import { LuvusAdapterError } from '../../src/connector/luvus/types.js'
import type { LuvusLocalConfig } from '../../src/connector/luvus/types.js'
import { FIXED_LUVUS_SHA256 } from '../../src/runtime/native-control.js'
import { ownedPathStamp } from '../../src/runtime/native-process.js'
import { createNativeRecord } from '../../src/runtime/native-record-files.js'
import {
  assertManagedRoot,
  claimManagedRoot,
  initializeManagedLuvusRoot,
  openManagedLuvusRoot
} from '../../src/runtime/native-root.js'
import type { ManagedLuvusRoot } from '../../src/runtime/native-root.js'
import { consumeNativeCustodyApproval, openNativeCustodyApprovals } from '../../src/runtime/native-custody.js'
import type {
  NativeCustodyApproval,
  NativeCustodyApprovalWriter,
  NativeCustodyIntent
} from '../../src/runtime/native-custody.js'
import { assertRestrictedLuvusCustody, startManagedLuvus } from '../../src/runtime/native-source.js'
import type { RestrictedLuvusCustody } from '../../src/runtime/native-source.js'

/** 合成配置记录只证明文件边界，假 binary 的字节不匹配会阻止真实 source 启动。 */
function fixture(maximum = 8) {
  const directory = mkdtempSync(
    join(process.env.LUVUS_TEST_ROOT ?? fileURLToPath(new URL('../../', import.meta.url)), '.managed-native-')
  )
  const home = join(directory, 'home')
  const state = join(directory, 'state')
  const cwd = join(directory, 'project')
  const control = join(directory, 'control')
  const approvalDirectory = join(control, 'approvals')
  const directories = [
    state,
    home,
    cwd,
    ...['config', 'data', 'cache', 'runtime'].map(/* 固定合成 XDG 空白目录。 */ (name) => join(home, name))
  ]
  for (const path of [...directories.slice(0, 3), control, approvalDirectory, ...directories.slice(3)]) {
    mkdirSync(path, { mode: 0o700 })
  }
  const binary = join(directory, 'untrusted-binary')
  writeFileSync(binary, '#!/bin/sh\nexit 99\n', { mode: 0o500 })
  const config: LuvusLocalConfig = {
    target: { machine_id: 'machine1', provider_id: 'provider1', profile: 'session', session: 'session1' },
    binding_revision: 1,
    config_ref: 'config1',
    binary,
    binary_sha256: FIXED_LUVUS_SHA256,
    state_root: state,
    home,
    cwd,
    transport: 'ipc'
  }
  const policy = {
    scopes: ['read', 'orchestration'] as const,
    methods: ['automation.list', 'task.add', 'task.update'],
    max_token_ttl_s: 120
  }
  const recordPath = join(control, 'root.json')
  const digest = createHash('sha256').update(boundedJson(config)).digest('hex')
  createNativeRecord(recordPath, {
    format: 'rovloom-luvus-root-v1',
    root_id: 'root1',
    root_revision: 1,
    config,
    config_digest: digest,
    custody_policy: policy,
    roots: directories.map(
      /* 记录真实合成目录的保护事实，不捏造运行实例。 */ (path) => [path, ownedPathStamp(path, 'directory')]
    ),
    created_at: 100_000
  })
  const root = openManagedLuvusRoot({ record_path: recordPath, expected_root_id: 'root1', expected_root_revision: 1 })
  let now = 100_000
  let writer: NativeCustodyApprovalWriter | undefined
  /** writer 只使用本测试的固定受保护目录和独立可控时钟。 */
  function open() {
    writer = openNativeCustodyApprovals(root, {
      directory: approvalDirectory,
      max_entries: maximum,
      /* 合成时钟只供文件边界回归，不证明真实 native 签发时间。 */ now: () => now
    })
    return writer
  }
  const intent: NativeCustodyIntent = {
    root_id: root.root_id,
    root_revision: root.root_revision,
    config_ref: config.config_ref,
    config_digest: root.config_digest,
    server_generation: 'generation1',
    scopes: ['read'],
    methods: ['automation.list'],
    token_ttl_s: 60
  }
  return {
    directory,
    config,
    policy,
    recordPath,
    root,
    intent,
    approvalDirectory,
    open,
    /** 仅显式测试操作可改变独立时钟。 */ setNow(value: number) {
      now = value
    },
    /** 创建短期合成审计决策，权限仍不是 actor 字符串或随机 ID 本身。 */ decision() {
      return { actor: 'admin1', confirmation_id: 'confirmation1', expires_at: now + 10_000 }
    },
    /** 没有真实 child，测试只清理自己创建的文件树。 */ close() {
      writer?.close()
      root.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

/** 校验安全固定错误，未知底层路径/内容不得进入错误 message。 */
function failure(code?: string) {
  return /* 只接纳 adapter 安全错误类型并核对公开 message。 */ (error: unknown) => {
    assert(error instanceof LuvusAdapterError)
    if (code) {
      assert.equal(error.code, code)
    }
    assert.equal(error.message, error.code)
    return true
  }
}

test(
  'managed root reopens persistent contents but a JSON clone cannot become its opaque source',
  /** 持模块登记记录可重开同一目录，业务内容不会被读取或当作启动许可。 */ () => {
    const f = fixture()
    try {
      writeFileSync(join(f.config.state_root, 'synthetic-persistent-content'), 'test-only', { mode: 0o600 })
      const reopened = openManagedLuvusRoot({
        record_path: f.recordPath,
        expected_root_id: 'root1',
        expected_root_revision: 1
      })
      assertManagedRoot(reopened)
      assert.equal(reopened.config_digest, f.root.config_digest)
      assert.throws(
        /* 同形 JSON 只保留元数据，不保留 WeakMap 来源。 */ () =>
          assertManagedRoot(JSON.parse(JSON.stringify(reopened)) as ManagedLuvusRoot),
        failure('native_root_unavailable')
      )
      reopened.close()
      assert.throws(
        /* close 使该记录句柄永久失效。 */ () => assertManagedRoot(reopened),
        failure('native_root_unavailable')
      )
    } finally {
      f.close()
    }
  }
)

test(
  'managed root initialization refuses preexisting contents and mismatched installed bytes',
  /** 首次入口不能接管用户目录；字节不符也不创建可启动记录。 */ async () => {
    const f = fixture()
    try {
      const record = join(f.directory, 'control', 'new-root.json')
      await assert.rejects(
        initializeManagedLuvusRoot({ record_path: record, config: f.config, custody_policy: f.policy }),
        failure('binary_identity_changed')
      )
      assert.equal(existsSync(record), false)
      writeFileSync(join(f.config.home, 'existing-config'), 'test-only', { mode: 0o600 })
      await assert.rejects(
        initializeManagedLuvusRoot({ record_path: record, config: f.config, custody_policy: f.policy }),
        failure('native_root_not_blank')
      )
      assert.equal(existsSync(record), false)
    } finally {
      f.close()
    }
  }
)

test(
  'managed root owner lock is exclusive and failed installation does not leave an unowned lock',
  /** 排他锁不含 PID；真正启动前 binary 字节失败时才可安全移除本轮锁。 */ async () => {
    const f = fixture()
    try {
      const owner = claimManagedRoot(f.root)
      assert.throws(
        /* 第二拥有者不能接管现有或遗留锁。 */ () => claimManagedRoot(f.root),
        failure('native_record_create_failed')
      )
      owner.assert()
      owner.release()
      await assert.rejects(startManagedLuvus(f.root), failure('binary_identity_changed'))
      assert.equal(existsSync(f.recordPath + '.owner.lock'), false)
      assertManagedRoot(f.root)
    } finally {
      f.close()
    }
  }
)

test(
  'managed root and approval files reject permission changes instead of trusting stored metadata',
  /** 文件保护事实每次重新核验，旧 handle 不允许绕过 chmod 或内容变化。 */ () => {
    const f = fixture()
    try {
      chmodSync(f.recordPath, 0o644)
      assert.throws(
        /* 真实模式改变立即撤销来源。 */ () => assertManagedRoot(f.root),
        failure('native_record_untrusted')
      )
      chmodSync(f.recordPath, 0o600)
    } finally {
      f.root.close()
      rmSync(f.directory, { recursive: true, force: true })
    }
  }
)

test(
  'Luvus custody approval is opaque, exact and durably consumed once across writer reopen',
  /** 真实保护文件与持久墓碑共同阻止同形 JSON、第二 handle 和重开后的重放。 */ () => {
    const f = fixture()
    try {
      const writer = f.open()
      const approval = writer.approve(f.intent, f.decision())
      assert.throws(
        /* JSON 不能重建批准能力。 */ () =>
          consumeNativeCustodyApproval(f.root, f.intent, JSON.parse(JSON.stringify(approval)) as NativeCustodyApproval),
        failure('native_custody_approval_untrusted')
      )
      const result = consumeNativeCustodyApproval(f.root, f.intent, approval)
      assert.equal(result.actor, 'admin1')
      assert.equal(result.approval_id, approval.approval_id)
      assert.throws(
        /* 第二 opaque handle 仍受同一持久消费墓碑限制。 */ () =>
          consumeNativeCustodyApproval(f.root, f.intent, writer.read(approval.approval_id)),
        failure('native_record_create_failed')
      )
      writer.close()
      const reopened = f.open()
      assert.throws(
        /* 重开 writer 也不删除或续期消费墓碑。 */ () =>
          consumeNativeCustodyApproval(f.root, f.intent, reopened.read(approval.approval_id)),
        failure('native_record_create_failed')
      )
    } finally {
      f.close()
    }
  }
)

test(
  'Luvus custody approval pins native generation and exact scopes, methods and TTL',
  /** 任一批准轴变化都在创建墓碑或 native 写入前拒绝，正确原 intent 仍可一次消费。 */ () => {
    const f = fixture()
    try {
      const writer = f.open()
      const approval = writer.approve(f.intent, f.decision())
      for (const change of [
        { server_generation: 'generation2' },
        { token_ttl_s: 61 },
        { scopes: ['read', 'orchestration'] },
        { methods: ['task.add'], scopes: ['read', 'orchestration'] }
      ]) {
        assert.throws(
          /* 不相同的原生 epoch 或权限不能借用同一个批准引用。 */ () =>
            consumeNativeCustodyApproval(f.root, { ...f.intent, ...change } as NativeCustodyIntent, approval),
          failure('native_custody_approval_mismatch')
        )
      }
      consumeNativeCustodyApproval(f.root, f.intent, approval)
    } finally {
      f.close()
    }
  }
)

test(
  'Luvus custody approval rejects unknown methods, broad scopes, oversized TTL and long confirmation windows',
  /** 独立批准 writer 不从 actor、方法 read 标签或 providers_manage 推导权限。 */ () => {
    const f = fixture()
    try {
      const writer = f.open()
      for (const change of [
        { scopes: ['all'] },
        { methods: ['task.next'] },
        { methods: ['task.*'] },
        { token_ttl_s: 121 }
      ]) {
        assert.throws(
          /* 超过固定受保护 root policy 的请求全部拒绝。 */ () =>
            writer.approve({ ...f.intent, ...change } as NativeCustodyIntent, f.decision()),
          failure()
        )
      }
      assert.throws(
        /* 审批窗口与 token TTL 分开，上限一分钟。 */ () =>
          writer.approve(f.intent, { ...f.decision(), expires_at: 160_001 }),
        failure('native_custody_approval_expired')
      )
      assert.deepEqual(readdirSync(f.approvalDirectory), ['.writer.lock'])
    } finally {
      f.close()
    }
  }
)

test(
  'Luvus custody approval expiry is fixed and read cannot renew its decision',
  /** 读取和新建 handle 都不能延长原批准，正好到期即拒绝。 */ () => {
    const f = fixture()
    try {
      const writer = f.open()
      const approval = writer.approve(f.intent, f.decision())
      f.setNow(109_999)
      writer.read(approval.approval_id)
      f.setNow(110_000)
      assert.throws(
        /* 原引用固定截止，不随上次读取续期。 */ () => consumeNativeCustodyApproval(f.root, f.intent, approval),
        failure('native_custody_approval_mismatch')
      )
      assert.throws(
        /* 新引用也不能恢复已过期的原批准。 */ () => writer.read(approval.approval_id),
        failure('native_custody_approval_expired')
      )
    } finally {
      f.close()
    }
  }
)

test(
  'Luvus custody approval quota keeps consumed records and refuses silent tombstone eviction',
  /** 独立记录配额满后拒绝，不以过期/消费为由删安全证据重新发行。 */ () => {
    const f = fixture(1)
    try {
      const writer = f.open()
      const approval = writer.approve(f.intent, f.decision())
      consumeNativeCustodyApproval(f.root, f.intent, approval)
      assert.throws(
        /* 消费不回收一次批准的持久安全份额。 */ () => writer.approve(f.intent, f.decision()),
        failure('native_custody_approval_limit')
      )
    } finally {
      f.close()
    }
  }
)

test(
  'managed provider custody assertion rejects flags and never invokes a forged ready callback',
  /** 正式 provider 必须持真实私有交付对象，不信任任意用户对象的 ready 或 source 字段。 */ () => {
    let invoked = false
    const forged = {
      ready: /* 假回调不能成为来源。 */ () => {
        invoked = true
        return true
      }
    } as unknown as RestrictedLuvusCustody
    assert.throws(
      /* WeakSet 身份在回调前完成核验。 */ () => assertRestrictedLuvusCustody(forged),
      failure('native_custody_unavailable')
    )
    assert.equal(invoked, false)
  }
)
