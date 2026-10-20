// 只操作自有临时目录及合成账本；原生 ACL 负例不改变账户、服务或用户目录。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { assertMacosAclEntry, assertMacosDescriptorAcl } from '../../src/storage/macos-acl.js'
import { createPrivate, ensurePrivateDirectory, privatePath, readPrivateBytes } from '../../src/storage/files.js'
import { readOrCreateRoleConfig } from '../../src/cli/first-config.js'
import { readConfig } from '../../src/cli/config.js'
import { readRuntimeJson } from '../../src/cli/runtime-files.js'
import { Store } from '../../src/store.js'
import { connected, management, options } from './helpers.js'

// macOS 临时根可能含系统软链接；只规范化测试根，产品仍拒绝调用方路径中的软链接。
function temporary(check: (directory: string) => void): void {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'rovloom-private-platform-'))
  try {
    check(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test(
  'Darwin ACL 已知 deny 不授予权限，私有叶拒绝读授权及未知位',
  /* 逐位覆盖读写和未知语义。 */ () => {
    assertMacosAclEntry(2, 0x103ffen, true)
    assertMacosAclEntry(1, 0xa8an, false)
    for (const tag of [0, 3]) {
      assert.throws(/* 未知 tag 不能被当作 deny。 */ () => assertMacosAclEntry(tag, 0n, false))
    }
    for (let bit = 0; bit <= 21; bit++) {
      assert.throws(
        /* 每个非零 allow 位都不属于私有叶可接受的扩展授权。 */ () => assertMacosAclEntry(1, 1n << BigInt(bit), true)
      )
    }
    for (const mask of [4n, 0x10n, 0x20n, 0x40n, 0x100n, 0x400n, 0x1000n, 0x2000n, 1n << 30n]) {
      assert.throws(/* 祖先写入/删除/改 ACL 或未知位不能放行。 */ () => assertMacosAclEntry(1, mask, false))
    }
  }
)

test(
  '私有配置和字节读取拒绝链接、超限、公开权限及不安全祖先且不修复',
  /* 同时覆盖正式 CLI 读取器。 */ () => {
    if (process.platform === 'win32') {
      assert.throws(
        /* Windows 等效文件层尚未接通，不能把 mode 当 ACL。 */ () => privatePath('C:\\private\\db'),
        /unsupported_storage_platform/
      )
      return
    }
    temporary(
      /* 全部权限和链接变更仅针对本例新建对象。 */ (root) => {
        const directory = join(root, 'state')
        ensurePrivateDirectory(directory)
        const path = join(directory, 'value.json')
        createPrivate(path, '{"value":"synthetic"}')
        assert.deepEqual(readRuntimeJson(path), { value: 'synthetic' })
        assert.throws(/* 实际大小不能超过调用方预算。 */ () => readPrivateBytes(path, 4))
        chmodSync(path, 0o644)
        assert.throws(/* 不接受公开可读的运行状态。 */ () => readRuntimeJson(path))
        assert.equal(statSync(path).mode & 0o777, 0o644)
        chmodSync(path, 0o600)
        const hard = join(directory, 'hard.json')
        linkSync(path, hard)
        assert.throws(/* 单个 fd 指向多链接对象仍拒绝。 */ () => readPrivateBytes(path, 1024))
        unlinkSync(hard)
        const link = join(directory, 'link.json')
        symlinkSync(path, link)
        assert.throws(/* 最终软链接不能绕过 nofollow。 */ () => readPrivateBytes(link, 1024))
        const alias = join(root, 'alias')
        symlinkSync(directory, alias)
        assert.throws(/* 路径祖先软链接同样拒绝。 */ () => readPrivateBytes(join(alias, 'value.json'), 1024))
        chmodSync(directory, 0o755)
        assert.throws(/* 私有父目录无效时不自动 chmod。 */ () => ensurePrivateDirectory(directory))
        assert.equal(statSync(directory).mode & 0o777, 0o755)
        chmodSync(directory, 0o700)
        const config = join(directory, 'gateway.json')
        const created = readOrCreateRoleConfig('gateway', config, { home: root, platform: process.platform })
        const before = readFileSync(config)
        const inode = statSync(config).ino
        chmodSync(config, 0o400)
        assert.deepEqual(readConfig(config), created)
        readOrCreateRoleConfig('gateway', config)
        assert.deepEqual(readFileSync(config), before)
        assert.equal(statSync(config).ino, inode)
        assert.equal(statSync(config).mode & 0o777, 0o400)
        assert.throws(
          /* 角色配置也不能接受额外硬链接。 */ () => {
            linkSync(config, join(directory, 'duplicate.json'))
            readConfig(config)
          }
        )
      }
    )
  }
)

test(
  '双开与残留锁均拒绝，SQLite 重开把在途调用保留为 unknown 且不重派',
  /* 只使用离线合成设备。 */ () => {
    if (process.platform === 'win32') {
      return
    }
    temporary(
      /* 实际数据库关闭重开，不伪造持久化成功。 */ (directory) => {
        const path = join(directory, 'gateway.db')
        let store = new Store(path, /* 固定账本时钟使恢复语义可比较。 */ () => 100, { management })
        try {
          const device = connected(store)
          const history = store.openHistory('alice', device.target, 1)
          const callOptions = options({
            history: { history_epoch: history.history_epoch, client_request_key: 'platform-key' }
          })
          const call = store.createCall('alice', device.target, { method: 'ping' }, callOptions)
          store.dispatch('alice', call.call_id, device.epoch)
          assert.throws(/* 当前 writer 存活时不能创建第二个 writer。 */ () => new Store(path), /EEXIST/)
          store.close()
          store = new Store(path, /* 同一时钟重开，不能把旧调用重新置为待派发。 */ () => 100, { management })
          assert.equal(store.call('alice', call.call_id).state, 'outcome_unknown')
          assert.equal(store.createCall('alice', device.target, { method: 'ping' }, callOptions).call_id, call.call_id)
          assert.throws(/* unknown 原调用不能再派发。 */ () => store.dispatch('alice', call.call_id, device.epoch))
          store.close()
          createPrivate(path + '.lock', 'synthetic-crash-lock')
          assert.throws(/* 崩溃锁不因重开被自动删除。 */ () => new Store(path), /EEXIST/)
          assert.equal(existsSync(path + '.lock'), true)
        } finally {
          store.close()
        }
      }
    )
  }
)

test(
  'macOS 实际 fd ACL 拒绝 mode0600 文件的额外读取及目录授权',
  /* 仅在 Darwin 内核上验证实际 ACL。 */ () => {
    if (process.platform !== 'darwin') {
      return
    }
    assert.throws(/* 无效 fd 的 EBADF 不能被当作 ACL 不存在。 */ () => assertMacosDescriptorAcl(-1, true))
    temporary(
      /* chmod 仅用于构造新 fixture 的不安全 ACL，不修改既有系统对象。 */ (directory) => {
        const path = join(directory, 'private.json')
        createPrivate(path, '{"synthetic":true}')
        const grant = spawnSync('/bin/chmod', ['+a', 'everyone allow read', path], { encoding: 'utf8' })
        assert.equal(grant.status, 0, grant.stderr)
        assert.equal(statSync(path).mode & 0o777, 0o600)
        assert.throws(/* mode 仍然私有，但实际 ACL 暴露正文，读取必须拒绝。 */ () => readPrivateBytes(path, 1024))
        const child = join(directory, 'child')
        mkdirSync(child, { mode: 0o700 })
        const changed = spawnSync('/bin/chmod', ['+a', 'everyone allow list,search', child], { encoding: 'utf8' })
        assert.equal(changed.status, 0, changed.stderr)
        assert.throws(/* 目录 ACL 不得授予私有叶额外读取。 */ () => ensurePrivateDirectory(child))
        assert.equal(statSync(child).mode & 0o777, 0o700)
      }
    )
  }
)
