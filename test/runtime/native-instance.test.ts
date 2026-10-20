/** 验证开发 native 启动前的拒绝边界；默认测试不依赖下载 binary，也不读取真实凭据。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEVELOPMENT_LUVUS_SHA256, startDevelopmentLuvus } from '../../src/runtime/native-instance.js'
import type { DevelopmentLuvusOptions } from '../../src/runtime/native-instance.js'
import { ownedPathStamp } from '../../src/runtime/native-process.js'
import { LuvusAdapterError } from '../../src/connector/luvus/index.js'
import type { LuvusLocalConfig } from '../../src/connector/luvus/index.js'

const options: DevelopmentLuvusOptions = { acknowledge_nonproduction: true, token_ttl_s: 120 }

/** 创建仅含不可执行标记脚本和空白隔离目录的测试夹具，绝不准备原生凭据。 */
function fixture() {
  const root = mkdtempSync(
    join(process.env.LUVUS_TEST_ROOT ?? fileURLToPath(new URL('../../', import.meta.url)), '.runtime-native-')
  )
  const home = join(root, 'home')
  const cwd = join(root, 'project')
  const state = join(root, 'state')
  for (const directory of [
    home,
    cwd,
    state,
    ...['config', 'data', 'cache', 'runtime'].map(/* 固定夹具的空白 XDG 目录。 */ (name) => join(home, name))
  ]) {
    mkdirSync(directory, { mode: 0o700 })
  }
  const binary = join(root, 'untrusted-binary')
  writeFileSync(binary, '#!/bin/sh\nexit 99\n', { mode: 0o500 })
  const config: LuvusLocalConfig = {
    target: { machine_id: 'machine1', provider_id: 'provider1', profile: 'session', session: 'fixedsession' },
    binding_revision: 1,
    config_ref: 'fixedconfig',
    binary,
    binary_sha256: DEVELOPMENT_LUVUS_SHA256,
    state_root: state,
    home,
    cwd,
    transport: 'ipc'
  }
  return {
    root,
    config,
    /** 只删除本测试创建的目录树。 */
    close() {
      rmSync(root, { recursive: true, force: true })
    }
  }
}

/** 只接纳固定安全错误码，错误不得附带底层路径或原始数据。 */
function failure(code: string) {
  return /* 对异常类型和完整 message 一并断言。 */ (error: unknown) => {
    assert(error instanceof LuvusAdapterError)
    assert.equal(error.code, code)
    assert.equal(error.message, code)
    return true
  }
}

test(
  'development native requires explicit nonproduction acknowledgement, short TTL and exact limited scopes',
  /** 所有无 opt-in、过长 TTL 或越权 scope 在读取安装前拒绝。 */ async () => {
    const f = fixture()
    try {
      for (const invalid of [
        { acknowledge_nonproduction: false },
        { token_ttl_s: 0 },
        { token_ttl_s: 301 },
        { token_ttl_s: 1.5 },
        { scopes: ['all'] },
        { scopes: ['orchestration'] },
        { scopes: ['read', 'read'] },
        { scopes: ['admin'] }
      ]) {
        await assert.rejects(
          startDevelopmentLuvus(f.config, { ...options, ...invalid } as DevelopmentLuvusOptions),
          failure('development_opt_in_required')
        )
      }
      assert.deepEqual(readdirSync(f.config.state_root), [])
    } finally {
      f.close()
    }
  }
)

test(
  'development native refuses CLI, changed installed bytes and overlapping roots before launch',
  /** caller 不能切换传输、binary 指纹或把空白 HOME 与工作根重叠。 */ async () => {
    const f = fixture()
    try {
      await assert.rejects(
        startDevelopmentLuvus({ ...f.config, transport: 'cli' }, options),
        failure('development_installation_unsupported')
      )
      await assert.rejects(
        startDevelopmentLuvus({ ...f.config, binary_sha256: '0'.repeat(64) }, options),
        failure('binary_identity_changed')
      )
      for (const cwd of [f.config.home, join(f.config.home, 'config')]) {
        await assert.rejects(startDevelopmentLuvus({ ...f.config, cwd }, options), failure('development_roots_overlap'))
      }
    } finally {
      f.close()
    }
  }
)

test(
  'development native rejects preexisting state, project, HOME and XDG contents without reading them',
  /** 合成私密内容只用作存在性拒绝断言，不被读取、执行或写入日志。 */ async () => {
    for (const directory of ['state', 'project', 'home', 'home/config', 'home/data', 'home/cache', 'home/runtime']) {
      const f = fixture()
      try {
        writeFileSync(join(f.root, directory, 'synthetic-existing-content'), 'test-only', { mode: 0o600 })
        await assert.rejects(startDevelopmentLuvus(f.config, options), failure('development_root_not_blank'))
      } finally {
        f.close()
      }
    }
  }
)

test(
  'development native refuses an old development ownership marker and keeps it intact',
  /** 遗留拥有标记不能被新工厂静默删除或接管。 */ async () => {
    const f = fixture()
    try {
      writeFileSync(join(f.config.state_root, '.rovloom-development-owner'), '', { mode: 0o600 })
      await assert.rejects(startDevelopmentLuvus(f.config, options), failure('development_root_not_blank'))
      assert.deepEqual(readdirSync(f.config.state_root), ['.rovloom-development-owner'])
    } finally {
      f.close()
    }
  }
)

test(
  'development native rejects directory symlinks and nonprivate directory permissions',
  /** Linux 目录链的权限与 inode 事实独立于配置 JSON。 */ async () => {
    const f = fixture()
    try {
      chmodSync(f.config.state_root, 0o755)
      await assert.rejects(startDevelopmentLuvus(f.config, options), failure('owned_path_untrusted'))
      chmodSync(f.config.state_root, 0o700)
      const alias = join(f.root, 'state-alias')
      symlinkSync(f.config.state_root, alias)
      await assert.rejects(
        startDevelopmentLuvus({ ...f.config, state_root: alias }, options),
        failure('owned_path_untrusted')
      )
    } finally {
      f.close()
    }
  }
)

test(
  'development native hashes the installed bytes and never executes a mismatched binary',
  /** 即使配置自报官方 SHA，实际字节不符也不启动任何 CLI/server 或生成拥有标记。 */ async () => {
    const f = fixture()
    try {
      await assert.rejects(startDevelopmentLuvus(f.config, options), failure('binary_identity_changed'))
      assert.deepEqual(readdirSync(f.config.state_root), [])
      assert.deepEqual(readdirSync(f.config.cwd), [])
      assert.deepEqual(readdirSync(f.config.home).sort(), ['cache', 'config', 'data', 'runtime'])
    } finally {
      f.close()
    }
  }
)

test(
  'owned Linux path stamps detect inode replacement and reject socket impostors',
  /** 同名目录替换与普通文件伪造 socket 都不能沿用原来源。 */ () => {
    const f = fixture()
    try {
      const first = ownedPathStamp(f.config.state_root, 'directory')
      renameSync(f.config.state_root, join(f.root, 'retained-old-state'))
      mkdirSync(f.config.state_root, { mode: 0o700 })
      assert.notEqual(ownedPathStamp(f.config.state_root, 'directory'), first)
      const socket = join(f.config.state_root, 'native.sock')
      writeFileSync(socket, '', { mode: 0o600 })
      assert.throws(
        /* 文件类型须由实际 lstat 证明。 */ () => ownedPathStamp(socket, 'socket'),
        failure('owned_path_untrusted')
      )
    } finally {
      f.close()
    }
  }
)
